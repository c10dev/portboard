package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The limits and words of src/mcp/thin.mjs and claude-plugin/bin/mcp.mjs.
const (
	pingTimeout    = 300 * time.Millisecond
	connectTimeout = 2 * time.Second
	// The longest tool (adoption_stats, remove_worktrees) may take this long to answer.
	replyTimeout = 10 * time.Minute
	retryAfter   = time.Second
	// The dashboard's POST /api/mcp body limit: a longer line is refused here instead of sent.
	maxLine = 1_048_576
)

var (
	sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`)
	claudePIDRe = regexp.MustCompile(`^\d{1,10}$`)
)

// rpcError is a JSON-RPC error reply. Field order is the order JSON.stringify gives thin.mjs's objects.
type rpcError struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Error   struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// encode writes v as one JSON value without the HTML escapes that Go adds by default.
func encode(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v) // the values here always encode; Encode ends with the newline
	return b.Bytes()
}

func errorLine(id any, code int, message string) []byte {
	e := rpcError{JSONRPC: "2.0", ID: id}
	e.Error.Code = code
	e.Error.Message = message
	return encode(e)
}

func failedLine(id any, tail string) []byte {
	return errorLine(id, -32603, "Portboard dashboard request failed: "+tail)
}

// stdout is shared by the replies of many requests and the Node child's lines: one lock, one whole line per write.
type lineWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lineWriter) line(b []byte) {
	b = bytes.TrimRight(b, "\n")
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(append(b[:len(b):len(b)], '\n'))
}

// readLine reads one line without its end ("\n" or "\r\n"). A line longer than max is read to its end and dropped:
// tooLong is true and line is nil. It returns io.EOF only when no byte was read.
func readLine(r *bufio.Reader, max int) (line []byte, tooLong bool, err error) {
	var buf []byte
	overflow := false
	read := 0
	for {
		frag, e := r.ReadSlice('\n')
		read += len(frag)
		if !overflow {
			buf = append(buf, frag...)
			if len(buf) > max+2 {
				overflow, buf = true, nil
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		if e != nil && e != io.EOF {
			return nil, false, e
		}
		if e == io.EOF && read == 0 {
			return nil, false, io.EOF
		}
		break
	}
	if overflow {
		return nil, true, nil
	}
	buf = bytes.TrimSuffix(buf, []byte("\n"))
	buf = bytes.TrimSuffix(buf, []byte("\r"))
	if len(buf) > max {
		return nil, true, nil
	}
	return buf, false, nil
}

// relay is one `mcp` session: stdin lines to the dashboard, replies to stdout, and the switch to Node's in-process
// server when the dashboard cannot be used.
type relay struct {
	endpoint string
	headers  map[string]string
	out      *lineWriter

	inflight sync.WaitGroup

	mu        sync.Mutex // guards child, childIn and the writes to childIn, so lines reach the child in order
	child     *exec.Cmd
	childIn   io.WriteCloser
	stdinDone bool
	childCode chan int // the child's exit code, once, after its output was copied
}

// idOf is thin.mjs's idOf: a request only when the message is an object with an id key.
func idOf(msg any) (id any, isRequest bool) {
	m, ok := msg.(map[string]any)
	if !ok {
		return nil, false
	}
	id, ok = m["id"]
	return id, ok
}

func decode(line []byte) (any, bool) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF { // text after the value
		return nil, false
	}
	return v, true
}

func refusesTool(body []byte) bool {
	var v struct {
		Error any `json:"error"`
	}
	return json.Unmarshal(body, &v) == nil && v.Error == "local only tool"
}

// post sends one line to the dashboard: 2 s to connect, 10 minutes for the answer, never a second time.
func (r *relay) post(line []byte) outcome {
	return do("POST", r.endpoint, r.headers, line, reqOpts{connectTimeout: connectTimeout, reply: replyTimeout, readLimit: 64 << 20})
}

// handle answers one request line. Requests run in their own goroutines.
func (r *relay) handle(line []byte, id any, isRequest bool) {
	fail := func(tail string) {
		if isRequest {
			r.out.line(failedLine(id, tail))
		}
	}
	if r.toChild(line) {
		return
	}
	sent := r.post(line)
	if sent.kind == "connect" {
		time.Sleep(retryAfter)
		if r.toChild(line) {
			return
		}
		sent = r.post(line)
	}
	// 409 {error: "local only tool"}: the dashboard refused a tool that runs only in the session's own process. Nothing
	// ran, so this request, and the rest of the session, are answered by Node.
	localOnly := sent.kind == "reply" && sent.status == 409 && refusesTool(sent.body)
	if sent.kind == "connect" || localOnly {
		r.switchTo(line)
		return
	}
	switch {
	case sent.kind == "lost":
		fail(sent.why)
	case sent.status == 204:
	case sent.status != 200:
		fail(strconv.Itoa(sent.status))
	default:
		var b bytes.Buffer
		if json.Compact(&b, sent.body) != nil || b.Len() == 0 {
			fail("bad reply")
			return
		}
		r.out.line(b.Bytes())
	}
}

// toChild writes the line to the Node child when the session has switched, and says whether it did.
func (r *relay) toChild(line []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.child == nil {
		return false
	}
	r.writeChild(line)
	return true
}

func (r *relay) writeChild(line []byte) {
	_, _ = r.childIn.Write(append(line[:len(line):len(line)], '\n')) // a dead child: the exit path reports it
}

// switchTo starts Node's in-process server for the rest of the session, once, and gives it the line that caused the
// switch. Without node or a checkout: one line on stderr and exit code 1.
func (r *relay) switchTo(line []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.child == nil {
		argv, reason := localCommand()
		if argv == nil {
			fmt.Fprintln(os.Stderr, reason)
			os.Exit(1)
		}
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stderr = os.Stderr
		in, err := cmd.StdinPipe()
		if err != nil {
			fmt.Fprintf(os.Stderr, "portboard plugin: cannot start node (%v)\n", err)
			os.Exit(1)
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			fmt.Fprintf(os.Stderr, "portboard plugin: cannot start node (%v)\n", err)
			os.Exit(1)
		}
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "portboard plugin: cannot start node (%v)\n", err)
			os.Exit(1)
		}
		r.child, r.childIn = cmd, in
		r.childCode = make(chan int, 1)
		go r.pump(cmd, out)
	}
	r.writeChild(line)
}

// pump copies the child's stdout to ours, one whole line at a time, then reports how the child ended. A child that ends
// before our stdin does is a failed session: the lines still to come would get no answer.
func (r *relay) pump(cmd *exec.Cmd, out io.Reader) {
	br := bufio.NewReaderSize(out, 64<<10)
	for {
		b, err := br.ReadBytes('\n')
		if len(b) > 0 {
			r.out.line(b)
		}
		if err != nil {
			break
		}
	}
	code := 0
	if err := cmd.Wait(); err != nil {
		code = 1
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() > 0 {
			code = ee.ExitCode()
		}
	}
	r.mu.Lock()
	done := r.stdinDone
	r.mu.Unlock()
	if !done {
		fmt.Fprintln(os.Stderr, "portboard plugin: the in-process server ended")
		if code == 0 {
			code = 1
		}
		os.Exit(code)
	}
	r.childCode <- code
}

// startLocal replaces this process with node running the in-process server.
func startLocal() int {
	argv, reason := localCommand()
	if argv == nil {
		fmt.Fprintln(os.Stderr, reason)
		return 1
	}
	return execv(argv)
}

func execv(argv []string) int {
	path := argv[0]
	if !strings.Contains(path, "/") {
		p, err := exec.LookPath(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, "portboard plugin: node not found")
			return 1
		}
		path = p
	}
	err := syscall.Exec(path, argv, os.Environ())
	fmt.Fprintf(os.Stderr, "portboard plugin: cannot start %s (%v)\n", filepath.Base(path), err)
	return 1
}

// ping is true when the dashboard answers 200 {"ok": true} within 300 ms.
func ping(base string) bool {
	res := do("GET", base+"/api/mcp/ping", nil, nil, reqOpts{total: pingTimeout, readLimit: 4096})
	if res.kind != "reply" || res.status != 200 {
		return false
	}
	var v struct {
		OK any `json:"ok"`
	}
	return json.Unmarshal(res.body, &v) == nil && v.OK == true
}

func runMCP() int {
	base := baseURL()
	u, ok := parseHTTP(base)
	if os.Getenv("PORTBOARD_MCP_MODE") == "local" || !ok {
		return startLocal()
	}
	if u.Scheme == "https" {
		// https needs TLS from Node's side as before: the Node thin client (bin/mcp.mjs) runs instead.
		dir, ok := exeDir()
		node, found := findNode()
		if !ok || !found {
			fmt.Fprintln(os.Stderr, "portboard plugin: node not found")
			return 1
		}
		return execv([]string{node, filepath.Join(dir, "mcp.mjs")})
	}
	if !ping(base) {
		return startLocal()
	}
	headers := map[string]string{"X-Portboard": "1", "Content-Type": "application/json"}
	if id := os.Getenv("CLAUDE_CODE_SESSION_ID"); sessionIDRe.MatchString(id) {
		headers["X-Portboard-Session"] = id
	}
	if pid := os.Getenv("CLAUDE_PID"); claudePIDRe.MatchString(pid) {
		headers["X-Portboard-Claude-Pid"] = pid
	}
	r := &relay{endpoint: base + "/api/mcp", headers: headers, out: &lineWriter{w: os.Stdout}}
	return r.serve(os.Stdin)
}

// serve reads stdin to its end, then waits for the requests in flight and for the child. It returns the exit code.
func (r *relay) serve(stdin io.Reader) int {
	in := bufio.NewReaderSize(stdin, 64<<10)
	for {
		line, tooLong, err := readLine(in, maxLine)
		if err != nil {
			break
		}
		if tooLong {
			r.out.line(failedLine(nil, "line too long"))
			continue
		}
		if strings.TrimSpace(string(line)) == "" {
			continue
		}
		msg, ok := decode(line)
		if !ok {
			r.out.line(errorLine(nil, -32700, "parse error"))
			continue
		}
		id, isRequest := idOf(msg)
		if r.toChild(line) {
			continue
		}
		r.inflight.Add(1)
		go func() {
			defer r.inflight.Done()
			r.handle(line, id, isRequest)
		}()
	}
	r.inflight.Wait()
	r.mu.Lock()
	r.stdinDone = true
	child := r.child
	if child != nil {
		_ = r.childIn.Close()
	}
	r.mu.Unlock()
	if child == nil {
		return 0
	}
	return <-r.childCode
}

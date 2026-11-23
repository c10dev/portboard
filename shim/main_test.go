package main

// The contract cases of test/fixtures/shim-contract/ run against the built binary, the same data that
// test/shim-contract.test.ts runs against the Node processes. The Go-only tests follow: what only the binary does
// (replacing itself with node, the child, the line limit, the redirects).
//
// Fake dashboards are httptest servers on temporary ports. Child processes get a clean environment and a temp HOME.
// The cases that need the in-process server run the real src/mcp.ts of this checkout with the node on PATH, and are
// skipped, with the reason, when there is none.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	shimBin  string
	repoRoot string
	nodePath string
)

func TestMain(m *testing.M) {
	os.Exit(testMain(m))
}

func testMain(m *testing.M) int {
	dir, err := os.MkdirTemp("", "pb-shim-bin-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(dir)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	shimBin = filepath.Join(dir, "portboard-shim")
	build := exec.Command("go", "build", "-o", shimBin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "go build: %v\n%s", err, out)
		return 1
	}
	repoRoot, _ = filepath.Abs("..")
	nodePath, _ = exec.LookPath("node")
	return m.Run()
}

// ---- helpers ----

func cleanEnv(t *testing.T, extra map[string]string) []string {
	t.Helper()
	pathDirs := "/usr/bin:/bin"
	if nodePath != "" {
		pathDirs = filepath.Dir(nodePath) + ":" + pathDirs
	}
	env := map[string]string{
		"HOME":           t.TempDir(),
		"PATH":           pathDirs,
		"PORTBOARD_HOME": repoRoot,
	}
	if l := os.Getenv("PORTBOARD_LOCALE"); l != "" {
		env["PORTBOARD_LOCALE"] = l
	}
	for k, v := range extra {
		env[k] = v
	}
	var out []string
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func closedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// bodyText is a fixture body: a JSON string is its text, any other JSON value is itself.
func bodyText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if raw[0] == '"' && json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

func hangUp(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if c, _, err := hj.Hijack(); err == nil {
			c.Close()
		}
	}
}

type postSpec struct {
	Status     int             `json:"status"`
	Body       json.RawMessage `json:"body"`
	Reply      string          `json:"reply"`
	Hangup     bool            `json:"hangup"`
	WhenMethod string          `json:"whenMethod"`
	DelayMs    int             `json:"delayMs"`
}

type pingSpec struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

var okPing = &pingSpec{Status: 200, Body: `{"ok":true}`}

type daemonSpec struct {
	Refuse         bool       `json:"refuse"`
	CloseAfterPing bool       `json:"closeAfterPing"`
	Ping           *pingSpec  `json:"ping"`
	Posts          []postSpec `json:"posts"`
	// nudge
	Status  int             `json:"status"`
	Body    json.RawMessage `json:"body"`
	DelayMs int             `json:"delayMs"`
}

type seen struct {
	body    string
	header  http.Header
	query   map[string][]string
	hasPath bool
}

type fake struct {
	url    string
	mu     sync.Mutex
	pings  int
	posts  []seen
	advice []seen
	srv    *httptest.Server
}

func (f *fake) counts() (pings, posts, advice int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pings, len(f.posts), len(f.advice)
}

func writeStatus(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Connection", "close")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// newFake starts a fake dashboard for the spec. With Refuse nothing listens, on a port that was free a moment ago.
func newFake(t *testing.T, spec daemonSpec) *fake {
	t.Helper()
	f := &fake{}
	if spec.Refuse {
		f.url = fmt.Sprintf("http://127.0.0.1:%d", closedPort(t))
		return f
	}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/mcp/ping":
			f.mu.Lock()
			f.pings++
			f.mu.Unlock()
			if spec.CloseAfterPing {
				f.srv.Listener.Close()
			}
			if spec.Ping == nil {
				writeStatus(w, 404, "{}")
				return
			}
			writeStatus(w, spec.Ping.Status, spec.Ping.Body)
		case r.Method == "POST" && r.URL.Path == "/api/mcp":
			f.mu.Lock()
			f.posts = append(f.posts, seen{body: string(body), header: r.Header.Clone()})
			f.mu.Unlock()
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			_ = json.Unmarshal(body, &msg)
			var pick *postSpec
			for i := range spec.Posts {
				if spec.Posts[i].WhenMethod != "" && spec.Posts[i].WhenMethod == msg.Method {
					pick = &spec.Posts[i]
					break
				}
			}
			for i := range spec.Posts {
				if pick == nil && spec.Posts[i].WhenMethod == "" {
					pick = &spec.Posts[i]
				}
			}
			if pick == nil && len(spec.Posts) > 0 {
				pick = &spec.Posts[len(spec.Posts)-1]
			}
			if pick == nil {
				writeStatus(w, 500, "{}")
				return
			}
			if pick.DelayMs > 0 {
				time.Sleep(time.Duration(pick.DelayMs) * time.Millisecond)
			}
			switch {
			case pick.Hangup:
				hangUp(w)
			case pick.Status == 204:
				w.Header().Set("Connection", "close")
				w.WriteHeader(204)
			case pick.Reply == "echo":
				id := string(msg.ID)
				if id == "" {
					id = "null"
				}
				method, _ := json.Marshal(msg.Method)
				status := pick.Status
				if status == 0 {
					status = 200
				}
				writeStatus(w, status, fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"echo":%s}}`, id, method))
			default:
				status := pick.Status
				if status == 0 {
					status = 200
				}
				writeStatus(w, status, bodyText(pick.Body))
			}
		case r.Method == "GET" && r.URL.Path == "/api/claude/port-advice":
			q := r.URL.Query()
			f.mu.Lock()
			f.advice = append(f.advice, seen{query: q})
			f.mu.Unlock()
			if spec.DelayMs > 0 {
				time.Sleep(time.Duration(spec.DelayMs) * time.Millisecond)
			}
			status := spec.Status
			if status == 0 {
				status = 200
			}
			if status == 204 {
				w.WriteHeader(204)
				return
			}
			text := string(spec.Body)
			if text == "" || text == "null" {
				text = "{}"
			}
			writeStatus(w, status, text)
		default:
			writeStatus(w, 404, `{"error":"not found"}`)
		}
	}))
	f.srv.Start()
	f.url = f.srv.URL
	t.Cleanup(func() {
		f.srv.CloseClientConnections()
		f.srv.Close()
	})
	return f
}

// session is one `portboard-shim mcp` process.
type session struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	mu     sync.Mutex
	out    bytes.Buffer
	stderr bytes.Buffer
	done   chan struct{}
	code   int
}

func startShim(t *testing.T, arg string, env []string) *session {
	t.Helper()
	s := &session{done: make(chan struct{})}
	s.cmd = exec.Command(shimBin, arg)
	s.cmd.Env = env
	stdin, err := s.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	s.stdin = stdin
	stdout, _ := s.cmd.StdoutPipe()
	stderr, _ := s.cmd.StderrPipe()
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	copyTo := func(r io.Reader, b *bytes.Buffer) {
		defer wg.Done()
		buf := make([]byte, 32<<10)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				s.mu.Lock()
				b.Write(buf[:n])
				s.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyTo(stdout, &s.out)
	go copyTo(stderr, &s.stderr)
	go func() {
		wg.Wait()
		err := s.cmd.Wait()
		s.code = 0
		if ee, ok := err.(*exec.ExitError); ok {
			s.code = ee.ExitCode()
		} else if err != nil {
			s.code = -1
		}
		close(s.done)
	}()
	t.Cleanup(func() { _ = s.cmd.Process.Kill() })
	return s
}

func (s *session) lines() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, l := range strings.Split(s.out.String(), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func (s *session) errText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stderr.String()
}

func (s *session) write(line string) {
	_, _ = io.WriteString(s.stdin, line+"\n")
}

func (s *session) waitLines(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for len(s.lines()) < n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d output lines, got %q (stderr %q)", n, s.lines(), s.errText())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// finish closes stdin and waits for the exit; it returns the exit code.
func (s *session) finish(t *testing.T) int {
	t.Helper()
	_ = s.stdin.Close()
	select {
	case <-s.done:
	case <-time.After(30 * time.Second):
		_ = s.cmd.Process.Kill()
		t.Fatalf("the process did not exit; stdout %q stderr %q", s.lines(), s.errText())
	}
	return s.code
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

func sorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func needNode(t *testing.T) {
	t.Helper()
	if nodePath == "" {
		t.Skip("no node on PATH: the in-process server (src/mcp.ts) cannot run")
	}
}

// fakeNode writes a shell script named node that stands in for node and returns its folder, to put first on PATH.
// body runs with the arguments in "$@".
func fakeNode(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "node"), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// ---- contract cases ----

func readFixture(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repoRoot, "test", "fixtures", "shim-contract", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

// merged is the case's expectation with the 'go' overrides applied.
func merged(expect map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range expect {
		if k != "node" && k != "go" {
			out[k] = v
		}
	}
	if g, ok := expect["go"].(map[string]any); ok {
		for k, v := range g {
			out[k] = v
		}
	}
	return out
}

func strs(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func num(v any) int { return int(v.(float64)) }

func TestMCPContract(t *testing.T) {
	var data struct {
		Cases []struct {
			Name   string            `json:"name"`
			Env    map[string]string `json:"env"`
			Daemon daemonSpec        `json:"daemon"`
			Stdin  []json.RawMessage `json:"stdin"`
			Expect map[string]any    `json:"expect"`
		} `json:"cases"`
	}
	readFixture(t, "mcp.json", &data)
	if len(data.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range data.Cases {
		t.Run(c.Name, func(t *testing.T) {
			want := merged(c.Expect)
			if strings.Contains(strings.Join(strs(want["stdout"]), "\n"), "method not found") {
				needNode(t)
			}
			f := newFake(t, c.Daemon)
			extra := map[string]string{"PORTBOARD_URL": f.url}
			for k, v := range c.Env {
				extra[k] = v
			}
			s := startShim(t, "mcp", cleanEnv(t, extra))
			for _, raw := range c.Stdin {
				var line string
				if json.Unmarshal(raw, &line) == nil {
					s.write(line)
					continue
				}
				var wait struct {
					WaitLines int `json:"waitLines"`
				}
				if err := json.Unmarshal(raw, &wait); err != nil {
					t.Fatal(err)
				}
				s.waitLines(t, wait.WaitLines)
			}
			code := s.finish(t)
			if got, w := sorted(s.lines()), sorted(strs(want["stdout"])); strings.Join(got, "\n") != strings.Join(w, "\n") {
				t.Errorf("stdout:\n got %q\nwant %q\nstderr %q", got, w, s.errText())
			}
			if code != num(want["exit"]) {
				t.Errorf("exit code %d, want %v", code, want["exit"])
			}
			pings, posts, _ := f.counts()
			if pings != num(want["pings"]) {
				t.Errorf("pings %d, want %v", pings, want["pings"])
			}
			if posts != num(want["posts"]) {
				t.Errorf("POSTs %d, want %v", posts, want["posts"])
			}
			if b, ok := want["bodies"]; ok {
				var got []string
				for _, p := range f.posts {
					got = append(got, p.body)
				}
				if strings.Join(sorted(got), "\n") != strings.Join(sorted(strs(b)), "\n") {
					t.Errorf("POST bodies %q, want %q", got, b)
				}
			}
			for _, p := range f.posts {
				if p.header.Get("X-Portboard") != "1" || p.header.Get("Content-Type") != "application/json" {
					t.Errorf("headers %v", p.header)
				}
				for key, header := range map[string]string{"session": "X-Portboard-Session", "pid": "X-Portboard-Claude-Pid"} {
					w, ok := want[key]
					if !ok {
						continue
					}
					got, has := p.header[http.CanonicalHeaderKey(header)]
					if w == nil && has || w != nil && (!has || got[0] != w.(string)) {
						t.Errorf("%s header %v, want %v", header, got, w)
					}
				}
			}
		})
	}
}

func commandOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	m := v.(map[string]any)
	prefix := m["prefix"].(string)
	return prefix + strings.Repeat(m["pad"].(string), num(m["padTo"])-len(prefix))
}

func TestNudgeContract(t *testing.T) {
	var data struct {
		Cases []struct {
			Name      string            `json:"name"`
			Input     map[string]any    `json:"input"`
			Stdin     json.RawMessage   `json:"stdin"`
			Env       map[string]string `json:"env"`
			URLScheme string            `json:"urlScheme"`
			Daemon    daemonSpec        `json:"daemon"`
			Expect    map[string]any    `json:"expect"`
			Split     string            `json:"split"`
		} `json:"cases"`
	}
	readFixture(t, "nudge.json", &data)
	splits := 0
	for _, c := range data.Cases {
		if c.Split != "" {
			splits++
		}
		t.Run(c.Name, func(t *testing.T) {
			var stdin string
			switch {
			case len(c.Stdin) > 0 && c.Stdin[0] == '"':
				_ = json.Unmarshal(c.Stdin, &stdin)
			case len(c.Stdin) > 0:
				var r struct {
					Repeat string `json:"repeat"`
					Times  int    `json:"times"`
				}
				_ = json.Unmarshal(c.Stdin, &r)
				stdin = strings.Repeat(r.Repeat, r.Times)
			default:
				input := map[string]any{"hook_event_name": "PreToolUse"}
				for k, v := range c.Input {
					input[k] = v
				}
				if ti, ok := input["tool_input"].(map[string]any); ok {
					if cmd, ok := ti["command"].(map[string]any); ok {
						ti["command"] = commandOf(cmd)
					}
				}
				raw, _ := json.Marshal(input)
				stdin = string(raw)
			}
			want := merged(c.Expect)
			f := newFake(t, c.Daemon)
			url := f.url
			if c.URLScheme != "" {
				url = strings.Replace(url, "http", c.URLScheme, 1)
			}
			extra := map[string]string{"PORTBOARD_URL": url, "PORTBOARD_HOOK_TIMEOUT_MS": "10000"}
			for k, v := range c.Env {
				extra[k] = v
			}
			cmd := exec.Command(shimBin, "nudge")
			cmd.Env = cleanEnv(t, extra)
			cmd.Stdin = strings.NewReader(stdin)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			if err := cmd.Run(); err != nil {
				t.Fatalf("exit: %v (the hook must always exit 0)", err)
			}
			if stderr.Len() != 0 {
				t.Errorf("stderr %q", stderr.String())
			}
			wantOut := ""
			if ctx, ok := want["context"].(string); ok {
				wantOut = fmt.Sprintf(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}`+"\n", strings.TrimSpace(string(encode(ctx))))
			}
			if stdout.String() != wantOut {
				t.Errorf("stdout %q, want %q", stdout.String(), wantOut)
			}
			_, _, n := f.counts()
			if n != num(want["requests"]) {
				t.Errorf("requests %d, want %v", n, want["requests"])
			}
			if n > 0 {
				last := f.advice[n-1].query
				for _, key := range []string{"cwd", "session"} {
					w, ok := want[key]
					if !ok {
						continue
					}
					got, has := last[key]
					if w == nil && has || w != nil && (!has || got[0] != w.(string)) {
						t.Errorf("query %s = %v, want %v", key, got, w)
					}
				}
				if w, ok := want["command"]; ok && first(last["command"]) != w.(string) {
					t.Errorf("query command %q, want %q", first(last["command"]), w)
				}
			}
		})
	}
	if splits != 3 {
		t.Errorf("%d accepted splits in the data, want exactly 3", splits)
	}
}

// ---- Go only: the binary ----

func TestVersionAndUsage(t *testing.T) {
	out, err := exec.Command(shimBin, "version").Output()
	if err != nil || !strings.HasPrefix(string(out), "portboard-shim ") || !strings.HasSuffix(string(out), "\n") {
		t.Fatalf("version: %q, %v", out, err)
	}
	for _, args := range [][]string{{}, {"nope"}, {"mcp", "extra"}, {"version", "x"}} {
		cmd := exec.Command(shimBin, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		err := cmd.Run()
		ee, ok := err.(*exec.ExitError)
		if !ok || ee.ExitCode() != 2 || strings.Count(stderr.String(), "\n") != 1 {
			t.Errorf("%v: exit %v, stderr %q", args, err, stderr.String())
		}
	}
}

// At the start the process is replaced by node (syscall.Exec): the pid stays, no Go process is left behind.
func TestStartFallbackReplacesProcess(t *testing.T) {
	record := filepath.Join(t.TempDir(), "record")
	node := fakeNode(t, fmt.Sprintf(`echo "$$" > %q; echo "$@" >> %q; exit 0`, record, record))
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_MCP_MODE": "local", "PATH": node + ":/usr/bin:/bin"}))
	if code := s.finish(t); code != 0 {
		t.Fatalf("exit %d, stderr %q", code, s.errText())
	}
	raw, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if parts[0] != strconv.Itoa(s.cmd.Process.Pid) {
		t.Errorf("node ran as pid %s, the shim was pid %d: the process was not replaced", parts[0], s.cmd.Process.Pid)
	}
	if want := filepath.Join(repoRoot, "src", "mcp.ts"); parts[1] != want {
		t.Errorf("node got %q, want %q", parts[1], want)
	}
}

func TestStartFallbackReasons(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"no node", map[string]string{"PORTBOARD_MCP_MODE": "local", "PATH": "/nonexistent"}, "node not found"},
		{"no checkout", map[string]string{"PORTBOARD_MCP_MODE": "local", "PORTBOARD_HOME": "/nonexistent/checkout"}, "checkout not found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := startShim(t, "mcp", cleanEnv(t, c.env))
			code := s.finish(t)
			if code != 1 || !strings.Contains(s.errText(), c.want) || strings.Count(s.errText(), "\n") != 1 || len(s.lines()) != 0 {
				t.Errorf("exit %d, stderr %q, stdout %q", code, s.errText(), s.lines())
			}
		})
	}
}

func TestOtherSchemesGoToNode(t *testing.T) {
	record := filepath.Join(t.TempDir(), "record")
	node := fakeNode(t, fmt.Sprintf(`echo "$@" > %q`, record))
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": "ftp://127.0.0.1:1", "PATH": node + ":/usr/bin:/bin"}))
	s.finish(t)
	raw, _ := os.ReadFile(record)
	if strings.TrimSpace(string(raw)) != filepath.Join(repoRoot, "src", "mcp.ts") {
		t.Errorf("node got %q", raw)
	}
}

// An https PORTBOARD_URL runs the Node thin client next to the binary, not the 115 MB in-process server.
func TestHTTPSRunsNodeThinClient(t *testing.T) {
	record := filepath.Join(t.TempDir(), "record")
	node := fakeNode(t, fmt.Sprintf(`echo "$@" > %q`, record))
	for _, url := range []string{"https://127.0.0.1:1", "HTTPS://127.0.0.1:1/"} {
		s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": url, "PATH": node + ":/usr/bin:/bin"}))
		s.finish(t)
		raw, _ := os.ReadFile(record)
		if want := filepath.Join(filepath.Dir(shimBin), "mcp.mjs"); strings.TrimSpace(string(raw)) != want {
			t.Errorf("%s: node got %q, want %q", url, raw, want)
		}
		os.Remove(record)
	}
}

const trigger = `{"jsonrpc":"2.0","id":1,"method":"first"}`

func localOnlyDaemon(t *testing.T) *fake {
	return newFake(t, daemonSpec{
		Ping:  okPing,
		Posts: []postSpec{{Status: 409, Body: json.RawMessage(`"{\"error\":\"local only tool\"}"`)}},
	})
}

// After the switch, the line that caused it and every later line reach the child in order, and what the child prints
// reaches stdout whole, line by line. Here the child echoes its stdin.
func TestMidSessionChildKeepsOrder(t *testing.T) {
	f := localOnlyDaemon(t)
	node := fakeNode(t, `exec cat`)
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": f.url, "PATH": node + ":/usr/bin:/bin"}))
	s.write(trigger)
	s.waitLines(t, 1)
	var want []string
	want = append(want, trigger)
	for i := 2; i < 300; i++ {
		l := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"m%d","params":{"pad":"%s"}}`, i, i, strings.Repeat("x", i*7))
		want = append(want, l)
		s.write(l)
	}
	if code := s.finish(t); code != 0 {
		t.Fatalf("exit %d, stderr %q", code, s.errText())
	}
	got := s.lines()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the child's lines differ: %d lines, want %d", len(got), len(want))
	}
	if _, posts, _ := f.counts(); posts != 1 {
		t.Errorf("the dashboard got %d POSTs, want 1 (later lines go to the child)", posts)
	}
}

func TestChildExitCodes(t *testing.T) {
	cases := []struct {
		name, script string
		close        bool // close stdin before the child exits
		want         int
		stderr       string
	}{
		{"child exits at stdin end: its code", `cat > /dev/null; exit 7`, true, 7, ""},
		{"child dies early: its code, one stderr line", `exit 3`, false, 3, "ended"},
		{"child exits 0 early: 1", `exit 0`, false, 1, "ended"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := localOnlyDaemon(t)
			s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": f.url, "PATH": fakeNode(t, c.script) + ":/usr/bin:/bin"}))
			s.write(trigger)
			var code int
			if c.close {
				code = s.finish(t)
			} else {
				select {
				case <-s.done:
					code = s.code
				case <-time.After(20 * time.Second):
					t.Fatal("the shim did not follow the child's exit")
				}
			}
			if code != c.want || !strings.Contains(s.errText(), c.stderr) {
				t.Errorf("exit %d, stderr %q; want %d, %q", code, s.errText(), c.want, c.stderr)
			}
		})
	}
}

func TestLineLimit(t *testing.T) {
	f := newFake(t, daemonSpec{
		Ping:  okPing,
		Posts: []postSpec{{Status: 200, Reply: "echo"}},
	})
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": f.url}))
	head := `{"jsonrpc":"2.0","id":1,"method":"big","params":"`
	tail := `"}`
	exact := head + strings.Repeat("x", maxLine-len(head)-len(tail)) + tail
	over := head + strings.Repeat("x", maxLine-len(head)-len(tail)+1) + tail
	if len(exact) != maxLine || len(over) != maxLine+1 {
		t.Fatal("test lines have the wrong size")
	}
	s.write(over)
	s.waitLines(t, 1)
	s.write(exact + "\r") // the line end "\r\n" is not part of the line
	s.write(`{"jsonrpc":"2.0","id":3,"method":"after"}`)
	s.waitLines(t, 3)
	if code := s.finish(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	got := sorted(s.lines())
	want := sorted([]string{
		`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Portboard dashboard request failed: line too long"}}`,
		`{"jsonrpc":"2.0","id":1,"result":{"echo":"big"}}`,
		`{"jsonrpc":"2.0","id":3,"result":{"echo":"after"}}`,
	})
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("stdout %q", got)
	}
	if _, posts, _ := f.counts(); posts != 2 {
		t.Errorf("POSTs %d, want 2 (the long line is not sent)", posts)
	}
}

func TestStdinCloseWaitsForRequestInFlight(t *testing.T) {
	f := newFake(t, daemonSpec{
		Ping:  okPing,
		Posts: []postSpec{{Status: 200, Reply: "echo", DelayMs: 600}},
	})
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": f.url}))
	s.write(`{"jsonrpc":"2.0","id":1,"method":"slow"}`)
	if code := s.finish(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := s.lines(); len(got) != 1 || got[0] != `{"jsonrpc":"2.0","id":1,"result":{"echo":"slow"}}` {
		t.Errorf("stdout %q", got)
	}
}

// The mcp client does not follow a redirect (node:http does not): a 3xx in mid-session is an error with the status.
func TestMCPDoesNotFollowRedirects(t *testing.T) {
	var hits int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		switch {
		case r.URL.Path == "/api/mcp/ping":
			writeStatus(w, 200, `{"ok":true}`)
		case r.URL.Path == "/api/mcp":
			http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
		default:
			t.Errorf("followed a redirect to %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	s := startShim(t, "mcp", cleanEnv(t, map[string]string{"PORTBOARD_URL": srv.URL}))
	s.write(`{"jsonrpc":"2.0","id":1,"method":"x"}`)
	s.finish(t)
	if got := s.lines(); len(got) != 1 || !strings.HasSuffix(got[0], `failed: 307"}}`) {
		t.Errorf("stdout %q", got)
	}
}

// The nudge follows redirects, as Node's fetch does.
func TestNudgeFollowsRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/claude/port-advice" {
			http.Redirect(w, r, "/moved", http.StatusFound)
			return
		}
		writeStatus(w, 200, `{"text":"[portboard] moved"}`)
	}))
	defer srv.Close()
	cmd := exec.Command(shimBin, "nudge")
	cmd.Env = cleanEnv(t, map[string]string{"PORTBOARD_URL": srv.URL, "PORTBOARD_HOOK_TIMEOUT_MS": "10000"})
	cmd.Stdin = strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"ls"}}`)
	out, err := cmd.Output()
	if err != nil || !strings.Contains(string(out), `"additionalContext":"[portboard] moved"`) {
		t.Errorf("stdout %q, %v", out, err)
	}
}

// The environment's proxy is not used: a proxy that nothing listens on must not matter.
func TestNoProxyFromEnvironment(t *testing.T) {
	f := newFake(t, daemonSpec{Status: 200, Body: json.RawMessage(`{"text":"[portboard] direct"}`)})
	cmd := exec.Command(shimBin, "nudge")
	cmd.Env = cleanEnv(t, map[string]string{"PORTBOARD_URL": f.url, "PORTBOARD_HOOK_TIMEOUT_MS": "10000", "HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "NO_PROXY": ""})
	cmd.Stdin = strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"ls"}}`)
	out, err := cmd.Output()
	if err != nil || !strings.Contains(string(out), "[portboard] direct") {
		t.Errorf("stdout %q, %v", out, err)
	}
}

// ---- Go only: units ----

func TestDoClassifiesFailures(t *testing.T) {
	// no connection: nothing was sent
	if o := do("POST", fmt.Sprintf("http://127.0.0.1:%d/x", closedPort(t)), nil, []byte("{}"), reqOpts{connectTimeout: time.Second, readLimit: 1 << 10}); o.kind != "connect" {
		t.Errorf("refused: %+v", o)
	}
	// connected, no answer in time: lost, with the word timeout
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(2 * time.Second) }))
	defer hang.CloseClientConnections()
	defer hang.Close()
	if o := do("POST", hang.URL, nil, []byte("{}"), reqOpts{connectTimeout: time.Second, reply: 100 * time.Millisecond, readLimit: 1 << 10}); o.kind != "lost" || o.why != "timeout" {
		t.Errorf("reply timeout: %+v", o)
	}
	// connected, hung up: lost
	cut := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hangUp(w) }))
	defer cut.Close()
	if o := do("POST", cut.URL, nil, []byte("{}"), reqOpts{connectTimeout: time.Second, reply: time.Minute, readLimit: 1 << 10}); o.kind != "lost" || o.why != "lost" {
		t.Errorf("hang up: %+v", o)
	}
	// a body that ends early
	short := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(w, "abc")
		hangUp(w)
	}))
	defer short.Close()
	if o := do("GET", short.URL, nil, nil, reqOpts{reply: time.Minute, readLimit: 1 << 10}); o.kind != "lost" {
		t.Errorf("short body: %+v", o)
	}
}

func TestReadLine(t *testing.T) {
	r := bufio.NewReaderSize(strings.NewReader("a\r\nbb\n\nccc\nlast"), 16)
	var got []string
	for {
		l, tooLong, err := readLine(r, 4)
		if err != nil {
			break
		}
		if tooLong {
			got = append(got, "TOOLONG")
		} else {
			got = append(got, string(l))
		}
	}
	if strings.Join(got, "|") != "a|bb||ccc|last" {
		t.Errorf("lines %q", got)
	}
	r = bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", 100)+"\nok\n"+strings.Repeat("y", 4)+"\n"), 16)
	got = nil
	for {
		l, tooLong, err := readLine(r, 3)
		if err != nil {
			break
		}
		if tooLong {
			got = append(got, "TOOLONG")
		} else {
			got = append(got, string(l))
		}
	}
	if strings.Join(got, "|") != "TOOLONG|ok|TOOLONG" {
		t.Errorf("lines %q", got)
	}
}

func TestHookTimeout(t *testing.T) {
	for in, want := range map[string]time.Duration{"": 300 * time.Millisecond, "0050": 50 * time.Millisecond, "10000": 10 * time.Second, "1": time.Millisecond,
		"0": 300 * time.Millisecond, "10001": 300 * time.Millisecond, "1.5": 300 * time.Millisecond, "-5": 300 * time.Millisecond, " 7": 300 * time.Millisecond, "1e3": 300 * time.Millisecond, "123456": 300 * time.Millisecond} {
		t.Setenv("PORTBOARD_HOOK_TIMEOUT_MS", in)
		if got := hookTimeout(); got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}

func TestFindNodePrefersHighestNvmVersion(t *testing.T) {
	home := t.TempDir()
	for _, v := range []string{"v9.1.0", "v22.18.0", "v22.9.0", "v24.1.2"} {
		dir := filepath.Join(home, ".nvm", "versions", "node", v, "bin")
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, "node"), []byte("#!/bin/sh\n"), 0o755)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/nonexistent")
	got, ok := findNode()
	if want := filepath.Join(home, ".nvm", "versions", "node", "v24.1.2", "bin", "node"); !ok || got != want {
		t.Errorf("findNode = %q, %v; want %q", got, ok, want)
	}
}

func TestIsCheckout(t *testing.T) {
	dir := t.TempDir()
	if isCheckout(dir) {
		t.Fatal("empty folder")
	}
	_ = os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "src", "mcp.ts"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"other"}`), 0o644)
	if isCheckout(dir) {
		t.Fatal("another package")
	}
	for _, name := range []string{"portboard", "@c10dev/portboard"} {
		_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"`+name+`"}`), 0o644)
		if !isCheckout(dir) {
			t.Errorf("%s", name)
		}
	}
	if !isCheckout(repoRoot) {
		t.Errorf("this checkout (%s) is not recognised", repoRoot)
	}
}

// ---- against the real dashboard ----

// stable drops what changes between two runs (timestamps), as test/mcp-local.test.ts does.
func stable(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range x {
			if k != "at" && k != "generatedAt" && k != "checkedAt" {
				out[k] = stable(val)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = stable(val)
		}
		return out
	}
	return v
}

// The same questions as test/mcp-local.test.ts test 1, with the Go binary: against a real dashboard (node src/server.ts
// on a temporary port, a temp HOME, stub commands first on PATH) its answers equal those of the in-process server.
func TestRealDashboardAnswersLikeLocal(t *testing.T) {
	needNode(t)
	tmp := t.TempDir()
	stubs := filepath.Join(tmp, "bin")
	_ = os.MkdirAll(stubs, 0o755)
	for _, c := range []string{"ss", "systemctl", "systemd-run", "journalctl", "tailscale", "docker", "ip", "gh", "git"} {
		body := "#!/bin/sh\nexit 1\n"
		if c == "ss" {
			body = "#!/bin/sh\necho 'LISTEN 0      511        127.0.0.1:4173        0.0.0.0:*'\n"
		}
		_ = os.WriteFile(filepath.Join(stubs, c), []byte(body), 0o755)
	}
	port := closedPort(t)
	env := map[string]string{
		"HOME":                 filepath.Join(tmp, "home"),
		"PATH":                 stubs + ":" + filepath.Dir(nodePath) + ":/usr/bin:/bin",
		"PORTBOARD_PORT":       strconv.Itoa(port),
		"PORTBOARD_REPOS_ROOT": filepath.Join(tmp, "repos"),
	}
	_ = os.MkdirAll(env["HOME"], 0o755)
	daemon := exec.Command(nodePath, filepath.Join(repoRoot, "src", "server.ts"))
	for k, v := range env {
		daemon.Env = append(daemon.Env, k+"="+v)
	}
	var dout bytes.Buffer
	var dmu sync.Mutex
	pipe, _ := daemon.StdoutPipe()
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = daemon.Process.Kill(); _ = daemon.Wait() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := pipe.Read(buf)
			dmu.Lock()
			dout.Write(buf[:n])
			dmu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get(url + "/api/mcp/ping")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			dmu.Lock()
			defer dmu.Unlock()
			t.Fatalf("the dashboard did not come up: %s", dout.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	ask := func(extra map[string]string) []map[string]any {
		e := map[string]string{"PORTBOARD_URL": url}
		for k, v := range env {
			e[k] = v
		}
		for k, v := range extra {
			e[k] = v
		}
		s := startShim(t, "mcp", cleanEnv(t, e))
		s.write(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
		s.waitLines(t, 1)
		s.write(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
		s.write(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
		s.write(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_ports","arguments":{"include_system":true}}}`)
		s.waitLines(t, 3)
		if code := s.finish(t); code != 0 {
			t.Fatalf("exit %d, stderr %q", code, s.errText())
		}
		var replies []map[string]any
		for _, l := range s.lines() {
			var m map[string]any
			if err := json.Unmarshal([]byte(l), &m); err != nil {
				t.Fatalf("not JSON on stdout: %q", l)
			}
			replies = append(replies, m)
		}
		sort.Slice(replies, func(i, j int) bool { return replies[i]["id"].(float64) < replies[j]["id"].(float64) })
		return replies
	}
	viaShim := ask(nil)
	local := ask(map[string]string{"PORTBOARD_MCP_MODE": "local"})
	if len(viaShim) != 3 || len(local) != 3 {
		t.Fatalf("replies: %d and %d, want 3", len(viaShim), len(local))
	}
	toolText := func(m map[string]any) any {
		text := m["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
		var v any
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			t.Fatalf("list_ports text: %v", err)
		}
		return stable(v)
	}
	same := func(a, b any) bool {
		x, _ := json.Marshal(a)
		y, _ := json.Marshal(b)
		return bytes.Equal(x, y)
	}
	if !same(stable(viaShim[0]), stable(local[0])) {
		t.Errorf("initialize differs:\n%v\n%v", viaShim[0], local[0])
	}
	if !same(viaShim[1], local[1]) {
		t.Error("tools/list differs")
	}
	if n := len(viaShim[1]["result"].(map[string]any)["tools"].([]any)); n < 30 {
		t.Errorf("tools/list has %d tools", n)
	}
	if !same(toolText(viaShim[2]), toolText(local[2])) {
		t.Errorf("list_ports differs:\n%v\n%v", toolText(viaShim[2]), toolText(local[2]))
	}
	if !strings.Contains(fmt.Sprint(toolText(viaShim[2])), "4173") {
		t.Error("the fixture port 4173 is not in the answer")
	}
}

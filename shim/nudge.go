package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHookTimeout = 300 * time.Millisecond
	nudgeMarker        = "[portboard]"
	// Up to 4096 UTF-16 units go through the dashboard's limit; this many bytes are always inside it, and keep the
	// query under Node's header limit (portboard#62 review).
	maxCommandBytes = 4096
	maxStdin        = 1_048_576
	maxAdviceBody   = 1_048_576
)

var (
	hookTimeoutRe = regexp.MustCompile(`^[0-9]{1,5}$`)
	nudgeOffRe    = regexp.MustCompile(`(?i)^(false|0|no|off)$`)
	adviceSession = regexp.MustCompile(`^[0-9a-zA-Z-]{1,64}$`)
)

// hookTimeout is claude-plugin/hooks/timeout.ts: PORTBOARD_HOOK_TIMEOUT_MS from 1 to 10000, else 300 ms.
func hookTimeout() time.Duration {
	raw := os.Getenv("PORTBOARD_HOOK_TIMEOUT_MS")
	if !hookTimeoutRe.MatchString(raw) {
		return defaultHookTimeout
	}
	n, _ := strconv.Atoi(raw)
	if n < 1 || n > 10000 {
		return defaultHookTimeout
	}
	return time.Duration(n) * time.Millisecond
}

// nudgeOff is `disabled` in port-nudge.ts.
func nudgeOff() bool {
	return os.Getenv("PORTBOARD_NUDGE") == "0" || nudgeOffRe.MatchString(os.Getenv("CLAUDE_PLUGIN_OPTION_PORT_NUDGE"))
}

type preToolUse struct {
	ToolName  any `json:"tool_name"`
	ToolInput struct {
		Command any `json:"command"`
	} `json:"tool_input"`
	CWD       any `json:"cwd"`
	SessionID any `json:"session_id"`
}

// advice is the hook's context text for the Bash command in input, or "" for nothing to add. It never fails: any
// problem is "nothing to add".
func advice(input []byte) string {
	var in preToolUse
	if json.Unmarshal(input, &in) != nil || in.ToolName != "Bash" {
		return ""
	}
	command, ok := in.ToolInput.Command.(string)
	if !ok || len(command) > maxCommandBytes {
		return ""
	}
	base := baseURL()
	if _, ok := parseHTTP(base); !ok || nudgeOff() {
		return ""
	}
	q := url.Values{"command": {command}}
	if cwd, ok := in.CWD.(string); ok && strings.HasPrefix(cwd, "/") {
		q.Set("cwd", cwd)
	}
	if s, ok := in.SessionID.(string); ok && adviceSession.MatchString(s) {
		q.Set("session", s)
	}
	res := do("GET", base+"/api/claude/port-advice?"+q.Encode(), nil, nil, reqOpts{follow: true, total: hookTimeout(), readLimit: maxAdviceBody})
	if res.kind != "reply" || res.status < 200 || res.status > 299 {
		return ""
	}
	var body struct {
		Text any `json:"text"`
	}
	if json.Unmarshal(res.body, &body) != nil {
		return ""
	}
	if text, ok := body.Text.(string); ok && strings.HasPrefix(text, nudgeMarker) {
		return text
	}
	return ""
}

type hookOutput struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// runNudge is the PreToolUse hook. Whatever happens: exit code 0, nothing on stderr, and no permissionDecision.
func runNudge() (code int) {
	defer func() {
		if recover() != nil {
			code = 0
		}
	}()
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxStdin+1))
	if err != nil || len(input) > maxStdin {
		return 0
	}
	if text := advice(bytes.TrimSpace(input)); text != "" {
		var out hookOutput
		out.HookSpecificOutput.HookEventName = "PreToolUse"
		out.HookSpecificOutput.AdditionalContext = text
		_, _ = os.Stdout.Write(encode(out))
	}
	return 0
}

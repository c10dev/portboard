// portboard-shim: the plugin's two small processes as one Go binary, standard library only.
//
//	portboard-shim mcp      the stdio MCP server's thin client (what src/mcp/thin.mjs does)
//	portboard-shim nudge    the PreToolUse hook (what claude-plugin/hooks/port-nudge.ts does)
//	portboard-shim version  prints "portboard-shim <version>" and touches nothing else
//
// It moves bytes and builds a few fixed error replies. The rules stay in TypeScript: the dashboard parses the Bash
// command (GET /api/claude/port-advice?command=) and defines the tools (POST /api/mcp). claude-plugin/bin/run.sh
// starts this binary when it is there and falls back to Node when it is not.
package main

import (
	"fmt"
	"os"
)

const version = "0.5.0"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 1 {
		switch args[0] {
		case "version":
			fmt.Printf("portboard-shim %s\n", version)
			return 0
		case "mcp":
			return runMCP()
		case "nudge":
			return runNudge()
		}
	}
	fmt.Fprintln(os.Stderr, "usage: portboard-shim mcp | nudge | version")
	return 2
}

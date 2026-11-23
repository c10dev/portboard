package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
)

// isCheckout reports whether dir is a Portboard checkout: src/mcp.ts exists and package.json names Portboard.
// The same test as checkoutVersion in claude-plugin/bin/mcp.mjs.
func isCheckout(dir string) bool {
	if st, err := os.Stat(filepath.Join(dir, "src", "mcp.ts")); err != nil || st.IsDir() {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &pkg) != nil {
		return false
	}
	return pkg.Name == "portboard" || pkg.Name == "@c10dev/portboard"
}

// exeDir is the folder of this binary after symlinks (claude-plugin/bin/ for the plugin).
func exeDir() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", false
	}
	return filepath.Dir(exe), true
}

// findCheckout is where the Portboard checkout is, in the order of claude-plugin/bin/mcp.mjs: PORTBOARD_HOME alone
// when it is set (a folder that is not a checkout means none, with no look elsewhere), then this binary's folder and
// up to five parents, then ~/projects/portboard.
func findCheckout() (string, bool) {
	if env := os.Getenv("PORTBOARD_HOME"); env != "" {
		return env, isCheckout(env)
	}
	if dir, ok := exeDir(); ok {
		for i := 0; i < 6; i++ {
			if isCheckout(dir) {
				return dir, true
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		fallback := filepath.Join(home, "projects", "portboard")
		if isCheckout(fallback) {
			return fallback, true
		}
	}
	return "", false
}

var nvmVersion = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)`)

// findNode is the node to run, in the order of bin/run.sh: node on PATH, else the highest
// $HOME/.nvm/versions/node/v*/bin/node.
func findNode() (string, bool) {
	if p, err := exec.LookPath("node"); err == nil {
		return p, true
	}
	home := os.Getenv("HOME")
	if home == "" {
		return "", false
	}
	matches, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "v*", "bin", "node"))
	best, bestKey := "", [3]int{-1, 0, 0}
	for _, m := range matches {
		sub := nvmVersion.FindStringSubmatch(filepath.Base(filepath.Dir(filepath.Dir(m))))
		if sub == nil {
			continue
		}
		var key [3]int
		for i := range key {
			key[i], _ = strconv.Atoi(sub[i+1])
		}
		if st, err := os.Stat(m); err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
			continue
		}
		if key[0] > bestKey[0] || (key[0] == bestKey[0] && (key[1] > bestKey[1] || (key[1] == bestKey[1] && key[2] > bestKey[2]))) {
			best, bestKey = m, key
		}
	}
	return best, best != ""
}

// localCommand is the argv that runs the in-process server: node <checkout>/src/mcp.ts. ok is false, with the
// one-line reason for stderr, when node or the checkout is missing.
func localCommand() (argv []string, reason string) {
	node, ok := findNode()
	if !ok {
		return nil, "portboard plugin: node not found"
	}
	home, ok := findCheckout()
	if !ok {
		return nil, "portboard plugin: Portboard checkout not found (set PORTBOARD_HOME to the repo that has src/mcp.ts)"
	}
	return []string{node, filepath.Join(home, "src", "mcp.ts")}, ""
}

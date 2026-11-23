#!/bin/sh
# Run one of the plugin's .ts or .mjs files with Node. Finds node like bin/portboard-mcp does: Claude Code may be started
# without nvm on PATH. With --hook, a missing node is a silent pass (exit 0): a hook must never print an error on
# every Bash call.
#
# The Go binary bin/portboard-shim (npm run build:shim; docs/claude-plugin/README.md) replaces two of the files when it
# is there and works: bin/mcp.mjs becomes `portboard-shim mcp`, hooks/port-nudge.ts becomes `portboard-shim nudge`.
# It is used only when all of these hold: this script was started with a path that has a slash (the binary is looked up
# next to it), PORTBOARD_SHIM is not 0, the file is executable and starts with the magic bytes of a native program
# (ELF: 7f 45 4c 46, Mach-O: cf fa ed fe, ce fa ed fe or ca fe ba be; no other check of the architecture), and
# `portboard-shim version` prints "portboard-shim <version>" and exits 0. The probe runs before the exec on purpose: a
# failed exec ends this shell with 126 or 127 and an error, and a hook must stay silent. The probe has no stdin and its
# messages are dropped. A missing, unrunnable (another architecture, a cut file) or empty binary falls through to Node.
# The other hooks always run in Node.
HOOK=0
if [ "$1" = "--hook" ]; then HOOK=1; shift; fi

case "$0" in */*) DIR=${0%/*}; [ -n "$DIR" ] || DIR=/ ;; *) DIR= ;; esac
SHIM="$DIR/portboard-shim"
if [ -n "$DIR" ] && [ "${PORTBOARD_SHIM:-}" != 0 ] && [ -f "$SHIM" ] && [ -x "$SHIM" ]; then
  case "$1" in
    */bin/mcp.mjs) SUB=mcp ;;
    */hooks/port-nudge.ts) SUB=nudge ;;
    *) SUB= ;;
  esac
  if [ -n "$SUB" ]; then
    MAGIC=$(od -An -tx1 -N4 "$SHIM" 2>/dev/null)
    case "$MAGIC" in
      *"7f 45 4c 46" | *"cf fa ed fe" | *"ce fa ed fe" | *"ca fe ba be")
        if { SHIM_VERSION=$("$SHIM" version </dev/null); } 2>/dev/null; then
          case "$SHIM_VERSION" in
            "portboard-shim "*) exec "$SHIM" "$SUB" ;;
          esac
        fi
        ;;
    esac
  fi
fi

NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  NODE=$( (ls -d "$HOME"/.nvm/versions/node/v*/bin/node | sort -V | tail -1) 2>/dev/null)
fi
if [ -z "$NODE" ]; then
  [ "$HOOK" = 1 ] && exit 0
  echo "portboard plugin: node not found" >&2
  exit 1
fi
exec "$NODE" "$@"

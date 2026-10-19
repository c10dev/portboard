#!/bin/sh
# Run one of the plugin's .ts files with Node. Finds node like bin/portboard-mcp does: Claude Code may be started
# without nvm on PATH. With --hook, a missing node is a silent pass (exit 0): a hook must never print an error on
# every Bash call.
HOOK=0
if [ "$1" = "--hook" ]; then HOOK=1; shift; fi
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

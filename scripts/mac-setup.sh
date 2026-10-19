#!/bin/bash
# One-time Mac setup: register portboard's MCP server (running on the server, reached over SSH)
# with Claude Code and Claude Desktop on this Mac. Run it on the Mac, with the server's SSH target:
#
#   scp <user>@<server>:projects/portboard/scripts/mac-setup.sh /tmp/ && bash /tmp/mac-setup.sh <user>@<server>
#
# <server> is its MagicDNS name (host.tailnet.ts.net), which the dashboard's https certificate is for.
# The target can also come from PORTBOARD_REMOTE; PORTBOARD_LAUNCHER is the MCP launcher's path on the server.
# (Piping it into bash also works: every command that could read stdin gets </dev/null.)
# Safe to re-run: it replaces its own entries and leaves other MCP servers alone.

set -euo pipefail

REMOTE="${1:-${PORTBOARD_REMOTE:-}}"
# relative to the home directory, where ssh runs the command
LAUNCHER="${PORTBOARD_LAUNCHER:-projects/portboard/bin/portboard-mcp}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
skip() { printf '  \033[33m–\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(uname)" != "Darwin" ]; then die "Run this on the Mac, not on the server."; fi
if [ -z "$REMOTE" ]; then die "Which server? bash $0 <user>@<host>.<tailnet>.ts.net (or set PORTBOARD_REMOTE)"; fi

echo "1) SSH to $REMOTE without a password prompt"
if ssh "${SSH_OPTS[@]}" "$REMOTE" true </dev/null 2>/tmp/portboard-ssh.err; then
  ok "key login works"
else
  cat /tmp/portboard-ssh.err >&2
  die "SSH key login failed. Check Tailscale is connected and 'ssh $REMOTE' works without a password."
fi

echo "2) MCP server answers over SSH"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mac-setup","version":"0"}}}'
if printf '%s\n' "$INIT" | ssh "${SSH_OPTS[@]}" "$REMOTE" "$LAUNCHER" | grep -q '"serverInfo":{"name":"portboard"'; then
  ok "portboard MCP responded"
else
  die "No MCP reply from $LAUNCHER on the server."
fi

echo "3) Claude Code (user scope)"
CLAUDE=$(command -v claude || true)
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" mcp remove portboard -s user </dev/null >/dev/null 2>&1 || true
  "$CLAUDE" mcp add --scope user portboard -- ssh "${SSH_OPTS[@]}" "$REMOTE" "$LAUNCHER" </dev/null >/dev/null
  ok "registered with $CLAUDE (check: claude mcp get portboard)"
else
  skip "claude CLI not found on this Mac; skipped"
fi

echo "4) Claude Desktop (claude_desktop_config.json)"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-portboard"
ARGS_JSON=$(printf '"%s",' "${SSH_OPTS[@]}" "$REMOTE" "$LAUNCHER")
ARGS_JSON="[${ARGS_JSON%,}]"
/usr/bin/osascript -l JavaScript - "$CFG" "$ARGS_JSON" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  const path = argv[0];
  const args = JSON.parse(argv[1]);
  let cfg = {};
  if ($.NSFileManager.defaultManager.fileExistsAtPath(path)) {
    const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null));
    if (text && text.trim()) cfg = JSON.parse(text);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.portboard = { command: 'ssh', args: args };
  const ok = $(JSON.stringify(cfg, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  if (!ok) throw new Error('could not write ' + path);
}
JXA
ok "added mcpServers.portboard (backup: claude_desktop_config.json.bak-portboard)"

echo
echo "Done. Quit and reopen the Claude app, then ask: What's running on the server right now?"
echo "Dashboard: https://${REMOTE#*@}:8443 (the port tailscale serve publishes, usually 8443)"

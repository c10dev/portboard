#!/bin/bash
# Install the portboard SwiftBar menu bar plugin on this Mac. Run it on the Mac, with the server's SSH target:
#
#   scp <user>@<server>:projects/portboard/scripts/mac-menubar-setup.sh /tmp/ && bash /tmp/mac-menubar-setup.sh <user>@<server>
#
# It copies menubar/portboard.30s.mjs and menubar/format.mjs (from a checkout next to this script, else via scp from
# the server) to ~/Library/Application Support/portboard-menubar/, rewrites the shebang to an absolute node path
# (SwiftBar does not load nvm), and links the plugin into SwiftBar's plugin folder. Only the link sits in that folder,
# so SwiftBar does not try to run format.mjs as a plugin. Safe to re-run (also after a node upgrade).
#
# Env: PORTBOARD_REMOTE (ssh target, instead of the argument; not needed when run from a checkout), PORTBOARD_INTERVAL (refresh, default 30s), PORTBOARD_NODE (node binary),
# PORTBOARD_URL (the dashboard the plugin reads; default https://<host from the ssh target>:8443).

set -euo pipefail

REMOTE="${1:-${PORTBOARD_REMOTE:-}}"
REMOTE_DIR="${PORTBOARD_REMOTE_DIR:-projects/portboard/menubar}"
INTERVAL="${PORTBOARD_INTERVAL:-30s}"
SUPPORT="$HOME/Library/Application Support/portboard-menubar"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m–\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(uname)" != "Darwin" ]; then die "Run this on the Mac, not on the server."; fi
case "$INTERVAL" in [0-9]*[smhd]) ;; *) die "PORTBOARD_INTERVAL must look like 30s, 1m or 5m (got $INTERVAL)";; esac

echo "1) SwiftBar"
SWIFTBAR_APP=""
for app in "/Applications/SwiftBar.app" "$HOME/Applications/SwiftBar.app"; do
  [ -d "$app" ] && SWIFTBAR_APP="$app" && break
done
if [ -z "$SWIFTBAR_APP" ]; then
  SWIFTBAR_APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.ameba.SwiftBar'" 2>/dev/null </dev/null | head -1 || true)
fi
if [ -z "$SWIFTBAR_APP" ]; then
  echo "    SwiftBar is not installed. Install it, open it once, then re-run this script:"
  echo
  echo "      brew install --cask swiftbar"
  echo
  exit 1
fi
ok "found $SWIFTBAR_APP"

echo "2) node that SwiftBar can run (absolute path, no nvm PATH needed)"
node_ok() { [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' </dev/null 2>/dev/null; }
NODE=""
CANDIDATES=()
[ -n "${PORTBOARD_NODE:-}" ] && CANDIDATES+=("$PORTBOARD_NODE")
command -v node >/dev/null 2>&1 && CANDIDATES+=("$(command -v node)")
# nvm (this script runs in bash, which does not load zsh's nvm): newest installed version first
if [ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]; then
  while IFS= read -r n; do CANDIDATES+=("$n"); done < <(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node 2>/dev/null | sort -rV)
fi
CANDIDATES+=(/opt/homebrew/bin/node /usr/local/bin/node)
for c in "${CANDIDATES[@]}"; do
  if node_ok "$c"; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || die "No node >= 18 found. Install one (nvm install 24) or set PORTBOARD_NODE=/path/to/node."
case "$NODE" in *" "*) die "node path has a space, which a shebang cannot hold: $NODE (set PORTBOARD_NODE)";; esac
ok "$NODE ($("$NODE" --version </dev/null))"

echo "3) plugin files"
mkdir -p "$SUPPORT"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ -f "$HERE/../menubar/portboard.30s.mjs" ] && [ -f "$HERE/../menubar/format.mjs" ]; then
  cp "$HERE/../menubar/portboard.30s.mjs" "$HERE/../menubar/format.mjs" "$TMP/"
  ok "from the checkout at $(cd "$HERE/.." && pwd)"
else
  [ -n "$REMOTE" ] || die "Which server? bash $0 <user>@<host>.<tailnet>.ts.net (or set PORTBOARD_REMOTE)"
  scp -q "${SSH_OPTS[@]}" "$REMOTE:$REMOTE_DIR/portboard.30s.mjs" "$REMOTE:$REMOTE_DIR/format.mjs" "$TMP/" </dev/null \
    || die "scp from $REMOTE:$REMOTE_DIR failed. Check Tailscale and that 'ssh $REMOTE' works without a password."
  ok "from $REMOTE:$REMOTE_DIR"
fi
{ printf '#!%s\n' "$NODE"; tail -n +2 "$TMP/portboard.30s.mjs"; } > "$SUPPORT/portboard.mjs"
# The dashboard address: PORTBOARD_URL, else https://<host of the ssh target>:8443 (tailscale serve in docs/setup.md)
URL="${PORTBOARD_URL:-}"
if [ -z "$URL" ] && [ -n "$REMOTE" ]; then URL="https://${REMOTE#*@}:8443"; fi
case "$URL" in ''|https://*|http://*) ;; *) die "PORTBOARD_URL must start with https:// (got $URL)";; esac
case "$URL" in *'"'*|*'|'*|*\\*) die "PORTBOARD_URL has a character it cannot hold: $URL";; esac
if [ -n "$URL" ]; then
  sed "s|^export const DEFAULT_BASE = .*|export const DEFAULT_BASE = \"$URL\";|" "$TMP/format.mjs" > "$SUPPORT/format.mjs"
  ok "dashboard: $URL"
else
  cp "$TMP/format.mjs" "$SUPPORT/format.mjs"
  warn "no dashboard address (set PORTBOARD_URL or pass the ssh target); the plugin shows the placeholder until then"
fi
chmod 755 "$SUPPORT/portboard.mjs"
chmod 644 "$SUPPORT/format.mjs"
ok "installed in $SUPPORT"

echo "4) SwiftBar plugin folder"
PLUGIN_DIR=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null </dev/null || true)
if [ -z "$PLUGIN_DIR" ]; then
  PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
  mkdir -p "$PLUGIN_DIR"
  defaults write com.ameba.SwiftBar PluginDirectory "$PLUGIN_DIR"
  warn "SwiftBar had no plugin folder yet; set it to $PLUGIN_DIR"
fi
PLUGIN_DIR="${PLUGIN_DIR/#\~/$HOME}"
mkdir -p "$PLUGIN_DIR"
# an older install with another interval would run twice
find "$PLUGIN_DIR" -maxdepth 1 -name 'portboard.*.mjs' ! -name "portboard.$INTERVAL.mjs" -print -delete | sed 's/^/    removed /'
ln -sfn "$SUPPORT/portboard.mjs" "$PLUGIN_DIR/portboard.$INTERVAL.mjs"
ok "$PLUGIN_DIR/portboard.$INTERVAL.mjs → $SUPPORT/portboard.mjs"

echo "5) dry run with SwiftBar's bare environment"
OUT=$(env -i HOME="$HOME" PATH=/usr/bin:/bin "$PLUGIN_DIR/portboard.$INTERVAL.mjs" </dev/null 2>&1 || true)
TITLE=$(printf '%s\n' "$OUT" | head -1)
case "$TITLE" in
  "⇄ "*) ok "title: ${TITLE%% |*}" ;;
  "portboard ⚠"*) warn "plugin runs, but portboard is not reachable: $(printf '%s\n' "$OUT" | sed -n 3p | sed 's/ |.*//')" ;;
  *) printf '%s\n' "$OUT" | head -5 >&2; die "the plugin did not print a menu" ;;
esac

echo "6) refresh SwiftBar"
if pgrep -x SwiftBar >/dev/null; then
  open -g "swiftbar://refreshallplugins" </dev/null && ok "asked SwiftBar to reload plugins"
else
  open -a "$SWIFTBAR_APP" </dev/null && ok "started SwiftBar"
fi

echo
echo "Done. Look for '⇄ n' in the menu bar. To remove: rm \"$PLUGIN_DIR/portboard.$INTERVAL.mjs\"; rm -r \"$SUPPORT\""

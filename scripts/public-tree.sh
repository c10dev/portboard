#!/bin/bash
# Builds the public tree of Portboard: a commit's files without the paths in scripts/public-exclude.txt, then scans it
# (scripts/public-scan.mjs, plus gitleaks when docker can run it) and, with --test, runs `npm ci && npm test` on a
# fresh clone of it in a clean node container. Nothing is pushed or published.
#
#   scripts/public-tree.sh [--out DIR] [--rev REV] [--denylist FILE] [--test] [--no-gitleaks]
#
#   --out DIR        where to put the tree (must not exist or be empty; default: a new temp dir, printed at the end)
#   --rev REV        the commit to export (default HEAD; uncommitted changes are never included)
#   --denylist FILE  patterns that must not appear (default private/denylist.txt when it exists)
#   --test           also run npm ci, typecheck and npm test on a fresh git clone of the tree in node:24 (docker)
#   --no-gitleaks    skip the gitleaks scan
#
# Exit status: 0 when the tree is clean (and the tests pass with --test), 1 otherwise.
set -euo pipefail

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="" REV="HEAD" DENY="" TEST=0 GITLEAKS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    --denylist) DENY="$2"; shift 2 ;;
    --test) TEST=1; shift ;;
    --no-gitleaks) GITLEAKS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -z "$DENY" ] && [ -f "$ROOT/private/denylist.txt" ] && DENY="$ROOT/private/denylist.txt"
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/portboard-public.XXXXXX")"
elif [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "$OUT is not empty" >&2
  exit 2
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
COMMIT="$(git -C "$ROOT" rev-parse --verify "$REV^{commit}")"

echo "▸ export ${COMMIT:0:12} → $OUT"
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$OUT"
# The exclude list as it is in that commit
removed=0
while IFS= read -r line; do
  line="${line%%#*}"; line="$(printf '%s' "$line" | sed 's/[[:space:]]*$//')"
  [ -z "$line" ] && continue
  case "$line" in /*|*..*) echo "refusing exclude line: $line" >&2; exit 2 ;; esac
  # globs expand inside the tree only; a line that matches nothing is fine
  for p in $(cd "$OUT" && shopt -s nullglob && echo ${line%/}); do
    rm -rf -- "${OUT:?}/$p"
    removed=$((removed + 1))
  done
done < <(git -C "$ROOT" show "$COMMIT:scripts/public-exclude.txt")
echo "  $(find "$OUT" -type f | wc -l | tr -d ' ') files, $removed excluded paths removed"

status=0
echo "▸ scan (scripts/public-scan.mjs${DENY:+, denylist $DENY})"
if ! node "$ROOT/scripts/public-scan.mjs" "$OUT" ${DENY:+--denylist "$DENY"}; then status=1; fi

if [ "$GITLEAKS" = 1 ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "▸ gitleaks"
    if ! docker run --rm -v "$OUT:/scan:ro" zricethezav/gitleaks:v8.28.0 dir /scan --no-banner --redact --exit-code 1; then status=1; fi
  else
    echo "▸ gitleaks skipped (no docker)"
  fi
fi

if [ "$TEST" = 1 ]; then
  echo "▸ fresh clone → npm ci, typecheck, npm test (node:24-bookworm-slim)"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/portboard-public-test.XXXXXX")"
  cp -a "$OUT/." "$WORK/src"
  git -C "$WORK/src" init -q -b main
  git -C "$WORK/src" -c user.name=public-tree -c user.email=public-tree@example.com add -A
  git -C "$WORK/src" -c user.name=public-tree -c user.email=public-tree@example.com -c commit.gpgsign=false commit -q -m "Public tree of ${COMMIT:0:12}"
  if ! docker run --rm -v "$WORK/src:/src:ro" node:24-bookworm-slim sh -euc '
      apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
      git config --global --add safe.directory "*"
      git clone -q /src /w/portboard
      cd /w/portboard
      npm ci --no-audit --no-fund
      npm run typecheck
      npm test > /tmp/test.log 2>&1 || { tail -n 60 /tmp/test.log; exit 1; }
      tail -n 9 /tmp/test.log'; then
    status=1
  fi
  rm -rf "$WORK"
fi

if [ "$status" = 0 ]; then echo "✔ public tree clean: $OUT"; else echo "✘ public tree has findings: $OUT" >&2; fi
exit "$status"

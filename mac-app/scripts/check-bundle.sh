#!/bin/bash
# Checks what Portboard.app asks macOS for, so a release can't quietly gain more (the Orca review: entitlements on
# every binary, ATS turned off). Run on the Mac after signing.
#
#   scripts/check-bundle.sh build/Portboard.app              → no entitlements, no NSAppTransportSecurity in Info.plist
#   scripts/check-bundle.sh --release build/Portboard.app    … and signed with the hardened runtime by a Developer ID
#
# No sandbox and no entitlements is on purpose: outside the App Sandbox the app needs no network entitlement for the
# dashboard or the update check (https://api.github.com), and the ATS defaults allow both because they are https.
set -euo pipefail

RELEASE=0
APP=""
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) APP="$arg" ;;
  esac
done
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "Usage: $0 [--release] path/to/Portboard.app" >&2
  exit 2
fi

FAIL=0
fail() { echo "✗ $*" >&2; FAIL=1; }

# Every Mach-O in the bundle, not just the main executable
while IFS= read -r -d '' file; do
  file -b "$file" | grep -q 'Mach-O' || continue
  ents="$(codesign -d --entitlements - --xml "$file" 2>/dev/null || true)"
  if grep -q '<key>' <<<"$ents"; then
    fail "entitlements on ${file#"$APP"/}: $(grep -o '<key>[^<]*</key>' <<<"$ents" | sed 's/<[^>]*>//g' | tr '\n' ' ')"
  fi
done < <(find "$APP" -type f -perm -u+x -print0)

PLIST="$APP/Contents/Info.plist"
if plutil -extract NSAppTransportSecurity xml1 -o - "$PLIST" >/dev/null 2>&1; then
  fail "Info.plist has NSAppTransportSecurity (ATS must stay at the defaults)"
fi

if [[ "$RELEASE" == 1 ]]; then
  info="$(codesign -dvvv "$APP" 2>&1)"
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$info" || fail "not signed with the hardened runtime"
  grep -q '^Authority=Developer ID Application:' <<<"$info" || fail "not signed by a Developer ID Application certificate"
  grep -q '^Timestamp=' <<<"$info" || fail "the signature has no secure timestamp"
fi

if [[ "$FAIL" == 1 ]]; then exit 1; fi
echo "✓ $APP: no entitlements, ATS at the defaults$([[ "$RELEASE" == 1 ]] && echo ", hardened runtime, Developer ID, timestamp")"

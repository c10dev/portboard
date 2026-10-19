#!/bin/bash
# Builds Portboard.app from this Swift package. Run it on the Mac (macOS 14+), with the Command Line Tools
# (`xcode-select --install`) or Xcode. No Xcode project: `swift build`, then the bundle is put together here.
#
#   ./build.sh              → mac-app/build/Portboard.app
#   ./build.sh --install    … and copy it to /Applications (quits a running Portboard first), then open it
#
# The version comes from ../package.json (PORTBOARD_VERSION overrides it, 0.0.0 when neither is there).
# The app is signed ad hoc (codesign --sign -): fine for this Mac, not for handing to other people.
#
# Your server and bundle id: PORTBOARD_SERVER_URL (the dashboard, e.g. https://<host>.<tailnet>.ts.net:8443) and
# PORTBOARD_BUNDLE_ID, from the environment or from mac-app/build.env (KEY=value lines, not in the public tree).
# Without a server address the app starts at a placeholder and asks in 설정.
set -euo pipefail

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "모르는 옵션: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "macOS에서 실행하세요 (이 스크립트는 Portboard.app을 만들어요)" >&2
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "swift가 없어요. Command Line Tools를 설치하세요: xcode-select --install" >&2
  exit 1
fi

VERSION="${PORTBOARD_VERSION:-}"
if [[ -z "$VERSION" && -f ../package.json ]]; then
  VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' ../package.json | head -n 1)"
fi
VERSION="${VERSION:-0.0.0}"
BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || date +%Y%m%d%H%M)"
# build.env: this install's server and bundle id; the environment wins
if [[ -f build.env ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      PORTBOARD_SERVER_URL|PORTBOARD_BUNDLE_ID) [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' build.env)
fi
BUNDLE_ID="${PORTBOARD_BUNDLE_ID:-io.github.c10dev.portboard}"
SERVER_URL="${PORTBOARD_SERVER_URL:-}"
if [[ ! "$BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "PORTBOARD_BUNDLE_ID는 영문·숫자·.·- 만 돼요: $BUNDLE_ID" >&2; exit 2; fi
if [[ -n "$SERVER_URL" && ! "$SERVER_URL" =~ ^https?://[A-Za-z0-9.:-]+/?$ ]]; then echo "PORTBOARD_SERVER_URL이 주소가 아니에요: $SERVER_URL" >&2; exit 2; fi
APP="build/Portboard.app"

echo "▸ swift build -c release (Portboard ${VERSION}, build ${BUILD_NUMBER}, ${BUNDLE_ID}, server ${SERVER_URL:-not set})"
swift build -c release --product Portboard
BIN_DIR="$(swift build -c release --show-bin-path)"

echo "▸ ${APP}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Portboard" "$APP/Contents/MacOS/Portboard"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# App icon: Resources/AppIcon.png (rendered from public/icon.svg by scripts/render-icon.py) → AppIcon.icns
ICON_KEY=""
if [[ -f Resources/AppIcon.png ]] && command -v iconutil >/dev/null 2>&1; then
  WORK="$(mktemp -d)"
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"; then
    ICON_KEY="<key>CFBundleIconFile</key><string>AppIcon</string>"
  else
    echo "  (아이콘을 만들지 못했어요: 기본 아이콘으로 계속해요)" >&2
  fi
  rm -rf "$WORK"
fi

# NSAppTransportSecurity is left at the defaults: the dashboard is https (tailscale serve).
SERVER_KEY=""
[[ -n "$SERVER_URL" ]] && SERVER_KEY="<key>PortboardServerURL</key><string>${SERVER_URL}</string>"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleExecutable</key><string>Portboard</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Portboard</string>
  <key>CFBundleDisplayName</key><string>Portboard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  ${ICON_KEY}
  ${SERVER_KEY}
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "▸ codesign --sign - (ad hoc)"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

if [[ "$INSTALL" == 1 ]]; then
  echo "▸ /Applications/Portboard.app"
  osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  sleep 1
  rm -rf /Applications/Portboard.app
  ditto "$APP" /Applications/Portboard.app
  open /Applications/Portboard.app
  echo "✓ 설치하고 열었어요: /Applications/Portboard.app"
else
  echo "✓ $(pwd)/${APP}"
  echo "  열기: open \"$(pwd)/${APP}\"   ·   /Applications에 설치: ./build.sh --install"
fi

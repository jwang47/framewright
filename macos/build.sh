#!/bin/sh
# Build Framewright.app: a native macOS window around the local server.
#
#   macos/build.sh                # -> dist/Framewright.app
#   macos/build.sh --install      # also copy it to /Applications
#
# Needs the Xcode command line tools (swiftc). The app bundles this
# checkout's framewright package and runs it with the user's Python 3.10+.
set -eu
cd "$(dirname "$0")/.."
out=dist/Framewright.app
version=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources/app"
swiftc -O -o "$out/Contents/MacOS/Framewright" macos/Framewright.swift \
  -framework AppKit -framework WebKit -framework UserNotifications 2>&1 | grep -v "^$" || true
test -x "$out/Contents/MacOS/Framewright"

# The Python package, without caches.
rsync -a --exclude '__pycache__' --exclude '*.pyc' framewright "$out/Contents/Resources/app/"

swift macos/icon.swift "$tmp/Framewright.iconset" >/dev/null
iconutil -c icns "$tmp/Framewright.iconset" -o "$out/Contents/Resources/Framewright.icns"

cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Framewright</string>
  <key>CFBundleDisplayName</key><string>Framewright</string>
  <key>CFBundleIdentifier</key><string>app.framewright.mac</string>
  <key>CFBundleExecutable</key><string>Framewright</string>
  <key>CFBundleIconFile</key><string>Framewright</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version:-0.0.0}</string>
  <key>CFBundleVersion</key><string>${version:-0.0.0}</string>
  <key>LSMinimumSystemVersion</key><string>13.3</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.photography</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSRemovableVolumesUsageDescription</key><string>Framewright imports photos and videos from camera cards.</string>
</dict></plist>
PLIST

codesign --force --deep --sign - "$out" >/dev/null 2>&1 || echo "warning: ad-hoc signing failed" >&2
echo "built $out"

if [ "${1:-}" = "--install" ]; then
  rm -rf /Applications/Framewright.app
  cp -R "$out" /Applications/
  echo "installed /Applications/Framewright.app"
fi

#!/usr/bin/env bash
# Build HiFi Buddy.app for macOS (universal2: arm64 + x86_64).
#
# Usage:
#   pip3 install -r requirements-build.txt   # one-time
#   ./build-mac.sh                            # produces dist/HiFi Buddy.app
#
# Output:
#   dist/HiFi Buddy.app   ← drag-into-Applications artifact
#   build/                ← intermediate, safe to delete
#
# Notes on first-run UX:
# The .app is unsigned. macOS Gatekeeper will block opening on first
# launch — users need to right-click → Open → confirm "Open Anyway".
# This is documented in docs/BUILDING.md and in the GitHub Release notes.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pyinstaller >/dev/null 2>&1; then
  echo "pyinstaller not found. Run:  pip3 install -r requirements-build.txt" >&2
  exit 1
fi

# Regenerate the app icon from the brand soundwave so we never ship the
# default Python placeholder. The script is idempotent — overwrites
# assets/icon.icns each time so source-of-truth changes (logo color,
# bar layout) flow through automatically on the next build.
#
# Prefer the local venv's Python if one exists (it has Pillow); fall
# back to system python3 otherwise. The user can override with
# PYTHON=/path/to/python ./build-mac.sh.
PY="${PYTHON:-}"
if [[ -z "$PY" ]]; then
  for cand in .env/bin/python venv/bin/python .venv/bin/python python3; do
    if [[ -x "$cand" ]] || command -v "$cand" >/dev/null 2>&1; then
      PY="$cand"; break
    fi
  done
fi
echo "Generating assets/icon.icns from the brand soundwave (using $PY)…"
"$PY" tools/make-icon.py

# Clean previous output so stale code can't sneak into the bundle.
rm -rf build/ dist/

# Bundle everything the runtime needs as data:
#   - index.html, styles.css, manifest.json, service-worker.js → SPA entry
#   - js/, data/, assets/, docs/ → app + lessons + screenshots
#   - server.py is auto-bundled because launcher.py imports it
# We deliberately don't bundle ffmpeg/ffprobe — users on a Mac without
# Homebrew ffmpeg get a graceful "ffprobe not installed" toast and can
# install via the docs link. Bundling adds ~80 MB; we'll add it later
# if user feedback demands.

# --target-architecture: omitted on purpose. Universal2 builds require
# every bundled native dependency (Pillow, etc.) to be a fat binary, and
# pip will install single-arch wheels matching the host Python. Building
# for the current arch only is the path of least friction; if you need
# Intel coverage, set up a universal2 Python install or build twice and
# `lipo` the binaries together.
#  --collect-all=pystray, PIL, AppKit, objc:
#    PyInstaller's static analysis misses pystray's lazy backend imports
#    (pystray._darwin -> AppKit -> objc) on macOS. Without these flags the
#    bundled app starts the server fine but renders no menu-bar icon.
pyinstaller \
  --noconfirm \
  --windowed \
  --name "HiFi Buddy" \
  --osx-bundle-identifier "net.hifibuddy.app" \
  --icon "assets/icon.icns" \
  --collect-all=pystray \
  --collect-all=PIL \
  --collect-all=AppKit \
  --collect-all=objc \
  --hidden-import=pystray._darwin \
  --hidden-import=pystray._base \
  --add-data "index.html:." \
  --add-data "styles.css:." \
  --add-data "manifest.json:." \
  --add-data "service-worker.js:." \
  --add-data "server.py:." \
  --add-data "js:js" \
  --add-data "data:data" \
  --add-data "assets:assets" \
  --add-data "docs:docs" \
  launcher.py

if [[ ! -d "dist/HiFi Buddy.app" ]]; then
  echo "❌ Build failed — dist/HiFi Buddy.app was not produced." >&2
  exit 1
fi

# Make the app menu-bar-only — no Dock icon, no app-switcher entry. This
# matches utilities like Bartender or iStat Menus, which is the right
# model for an "always-on background server with a tray menu". Without
# LSUIElement, macOS shows a generic Python rocket in the Dock.
PLIST="dist/HiFi Buddy.app/Contents/Info.plist"
if [[ -f "$PLIST" ]]; then
  /usr/libexec/PlistBuddy -c "Delete :LSUIElement"           "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add    :LSUIElement bool true" "$PLIST"
fi

echo ""
echo "✅ Built: dist/HiFi Buddy.app"

# Optionally produce a .dmg for distribution. Skipped if BUILD_DMG=0,
# which is useful during dev iteration (the .dmg adds ~5-10 sec).
if [[ "${BUILD_DMG:-1}" != "0" ]]; then
  DMG_PATH="dist/HiFi Buddy.dmg"
  rm -f "$DMG_PATH"
  # UDZO = compressed read-only. Smaller download, slightly slower mount.
  # The Applications symlink lets users drag-to-install from the mounted
  # volume without leaving Finder.
  STAGING=$(mktemp -d -t hifibuddy-dmg)
  cp -R "dist/HiFi Buddy.app" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create \
    -volname 'HiFi Buddy' \
    -srcfolder "$STAGING" \
    -ov -format UDZO \
    "$DMG_PATH" >/dev/null
  rm -rf "$STAGING"
  echo "✅ Built: $DMG_PATH ($(du -h "$DMG_PATH" | cut -f1))"
fi

echo ""
echo "Test with:"
echo "    open 'dist/HiFi Buddy.app'"
echo ""
echo "Or try the .dmg:"
echo "    open 'dist/HiFi Buddy.dmg'"
echo "    # then drag the app into /Applications"
echo ""
echo "First launch on macOS Gatekeeper-enabled systems requires:"
echo "    right-click → Open → confirm 'Open Anyway'"
echo "(the app is unsigned)"

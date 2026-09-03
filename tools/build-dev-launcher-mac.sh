#!/bin/bash
# Builds a real macOS .app that launches this repo's `npm run dev` from the
# Dock — for whoever's iterating on munder-difflin itself and wants a
# one-click way back in, instead of retyping the command in a terminal every
# time. macOS only (Dock icons and .app bundles are a macOS concept).
#
# Usage:
#   tools/build-dev-launcher-mac.sh
#   → build/dev-launcher/Munder Difflin (Dev).app
#   Drag that into /Applications (or ~/Applications) and pin it to the Dock.
#
# Re-run this after moving/re-cloning the repo — the generated app bakes in
# THIS checkout's absolute path (there is no portable way to make a fixed
# double-clickable app find "wherever the repo happens to be" on its own),
# so a copy dragged from one clone won't point at a different one.
#
# Design notes (why it's built this way, not simpler):
#   - It launches a real Terminal window running `npm run dev`, rather than
#     backgrounding the dev server invisibly. A backgrounded process died the
#     moment this script's own process exited — launching it from Finder/Dock
#     tears down the process group once the launcher "finishes", and `nohup`
#     only survives a HUP, not that. Terminal gives the dev server (and the
#     HMR/auto-rebuild supervisor it depends on) its own real session.
#   - It opens Terminal via `open -a Terminal <file>.command`, never via
#     `osascript`/AppleScript. Driving Terminal with AppleScript needs a
#     one-time Automation permission (System Settings → Privacy & Security →
#     Automation) that this script cannot grant itself and fails hard
#     without — `open -a` is the same "open this document with this app"
#     LaunchServices call a Finder double-click makes, so it needs nothing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/build/dev-launcher"
APP="$OUT_DIR/Munder Difflin (Dev).app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Munder Difflin (Dev)</string>
	<key>CFBundleDisplayName</key>
	<string>Munder Difflin (Dev)</string>
	<key>CFBundleIdentifier</key>
	<string>in.munderdiffl.app.devlauncher</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleExecutable</key>
	<string>launch</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>LSUIElement</key>
	<false/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/Resources/run-dev.command" <<CMD
#!/bin/bash
# Run the agents against a NON-DEFAULT Claude account (e.g. a company login
# kept separate from your personal one): uncomment and point at that
# account's config dir. \`CLAUDE_CONFIG_DIR\` selects which config dir — and
# therefore which credentials — the claude CLI uses, and src/main/ptyEnv.ts
# passes it through to every agent PTY on purpose while stripping the rest
# of the CLAUDE* namespace. It belongs HERE rather than in a shell profile:
# this .command is run by bash as a NON-INTERACTIVE script, so ~/.zshrc and
# ~/.bash_profile are never sourced for a Dock launch.
# export CLAUDE_CONFIG_DIR="\$HOME/.claude-<account>"
cd "$REPO_ROOT" || exit 1
npm run dev
CMD
chmod +x "$APP/Contents/Resources/run-dev.command"

cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
if pgrep -f "electron-vite dev" > /dev/null 2>&1; then
  # Already running — bring its window forward instead of starting a second
  # dev server (which would just fail to bind the same ports).
  open -a Electron > /dev/null 2>&1
  exit 0
fi

DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
open -a Terminal "$DIR/run-dev.command"
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

cp "$REPO_ROOT/build/icon.icns" "$APP/Contents/Resources/icon.icns"

# Ad-hoc signature — required for LaunchServices (Dock/Finder double-click)
# to run the bundle at all; direct execution works unsigned, but `open`
# launching it silently fails without even this minimal signing.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "Built: $APP"
echo "Drag it into /Applications (or ~/Applications) and pin it to the Dock."

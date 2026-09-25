#!/bin/sh
# Installs Webswitch for the current user: the app under ~/.local/share/webswitch/app, a launcher in
# ~/.local/bin and a desktop entry, so it shows up in the applications menu. No root needed.
# Works from a built checkout (after `npm run build`) or from the unpacked release archive.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$HERE/dist" ] || HERE="$(cd "$HERE/.." && pwd)"
[ -f "$HERE/dist/main.js" ] || { echo "dist/main.js not found: run 'npm run build' first" >&2; exit 1; }

APP="${XDG_DATA_HOME:-$HOME/.local/share}/webswitch/app"
BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
mkdir -p "$APP" "$BIN" "$APPS" "$ICONS"

rm -rf "$APP/dist"
cp -r "$HERE/dist" "$APP/dist"
printf '#!/bin/sh\nexec gjs -m "%s/dist/main.js" "$@"\n' "$APP" > "$BIN/webswitch"
chmod +x "$BIN/webswitch"
cp "$HERE/data/dev.webswitch.Webswitch.desktop" "$APPS/"
cp "$HERE/data/dev.webswitch.Webswitch.svg" "$ICONS/"
sed -i "s|^Exec=.*|Exec=$BIN/webswitch|" "$APPS/dev.webswitch.Webswitch.desktop"
echo "Installed. Start it from the applications menu, or run: $BIN/webswitch"

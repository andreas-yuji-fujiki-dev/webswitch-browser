#!/bin/sh
# Builds, serves tests/site on localhost, runs the self-test (it opens a real window) and prints the
# result. Screenshots go to $WEBSWITCH_SELFTEST_OUT (default: a fresh folder under /tmp).
set -e
cd "$(dirname "$0")/.."
npm run build >/dev/null
export WEBSWITCH_SELFTEST_OUT="${WEBSWITCH_SELFTEST_OUT:-$(mktemp -d /tmp/webswitch-selftest.XXXXXX)}"
# A private home for config and data, so the test never touches the real ones.
export XDG_CONFIG_HOME="$WEBSWITCH_SELFTEST_OUT/config" XDG_DATA_HOME="$WEBSWITCH_SELFTEST_OUT/data" XDG_CACHE_HOME="$WEBSWITCH_SELFTEST_OUT/cache"
# A stand-in for Chrome first in PATH, so the DRM hand-off can be checked without opening a window.
export PATH="$PWD/tests/fake-bin:$PATH"
# The self-test covers the app-window hand-off on native Wayland; embedded tabs need X11 and a real Chrome.
export WEBSWITCH_EMBED_DRM=0
python3 tests/serve.py &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
gjs -m dist/selftest.js
echo "screenshots: $WEBSWITCH_SELFTEST_OUT"

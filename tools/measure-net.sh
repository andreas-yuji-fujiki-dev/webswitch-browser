#!/usr/bin/env bash
# Measures every network attempt the browser makes, without letting a single packet out.
#
#   tools/measure-net.sh [seconds]      the browser open on a blank page, doing nothing
#   tools/measure-net.sh --selftest     the whole self-test scenario (tabs, pages, menu, DevTools...)
#
# The browser runs inside an empty network namespace (`unshare -Urn`): its only interface is a
# loopback plus a dummy one that holds the address /etc/resolv.conf points at. A DNS server on that
# address answers NXDOMAIN to everything and logs each name asked. `strace` records every connect()
# and send*(), so every attempt is visible and none can leave the machine. It starts from a
# clean profile, as a first run.
set -eu
cd "$(dirname "$0")/.."
MODE="idle"; SECONDS_TO_RUN=60
case "${1:-}" in --selftest) MODE="selftest" ;; "") ;; *) SECONDS_TO_RUN="$1" ;; esac

npm run build >/dev/null
WORK="$(mktemp -d)"
export XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache"
export WEBSWITCH_SELFTEST_OUT="$WORK/shots"; mkdir -p "$WEBSWITCH_SELFTEST_OUT"
# Only for this measurement: WebKit's own sandbox cannot nest inside the namespace used here.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
# Never join a browser that is already open (it would take the launch and this run would end).
export WEBSWITCH_APP_ID=dev.webswitch.Measure
: > "$WORK/dns.log"

if [ "$MODE" = "selftest" ]; then TARGET="dist/selftest.js"; LIMIT=180; else TARGET="dist/main.js"; LIMIT="$SECONDS_TO_RUN"; fi
echo "mode: $MODE   target: $TARGET   limit: ${LIMIT}s"

unshare -Urn -- sh -c '
  NS=$(grep -m1 "^nameserver" /etc/resolv.conf | cut -d" " -f2); NS="${NS:-192.168.15.1}"
  ip link set lo up && ip link add ws0 type dummy && ip addr add "$NS/24" dev ws0 && ip link set ws0 up
  python3 tools/dns-sink.py "$1/dns.log" &
  SINK=$!
  python3 tests/serve.py >/dev/null 2>&1 &
  SITE=$!
  sleep 0.5
  unshare -U --map-user='"$(id -u)"' --map-group='"$(id -g)"' -- \
    strace -f -qq -s 300 -tt -e trace=execve,connect,sendto,sendmsg,sendmmsg -o "$1/net.strace" \
    timeout "$2" gjs -m "$3"
  kill $SINK $SITE
' sh "$WORK" "$LIMIT" "$TARGET" 2>&1 | grep -E "ALL PASSED|FAILED|FAIL " || true

python3 tools/analyze-net.py "$WORK/net.strace" "$WORK/dns.log"
echo "kept: $WORK"

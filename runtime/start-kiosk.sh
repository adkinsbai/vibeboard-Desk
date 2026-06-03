#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:0}"

URL="${TAISHAN_SCREEN_URL:-http://127.0.0.1:8765/}"
LOG="${TAISHAN_SCREEN_KIOSK_LOG:-/tmp/taishan-screen-kiosk.log}"
USER_HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
XAUTHORITY="${XAUTHORITY:-$USER_HOME/.Xauthority}"
PROFILE="${TAISHAN_SCREEN_CHROMIUM_PROFILE:-$USER_HOME/.cache/taishan-screen-chromium}"
CHROMIUM_BIN="${CHROMIUM_BIN:-}"

export XAUTHORITY

mkdir -p "$PROFILE"

if [ -z "$CHROMIUM_BIN" ]; then
  if command -v chromium >/dev/null 2>&1; then
    CHROMIUM_BIN="$(command -v chromium)"
  elif command -v chromium-browser >/dev/null 2>&1; then
    CHROMIUM_BIN="$(command -v chromium-browser)"
  elif [ -x /usr/lib/chromium/chromium-wrapper ]; then
    CHROMIUM_BIN="/usr/lib/chromium/chromium-wrapper"
  elif command -v chromium-bin >/dev/null 2>&1; then
    CHROMIUM_BIN="$(command -v chromium-bin)"
  elif [ -x /usr/lib/chromium/chromium-bin ]; then
    CHROMIUM_BIN="/usr/lib/chromium/chromium-bin"
  else
    echo "[$(date -Iseconds)] Chromium executable not found" >>"$LOG"
    exit 1
  fi
fi

CHROMIUM_DIR="$(dirname "$CHROMIUM_BIN")"
export LD_LIBRARY_PATH="$CHROMIUM_DIR:$CHROMIUM_DIR/lib:${LD_LIBRARY_PATH:-}"

wait_for_x() {
  i=0
  while [ "$i" -lt 30 ]; do
    if xrandr 2>/dev/null | grep -q "current 480 x 360"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

wait_for_http() {
  i=0
  while [ "$i" -lt 30 ]; do
    if command -v curl >/dev/null 2>&1 && curl -fsS "$URL" >/dev/null 2>&1; then
      return 0
    fi
    if command -v python3 >/dev/null 2>&1 && python3 - "$URL" >/dev/null 2>&1 <<'PY'; then
import sys
import urllib.request

urllib.request.urlopen(sys.argv[1], timeout=2).read(1)
PY
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

kill_existing_chromium() {
  old_pids="$({ ps -C chromium -o pid= 2>/dev/null; ps -C chromium-bin -o pid= 2>/dev/null; } | awk 'NF { print $1 }' | sort -u)"
  if [ -n "$old_pids" ]; then
    kill $old_pids 2>/dev/null || true
    i=0
    while [ "$i" -lt 10 ]; do
      remaining="$({ ps -C chromium -o pid= 2>/dev/null; ps -C chromium-bin -o pid= 2>/dev/null; } | awk 'NF { print $1 }' | sort -u)"
      [ -z "$remaining" ] && return 0
      i=$((i + 1))
      sleep 0.5
    done
    kill -9 $remaining 2>/dev/null || true
    sleep 0.5
  fi
}

{
  echo "[$(date -Iseconds)] waiting for X 480x360"
  wait_for_x || echo "[$(date -Iseconds)] X did not report 480x360 before timeout"

  echo "[$(date -Iseconds)] waiting for $URL"
  wait_for_http || echo "[$(date -Iseconds)] local screen service did not answer before timeout"

  xset s off -dpms s noblank >/dev/null 2>&1 || true

  # Disable input method frameworks to prevent IME popup
  export XMODIFIERS="@im=none"
  export GTK_IM_MODULE="none"
  export QT_IM_MODULE="none"
  export CLUTTER_IM_MODULE="none"
  export INPUT_METHOD="none"
  # Kill any running input method daemons
  pkill -9 fcitx 2>/dev/null || true
  pkill -9 ibus-daemon 2>/dev/null || true
  pkill -9 ibus 2>/dev/null || true

  kill_existing_chromium

  echo "[$(date -Iseconds)] launching Chromium kiosk via $CHROMIUM_BIN"
  exec "$CHROMIUM_BIN" \
    --no-sandbox \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-gpu-compositing \
    --disable-accelerated-2d-canvas \
    --disable-accelerated-video-decode \
    --disable-features=UseSkiaRenderer,VizDisplayCompositor,VizHitTestSurfaceLayer \
    --use-gl=disabled \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --disable-session-crashed-bubble \
    --disable-infobars \
    --disable-translate \
    --disable-pinch \
    --hide-scrollbars \
    --overscroll-history-navigation=0 \
    --force-device-scale-factor=1 \
    --window-position=0,0 \
    --window-size=480,360 \
    --kiosk "$URL"
} >>"$LOG" 2>&1

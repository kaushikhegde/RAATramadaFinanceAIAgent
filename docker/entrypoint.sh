#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Five processes, one container, and an honest answer when any of them dies.
#
#   Xvfb        the display, drawn to memory
#   fluxbox     a window manager, so Chrome has a window and dialogs have edges
#   Chromium    on that display, debugging port open, profile on the volume
#   x11vnc      serves the display, bound to 127.0.0.1 INSIDE the container
#   websockify  wraps that in WebSocket + noVNC for a browser tab
#   node        the app
#
# ── Why not supervisord ──────────────────────────────────────────────────────
#
# Because the useful behaviour here is the opposite of what a supervisor does.
# If Chrome dies, this container is no longer able to do the one thing it
# exists for, and quietly restarting it would hand back a browser nobody is
# signed into — a run would then sit waiting for a login against a window that
# was never there. So: any of these exiting takes the container down, Docker's
# own restart policy decides what happens next, and the log says which one went
# and what it said.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

log() { printf '  %s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

NAMES=()
PIDS=()

start() {
  local name="$1"; shift
  "$@" &
  local pid=$!
  NAMES+=("$name")
  PIDS+=("$pid")
  log "$name started (pid $pid)"
}

# SIGTERM from `docker stop` has to reach all of them, or the container takes
# the full ten seconds and is killed instead of stopping.
shutdown() {
  log "stopping…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

mkdir -p "$CHROME_PROFILE" /data/uploads

log "display  $DISPLAY at $SCREEN"
start Xvfb Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp

# WAIT for the display, do not sleep at it. A fixed sleep is either too short on
# a cold start — Chrome then exits with "cannot open display" and takes the
# container with it — or wasted on every start after that.
for i in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  if [ "$i" = 50 ]; then log "the display never came up"; exit 1; fi
  sleep 0.2
done
log "display ready"

# Fluxbox's config has to be written HERE, not baked into the image: HOME is
# /data, /data is a volume, and anything the build put there is hidden the
# moment the volume mounts over it.
#
# The root command paints the background the brand indigo. It is NOT what stops
# fbsetbg opening its "I can't find an app to set the wallpaper with" xmessage —
# that was tested and it does not; feh being installed is what does. The toolbar
# goes because there is one window here and nothing to switch to.
#
# The colour is written rgb:13/00/64 rather than #130064 on purpose: `#` starts
# a comment in this file, so the hex form silently loses its value and the root
# window comes up the default grey weave.
mkdir -p "$HOME/.fluxbox"
if [ ! -f "$HOME/.fluxbox/init" ]; then
  cat > "$HOME/.fluxbox/init" <<'FLUXBOX'
session.screen0.rootCommand: xsetroot -solid rgb:13/00/64
session.screen0.toolbar.visible: false
session.screen0.workspaces: 1
session.screen0.fullMaximization: true
FLUXBOX
  log "wrote a fluxbox config"
fi
start fluxbox fluxbox

# ── Chromium ─────────────────────────────────────────────────────────────────
# --no-sandbox: the Chrome sandbox needs kernel privileges a default container
#   does not have. The alternative is --cap-add=SYS_ADMIN, which hands the
#   container far more than it takes away. This browser talks to one host,
#   Tramada, and nothing else.
# --disable-dev-shm-usage: /dev/shm is 64MB by default and Chrome will use more
#   than that on a page of 4,000 statement rows. compose also raises shm_size;
#   this is the belt to that's braces, for `docker run` without one.
# --test-type: hides the yellow "you are using an unsupported command-line flag"
#   bar. It is about --no-sandbox, which is above and deliberate, and it sits
#   across the top of the page somebody is signing into.
# The login page is opened on purpose, so the window a person is looking at is
# already the one they need to sign into.
TRAMADA_URL="${TRAMADA_URL:-https://asp.tramada.com.au/ttms/raatravelsandbox}"
start Chromium chromium \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$CHROME_PROFILE" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --test-type \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --window-position=0,0 \
  --window-size=1600,1000 \
  "${TRAMADA_URL%/}/login.htm"

# ── the screen ───────────────────────────────────────────────────────────────
# -localhost binds x11vnc to 127.0.0.1 inside the container, so the only thing
# that can reach it is websockify beside it. -nopw was asked for; the container
# port is published to the host's loopback only, which is what keeps it shut.
start x11vnc x11vnc \
  -display "$DISPLAY" \
  -rfbport "$VNC_PORT" \
  -localhost \
  -forever \
  -shared \
  -nopw \
  -quiet

start noVNC websockify \
  --web /usr/share/novnc \
  "0.0.0.0:$NOVNC_PORT" \
  "127.0.0.1:$VNC_PORT"

start app node server.js

log ""
log "app     http://127.0.0.1:${PORT}"
log "screen  http://127.0.0.1:${NOVNC_PORT}/vnc.html   ← sign into Tramada here"
log ""

# `wait -n` returns as soon as ANY child exits. Which one it was is worked out
# by asking, rather than assumed from the exit code — the code alone cannot say
# whether the browser went or the app did, and that is the whole message.
while true; do
  wait -n || true
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      log "${NAMES[$i]} exited — stopping the container so it is restarted whole."
      shutdown_code=1
      for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
      wait 2>/dev/null || true
      exit "$shutdown_code"
    fi
  done
done

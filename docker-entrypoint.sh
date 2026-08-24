#!/bin/bash
# Bring up the six processes a self-contained run needs, then supervise them.
#
#   Xvfb        virtual screen :99
#   fluxbox     a window manager for it
#   chromium    headful, on the Tramada login page, CDP on 127.0.0.1:9222
#   x11vnc      exposes screen :99 over VNC on loopback :5900
#   websockify  serves that VNC as a web page on :6080 (noVNC)
#   node        the reconciliation server on :3000
#
# The rule that shapes this file: if ANY of them dies the container stops and
# says which one (CLAUDE.md README). Restarting a dead Chromium on its own would
# hand back a browser nobody is signed into, and a run would then sit forever
# waiting for a login against a window that was never there.
set -u

DISPLAY_NUM="${DISPLAY:-:99}"
SCREEN="${VNC_SCREEN:-1440x900x24}"
CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium}"
STORE_DIR="${RECON_STORE_DIR:-/data}"
CDP_PORT="${CDP_PORT:-9222}"
export DISPLAY="$DISPLAY_NUM"

# Where TO open for the login. Derived from TRAMADA_URL so it always matches the
# instance the run drives — a login typed into the wrong portal is no login.
TRAMADA_URL="${TRAMADA_URL:-https://asp.tramada.com.au/ttms/raatravelsandbox}"
TRAMADA_LOGIN="${TRAMADA_URL%/}/login.htm"

log() { echo "[entrypoint] $*"; }

# name -> pid, so a death can be named, not just detected.
declare -A PID

start() {  # start <name> <cmd...>
  local name="$1"; shift
  "$@" &
  PID["$name"]=$!
  log "started $name (pid ${PID[$name]})"
}

cleanup() {
  log "stopping all processes"
  for n in "${!PID[@]}"; do kill "${PID[$n]}" 2>/dev/null; done
}
trap 'cleanup; exit 143' TERM INT

mkdir -p "$STORE_DIR/chrome-profile"

# Clear stale singleton locks. A chromium killed with the container (it never
# shuts down cleanly — the supervisor SIGTERMs it) leaves SingletonLock etc.
# pointing at the OLD container's hostname. Next run the hostname is different,
# so chromium reads the lock as "profile in use on another machine" and exits on
# startup — which stopped the container on the second `up`. Nothing else ever
# uses this profile and the container just started, so any lock here is stale.
rm -f "$STORE_DIR"/chrome-profile/Singleton*

# 1) virtual screen
start Xvfb Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -nolisten tcp
for i in $(seq 1 40); do
  xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && break
  sleep 0.25
done

# 2) window manager
start fluxbox fluxbox

# 3) the browser. --no-sandbox because it runs as root in the container;
# --disable-dev-shm-usage because the default /dev/shm is tiny and Chromium
# crashes tabs without it (compose also bumps shm_size). Loopback CDP only.
start chromium "$CHROMIUM_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$STORE_DIR/chrome-profile" \
  --window-position=0,0 \
  --start-maximized \
  "$TRAMADA_LOGIN"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done

# 4) VNC server for the screen — loopback only, no password. The loopback bind
# is what keeps it shut; the port is never published outside the container.
# No -bg: x11vnc must stay in the foreground so the supervisor can watch its pid
# (-bg would daemonize and the pid we tracked would exit immediately — which is
# exactly the false "x11vnc exited" that stopped the container on the first run).
# No -quiet either: this process dying takes the container with it, so its
# startup errors belong in the logs, not suppressed.
start x11vnc x11vnc -display "$DISPLAY_NUM" -forever -shared -nopw \
  -rfbport 5900 -localhost

# 5) noVNC: the VNC screen as a web page on :6080
start novnc websockify --web=/usr/share/novnc 6080 localhost:5900

# 6) the server
start node node server.js

log "READY  →  app http://127.0.0.1:3000   |   login screen http://127.0.0.1:6080/vnc.html"
log "Open the login screen, sign into Tramada by hand, then start a run in the app."

# Supervise. First death wins: name it, take the rest down, exit non-zero so the
# container stops rather than limping on with a browser nobody can reach.
while true; do
  for n in "${!PID[@]}"; do
    if ! kill -0 "${PID[$n]}" 2>/dev/null; then
      log "process '$n' exited — stopping container"
      cleanup
      exit 1
    fi
  done
  sleep 2
done

#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Does this thing actually run in Docker?
#
#   ./docker/smoke.sh            build, start, check, leave it running
#   ./docker/smoke.sh --down     the same, then stop and remove the container
#
# Eleven checks, each one a thing that has actually gone wrong somewhere:
#
#   1  docker is installed and its daemon is up
#   2  the image builds                       ← the step nobody can check for you
#   3  the container starts and stays up
#   4  every one of the six processes started
#   5  the app answers on 3000
#   6  the screen answers on 6080
#   7  Chrome's debugging port is reachable INSIDE the container
#   8  ...and is NOT reachable from the host
#   9  the VNC server is bound to the container's loopback
#  10  the login screen sends no header that would blank the in-app panel
#  11  NOVNC_PORT is set, so the app knows the login screen exists
#
# It does not sign into Tramada and it does not run a reconciliation. Those need
# a person, and that is the point of the noVNC screen — step 8 above is the
# reason it exists rather than exposing 9222 and driving it from outside.
#
# Nothing here deletes anything. `--down` removes the container; the recon-data
# volume, and the Tramada login inside it, are left alone.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

SERVICE=recon
NAME=raa-recon
PASS=0
FAIL=0

green() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
red()   { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info()  { printf '    %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# `docker compose` (v2, a plugin) or `docker-compose` (v1)? Both are in the
# wild and the error when you guess wrong says only "command not found".
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  DC=""
fi

head_ "1 · docker"
if ! command -v docker >/dev/null 2>&1; then
  red "docker is not installed — install Docker Desktop and open it once"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  red "docker is installed but the daemon is not running — start Docker Desktop"
  exit 1
fi
if [ -z "$DC" ]; then
  red "neither 'docker compose' nor 'docker-compose' is available"
  exit 1
fi
green "docker is up ($($DC version --short 2>/dev/null || echo "$DC"))"

head_ "2 · build"
info "first build pulls Debian packages and node modules — a few minutes"
if $DC build 2>&1 | tail -5; then
  green "the image built"
else
  red "the image did not build — the output above says why"
  exit 1
fi

head_ "3 · start"
$DC up -d >/dev/null 2>&1
sleep 5
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
  green "the container is running"
else
  red "the container is not running"
  info "logs:"
  $DC logs --tail 30 "$SERVICE" 2>&1 | sed 's/^/      /'
  exit 1
fi

# The app is the last of the six to start, so waiting for it to answer is
# waiting for all of them. Polled rather than slept at: a cold start pulls
# nothing but still has to bring up a display, a window manager and Chrome.
head_ "4 · the six processes"
for i in $(seq 1 60); do
  if docker exec "$NAME" curl -fsS http://127.0.0.1:3000/api/overview >/dev/null 2>&1; then break; fi
  sleep 2
done
LOG=$($DC logs "$SERVICE" 2>&1)
# The entrypoint logs "started <name>" per process; match that, not "<name>
# started". Names are exactly what docker-entrypoint.sh passes to start().
for p in Xvfb fluxbox chromium x11vnc novnc node; do
  if grep -q "started $p" <<<"$LOG"; then green "$p started"; else red "$p never started"; fi
done
# READY is logged only after all six are up, so it standing in for "the display
# and everything on it came up" is exact, not a proxy.
if grep -q "READY" <<<"$LOG"; then
  green "the stack reached READY (all six up)"
else
  red "the stack never reached READY"
fi
# The entrypoint takes the container down if any child exits, so this line
# appearing at all means something died and the rest is noise.
if grep -q "exited — stopping container" <<<"$LOG"; then
  red "one of them exited:"
  grep "exited — stopping" <<<"$LOG" | sed 's/^/      /'
fi

head_ "5 · the app"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/ 2>/dev/null)
if [ "$CODE" = "200" ]; then green "http://127.0.0.1:3000 → 200"; else red "http://127.0.0.1:3000 → ${CODE:-no answer}"; fi

head_ "6 · the screen"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:6080/vnc.html 2>/dev/null)
if [ "$CODE" = "200" ]; then green "http://127.0.0.1:6080/vnc.html → 200"; else red "http://127.0.0.1:6080/vnc.html → ${CODE:-no answer}"; fi

head_ "7 · Chrome, from inside"
if docker exec "$NAME" curl -fsS --max-time 5 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  VER=$(docker exec "$NAME" curl -fsS http://127.0.0.1:9222/json/version 2>/dev/null | grep -o '"Browser": *"[^"]*"' | cut -d'"' -f4)
  green "the debugging port answers inside the container (${VER:-Chrome})"
else
  red "Chrome's debugging port does not answer inside the container"
  info "a run would fail with 'Could not connect to Chrome on 127.0.0.1:9222'"
fi

head_ "8 · Chrome, from outside — this one SHOULD fail"
if curl -fsS --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  red "9222 is reachable from the host — anything local can drive a browser signed into Tramada"
  info "check that compose does not publish 9222"
else
  green "9222 is not published, as intended"
fi

head_ "9 · VNC is loopback-only inside the container"
if docker exec "$NAME" sh -c 'command -v ss >/dev/null 2>&1' 2>/dev/null; then
  BIND=$(docker exec "$NAME" ss -ltn 2>/dev/null | awk '$4 ~ /:5900$/ {print $4}')
else
  # No ss in a slim image; /proc/net/tcp is always there. 0100007F is 127.0.0.1
  # little-endian, and 170C is 5900.
  BIND=$(docker exec "$NAME" sh -c "awk '\$2 ~ /:170C\$/ {print \$2}' /proc/net/tcp" 2>/dev/null)
fi
case "$BIND" in
  *0100007F*|*127.0.0.1*) green "x11vnc is on the container's loopback (websockify is the only thing that reaches it)" ;;
  "")                     red "could not read what 5900 is bound to" ;;
  *)                      red "x11vnc is bound to $BIND, not loopback" ;;
esac

head_ "10 · the app can frame the login screen"
# The panel is a cross-origin iframe, :3000 → :6080. If websockify ever grows an
# X-Frame-Options or a frame-ancestors CSP, that iframe renders BLANK and the
# only symptom is an empty grey box where the login should be — no error, no log
# line. Cheaper to assert here than to debug there.
HDRS=$(curl -sSI --max-time 10 http://127.0.0.1:6080/vnc.html 2>/dev/null)
if grep -qi 'x-frame-options\|content-security-policy' <<<"$HDRS"; then
  red "the login screen sends a framing header — the in-app panel will be blank"
  grep -i 'x-frame-options\|content-security-policy' <<<"$HDRS" | sed 's/^/      /'
  info "fall back to opening it in a tab: the panel's \"Open in a tab\" link still works"
else
  green "no framing header — the app can show the login screen inline"
fi

head_ "11 · the server advertises the login screen"
# NOVNC_PORT is the ONLY thing that tells the page a login screen exists. Unset,
# every part of this feature silently does nothing and the run waits on a banner
# naming a port that is not published.
PORT_ENV=$(docker exec "$NAME" sh -c 'echo "$NOVNC_PORT"' 2>/dev/null | tr -d '\r')
if [ "$PORT_ENV" = "6080" ]; then
  green "NOVNC_PORT=6080 is set — the app will show the login screen itself"
else
  red "NOVNC_PORT is '${PORT_ENV:-unset}', not 6080 — the app will never show the login screen"
  info "set it in docker-compose.yml; it must match the published noVNC port"
fi

head_ "verdict"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  cat <<EOF

  It runs. What is NOT proven by any of the above:

    · that Tramada accepts a login          → open http://127.0.0.1:6080/vnc.html
                                               and sign in. The window is already
                                               on the login page.
    · that a run reconciles anything        → after signing in, upload a report on
                                               http://127.0.0.1:3000, tick DRY RUN,
                                               and start it. A dry run does
                                               everything except press Issue and
                                               Done.

  Both need a person, on purpose.
EOF
else
  printf '\n  %s logs -f %s   ← the whole story is in there\n\n' "$DC" "$SERVICE"
fi

if [ "${1:-}" = "--down" ]; then
  head_ "stopping"
  $DC down >/dev/null 2>&1 && info "container removed; the recon-data volume and its Tramada login are untouched"
fi

[ "$FAIL" -eq 0 ]

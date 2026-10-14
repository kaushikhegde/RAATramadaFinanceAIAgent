#!/usr/bin/env bash
# Who is actually answering on the app's port?
#
# Brought over from the payment assistant, where an afternoon went on reading
# /auth/login 404s as an Azure problem. They were not: a different application
# was on the port, and the app registration had been right every time.
#
#   ./tools/whats-on-the-port.sh [port]     # default APP_PORT from .env, else 3000
#
# Run it ON THE MACHINE YOU BROWSE FROM, not inside the container.
set -u
# Defaults to APP_PORT from .env beside this script, so it follows the app when
# the app moves. Override with an argument.
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FROM_ENV="$(sed -n 's/^APP_PORT=//p' "${HERE}/.env" 2>/dev/null | tail -1)"
PORT="${1:-${FROM_ENV:-3000}}"
echo "checking port ${PORT}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. What is listening on ${PORT}?"
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || echo "  nothing is listening on ${PORT}"
else
  echo "  (no lsof; trying ss)"; ss -ltnp 2>/dev/null | grep ":${PORT}" || echo "  nothing found"
fi

say "2. Which containers are up, and what did they publish?"
if command -v docker >/dev/null 2>&1; then
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' || true
  # A container that failed to bind is the case people miss: compose prints the
  # error once, it scrolls past, and the port is left to whatever else wants it.
  echo "  --- exited recently ---"
  docker ps -a --filter "status=exited" --format '  {{.Names}}\t{{.Status}}' | head -5
else
  echo "  docker not on PATH"
fi

say "3. Is it US? /api/me is this app's fingerprint."
# /api/me is served before the sign-in gate and answers with `entra` and
# `vault` fields. Anything else on the port either 404s or answers something
# that is not this shape.
BODY="$(curl -s --max-time 5 "http://localhost:${PORT}/api/me" || true)"
if [ -z "${BODY}" ]; then
  echo "  no answer — nothing is serving, or it refused the connection"
elif printf '%s' "${BODY}" | grep -q '"entra"'; then
  echo "  YES, this is the reconciliation app:"
  printf '  %s\n' "${BODY}"
  printf '%s' "${BODY}" | grep -q '"entra":true' \
    && echo "  → Entra sign-in is ON in that process." \
    || echo "  → Entra sign-in is OFF in that process: it never got AZURE_*."
else
  echo "  NO — something else is on this port. It answered:"
  printf '  %s\n' "$(printf '%s' "${BODY}" | head -c 300)"
  echo
  echo '  A body shaped {"message":...,"error":...,"statusCode":404} is NestJS.'
  echo "  This app is Express and answers /auth/login with 503 HTML when it is"
  echo "  unconfigured — never with JSON. Stop that other app, or move this one:"
  echo "    APP_PORT=3009 and AZURE_REDIRECT_URI=http://localhost:3009/auth/callback"
  echo "    (then add that exact URI to the Azure app registration)"
fi

say "4. And the sign-in route itself"
curl -s -o /dev/null -w '  /auth/login  -> HTTP %{http_code}  (%{content_type})\n' \
  --max-time 5 "http://localhost:${PORT}/auth/login" || echo "  unreachable"
echo "  Ours is 302 (to Microsoft) when configured, or 503 text/html when not."
echo "  404 application/json is somebody else's app."
echo

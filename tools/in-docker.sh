#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run a tools/ script INSIDE the raa-recon container, against the Chromium you
# signed into on the noVNC screen (http://127.0.0.1:6080/vnc.html).
#
#   tools/in-docker.sh tools/make-dvc-bookings.js --limit 1
#   tools/in-docker.sh tools/make-fixtures.js tokio
#   npm run fixtures:tokio:docker
#
# ── Why not just run it on the host ──────────────────────────────────────────
#
# On the host, the script attaches to whatever answers 127.0.0.1:9222 — the
# `npm run start:chrome` browser — which does not trust the corporate TLS root,
# so Tramada comes back ERR_CERT_AUTHORITY_INVALID on the first page.goto. The
# container's Chromium trusts it (docker/entrypoint.sh), but its 9222 is
# deliberately not published (docker-compose.yml), so the script goes to it.
#
# ── Why the copying ──────────────────────────────────────────────────────────
#
# The image holds a snapshot of the code and of tools/ and csv_uploads/ from
# build time. The created-bookings-*.json records are what make a re-run RESUME
# instead of re-booking a day already run, so running against that stale
# snapshot would make duplicate real bookings. So the host's current code,
# inputs and records go in first — which also means an edit to tramada-*.js
# runs without an image rebuild — and the results come back out even when the
# run fails: a run that dies on booking 3 has made two real ones, and the record
# of them must land on the host.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

CONTAINER="${RECON_CONTAINER:-raa-recon}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "usage: tools/in-docker.sh tools/<script>.js [args…]" >&2
  exit 2
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
  echo "  ✗ container $CONTAINER is not running — start it with: docker compose up -d" >&2
  exit 1
fi

# Code and inputs IN. node_modules stays the image's own — it was installed for
# the container's platform and the host's copy may not run there. .env stays
# out too: compose already gives the container its TRAMADA_URL and CDP_*, and
# the host .env points those at the host.
copy_in() {
  cd "$ROOT" || return 1
  local paths=()
  for p in *.js *.json tools fixtures cheat-sheets csv_uploads; do
    [ -e "$p" ] && paths+=("$p")
  done
  tar -c "${paths[@]}" | docker exec -i "$CONTAINER" tar -x -C /app
}

# Results OUT — the records, the CSVs, and Tokio's remarks. Not tools/ or the
# code wholesale: the host's copy is the one being edited, and the container's
# is just what went in a moment ago.
copy_out() {
  docker exec "$CONTAINER" sh -c '
    cd /app && tar -c csv_uploads \
      $(ls tools/created-bookings-*.json tokio-remarks.json 2>/dev/null)
  ' | tar -x -C "$ROOT"
}

copy_in || { echo "  ✗ could not copy the code and records into $CONTAINER — not running" >&2; exit 1; }

# The tools' own tunables, if set in this shell. Credentials are NOT on this
# list: the run waits for a human to sign in on the noVNC screen and never
# types them (CLAUDE.md §5).
ENVS=()
for v in DVC_CARD FIXTURE_OUTCOMES BPAY_ROWS MINT_ROWS TRAVELPAY_ROWS \
         IPSI_BANK_ACCOUNT IPSI_DIAGNOSE_DAYS IPSI_FROM_DAYS IPSI_KEEP_POPUP \
         IPSI_POPUP_TIMEOUT_MS IPSI_TOTAL_ROWS IPSI_VIABLE_ROWS TOKIO_MAX_PAGES DEBUG; do
  [ -n "${!v:-}" ] && ENVS+=(-e "$v=${!v}")
done

TTY=()
[ -t 0 ] && [ -t 1 ] && TTY=(-it)

docker exec "${TTY[@]}" "${ENVS[@]}" -w /app "$CONTAINER" node "$@"
rc=$?

copy_out || echo "  ⚠ could not copy results back — pull them with: docker cp $CONTAINER:/app/csv_uploads ./" >&2
exit $rc

# Database setup — local now, live later

The run history lives in **Postgres**. The app reads **one** setting, `DATABASE_URL`
— so moving from a local database to the live one later is a **single-line
change**, nothing in the code moves. The uploaded report bytes stay on disk
under `RECON_STORE_DIR` (`uploads/`) in every case.

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME
```

If `DATABASE_URL` is unset the server runs **in memory only** (usable, but runs
are lost on restart) and prints `⚠ no DATABASE_URL` at boot.

The 4 tables (`runs`, `run_rows`, `run_activity`, `cheat_sheets`) are created
automatically on first boot — no migration step. The database user just needs
`CREATE` on its database.

---

## Local database — pick ONE

Either option gives you a persistent local Postgres. Both end at the same URL:
`postgres://recon:recon@localhost:5432/recon`.

### Option A — Homebrew Postgres (native)

Postgres is installed via Homebrew (`postgresql@16`). Start it and create the
role + database once:

```bash
# Start it (auto-starts on login on a healthy Homebrew):
brew services start postgresql@16

# If `brew services` errors on this machine, start it directly instead
# (data dir is durable — it survives reboots; just re-run after a reboot):
pg_ctl -D /opt/homebrew/var/postgresql@16 -l /opt/homebrew/var/log/postgresql@16.log start

# One-time: create the role and database the app uses.
psql -h 127.0.0.1 -p 5432 -d postgres -c "CREATE ROLE recon LOGIN PASSWORD 'recon' CREATEDB;"
psql -h 127.0.0.1 -p 5432 -d postgres -c "CREATE DATABASE recon OWNER recon;"
```

Stop it with `brew services stop postgresql@16` (or
`pg_ctl -D /opt/homebrew/var/postgresql@16 stop`).

### Option B — Docker Postgres (isolated)

Needs the Docker daemon running. Persistent via a named volume:

```bash
docker run -d --name recon-pg \
  -e POSTGRES_USER=recon -e POSTGRES_PASSWORD=recon -e POSTGRES_DB=recon \
  -p 5432:5432 -v recon-pgdata:/var/lib/postgresql/data \
  postgres:16
```

Stop/remove with `docker stop recon-pg` (data survives) /
`docker rm recon-pg` (container only; the `recon-pgdata` volume keeps the data).

---

## Point the app at it

`DATABASE_URL` lives in `.env` (git-ignored). The host depends on **how you run
the app**:

| How you run the app | `DATABASE_URL` host |
|---|---|
| `npm start` on the host (with `npm run start:chrome`) | `localhost` |
| `docker compose up` (the bundled Chromium + VNC stack) | `host.docker.internal` |

```bash
# npm start:
DATABASE_URL=postgres://recon:recon@localhost:5432/recon

# docker compose (DB is on the host, app is in the container):
DATABASE_URL=postgres://recon:recon@host.docker.internal:5432/recon
```

For `docker compose`, set it in a `.env` **beside `docker-compose.yml`** (compose
substitutes `${DATABASE_URL}`) or export it before `docker compose up`.

Verify: open **http://localhost:3000** → **Run overview** loads (empty on a fresh
DB, no error), and `\dt` in the database shows the 4 tables.

---

## Switch to the live database (later)

Change **only** `DATABASE_URL` to the hosted Postgres and restart the app:

```bash
DATABASE_URL=postgres://USER:PASSWORD@LIVE_HOST:5432/DBNAME?sslmode=require
```

- **SSL:** hosted Postgres almost always requires it — add `?sslmode=require`.
  If you hit a self-signed / unknown-CA error, use `?sslmode=no-verify`.
- **Keep the volume:** the report bytes in `uploads/` (`RECON_STORE_DIR`) and the
  Chrome profile still live on disk — keep that volume mounted across deploys.
- **Fresh start:** the live database begins empty; the tables self-create on
  first boot, exactly like local.

Nothing else changes — the switch is this one variable.

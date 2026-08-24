# How to test the bank reconciliation app (Docker)

A step-by-step guide for running and testing the app on your own machine. No
developer tools, no Chrome setup — just Docker and a web browser.

Everything runs inside one Docker container: the app **and** a browser you sign
into. You do the Tramada login through a screen that opens in your own browser.

---

## Before you start — what you need

1. **Docker Desktop**, installed and running.
   Download: <https://www.docker.com/products/docker-desktop> (Mac, Windows, or Linux).
   After installing, open it once and wait until it says **Docker Desktop is running**.

2. **The project folder** on your machine (the one containing `docker-compose.yml`).

3. **A Tramada login** — you sign in by hand during the test, so have valid
   credentials for the Tramada instance (the **sandbox** is used by default).

4. **A sample report to upload** — a BPay or Mint report exactly as you normally
   receive it.

---

## The test — 4 steps

### 1. Start the app

Open a terminal **in the project folder** and run:

```bash
docker compose up --build
```

The first run downloads everything and takes a few minutes. Leave it running and
wait for this line to appear:

```
[entrypoint] READY  →  app http://127.0.0.1:3000   |   login screen http://127.0.0.1:6080/vnc.html
```

That line means everything is up.

### 2. Sign into Tramada

- In your browser, open **<http://127.0.0.1:6080/vnc.html>**
- Click **Connect**.
- You'll see a browser window already on the Tramada login page. **Sign in there,
  by hand**, exactly as you would normally.

> This screen *is* the browser the app drives. The app never types your password —
> a person always signs in. That is by design.

### 3. Run a reconciliation

- In another tab, open **<http://127.0.0.1:3000>** — this is the app.
- Upload your report file.
- Click **Preview**.
- Switch back to the login screen tab (`:6080`) and watch — the app drives the
  same browser you just signed into.

**Preview is safe.** It reads real bookings and shows you what it *would* file,
without filing anything.

### 4. Stop the app

When you're done, in the terminal press `Ctrl+C`, then run:

```bash
docker compose down
```

Your Tramada session and the run records are kept for next time (see below).

---

## What "it's working" looks like

- The `:6080` screen shows a real browser you can click into and log in.
- The `:3000` app loads and accepts your report upload.
- After you've signed in, a **Preview** run does **not** ask you to log in again —
  it's using the session you created.

---

## ⚠️ Important: real money

**"Start run" is not the same as "Preview."**

- **Preview** — safe. Shows what would happen. Files nothing.
- **Start run** — files **real receipts** against real bookings, and **nothing can
  be undone**.

Keep testing on the **sandbox** (the default). Only use a live Tramada instance
when you intend to file real receipts.

---

## If something doesn't work

**`docker: command not found` (some Macs).**
Docker Desktop didn't add itself to your PATH. Run this once, then retry:
```bash
export PATH="$HOME/.docker/bin:$PATH"
```

**The `:6080` screen is black or won't connect.**
Give it a few more seconds after the `READY` line, then reload the page and click
**Connect** again. The browser inside takes a moment to appear.

**The app says it's waiting for a login.**
You haven't finished signing into Tramada on the `:6080` screen yet, or the
session expired. Go back to `:6080` and sign in.

**You want to force a fresh, signed-out browser.**
```bash
docker compose run --rm recon rm -rf /data/chrome-profile
```

**You want to see the logs / which part failed.**
```bash
docker compose logs -f recon
```

**Save a copy of the run records for your files.**
```bash
docker compose cp recon:/data/runs.json ./runs.json
```

---

## What is kept between runs

Your Tramada session (the browser profile) and the run history (`runs.json`,
uploaded reports) are saved in a Docker volume called `recon-data`. They survive
`docker compose down`, so you don't sign in from scratch every time. Removing the
profile (command above) is how you deliberately start signed-out.

# Self-contained image: the server AND a browser a human can sign into.
#
# This app never types credentials (CLAUDE.md §5) — a human signs in. Inside a
# container that means the browser needs a display a person can reach, so the
# image ships a virtual X display (Xvfb), a window manager (fluxbox), a real
# Chromium, and a VNC bridge (x11vnc + noVNC) you open in your own browser to do
# the login. "Headless" here means no monitor, not no display. See
# docker-entrypoint.sh for how the six processes are supervised.
FROM node:20-slim

# chromium      — the browser the run drives (distro build, deps handled by apt)
# xvfb/fluxbox  — a virtual screen and a window manager for it
# x11vnc        — exposes that screen over VNC (loopback only)
# novnc/websockify — serves the VNC screen as a web page on :6080
# curl/x11-utils — readiness probes in the entrypoint (CDP up? X up?)
# dumb-init     — PID 1 that reaps the browser's many child processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb fluxbox x11vnc novnc websockify \
      x11-utils curl ca-certificates procps dumb-init \
      fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The playwright JS library is used only for connectOverCDP — it never launches
# a browser here (the entrypoint does), so the bundled Chromium download is dead
# weight. Skip it; we already have a distro Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# CDP_MODE=external: the server connects to the Chromium the entrypoint launched
# on loopback, and never spawns its own. The rest are container-side defaults;
# the compose file wires ports, the data volume, and TRAMADA_URL.
ENV CDP_MODE=external \
    CDP_HOST=127.0.0.1 \
    CDP_PORT=9222 \
    PORT=3000 \
    NOVNC_PORT=6080 \
    RECON_STORE_DIR=/data \
    DISPLAY=:99 \
    VNC_SCREEN=1440x900x24 \
    CHROMIUM_BIN=/usr/bin/chromium

# NOVNC_PORT is how the server knows a login screen exists at all — the page is
# told, and offers to frame it only here. Unset outside this image, where a
# local `npm start` has no such screen.
#
# 3000 = app, 6080 = noVNC login screen. 9222 (CDP) and 5900 (raw VNC) stay
# inside the container by design — anything reaching them drives a browser
# signed into a finance system.
EXPOSE 3000 6080

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]

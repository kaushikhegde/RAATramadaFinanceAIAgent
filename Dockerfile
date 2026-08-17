# ─────────────────────────────────────────────────────────────────────────────
# The reconciliation agent, its Chrome, and a screen you can reach.
#
#   docker compose up --build
#     app     http://127.0.0.1:3000
#     screen  http://127.0.0.1:6080/vnc.html     ← sign into Tramada here
#
# ── Why there is a whole desktop in here ─────────────────────────────────────
#
# The run never types Tramada credentials. It attaches over CDP to a Chrome a
# HUMAN has signed into, waits when it finds a login page, and carries on when
# the session goes warm. That rule is the reason this image is not just `node`:
# a person has to be able to reach the browser, and inside a container the only
# honest way to offer that is a real X display they can look at.
#
# So: Xvfb draws to memory, Chromium runs on that display with its debugging
# port open, x11vnc serves the display, and noVNC puts it in a browser tab.
# Nothing is headless in the "no display" sense — it is headless in the sense
# that there is no monitor, which is a different thing and the one that matters.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# chromium          the browser a run drives, and the one you sign into
# xvfb              the display it draws to; there is no monitor in a container
# x11vnc            serves that display over VNC, bound to localhost only
# novnc/websockify  turns the VNC stream into something a browser tab can show
# fluxbox           a minimal window manager. Without one Chrome has no window
#                   to maximise into and dialogs open with no decoration and no
#                   way to move them — which matters the first time Tramada
#                   pops an OTP prompt.
# x11-utils         xdpyinfo, so the entrypoint can WAIT for the display to be
#                   ready instead of sleeping a hopeful two seconds
# x11-xserver-utils xsetroot, which paints the root window the brand indigo so
#                   the screen behind Chrome is not the default grey weave
# feh               NOT for looking at pictures. Fluxbox runs fbsetbg on every
#                   start, fbsetbg hunts for a wallpaper setter, and when it
#                   finds none it opens an xmessage — "I can't find an app to
#                   set the wallpaper with" — a dialog sitting on the screen
#                   somebody is trying to sign into Tramada on. Measured, not
#                   guessed: an ~/.fluxbox/overlay with `background: none` left
#                   1 xmessage, and a runnable rootCommand left 1. Installing
#                   feh left 0. It is the smallest thing fbsetbg accepts.
# fonts-*           a container with no fonts renders Tramada as empty boxes
RUN apt-get update && apt-get install --no-install-recommends -y \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fluxbox \
      x11-utils \
      x11-xserver-utils \
      feh \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
      curl \
      procps \
 && rm -rf /var/lib/apt/lists/*

# Debian's novnc ships vnc.html but not always an index.html, so `/` 404s and
# the first thing anyone sees is a file listing. Point one at the other.
RUN if [ ! -e /usr/share/novnc/index.html ]; then \
      ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html; \
    fi

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./

# PLAYWRIGHT SKIPS ITS BROWSER DOWNLOAD, and that is not a saving — it is
# correct. A run calls `chromium.connectOverCDP`, which needs no local browser
# at all; the browser it drives is the one below, the one you sign into. A
# bundled Playwright Chromium would be a second, signed-out browser nobody ever
# looks at, and ~150MB of image for it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY . .

# Built rather than trusted: public/index.html is generated from the mockup and
# the wiring, and a stale one in the build context would ship silently.
RUN node build-recon.js

ENV PORT=3000 \
    CDP_HOST=127.0.0.1 \
    CDP_PORT=9222 \
    CDP_MODE=external \
    DISPLAY=:99 \
    SCREEN=1600x1000x24 \
    NOVNC_PORT=6080 \
    VNC_PORT=5900 \
    CHROME_PROFILE=/data/chrome-profile \
    RECON_STORE_DIR=/data \
    HOME=/data

# runs.json, uploads/ and the Chrome profile all live here. Declared so the
# image still runs without a compose file — without a volume the login and the
# run history last exactly as long as the container does.
VOLUME ["/data"]

EXPOSE 3000 6080

# The debugging port is deliberately NOT exposed. Anything that can reach it
# drives a browser signed into a finance system, and inside this container the
# app reaches it on 127.0.0.1 without any of that being published.

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/overview" > /dev/null || exit 1

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

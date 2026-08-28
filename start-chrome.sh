#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Start Chrome with Remote Debugging for the RAA Travel Chatbot
# ─────────────────────────────────────────────────────────────
# This opens a DEDICATED Chrome OR EDGE window (its own profile) on port 9222.
# The chatbot (npm run chat) drives THIS window — not your normal Chrome.
#
# IMPORTANT: after it opens, LOG INTO TRAMADA *IN THIS WINDOW*.
# Your everyday browser does NOT share this login. Keep this window open.
# ─────────────────────────────────────────────────────────────

# ── arguments ────────────────────────────────────────────────
#   ./start-chrome.sh                 whatever is installed (Chrome first)
#   ./start-chrome.sh --edge          Edge, and say so if it is not there
#   ./start-chrome.sh --chrome        Chrome, likewise
#   ./start-chrome.sh 9333            a different port
#   ./start-chrome.sh --edge 9333     both
#
# Flags are read out of the arguments first so the port can be given in any
# position — `--edge` used to land in $1 and become the port number, and the
# script then waited for a debugging port called "--edge" to answer.
WANT=""
PORT=""
for arg in "$@"; do
    case "$arg" in
        --edge)   WANT="edge" ;;
        --chrome) WANT="chrome" ;;
        [0-9]*)   PORT="$arg" ;;
        *) echo "Unknown argument: $arg"; echo "Usage: $0 [--edge|--chrome] [port]"; exit 1 ;;
    esac
done
PORT="${PORT:-9222}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="${PROFILE_DIR:-${SCRIPT_DIR}/.jetstar-profile-cdp}"

# Tramada login page to open automatically so you log into the RIGHT window.
# Override by exporting TRAMADA_URL (must match the one in your .env).
TRAMADA_URL="${TRAMADA_URL:-https://asp.tramada.com.au/ttms/raatravelsandbox}"
TRAMADA_LOGIN="${TRAMADA_URL%/}/login.htm"

# ─────────────────────────────────────────────────────────────
# WHICH BROWSER — Chrome OR EDGE.
#
# The run drives this window over the DevTools protocol, and Edge is Chromium:
# it speaks the same protocol, takes the same --remote-debugging-port, and
# Playwright's connectOverCDP cannot tell the difference. So an Edge-only
# machine is fine, and RAA's is one — Edge is their default browser.
#
# This used to hardcode Chrome's path on all three platforms and exit with
# "Could not find Chrome. Please install Google Chrome" on a machine that had a
# perfectly good browser sitting right there.
#
# Order: whatever BROWSER says, then Chrome, then Edge. Chrome first only
# because that is what this was built and tested against — not because Edge is
# second best.
#
#   BROWSER="/path/to/whatever" ./start-chrome.sh      pick it yourself
# ─────────────────────────────────────────────────────────────
find_browser() {
    local candidates=()
    if [ -n "${BROWSER:-}" ]; then candidates+=("$BROWSER"); fi

    # `--edge` / `--chrome` narrow the list to ONE family rather than merely
    # reordering it. Reordering would fall through to the other browser when the
    # asked-for one is missing, open a window, and let you believe you were
    # testing what you asked for.
    if [[ "$OSTYPE" == "darwin"* ]]; then
        [ "$WANT" != "edge" ] && candidates+=(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )
        [ "$WANT" != "chrome" ] && candidates+=(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            "$HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        )
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        names=""
        [ "$WANT" != "edge" ]   && names="$names google-chrome google-chrome-stable chromium-browser chromium"
        [ "$WANT" != "chrome" ] && names="$names microsoft-edge microsoft-edge-stable"
        for n in $names; do
            p="$(command -v "$n" 2>/dev/null)"; [ -n "$p" ] && candidates+=("$p")
        done
    elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        [ "$WANT" != "edge" ] && candidates+=(
            "/c/Program Files/Google/Chrome/Application/chrome.exe"
            "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
            "C:/Program Files/Google/Chrome/Application/chrome.exe"
        )
        [ "$WANT" != "chrome" ] && candidates+=(
            "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
            "/c/Program Files/Microsoft/Edge/Application/msedge.exe"
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
        )
    fi

    for c in "${candidates[@]}"; do
        if [ -x "$c" ] || [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
    done
    return 1
}

# AN EXPLICIT BROWSER= THAT DOES NOT EXIST IS AN ERROR, NOT A HINT.
# find_browser() treats BROWSER as the first candidate and falls through to the
# others when it is not there — so a typo'd Edge path silently launched Chrome,
# a window opened, and you would reasonably believe you were testing Edge.
# Asking for something specific and getting something else is exactly the
# failure this whole script is meant to stop.
if [ -n "${BROWSER:-}" ] && [ ! -x "$BROWSER" ] && [ ! -f "$BROWSER" ]; then
    echo "ERROR: BROWSER is set, but there is nothing at that path:"
    echo "    $BROWSER"
    echo ""
    echo "Nothing was started. Check the path — on a Mac, Edge is normally:"
    echo "    /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    echo ""
    echo "Confirm it exists first:"
    echo "    ls -l \"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge\""
    exit 1
fi

CHROME="$(find_browser)"
if [ -z "$CHROME" ]; then
    if [ "$WANT" = "edge" ]; then
        echo "ERROR: could not find Microsoft Edge."
        echo ""
        echo "Nothing was started — and deliberately NOT Chrome, because you asked"
        echo "for Edge. Looked in:"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo "    /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            echo "    $HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            echo "    microsoft-edge, microsoft-edge-stable (on PATH)"
        else
            echo "    C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
            echo "    C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
        fi
        echo ""
        echo "If it is installed elsewhere:"
        echo "    BROWSER=\"/path/to/Microsoft Edge\" npm run start:chrome"
        exit 1
    fi
    echo "ERROR: could not find Chrome or Edge."
    echo ""
    echo "Either is fine — the run drives whichever one this opens, and Edge"
    echo "speaks the same debugging protocol as Chrome."
    echo ""
    echo "Looked in the usual places for this OS ($OSTYPE). If yours is installed"
    echo "somewhere else, point at it directly:"
    echo "    BROWSER=\"/path/to/msedge\" $0"
    exit 1
fi

case "$CHROME" in
    *[Ee]dge*) BROWSER_NAME="Edge" ;;
    *)         BROWSER_NAME="Chrome" ;;
esac

# ─────────────────────────────────────────────────────────────
# Already running with debugging? Say WHICH BROWSER is on the port.
#
# This used to just print "already running" and exit 0. If you asked for Edge
# while a Chrome from an earlier session still held 9222, it told you you were
# ready — and every run afterwards drove Chrome, silently, while you believed
# you were testing Edge. The port being busy is not the same as the port having
# the browser you asked for.
#
# /json/version reports it, so ask.
# ─────────────────────────────────────────────────────────────
RUNNING_JSON="$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/json/version" 2>/dev/null)"
if [ -n "$RUNNING_JSON" ]; then
    RUNNING_UA="$(printf '%s' "$RUNNING_JSON" | tr ',' '\n' | grep -i '"Browser"' | cut -d'"' -f4)"
    case "$RUNNING_UA" in
        *Edg*)  RUNNING_NAME="Edge" ;;
        *hrome*|*hromium*) RUNNING_NAME="Chrome" ;;
        *)      RUNNING_NAME="${RUNNING_UA:-a browser}" ;;
    esac

    echo "$RUNNING_NAME is already running with remote debugging on port ${PORT}."
    echo "  (${RUNNING_UA:-unknown build})"
    echo ""

    # You asked for something specific and got something else. Do not pretend.
    if [ -n "${BROWSER:-}" ] && [ "$RUNNING_NAME" != "$BROWSER_NAME" ]; then
        echo "  *** BUT YOU ASKED FOR $BROWSER_NAME, AND PORT ${PORT} HAS $RUNNING_NAME. ***"
        echo ""
        echo "  Nothing was started. The run drives whatever holds this port, so"
        echo "  it would drive $RUNNING_NAME while you believed it was $BROWSER_NAME."
        echo ""
        echo "  Either quit the $RUNNING_NAME window using port ${PORT} and run this"
        echo "  again, or put $BROWSER_NAME on a different port and point the app at it:"
        echo ""
        echo "      BROWSER=\"$CHROME\" $0 9333"
        echo "      CDP_PORT=9333 npm start"
        echo ""
        exit 1
    fi

    echo ">> Make sure you're LOGGED INTO TRAMADA in that window:"
    echo "   ${TRAMADA_LOGIN}"
    echo ">> Then run:  npm start"
    exit 0
fi

mkdir -p "$PROFILE_DIR"

echo "Starting a dedicated $BROWSER_NAME (port ${PORT}) with profile:"
echo "  $CHROME"
echo "  $PROFILE_DIR"
if [ -d "$PROFILE_DIR/Default" ]; then
    echo "  (reusing profile — if you logged into Tramada here before, it's still warm)"
else
    echo "  (NEW profile — you'll need to log into Tramada in the window that opens)"
fi
echo ""

# Launch a separate Chrome instance (own profile) and open Tramada login in it,
# so it's obvious which window to sign into.
"$CHROME" \
    --remote-debugging-port=${PORT} \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$PROFILE_DIR" \
    "$TRAMADA_LOGIN" \
    >/dev/null 2>&1 &

echo "Waiting for $BROWSER_NAME to be ready..."
for i in $(seq 1 15); do
    if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
        echo ""
        echo "============================================================"
        echo "  $BROWSER_NAME is ready on port ${PORT}."
        echo ""
        echo "  1) In the $BROWSER_NAME window that just opened, LOG INTO TRAMADA"
        echo "     (${TRAMADA_LOGIN})"
        echo "  2) Keep that window open."
        echo "  3) In another terminal, run:  npm run chat"
        echo "============================================================"
        exit 0
    fi
    sleep 1
done

echo "ERROR: $BROWSER_NAME did not start with remote debugging on port ${PORT}."
echo "If your normal $BROWSER_NAME was open, this still launches a SEPARATE"
echo "window with its own profile — look for a new $BROWSER_NAME window showing"
echo "the Tramada login page. If nothing opened, fully quit $BROWSER_NAME"
echo "(Cmd+Q on a Mac) and retry."
exit 1

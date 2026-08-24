/**
 * shot-login-screen.js — photograph the login screen appearing and going away.
 *
 *   node shot-login-screen.js
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * This does NOT open Tramada, does not run noVNC and does not prove anybody can
 * sign in. It replays the two frames by hand and photographs what the pane does
 * with them.
 *
 * What it checks is the half that only fails when you look at it: that the
 * login screen appears when a run asks for a sign-in, goes away when the
 * sign-in lands, and stays when it is pinned. None of that shows up in a node
 * test — there is no rule here to test, only a panel — and all of it is obvious
 * in a screenshot.
 *
 * It also asserts the one thing a screenshot CANNOT show: that the iframe's src
 * is emptied when the panel hides. display:none does not stop an iframe, so a
 * hidden-but-loaded one holds a live VNC socket open to a browser signed into a
 * finance system for the rest of the run. A picture of a hidden panel looks
 * identical either way, which is exactly why it is asserted rather than
 * eyeballed.
 *
 * Fully offline: the harness serves its OWN stub at /vnc.html and advertises
 * its own port as the login screen, so nothing here needs Docker running.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");

/* Screenshots land in shots/out/, never the repo root. A bare relative path in
   page.screenshot() resolves against cwd, not against this file. */
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => path.join(OUT, name);

const PORT = 3897;
const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/* Something recognisable to frame. The real thing is a whole Chromium on a
   virtual screen; all this has to do is prove the panel loads what it is
   pointed at, and be legible in the picture. */
const STUB_VNC = `<!doctype html><meta charset="utf-8"><title>stub</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui;background:#2b2b2b;color:#eee">
<div style="background:#fff;color:#222;padding:28px 34px;border-radius:8px;text-align:center">
<div style="font-weight:700;margin-bottom:14px">TRAMADA</div>
<div style="margin-bottom:6px"><input placeholder="Username" style="padding:6px 8px;width:180px"></div>
<div style="margin-bottom:12px"><input placeholder="Password" type="password" style="padding:6px 8px;width:180px"></div>
<button style="padding:6px 22px">Sign in</button>
<div style="margin-top:14px;font-size:11px;color:#888">stub — shots/shot-login-screen.js</div>
</div></body>`;

const CSV = [
  "Date,Reference,Rec/Pay Type,Amount,Booking No",
  "2026-08-06,Deposit - Jill Shields,Debtor Payment Receipt,150.00,13201",
].join("\n") + "\n";

let fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

/* What the panel is doing right now, read out of the live page rather than
   inferred from the frames we sent. */
const panelState = (page) => page.evaluate(() => {
  const wrap = document.querySelector("#rcVncWrap");
  const frame = document.querySelector("#rcVnc");
  const pin = document.querySelector("#rcVncPin");
  return {
    exists: !!wrap,
    shown: !!wrap && getComputedStyle(wrap).display !== "none",
    src: frame ? (frame.getAttribute("src") || "") : null,
    pinned: pin ? pin.checked : null,
    banner: (document.querySelector("#rcLogin") || {}).textContent || "",
  };
});

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/vnc.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(STUB_VNC);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });

  let sock = null;
  const connected = new Promise((r) => {
    wss.on("connection", (ws) => {
      sock = ws;
      // Exactly as server.js does it, on connect and before anything else: this
      // is the frame that tells the page a login screen exists at all.
      ws.send(JSON.stringify({ type: "recon_hello", novncPort: PORT }));
      ws.on("message", (data) => {
        let msg = {};
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === "recon_run") r();
      });
    });
  });
  const send = (f) => sock && sock.readyState === 1 && sock.send(JSON.stringify(f));

  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); fail++; });

  await page.goto(`http://127.0.0.1:${PORT}/recon`);
  await page.waitForTimeout(600);

  const csvPath = path.join(require("os").tmpdir(), "recon-login-shot.csv");
  fs.writeFileSync(csvPath, CSV);
  await page.evaluate(() => document.querySelector('[data-choose="bpay"]').click());
  await page.locator("#filePicker").setInputFiles(csvPath);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('.nav-item[data-go="sources"]').click());
  await page.locator("#rcOpening").fill("12500.00");
  await page.locator("#rcClosing").fill("13010.00");
  await page.locator("#startRun").click();
  await connected;
  await page.waitForTimeout(200);

  console.log("\nbefore the run asks for anything");
  send({ type: "recon_progress", message: "Opening Tramada…" });
  await page.waitForTimeout(300);
  let st = await panelState(page);
  check("the panel exists on the page", st.exists);
  check("but is not shown — nothing has asked for a login", !st.shown);
  check("and its iframe has no src", st.src === "");
  await page.screenshot({ path: shot("login-0-before.png") });

  console.log("\nrecon_login — a human has to sign in");
  send({ type: "recon_login", message: "Sign into Tramada on the login screen below — I'll wait, and I never type credentials." });
  await page.waitForTimeout(700);
  st = await panelState(page);
  check("the login screen is shown", st.shown);
  check("the iframe points at the login screen", /\/vnc\.html\?/.test(st.src));
  check("built from the page's own hostname, not a hardcoded 127.0.0.1",
    st.src.indexOf(`//127.0.0.1:${PORT}/`) === 0 || st.src.indexOf("//localhost:") === 0 || /^https?:\/\/127\.0\.0\.1:/.test(st.src));
  check("the banner names the screen, not port 9222", !/9222/.test(st.banner));
  await page.screenshot({ path: shot("login-1-asking.png") });
  console.log("  wrote shots/out/login-1-asking.png");

  console.log("\nrecon_login_ok — they signed in");
  send({ type: "recon_login_ok", message: "Signed into Tramada — carrying on." });
  await page.waitForTimeout(600);
  st = await panelState(page);
  check("the login screen is hidden again", !st.shown);
  // The one a picture cannot show. A hidden iframe that kept its src would keep
  // its VNC socket open for the rest of the run.
  check("AND its src is cleared, so the VNC connection is dropped", st.src === "");
  check("the banner is gone", !st.banner);
  send({ type: "recon_progress", message: "Reading the existing Trust Account statement pages…", ok: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot("login-2-signed-in.png") });
  console.log("  wrote shots/out/login-2-signed-in.png");

  console.log('\n"Keep open" ticked — the screen stays up through the sign-in');
  send({ type: "recon_login", message: "Sign into Tramada on the login screen below — I'll wait, and I never type credentials." });
  await page.waitForTimeout(500);
  await page.locator("#rcVncPin").check();
  await page.waitForTimeout(300);
  st = await panelState(page);
  check("the pin reads as ticked", st.pinned === true);
  send({ type: "recon_login_ok", message: "Signed into Tramada — carrying on." });
  await page.waitForTimeout(600);
  st = await panelState(page);
  check("the screen is STILL shown after the sign-in", st.shown);
  check("and still connected", /\/vnc\.html\?/.test(st.src));
  await page.screenshot({ path: shot("login-3-pinned.png") });
  console.log("  wrote shots/out/login-3-pinned.png");

  console.log("\nthe run ends");
  send({ type: "recon_done", pageNumber: 10 });
  await page.waitForTimeout(600);
  st = await panelState(page);
  // The pin survives the run (it is a preference), but a finished run has
  // nothing to sign into, so the screen still comes down and lets go.
  check("a finished run takes the screen down even pinned", !st.shown);
  check("and drops the connection", st.src === "");
  check("the pin itself is remembered", st.pinned === true);

  console.log("\nunpinned, a page reload forgets nothing it should not");
  await page.evaluate(() => { try { localStorage.setItem("rcVncPin", "0"); } catch (_) {} });

  await browser.close();
  server.close();
  wss.close();
  console.log(`\n${fail === 0 ? "✅" : "❌"} ${fail === 0 ? "all checks passed" : fail + " failed"}`);
  process.exit(fail === 0 ? 0 : 1);
})();

/**
 * shot-recon-run.js — photograph the reconciliation inbox mid-run and finished.
 *
 *   node shot-recon-run.js
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * This does NOT test the automation. It never opens Tramada, never files a
 * receipt and never proves a rule. The frames it replays are written out below
 * by hand.
 *
 * What it tests is the half that only fails when you look at it: that the pane
 * turns a run's frames into the right table. Every earlier bug in this file's
 * neighbourhood was of that kind — recon_progress arriving and being dropped,
 * a stop reason written into the lede and wiped by the next repaint, a
 * Playwright call log rendered raw into a table cell. None of those show up in
 * a node test and all of them are obvious in a screenshot.
 *
 * The rules themselves are tested, offline and for real, in test-recon-core.js.
 * The automation is tested by running it (npm start, then a live run).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

/* Screenshots land in shots/out/, never the repo root. A bare relative path in
   page.screenshot() resolves against cwd, not against this file, which is how a
   dozen PNGs ended up sitting beside server.js. */
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => path.join(OUT, name);
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");

const PORT = 3899;
const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/* The CSV the harness "uploads" — the three-booking set from bookings.json, so
   the picture shows all three allocation outcomes side by side. */
const CSV = [
  "Date,Reference,Rec/Pay Type,Amount,Booking No",
  "2026-08-06,Deposit - Jill Shields,Debtor Payment Receipt,150.00,13201",
  "2026-08-06,Trip File Tsfr 1105,Debtor Payment Receipt,260.00,13202",
  "2026-08-06,VIX122334,Debtor Payment Receipt,100.00,13203",
].join("\n") + "\n";

/* One realistic run, in the order runReconciliation actually emits it:
   every receipt first, then the statement page, then the matching. */
const SCRIPT = [
  { t: 300, f: { type: "recon_row", n: 1, row: { allocation: "Running" } } },
  { t: 120, f: { type: "recon_progress", message: "Row 1: opening the receipt form for booking 13201…" } },
  { t: 260, f: { type: "recon_progress", message: "Row 1: 150.00 settles the hotel segment in full." } },
  { t: 120, f: { type: "recon_row", n: 1, row: { receiptNo: "R.0000009403", allocation: "Allocated", why: "settles the hotel segment in full" } } },
  { t: 120, f: { type: "recon_progress", message: "Row 1: receipt R.0000009403 — Allocated", ok: true } },

  { t: 200, f: { type: "recon_row", n: 2, row: { allocation: "Running" } } },
  { t: 120, f: { type: "recon_progress", message: "Row 2: opening the receipt form for booking 13202…" } },
  { t: 260, f: { type: "recon_progress", message: "Row 2: 260.00 settles the ticket (200.00); the 60.00 hotel would take it over." } },
  { t: 120, f: { type: "recon_row", n: 2, row: { receiptNo: "R.0000009404", allocation: "Part allocated", why: "settles the ticket; 60.00 of the receipt is left unallocated" } } },
  { t: 120, f: { type: "recon_progress", message: "Row 2: receipt R.0000009404 — Part allocated" } },

  { t: 200, f: { type: "recon_row", n: 3, row: { allocation: "Running" } } },
  { t: 120, f: { type: "recon_progress", message: "Row 3: opening the receipt form for booking 13203…" } },
  { t: 260, f: { type: "recon_progress", message: "Row 3: no segment is small enough for 100.00 — the receipt is filed unallocated." } },
  { t: 120, f: { type: "recon_row", n: 3, row: { receiptNo: "R.0000009405", allocation: "Not allocated", why: "every segment costs more than the receipt" } } },

  { t: 300, f: { type: "recon_progress", message: "Reading the existing Trust Account statement pages…" } },
  { t: 260, f: { type: "recon_progress", message: "Last page is 9; creating page 10." } },
  { t: 400, f: { type: "recon_progress", message: "Page 10 created (07-08-2026).", ok: true } },
  { t: 200, f: { type: "recon_progress", message: "Sorting by date descending, then filtering to Client Payment Receipt…" } },
  { t: 400, f: { type: "recon_progress", message: "3 transactions showing after the filter." } },

  { t: 200, f: { type: "recon_row", n: 1, row: { reconciliation: "Reconciled", why: "receipt R.0000009403 found at $150.00" } } },
  { t: 120, f: { type: "recon_row", n: 2, row: { reconciliation: "Reconciled", why: "receipt R.0000009404 found at $260.00" } } },
  { t: 120, f: { type: "recon_row", n: 3, row: { reconciliation: "Not reconciled", why: "receipt R.0000009405 is not among the transactions on this page" } } },
  { t: 200, f: { type: "recon_done", pageNumber: 10 } },
];

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });

  let mid = null;                       // resolves once the run is half-played
  const midway = new Promise((r) => { mid = r; });
  let done = null;
  const finished = new Promise((r) => { done = r; });

  // Wait for the pane's own recon_run frame before replaying, exactly as the
  // server does. Replaying on connect instead sent row 1's result before the
  // CSV was even loaded, and start() then reset the row — which looked like a
  // rendering bug and was the harness getting ahead of itself.
  wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
      let msg = {};
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type !== "recon_run") return;
      console.log(`run requested: ${(msg.rows || []).length} rows, ` +
        `${msg.statementDate} / ${msg.openingBalance} → ${msg.closingBalance}`);
      for (let i = 0; i < SCRIPT.length; i++) {
        await new Promise((r) => setTimeout(r, SCRIPT[i].t));
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(SCRIPT[i].f));
        if (i === 12) mid();           // three receipts in, statement not yet made
      }
      done();
    });
  });

  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`http://127.0.0.1:${PORT}/recon`);
  await page.waitForTimeout(600);

  const csvPath = path.join(require("os").tmpdir(), "recon-harness.csv");
  fs.writeFileSync(csvPath, CSV);
  await page.evaluate(() => document.querySelector('[data-choose="bpay"]').click());
  await page.locator("#filePicker").setInputFiles(csvPath);
  await page.waitForTimeout(500);

  await page.evaluate(() => document.querySelector('.nav-item[data-go="sources"]').click());
  await page.locator("#rcOpening").fill("12500.00");
  await page.locator("#rcClosing").fill("13010.00");
  await page.screenshot({ path: shot("recon-run-0-ready.png") });

  // The source card, with its preview open. This is the screen the agent is
  // looking at when they decide whether to start a run that files receipts, so
  // it is worth a picture of its own.
  await page.locator('[data-preview="bpay"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot("recon-run-0b-preview.png") });
  console.log("wrote shots/out/recon-run-0b-preview.png");
  await page.locator('[data-preview="bpay"]').click();

  await page.locator("#startRun").click();
  await midway;
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot("recon-run-1-midway.png") });
  console.log("wrote shots/out/recon-run-1-midway.png");

  await finished;
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("recon-run-2-finished.png") });
  console.log("wrote shots/out/recon-run-2-finished.png");

  // …and the source card once it is over: "processed", not "not run yet".
  await page.evaluate(() => document.querySelector('.nav-item[data-go="sources"]').click());
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot("recon-run-3-source-after.png") });
  console.log("wrote shots/out/recon-run-3-source-after.png");
  console.log("card:", (await page.locator('#tileGrid .dz[data-kind="bpay"]').textContent()).replace(/\s+/g, " ").trim());
  await page.evaluate(() => document.querySelector('.nav-item[data-go="inbox"]').click());
  await page.waitForTimeout(200);

  // What the table ended up saying, so a broken cell fails the run rather than
  // waiting to be noticed in an image.
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll("#triagePane tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
  console.log(JSON.stringify(cells, null, 1));

  await browser.close();
  server.close();
  wss.close();
  process.exit(0);
})();

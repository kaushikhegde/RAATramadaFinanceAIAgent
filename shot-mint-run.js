/**
 * shot-mint-run.js — photograph a finished Mint daily settlement run.
 *
 *   node shot-mint-run.js
 *
 * The sibling of `shot-recon-run.js`, and the same warning applies: this does
 * NOT test the automation. Tramada is never opened. The statement transactions
 * are made up here.
 *
 * What is real: the workbook. `mint.xlsx` is read by `xlsx-lite` and parsed by
 * `recon-core.parseMintRows` — the same two steps the server does — and the
 * verdicts come from `recon-core.matchMintAgainstStatement`. So the picture
 * shows the actual rules applied to the actual sample, with only the page's
 * transaction list invented.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const core = require("./recon-core");
const xlsx = require("./xlsx-lite");

const PORT = 3902;
const PAGE = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const BOOK = path.join(__dirname, "mint.xlsx");

/* A transaction list that produces one of each outcome:
   - most references present and agreeing            → Reconciled
   - one present for a different amount              → Reconciled, difference noted
   - one present but paid to a different company     → Reconciled, difference noted
   - two absent                                      → Not reconciled            */
function makeStatement(rows) {
  const out = [];
  rows.forEach((r, i) => {
    if (i === 3 || i === 7) return;                                   // never arrived
    const amount = i === 1 ? "1.00" : (r.amountCents / 100).toFixed(2); // wrong figure
    const payee = i === 2 ? "Someone Else Pty Ltd" : r.toCompany;       // wrong company
    out.push({ transNo: r.transNo, payee, amount, date: "07-08-2026", recPayType: "Creditor Payment" });
  });
  return out;
}

(async () => {
  const sheet = xlsx.readSheet(fs.readFileSync(BOOK));
  const parsed = core.parseMintRows(sheet.headers, sheet.rows);
  const statement = makeStatement(parsed.rows);

  const server = http.createServer((q, s) => {
    s.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    s.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });

  let done;
  const finished = new Promise((r) => { done = r; });

  wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
      let msg = {};
      try { msg = JSON.parse(String(data)); } catch { return; }
      const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

      if (msg.type === "recon_parse") {
        // Exactly what the server does — same reader, same parser.
        const s = xlsx.readSheet(Buffer.from(String(msg.base64), "base64"));
        const p = core.parseMintRows(s.headers, s.rows);
        send({ type: "recon_parsed", source: "mint", name: msg.name, rows: p.rows, problems: p.problems });
        return;
      }

      if (msg.type !== "recon_run") return;
      console.log(`run requested: ${msg.source}, ${(msg.rows || []).length} rows`);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      send({ type: "recon_progress", message: `${msg.rows.length} settlements to check. Nothing is filed — this run only looks for them on the statement page.` });
      await wait(400);
      send({ type: "recon_progress", message: "Reading the existing [TRUST] Trust Account statement pages…" });
      await wait(400);
      send({ type: "recon_progress", message: "10 existing pages read (highest 10); creating page 11." });
      await wait(500);
      send({ type: "recon_progress", message: "Page 11 created (07-08-2026).", ok: true });
      await wait(300);
      send({ type: "recon_progress", message: "Sorting by date descending, then filtering to Creditor Payment…" });
      await wait(500);
      send({ type: "recon_progress", message: `${statement.length} transactions showing after the filter.` });

      for (const r of msg.rows) {
        const m = core.matchMintAgainstStatement(r, statement);
        send({ type: "recon_row", n: r.n || msg.rows.indexOf(r) + 1,
          row: { reconciliation: m.status, why: m.reason, mismatch: m.mismatch } });
      }
      await wait(300);
      const summary = core.summariseMint(msg.rows.map((r) => {
        const m = core.matchMintAgainstStatement(r, statement);
        return { reconciliation: m.status, mismatch: m.mismatch };
      }));
      send({ type: "recon_progress", message:
        `${summary.reconciled} of ${summary.total} found on page 11` +
        (summary.mismatched ? `, ${summary.mismatched} with a difference to check` : "") +
        (summary.notReconciled ? `, ${summary.notReconciled} missing` : "") });
      send({ type: "recon_done", pageNumber: 11, summary });
      done();
    });
  });

  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`http://127.0.0.1:${PORT}/recon`);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('.nav-item[data-go="sources"]').click());
  await page.evaluate(() => document.querySelector('[data-choose="mint"]').click());
  await page.locator("#filePicker").setInputFiles(BOOK);
  await page.waitForTimeout(900);
  await page.locator("#rcOpening").fill("1300000.00");
  await page.locator("#rcClosing").fill("1300000.00");
  await page.screenshot({ path: "mint-run-0-loaded.png" });
  console.log("wrote mint-run-0-loaded.png");

  await page.locator("#startRun").click();
  await finished;
  await page.waitForTimeout(600);
  await page.screenshot({ path: "mint-run-1-finished.png" });
  console.log("wrote mint-run-1-finished.png");

  console.log("lede:", (await page.locator("#ibLede").textContent()).trim());
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll("#triagePane tbody tr")].slice(0, 4).map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent.trim().slice(0, 70))));
  console.log(JSON.stringify(cells, null, 1));

  await browser.close();
  server.close();
  wss.close();
  process.exit(0);
})();

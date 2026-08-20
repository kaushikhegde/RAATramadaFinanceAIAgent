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
const core = require("../recon-core");
const xlsx = require("../xlsx-lite");

/* Screenshots go to shots/out/, not to whatever directory npm was run from. */
const SHOT_OUT = require("path").join(__dirname, "out");
require("fs").mkdirSync(SHOT_OUT, { recursive: true });
const shotPath = (n) => require("path").join(SHOT_OUT, n);


const PORT = 3902;
const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const BOOK = path.join(__dirname, "..", "fixtures", "mint.xlsx");

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

  /* The real sheet, served the way the real server serves it — ONE sheet, and
     the same one whichever report asks for it. */
  const cheat = core.parseCheatSheet(
    xlsx.readSheet(fs.readFileSync(path.join(__dirname, "..", "cheat-sheets", "supplier-names.xlsx"))));
  const server = http.createServer((q, s) => {
    if ((q.url || "").startsWith("/api/cheat-sheet/")) {
      s.writeHead(200, { "Content-Type": "application/json" });
      s.end(JSON.stringify({
        source: "suppliers", name: "supplier-names.xlsx", pairs: cheat.pairs, shipped: true,
      }));
      return;
    }
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
  /* The cheat sheet panel. ONE of them, not one per report — the guides name a
     sheet each, RAA's file is headed "SUPPLIER NAME IN MINT / TRAVELPAY" and
     covers both. A second panel here would mean somebody has to upload the same
     file twice and wonder which one a run used. */
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
  };
  const panel = await page.evaluate(() => {
    const host = document.querySelector("#cheatSheets");
    if (!host) return { cards: 0 };
    const picker = document.querySelector("#cheatPicker");
    return {
      cards: host.querySelectorAll(".card").length,
      buttons: host.querySelectorAll("[data-cheat]").length,
      shown: host.style.display !== "none",
      text: host.innerText.replace(/\s+/g, " ").trim(),
      accept: picker ? picker.accept : null,
    };
  });
  console.log("\nthe supplier cheat sheet panel");
  check("one panel, not one per report", panel.cards, 1);
  check("with one upload button", panel.buttons, 1);
  check("and it is on screen once a file is loaded", panel.shown, true);
  check("it says the sheet serves both reports",
    /MINT and TravelPay/.test(panel.text), true);
  check("it names the file and counts the suppliers",
    /supplier-names\.xlsx/.test(panel.text) && /28 suppliers/.test(panel.text), true);
  check("and says where it came from", /supplied with the app/.test(panel.text), true);
  check("the picker takes a workbook as well as a CSV",
    /\.xlsx/.test(panel.accept || ""), true);
  if (fail) { console.log(`\n❌ ${pass} passed, ${fail} failed`); process.exitCode = 1; }
  else console.log(`  ${pass} passed`);

  await page.locator("#rcOpening").fill("1300000.00");
  await page.locator("#rcClosing").fill("1300000.00");
  await page.screenshot({ path: shotPath("mint-run-0-loaded.png") });
  console.log("wrote mint-run-0-loaded.png");

  await page.locator("#startRun").click();
  await finished;
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath("mint-run-1-finished.png") });
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

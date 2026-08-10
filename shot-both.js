/**
 * Loading BOTH reports and starting one run.
 *
 * The screen used to refuse this outright — "Two reports are loaded… remove the
 * one you are not running" — and Start run stayed dead. This drives the real
 * page: picks a BPay CSV on one card, a Mint CSV on the other, and checks that
 * the button comes alive and that what goes down the socket is ONE combined run
 * rather than two.
 *
 * The socket is stubbed, so nothing reaches Tramada.
 *
 *   node shot-both.js        → both-loaded.png
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-both-"));
process.env.RECON_STORE_DIR = DIR;
process.env.PORT = process.env.PORT || "3144";

require("./server");
const { chromium } = require("playwright");

let bad = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { bad++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

  await page.goto(`http://127.0.0.1:${process.env.PORT}/`, { waitUntil: "networkidle" });

  // Catch what the page SENDS without letting it reach a run.
  await page.evaluate(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(data);
        window.__sent.push(m);
        if (m.type === "recon_run") return;      // stop here: nothing drives Tramada
      } catch (e) { /* not ours */ }
      return send.call(this, data);
    };
  });

  const pick = async (kind, file) => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click(`[data-choose="${kind}"]`),
    ]);
    await chooser.setFiles(path.join(__dirname, file));
    await page.waitForTimeout(700);
  };

  await pick("bpay", "tramada-statement-lines.csv");
  ok("one report loaded enables Start run",
    !(await page.locator("#startRun").isDisabled()));

  await pick("mint", "mint-payments.csv");
  await page.waitForTimeout(900);

  const state = await page.evaluate(() => ({
    startDisabled: document.querySelector("#startRun").disabled,
    banner: (document.querySelector("#tileGrid .note") || {}).textContent || "",
    cards: [...document.querySelectorAll("[data-choose]")].length,
  }));
  ok("BOTH reports loaded still enables Start run", !state.startDisabled, "the button is dead");
  ok("and the screen says they run together",
    /run together/i.test(state.banner), state.banner.slice(0, 140));
  ok("it no longer tells you to remove one",
    !/remove the one/i.test(state.banner), state.banner.slice(0, 140));

  // Fill the statement fields the run insists on, then press Start.
  await page.fill("#rcDate", "10-08-2026");
  await page.fill("#rcOpening", "111753.97");
  await page.fill("#rcClosing", "120000.00");
  await page.click("#startRun");
  await page.waitForTimeout(600);

  const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === "recon_run"));
  ok("exactly ONE run is sent, not two", sent.length === 1, JSON.stringify(sent.map((s) => s.source)));
  ok("and it is a combined run", sent[0] && sent[0].source === "both", sent[0] && sent[0].source);
  ok("carrying the BPay rows", sent[0] && (sent[0].bpayRows || []).length > 0,
    JSON.stringify(sent[0] && (sent[0].bpayRows || []).length));
  ok("and the Mint rows", sent[0] && (sent[0].mintRows || []).length > 0,
    JSON.stringify(sent[0] && (sent[0].mintRows || []).length));
  ok("with the statement date and balances",
    sent[0] && sent[0].statementDate === "10-08-2026" && sent[0].openingBalance === "111753.97",
    JSON.stringify(sent[0] && { d: sent[0].statementDate, o: sent[0].openingBalance }));

  const inbox = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("#triagePane tbody tr")].map((tr) =>
      [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())),
    text: (document.querySelector("#ibLede") || {}).textContent || "",
  }));
  // The BPay lines and the Mint settlements share one table, numbered across
  // both — two rows called 1 would overwrite each other in the inbox.
  ok("the inbox holds every row from both reports", inbox.rows.length >= 4, String(inbox.rows.length));
  ok("a BPay row still names its reference and booking",
    inbox.rows.some((r) => r.join(" ").includes("13157")), JSON.stringify(inbox.rows[0]));
  // A Mint row has no reference, no date and no booking. Drawn as a BPay row it
  // came out as a bare "·" with a "pending" allocation for a report that
  // allocates nothing.
  ok("a Mint row names its transaction, not a bare dot",
    inbox.rows.some((r) => r.join(" ").includes("P.0000004123")), JSON.stringify(inbox.rows.slice(1, 2)));
  ok("and says which report it came from",
    inbox.rows.some((r) => r.join(" ").includes("Mint settlement")), JSON.stringify(inbox.rows.slice(1, 2)));
  ok("no Mint row claims a pending allocation",
    !inbox.rows.filter((r) => r.join(" ").includes("Mint settlement")).some((r) => r.join(" ").includes("pending")),
    JSON.stringify(inbox.rows.slice(1, 2)));

  ok("no page errors", problems.length === 0, problems.join(" | "));

  await page.screenshot({ path: path.join(__dirname, "both-loaded.png"), fullPage: false });
  console.log(`\n  both-loaded.png written${bad ? " (with failures above)" : ""}\n`);
  await browser.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("\n  shot failed:", e); process.exit(1); });

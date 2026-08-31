/**
 * WHY DOES THIS BOOKING SAY "Debtor Payment Receipt not available"?
 *
 *   node tools/check-booking-clients.js 13115 13703 13706
 *   node tools/check-booking-clients.js --from csv_uploads/tramada-statement-lines.csv
 *
 * Opens each booking's Profile and Receipts pages and reports three things: the
 * booking's ACCOUNT TYPE, its client, and what `#receiptCategory` actually
 * offers. Nothing else, and nothing is saved — no receipt is raised, no form is
 * submitted.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * "BPAY has issues, mainly the debtor payment error" is a report we cannot act
 * on, because the same message has two completely different causes and
 * opposite fixes:
 *
 *   1. The BOOKINGS were opened on the wrong account type. `Debtor Payment
 *      Receipt` appears only on a CORPORATE booking; a RETAIL one fills
 *      `#retailDebtor`, leaves `#debtor` empty, and so has no debtor to receipt
 *      against — Tramada offers the Client variants and nothing else, and the
 *      run correctly refuses rather than filing a BPay payment under a type the
 *      reconcile filter never looks at.
 *      → Fix the fixtures (tools/make-fixtures.js ACCOUNT_FOR). The code is right.
 *
 *   2. Real RAA BPay bookings genuinely are NOT debtor-account bookings, in
 *      which case `core.BPAY_RECEIPT` is wrong and the whole thing needs
 *      revisiting with Finance.
 *      → Fix the code. The bookings are right.
 *
 * Guessing between those is how `BPAY_RECEIPT.label` got changed once already,
 * on the evidence of whichever bookings happened to be on hand. This asks
 * Tramada instead.
 *
 * ── IT IS THE BOOKING, NOT THE CLIENT ────────────────────────────────────
 * This tool used to print only the client and conclude "this is a CLIENT
 * problem — the DR suffix matters", which sent you to change the client while
 * the booking stayed retail and the dropdown never moved. Separated live
 * 31-Aug-2026, same client on both sides:
 *
 *   13115  GRAY/MEGAN DR (client id 415)  booking CORPORATE  → Debtor variants
 *   14120  GRAY/MEGAN DR (client id 415)  booking RETAIL     → Client variants
 *   13034  MOULDS/NICHOLAS MR (id 4103)   booking CORPORATE  → Debtor variants
 *
 * Both of those clients are CORPORATE account types. The client is still worth
 * printing — Tramada takes the booking's initial account type from it — but the
 * account type is the answer, so it gets its own column.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const core = require("../recon-core");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const HOST = process.env.CDP_HOST || "127.0.0.1";

let args = process.argv.slice(2);
let bookings = [];
const fromIdx = args.indexOf("--from");
if (fromIdx >= 0) {
  // Pull the booking column out of a BPay file, so you can point this at the
  // very file that produced the errors.
  const file = args[fromIdx + 1];
  const g = core.csvGrid(fs.readFileSync(path.resolve(file), "utf8"));
  const cols = core.mapColumns(g.headers, { bookingNo: ["tramada bkg no", "booking no", "booking no.", "bookingno"] });
  if (cols.bookingNo < 0) { console.error(`\n  ${file} has no booking column.\n`); process.exit(1); }
  bookings = g.rows.map((r) => String(r[cols.bookingNo] || "").trim()).filter(Boolean);
} else {
  bookings = args.filter((a) => !a.startsWith("--"));
}

if (!bookings.length) {
  console.error("\n  usage: node tools/check-booking-clients.js <bookingNo…>");
  console.error("         node tools/check-booking-clients.js --from <bpay file>\n");
  process.exit(1);
}

const WANT = core.BPAY_RECEIPT.label;

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://${HOST}:${PORT}`);
  } catch (e) {
    console.error(`\n  Could not reach the browser on ${HOST}:${PORT}.`);
    console.error(`  Run "npm run start:chrome" (or start:edge) and sign into Tramada there.\n`);
    process.exit(1);
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  console.log(`\n  Looking for "${WANT}" on ${bookings.length} booking(s).\n`);
  console.log(`  ${"booking".padEnd(10)}${"account".padEnd(11)}${"client".padEnd(20)}offers`);
  console.log(`  ${"-".repeat(84)}`);

  const bad = [];
  for (const b of bookings) {
    try {
      /* The account type comes off the PROFILE page's own <select>, never off a
         name-shaped string in the page text. The old client column was
         `body.innerText.match(/[A-Z]+\/[A-Z]+.../)` — the first thing on the
         page that looked like a name, which is a passenger as often as the
         client. Read the control that decides, and read it by id. */
      await page.goto(`${BASE}/booking/booking-profile.htm?mode=edit&id=${encodeURIComponent(b)}`,
        { waitUntil: "domcontentloaded", timeout: 45000 });
      if (page.url().includes("login.htm")) {
        console.log(`\n  That browser is not signed into Tramada. Sign in and re-run.\n`);
        break;
      }
      const prof = await page.evaluate(() => {
        const g = (id) => document.getElementById(id);
        return {
          accountType: g("accountTypeCode") ? String(g("accountTypeCode").value || "") : "",
          client: g("client") ? String(g("client").value || "").trim() : "",
        };
      });

      await page.goto(`${BASE}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(b)}`,
        { waitUntil: "domcontentloaded", timeout: 45000 });
      const info = await page.evaluate(() => {
        const sel = document.querySelector("#receiptCategory");
        return { options: sel ? [...sel.options].map((o) => o.text.trim()).filter(Boolean) : null };
      });
      const acct = (prof.accountType || "?").padEnd(11);
      const client = (prof.client || "(not found)").padEnd(20);
      if (!info.options) {
        console.log(`  ${String(b).padEnd(10)}${acct}${client}(no receipt category on the page — is ${b} a real booking?)`);
        bad.push({ b, why: "no receipt category" });
        continue;
      }
      const has = info.options.includes(WANT);
      console.log(`  ${String(b).padEnd(10)}${acct}${client}${has ? "\x1b[32m✓\x1b[0m " : "\x1b[31m✗\x1b[0m "}${info.options.join(" · ")}`);
      if (!has) bad.push({ b, client: prof.client, accountType: prof.accountType, options: info.options });
    } catch (e) {
      console.log(`  ${String(b).padEnd(10)}${"".padEnd(31)}could not read it — ${e.message.split("\n")[0]}`);
      bad.push({ b, why: e.message.split("\n")[0] });
    }
  }

  console.log("");
  if (!bad.length) {
    console.log(`  Every booking offers "${WANT}".`);
    console.log(`  If a run still reports it missing, the problem is elsewhere — send the run's activity log.\n`);
  } else {
    console.log(`  ${bad.length} of ${bookings.length} cannot take a "${WANT}".\n`);
    const retail = bad.filter((x) => x.accountType === "RETAIL");
    if (retail.length) {
      console.log(retail.length === 1
        ? `  ${retail.length} of those is a RETAIL booking, and that is the whole reason:`
        : `  ${retail.length} of those are RETAIL bookings, and that is the whole reason:`);
      console.log(`  a RETAIL booking fills #retailDebtor and leaves #debtor EMPTY, so it has no`);
      console.log(`  debtor to receipt against and Tramada offers only the Client variants. The`);
      console.log(`  client is not the problem — 13115 and 14120 are the SAME client and differ`);
      console.log(`  only in this field.\n`);
      console.log(`  To rebuild fixtures opened as CORPORATE (tools/make-fixtures.js ACCOUNT_FOR):`);
      console.log(`      node tools/make-fixtures.js bpay\n`);
      console.log(`  To fix one that already exists, reopen the BOOKING on the right account`);
      console.log(`  type — moving it to another client will not move the dropdown.\n`);
    }
    console.log(`  BUT: if these are REAL RAA BPay bookings rather than test ones, then the`);
    console.log(`  assumption that BPay bookings are debtor-account is wrong, and`);
    console.log(`  core.BPAY_RECEIPT needs revisiting with Finance. Send this output over`);
    console.log(`  rather than changing the receipt type — that has been guessed wrong before.\n`);
  }
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(`\n  failed: ${e.message}\n`); process.exit(1); });

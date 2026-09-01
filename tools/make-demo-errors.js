/**
 * make-demo-errors.js — five rows per payment type, each tripping a DIFFERENT rule.
 *
 *   node tools/make-demo-errors.js            write all four files
 *   node tools/make-demo-errors.js bpay mint  just those
 *
 * RAA, 29-Aug: "Make 5 transactions as created from the scripts for each of the
 * payment types (we have 3 now), which would be good to show the varying
 * flagged errors."
 *
 * ── WHY THIS IS A SEPARATE SCRIPT ────────────────────────────────────────
 * `make-fixtures.js` and the two `*-5-rows.js` scripts build CORRECT data in
 * Tramada — five bookings that reconcile cleanly. That proves the happy path
 * and nothing else. A demo of five green rows does not show RAA what the agent
 * is FOR.
 *
 * An error is the spreadsheet disagreeing with Tramada. So the Tramada side
 * stays correct and the disagreement is introduced HERE, in the file. That also
 * means this script needs no browser, touches nothing, and can be checked
 * offline — which `--verify` does.
 *
 * Booking numbers come from tools/created-bookings-*.json when those exist, so
 * the rows point at real bookings. Where they do not, a placeholder is written
 * and named in the output, for you to substitute.
 */
const fs = require("fs");
const path = require("path");
const core = require("../recon-core");

const OUT = path.join(__dirname, "..", "csv_uploads");
const money = (c) => (c / 100).toFixed(2);
const pick = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const VERIFY = process.argv.includes("--verify");

const STALE = [];

/* THE SAVED BOOKINGS CAN BE ON THE WRONG CLIENT, and if they are, every BPay
   row fails with "Debtor Payment Receipt not available" no matter how good the
   file is. That happened on 01-Sep: `created-bookings-bpay.json` was written
   before CLIENT_FOR.bpay was corrected to "GRAY/MEGAN DR" on 28-Aug, so the
   demo pointed at three retail-account bookings and all five rows came back
   with the same error — hiding the varying errors this script exists to show.

   `#receiptCategory` offers the Debtor variants only when the booking's client
   is a debtor account, so a checkpoint written under a different client than
   make-fixtures.js now uses is stale by definition. Say so rather than emit a
   file that cannot work. */
function realBookings(which) {
  const f = path.join(__dirname, `created-bookings-${which}.json`);
  let list;
  try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return []; }

  try {
    const src = fs.readFileSync(path.join(__dirname, "make-fixtures.js"), "utf8");
    const m = src.match(new RegExp(`${which}:\\s*"([^"]+)"`));
    const wanted = m && m[1];
    const on = [...new Set(list.map((b) => b.clientCode).filter(Boolean))];
    if (wanted && on.length && !on.includes(wanted)) {
      STALE.push({ which, wanted, on, file: path.basename(f), count: list.length });
      return [];                       // fall back to placeholders, not wrong numbers
    }
  } catch (e) { /* no make-fixtures to compare against — carry on */ }
  return list;
}

/* Each row says what it is FOR. `expect` is the remark or status the run should
   produce — printed as a table, and checked by --verify where the decision is
   one this process can make without Tramada. */
const PLANS = {
  /* BPay's outcomes are decided by the CSV amount against what the booking
     owes, so the five amounts are derived from each booking's real dueCents. */
  bpay: () => {
    const b = realBookings("bpay");
    const due = (i, fallback) => (b[i] ? b[i].dueCents : fallback);
    const no = (i, fallback) => (b[i] ? b[i].bookingNo : fallback);
    return {
      file: "demo-bpay-5.csv",
      headers: ["B/PAY FILE DATE", "CUSTOMER REF", "RECEIPT NO", "AMOUNT", "CONSULTANT", "SHOP", "TRAMADA BKG NO", "REMARKS"],
      rows: [
        { why: "settles the booking exactly", expect: "Allocated — no remark",
          cells: ["29-08-26", "D1", "BP-D1", money(due(0, 14554)), "", "", no(0, "PLACEHOLDER-1"), ""] },
        { why: "pays MORE than owed, one segment", expect: "Allocated + \"Overpayment, please check\"",
          cells: ["29-08-26", "D2", "BP-D2", money(due(1, 20000) + 5000), "", "", no(1, "PLACEHOLDER-2"), ""] },
        /* PAYS LESS THAN THE BOOKING OWES. This row used to pay MORE, on the
           theory that a multi-segment booking would refuse it — but the
           fixtures are single-segment, so it allocated exactly like row 2 and
           the demo showed the same remark twice. What a row demonstrates must
           not depend on a booking's segment count, which only Tramada knows.
           An amount below what is owed is refused whatever the shape. */
        { why: "pays LESS than the booking owes", expect: "Not allocated + \"Please allocate\"",
          cells: ["29-08-26", "D3", "BP-D3", money(Math.max(1, due(2, 79000) - 7777)), "", "", no(2, "PLACEHOLDER-3"), ""] },
        /* DELIBERATELY THE SAME BOOKING AS ROW 1, which row 1 has just
           settled. Not a mistake — it is how a duplicated line in Finance's
           file shows up, and "No outstanding amount found" is the remark that
           catches it. Row order matters here: this only works because row 1
           runs first. */
        { why: "a second payment against a booking row 1 already settled",
          expect: "Not allocated + \"No outstanding amount found\"",
          cells: ["29-08-26", "D4", "BP-D4", money(due(0, 14554) + 777), "", "", no(0, "PLACEHOLDER-1"), ""] },
        { why: "booking that does not exist in Tramada", expect: "the run reports the booking could not be opened",
          cells: ["29-08-26", "D5", "BP-D5", "310.00", "", "", "999999", ""] },
      ],
    };
  },

  /* Mint and TravelPay reconcile against the statement page: their errors are
     a reference that is not there, an amount that disagrees, a supplier that
     disagrees, and a typed total that does not add up. */
  mint: () => ({
    file: "demo-mint-5.csv",
    headers: ["From Company", "From Company Number", "To Company ", "To Company Number", "Transaction Reference",
              "Amount", "Currency", "Status", "Created Time", "Authorised Time", "Updated Time", "Due Time",
              "Recipient Reference", "Sender Reference", "Settlement Amt", "Statement Date"],
    rows: [
      { why: "on the page, right amount, right supplier", expect: "Reconciled — no remark",
        cells: ["RAA", "M363355", "READY ROOMS", "", "P.0000004123", "400.00", "AUD", "Pending at Bank",
                "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "MNT1", "MNT1", "", "2026-08-29"] },
      { why: "amount disagrees with the page", expect: "Reconciled, with the amount difference reported",
        cells: ["RAA", "M363355", "READY ROOMS", "", "P.0000004124", "612.50", "AUD", "Pending at Bank",
                "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "MNT2", "MNT2", "", "2026-08-29"] },
      { why: "supplier disagrees with the page", expect: "Reconciled, with the supplier difference reported",
        cells: ["RAA", "M363355", "SOMEONE ELSE PTY LTD", "", "P.0000004125", "150.00", "AUD", "Pending at Bank",
                "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "MNT3", "MNT3", "", "2026-08-29"] },
      { why: "reference is not on the page at all", expect: "Not reconciled — \"not among the transactions on this page\"",
        cells: ["RAA", "M363355", "TEMPO HOLIDAYS", "", "P.9999999999", "88.20", "AUD", "Pending at Bank",
                "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "MNT4", "MNT4", "", "2026-08-29"] },
      { why: "makes the file total disagree with the typed Transaction Total",
        expect: "run remark \"Total transaction amounts does not match.\"",
        cells: ["RAA", "M363355", "READY ROOMS", "", "P.0000004126", "1.11", "AUD", "Pending at Bank",
                "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "MNT5", "MNT5", "", "2026-08-29"] },
    ],
  }),

  travelpay: () => ({
    file: "demo-travelpay-5.csv",
    headers: ["Processing Date", "Merchant Settlement Date", "MerchantCompanyName", "Base Amount",
              "Processed Amount", "Payment Reference", "Transaction Status", "Additional Reference"],
    rows: [
      { why: "on the page, right amount", expect: "Reconciled — no remark",
        cells: ["2026-08-29", "2026-08-29", "Monarto Resort Pty Ltd", "1480.88", "1480.88", "31282716", "Successful", "Client - 128380"] },
      { why: "amount disagrees with the page", expect: "Reconciled, with the amount difference reported",
        cells: ["2026-08-29", "2026-08-29", "Monarto Resort Pty Ltd", "1735.84", "1799.99", "31282311", "Successful", "Client - B128297"] },
      { why: "reference is not on the page", expect: "Not reconciled — not in Reference and not a transaction number",
        cells: ["2026-08-29", "2026-08-29", "Monarto Resort Pty Ltd", "640.00", "640.00", "99999999", "Successful", "Client - 128401"] },
      { why: "did not succeed — held back, not counted as missing", expect: "held back rather than reported missing",
        cells: ["2026-08-29", "2026-08-29", "Monarto Resort Pty Ltd", "215.00", "215.00", "31282900", "Failed", "Client - 128402"] },
      { why: "makes the file total disagree with the typed Transaction Total",
        expect: "run remark \"Total transaction amounts does not match.\"",
        cells: ["2026-08-29", "2026-08-29", "Monarto Resort Pty Ltd", "2.22", "2.22", "31282901", "Successful", "Client - 128403"] },
    ],
  }),

  /* IPSI's four remark strings, one per row, plus a refund so the negative
     path is on screen too. */
  ipsi: () => {
    const b = realBookings("ipsi");
    const no = (i, fallback) => (b[i] ? b[i].bookingNo : fallback);
    return {
      file: "demo-ipsi-5.csv",
      headers: ["Transaction Reference", "Transaction Time stamp", "Transaction Type", "Transaction Status",
                "Channel", "Transaction Amount", "Settlement Date", "Card Type", "Custom 5",
                "Booking Number", "Settlement Amount", "Tramada Payment Number"],
      rows: [
        { why: "matches a receipt exactly", expect: "Reconciled — no remark",
          cells: ["REF-D1", "2026-08-29", "1", "APPROVED", "terminal", "145.54", "2026-08-29", "VISA", "Purchase (1)", no(0, "PLACEHOLDER-1"), "", ""] },
        { why: "amount out by more than $0.03", expect: "\"Incorrect amount\" (BR07)",
          cells: ["REF-D2", "2026-08-29", "1", "APPROVED", "terminal", "200.75", "2026-08-29", "VISA", "Purchase (1)", no(1, "PLACEHOLDER-2"), "", ""] },
        { why: "booking number is not one Tramada knows", expect: "\"Booking number mismatch or not found\" (BR06)",
          cells: ["REF-D3", "2026-08-29", "1", "APPROVED", "terminal", "790.00", "2026-08-29", "VISA", "Purchase (1)", "999999", "", ""] },
        { why: "reference does not match Tramada's", expect: "\"Incorrect payment reference\" (BR10)",
          cells: ["NOT-THE-REF", "2026-08-29", "1", "APPROVED", "terminal", "310.00", "2026-08-29", "VISA", "Purchase (1)", no(2, "PLACEHOLDER-3"), "", ""] },
        { why: "a refund — type 20, flipped negative by step 5", expect: "negative amount, ticked in Payments To Reconcile",
          cells: ["REF-D5", "2026-08-29", "20", "APPROVED", "terminal", "120.00", "2026-08-29", "VISA", "Refund (20)", no(0, "PLACEHOLDER-1"), "", ""] },
      ],
    };
  },
};

const csvCell = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const which = pick.length ? pick : Object.keys(PLANS);
let wrote = 0;
for (const kind of which) {
  if (!PLANS[kind]) { console.error(`  unknown payment type: ${kind}`); continue; }
  const plan = PLANS[kind]();
  const lines = [plan.headers.map(csvCell).join(",")]
    .concat(plan.rows.map((r) => r.cells.map(csvCell).join(",")));
  const dest = path.join(OUT, plan.file);
  fs.writeFileSync(dest, lines.join("\n") + "\n");
  wrote++;

  console.log(`\n\x1b[1m${kind.toUpperCase()}\x1b[0m  →  csv_uploads/${plan.file}`);
  const total = plan.rows.reduce((a, r) => {
    const n = r.cells.map((c) => Number(c)).filter((n) => !Number.isNaN(n) && n > 0);
    return a;
  }, 0);
  plan.rows.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.why}`);
    console.log(`     → ${r.expect}`);
  });
  const holders = plan.rows.filter((r) => r.cells.some((c) => String(c).startsWith("PLACEHOLDER")));
  if (holders.length) {
    console.log(`  \x1b[33m${holders.length} row(s) carry PLACEHOLDER booking numbers\x1b[0m — no ` +
      `tools/created-bookings-${kind}.json to read real ones from. Run the fixture script for ${kind}, ` +
      `or paste real booking numbers into the file.`);
  }
}

for (const st of STALE) {
  console.log(`\n  \x1b[31mSTALE FIXTURES — ${st.file} ignored.\x1b[0m`);
  console.log(`  Those ${st.count} booking(s) were created under "${st.on.join(", ")}", but ` +
    `make-fixtures.js now builds ${st.which} under "${st.wanted}".`);
  console.log(`  The client's account type is what decides the receipt types Tramada offers, so`);
  console.log(`  every row against those bookings would fail the same way and you would see one`);
  console.log(`  repeated error instead of the five different ones this file is for.`);
  console.log(`      node tools/make-fixtures.js ${st.which}      # rebuild on the right client`);
  console.log(`  then run this again.`);
}

console.log(`\n  ${wrote} file(s) written to csv_uploads/.`);
console.log(`  Upload each on its own card. Rows 2-5 are MEANT to be flagged — that is the point.\n`);

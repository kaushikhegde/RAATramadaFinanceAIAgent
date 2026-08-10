/**
 * make-fixtures.js — build a day's worth of REAL Tramada data to reconcile
 * against, and the report file that matches it.
 *
 *   npm run start:chrome                 # once, and sign into Tramada in it
 *   node make-fixtures.js --dry-run      # say what it would create, touch nothing
 *   node make-fixtures.js bpay
 *   node make-fixtures.js travelpay
 *   node make-fixtures.js mint
 *   node make-fixtures.js ipsi
 *   node make-fixtures.js all            # all four, in order — never in parallel
 *
 * Each subcommand creates real bookings through the same `runFullBooking` path
 * the rest of the project uses, then writes the report file whose references
 * point at what it just made. Run the matching card afterwards and the run has
 * something true to find.
 *
 * ── Why the report file is written LAST ──────────────────────────────────────
 *
 * The whole point is that the references in the file are the ones Tramada
 * issued, not ones this script invented (CLAUDE.md §3). So nothing is written
 * until the booking — and for TravelPay the receipt — has come back with its
 * real number. A fixture whose references were made up tests the parser and
 * nothing else, which is exactly the trap `statement-csv.js` already warns
 * about.
 *
 * ── What each one covers ─────────────────────────────────────────────────────
 *
 * The CSVs are written to csv_uploads/ — the folder to open when you go to
 * upload them. The bookings each run created are listed beside this file as
 * created-bookings-{bpay,travelpay,mint}.json. `ipsi` creates no bookings.
 *
 *   bpay       bookings + costings            → csv_uploads/tramada-statement-lines.csv
 *              NO RECEIPTS, on purpose. Raising the receipt is the BPay run's
 *              entire job, so a fixture that pre-receipted the bookings would
 *              leave every row with nothing outstanding — the run would come
 *              back green while testing the opposite of what it claims to.
 *
 *   travelpay  bookings + costings + RECEIPTS → csv_uploads/travelpay-payments.csv
 *              TravelPay files nothing, so the receipts have to exist before
 *              the run looks for them. Each row's Payment Reference is the
 *              receipt number Tramada issued, digits only — that is what turns
 *              up as `Trans. No` on the statement page.
 *
 *   mint       bookings + costings + PAYMENTS → csv_uploads/mint-payments.csv
 *              Real creditor payments to READY ROOMS. Each row's Transaction
 *              Reference is the `P.` number Tramada issued.
 *
 *   ipsi       bookings + costings, then WAITS while you raise the Credit
 *              Card Swipe receipts, then writes the IPSI file pointing at
 *              them → csv_uploads/ipsi-payments.csv
 *              `--read-only` skips the bookings and takes what is waiting.
 *
 *   all        the four above, in order. Never in parallel — see makeAll().
 *
 * ── Why `ipsi` creates nothing ───────────────────────────────────────────────
 *
 * The bookings ARE created, like the other three. The RECEIPTS are not: an IPSI
 * settlement covers **Credit Card Swipe** receipts, and Tramada's swipe path
 * types a real card number into its card form. So the script makes the
 * bookings, names them, and waits while you raise the receipts — then reads
 * what is waiting and writes the file. Only receipts against the bookings that
 * run created are used, so a stray receipt cannot wander into the fixture.
 *
 * ── Mint pays money OUT ─────────────────────────────────────────────────────
 *
 * `mint` raises real CREDITOR PAYMENTS through `tramada-payment.js`, mapped
 * live on 10-08-2026. That is money leaving the trust account, so it only pays
 * what the booking is actually costed at, it never ticks the form's remittance
 * email, and it never re-clicks Issue while waiting.
 *
 * A booking with no costing owes the creditor nothing and is skipped out loud
 * rather than paid a figure this script invented.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("./recon-core");
const { runFullBooking } = require("./tramada-segments");
const { runTramadaReceipt } = require("./tramada-receipt");
const { runCreditorPayment } = require("./tramada-payment");
const { searchIssueReceipts, readReceiptsToReconcile } = require("./tramada-ipsi");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let WHAT = args.find((a) => !a.startsWith("--")) || "";
const DRY = has("--dry-run");
// `--limit 0` is honoured, unlike the older scripts where the string "0" is
// truthy and the number 0 is falsy so the limit silently vanished.
const rawLimit = valueOf("--limit", null);
const LIMIT = rawLimit == null ? null : parseInt(rawLimit, 10);
const IN = path.resolve(valueOf("--file", path.join(__dirname, "bookings.json")));
/* The CSVs land in csv_uploads/, not the repo root.
   Two reasons. It is the folder you open when you go to upload something, so
   the three files you need are the only things in it. And the root already
   holds tramada-statement-lines.csv, mint-payments.csv and
   travelpay-payments.csv as CHECKED-IN SAMPLES — real captured data the tests
   run against — which a fixture run used to overwrite. Generated files and
   sample files are different things and no longer share a name. */
const CSV_DIR = path.resolve(valueOf("--out-dir", path.join(__dirname, "csv_uploads")));
// The booking records are not something you upload, so they stay out of it.
const OUT_DIR = __dirname;

function csvOut(name) {
  fs.mkdirSync(CSV_DIR, { recursive: true });
  return path.join(CSV_DIR, name);
}
const shortPath = (p) => path.relative(__dirname, p) || path.basename(p);
// The creditor the Mint fixture pays. Only creditors with something payable
// on the booking are offered by the form, so this has to match what the
// bookings are costed to.
const CREDITOR = valueOf("--creditor", "READY ROOMS");
// The debtor whose card receipts an IPSI settlement covers.
const IPSI_DEBTOR = valueOf("--debtor", "MASTER");

/**
 * A tag that is different every run, and the references built from it.
 *
 * References used to be `TRAVELPAY-13196` / `MINT-13196` / `FIXTURE0001` —
 * worked out from the booking number, or in IPSI's case from nothing at all.
 * That is wrong in three ways:
 *
 *   - `FIXTURE0001` is the SAME on every IPSI run ever. Two runs produce two
 *     settlements carrying identical transaction references.
 *   - Retry a booking whose receipt failed and the reference repeats. Both
 *     `readLatestReceipt` and `findIssuedPayment` find a receipt BY reference,
 *     so a repeat lets the run read back the wrong transaction and report a
 *     number that belongs to an earlier attempt.
 *   - Nothing in the real world works this way. RAA's references come from a
 *     payment provider and are never reused, so a fixture that reuses them
 *     tests a case that cannot happen and skips the one that does.
 *
 * Random, not a counter or a timestamp: a counter needs state that survives the
 * process, and two runs started in the same second share a timestamp.
 *
 * `--tag ABC12` pins it, for when you want a second run to be findable
 * alongside the first.
 */
const RUN = String(valueOf("--tag", "")).trim().toUpperCase() ||
  require("crypto").randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, "0").slice(-5);

/**
 * Short on purpose. Nothing reads Tramada's reference field back, so if it has
 * a maxlength a longer reference is silently truncated and the lookup after
 * Issue then fails to find money that was really taken. `TP-K3F9Q-13196` is 14
 * characters — shorter than "Deposit - Jill Shields", which the live statement
 * carries — and the drivers now read the field back either way.
 */
const ref = (kind, bookingNo) => `${kind}-${RUN}-${bookingNo}`;

const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };
const say = (m) => console.log(`  ${m}`);

function loadBookings() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(IN, "utf8")); }
  catch (e) { die(`Can't read ${path.basename(IN)}: ${e.message}`); }
  const list = Array.isArray(doc) ? doc : doc.bookings;
  if (!Array.isArray(list) || !list.length) die(`${path.basename(IN)} has no "bookings" array.`);
  return LIMIT == null ? list : list.slice(0, LIMIT);
}

/**
 * What a booking is costed at, in cents — EVERY allocatable row, not just some.
 *
 * This figure becomes the receipt amount, and the receipt is allocated with
 * `allocation: "ALL"` — which clicks Tramada's Select All and ticks every row
 * on the form. So it has to be the total of every row that form will show, or
 * Tramada refuses the receipt outright:
 *
 *     Allocation cannot be greater than Amount Received
 *
 * It did, on three real bookings, because this used to `return` the costings
 * and never look at the segments:
 *
 *     const fares = ...; if (fares.length) return fares.reduce(...)
 *
 * A booking with a 200.00 ticket and a 60.00 hotel was receipted for 200.00
 * while Select All allocated 260.00. Both halves are counted now.
 *
 * A hotel's Debtor Due is rate x nights x rooms, NOT the rate — verified live
 * on booking 13127, where 100.00 over 2 nights produced Due inc GST 200.00.
 * Reading the rate alone is what made booking 13196 ask for 75.00 against a
 * 150.00 row.
 *
 * A flight contributes nothing on its own; its ticket costing is the row. A
 * booking with neither owes nothing, and that is a real outcome the BPay run
 * has to handle rather than something to paper over.
 */
function costedCents(b) {
  const fares = (b.costings || [])
    .map((c) => core.cents(c.fare) || 0)
    .reduce((a, n) => a + n, 0);
  const stays = (b.segments || []).reduce((a, s) => {
    const rate = core.cents(s.rate);
    if (rate == null) return a;                       // flights carry no rate
    const nights = Number(s.nights) > 0 ? Number(s.nights) : 1;
    const rooms = Number(s.rooms) > 0 ? Number(s.rooms) : 1;
    return a + rate * nights * rooms;
  }, 0);
  return fares + stays;
}

/**
 * The amount to put on a BPay row, chosen to exercise a DIFFERENT outcome per
 * booking.
 *
 * `statement-csv.js` already says why: with random or identical amounts a run
 * can come back entirely "Not allocated" and demonstrate nothing. Three
 * bookings, three outcomes, on purpose:
 *
 *   0  exactly what it owes        → Allocated
 *   1  more than it owes           → Part allocated (the rest stays unallocated)
 *   2  less than its cheapest      → Not allocated (the receipt is still filed)
 *
 * Past the third booking it repeats the cycle.
 */
function bpayCents(b, i) {
  const due = costedCents(b);
  if (!due) return 15000;                       // owes nothing — any figure files unallocated
  const outcome = i % 3;
  if (outcome === 0) return due;
  if (outcome === 1) return due + 5000;
  return Math.max(100, Math.floor(due / 2) - 100);
}

/**
 * Create one booking with its segments and costings, and hand back its number.
 *
 * `receipt: null` and `dryRunReceipt: true` together are a belt and braces:
 * creating bookings and taking money are different decisions, and this step is
 * only authorised to make the first (the same rule `run-bookings.js` follows).
 */
async function createBooking(b, i, total) {
  const tag = `[${i + 1}/${total}] ${b.label || b.clientCode}`;
  say(tag);
  const res = await runFullBooking({
    username: process.env.TRAMADA_USERNAME,
    password: process.env.TRAMADA_PASSWORD,
    clientCode: b.clientCode,
    booking: b.booking,
    segments: b.segments || [],
    costings: b.costings || [],
    receipt: null,
    dryRunReceipt: true,
    callbacks: {
      onProgress: (p, m) => console.log(`       [${String(p).padStart(3)}%] ${m}`),
      onStage: (name, d) => { if (name === "booking" && d && d.bookingNo) say(`     → booking ${d.bookingNo}`); },
      onError: (m) => console.error(`       ERROR: ${m}`),
      onNeedLogin: () =>
        say("     Sign into Tramada in the Chrome on port 9222 — I'll wait, and I never type credentials."),
    },
  });
  if (!res || !res.bookingNo) throw new Error("finished without returning a booking number");
  return String(res.bookingNo);
}

/** Every booking in the file, written down as they come back. */
async function createBookings(list) {
  const made = [];
  /* Named per fixture. One shared created-bookings.json meant `all` finished
     with only the last fixture's numbers in it, and the bookings the other two
     had made were findable nowhere. */
  const outPath = path.join(OUT_DIR, `created-bookings-${WHAT}.json`);
  for (const [i, b] of list.entries()) {
    try {
      const bookingNo = await createBooking(b, i, list.length);
      made.push({
        bookingNo, label: b.label || null, clientCode: b.clientCode,
        // Carried through so the report file can be written from what the
        // booking is actually costed at.
        dueCents: costedCents(b), index: i,
      });
      // After EVERY booking, not at the end: a run that dies on the third has
      // still created the first two, and a number that only existed in a dead
      // process's memory is a booking nobody can find again.
      fs.writeFileSync(outPath, JSON.stringify(made, null, 2));
      say(`     ✓ booking ${bookingNo}\n`);
    } catch (err) {
      console.error(`     ✗ stopped on booking ${i + 1}: ${core.tidyError(err.message)}`);
      console.error(`       ${made.length} booking(s) created so far are in ${path.basename(outPath)}.\n`);
      if (!made.length) process.exit(1);
      break;
    }
  }
  return made;
}

/* ── bpay: bookings and costings, then the CSV ───────────────────────────── */

/**
 * The BPay fixture is deliberately NOT receipted.
 *
 * Raising the receipt is the BPay run's entire job. Pre-receipting the bookings
 * would leave every row with nothing outstanding, the run would file receipts
 * that allocate against nothing, and the fixture would "pass" while testing the
 * opposite of what it claims to.
 */
async function makeBpay() {
  const list = loadBookings();
  say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings, no receipts.\n`);
  if (DRY) return say("Dry run — Tramada was never opened.\n");

  const made = await createBookings(list);
  const rows = made.map((b, i) => {
    const cents = bpayCents(list[b.index] || {}, i);
    return {
      Date: new Date().toISOString().slice(0, 10),
      Reference: ref("BP", b.bookingNo),
      "Rec/Pay Type": "Debtor Payment Receipt",
      Amount: core.money(cents),
      "Booking No": b.bookingNo,
      _due: b.dueCents,
      _cents: cents,
    };
  });
  const out = csvOut("tramada-statement-lines.csv");
  fs.writeFileSync(out, [
    "Date,Reference,Rec/Pay Type,Amount,Booking No",
    ...rows.map((r) => ["Date", "Reference", "Rec/Pay Type", "Amount", "Booking No"]
      .map((c) => { const s = String(r[c]); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; })
      .join(",")),
  ].join("\n") + "\n");

  say(`\n  ${shortPath(out)} — ${rows.length} row${rows.length === 1 ? "" : "s"}.`);
  // Say which outcome each row is FOR, so a run that comes back with something
  // else is obviously wrong rather than merely surprising.
  for (const r of rows) {
    const expect = !r._due ? "Not allocated (the booking owes nothing)"
      : r._cents === r._due ? "Allocated (exactly what it owes)"
      : r._cents > r._due ? "Part allocated (more than it owes)"
      : "Not allocated (less than its cheapest segment)";
    say(`     booking ${r["Booking No"]} · $${r.Amount} vs $${core.money(r._due)} owed → expect ${expect}`);
  }
  say("\n  Load it on the BPay card and press Start run — it will raise the receipts.\n");
}

/* ── travelpay: bookings, costings, RECEIPTS, then the CSV ───────────────── */

/**
 * TravelPay files nothing, so its fixture has to.
 *
 * The receipts are raised here, and the number Tramada hands back — `R.0000009403`
 * — becomes the row's Payment Reference with the punctuation and padding
 * stripped, because `receiptKey()` reduces both sides to the same key and that
 * is what the run matches on. Inventing a reference would produce a file that
 * reconciles nothing and looks like a broken matcher.
 */
async function makeTravelPay() {
  const list = loadBookings();
  say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings + receipts.\n`);
  if (DRY) return say("Dry run — Tramada was never opened.\n");

  const made = await createBookings(list);
  const rows = [];
  for (const [i, b] of made.entries()) {
    // What the booking owes, so the receipt allocates cleanly and the run has
    // an unambiguous thing to find. TravelPay only checks; it files nothing.
    const amount = core.money(b.dueCents || 148088);
    say(`Receipting booking ${b.bookingNo} for $${amount}…`);
    try {
      const filed = await runTramadaReceipt({
        username: process.env.TRAMADA_USERNAME,
        password: process.env.TRAMADA_PASSWORD,
        bookingNo: b.bookingNo,
        receipt: {
          transactionType: "EFT",
          amount,
          reference: ref("TP", b.bookingNo),
          dateReceived: new Date().toISOString().slice(0, 10),
          allocation: "ALL",
        },
        dryRun: false,
        callbacks: { onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222.") },
      });
      const receiptNo = (filed && filed.receipt && filed.receipt.receiptNo) || "";
      if (!receiptNo) throw new Error("no receipt number came back");
      // R.0000009403 → 9403. receiptKey reduces the statement's Trans. No the
      // same way, so the two meet in the middle.
      const paymentRef = core.receiptKey(receiptNo).replace(/^[A-Z]+/, "");
      say(`     ✓ ${receiptNo} → Payment Reference ${paymentRef}`);
      rows.push({
        "Processing Date": new Date().toISOString().slice(0, 10),
        "Merchant Settlement Date": new Date().toISOString().slice(0, 10),
        MerchantCompanyName: "Monarto Resort Pty Ltd",
        "Base Amount": amount,
        "Customer Fee": "0",
        "Processed Amount": amount,
        "Payment Method": "BankAccount",
        "Transaction Status": "Successful",
        "Payment Reference": paymentRef,
        "Processor Reference": receiptNo,
        "Failure Reason": "",
        "Additional Reference": `Client Name - ${b.bookingNo}`,
      });
    } catch (err) {
      console.error(`     ✗ ${core.tidyError(err.message)}`);
    }
  }
  if (!rows.length) die("No receipts were raised, so there is nothing to write.");

  const cols = Object.keys(rows[0]);
  const out = csvOut("travelpay-payments.csv");
  fs.writeFileSync(out, [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => {
      const s = String(r[c] == null ? "" : r[c]);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")),
  ].join("\n") + "\n");

  // Prove it before promising it: the file has to survive the parser the run
  // will use, or the fixture is a fixture of nothing.
  const parsed = core.parseTravelPayRows(...(({ headers, rows: rs }) => [headers, rs])(
    core.csvGrid(fs.readFileSync(out, "utf8"))));
  say(`\n  ${shortPath(out)} — ${rows.length} row${rows.length === 1 ? "" : "s"}, ` +
    `${parsed.rows.length} readable by the run's own parser` +
    (parsed.problems.length ? `, ${parsed.problems.length} held back` : "") + ".");
  say("Load it on the TravelPay card and press Start run — it will look for these receipts.\n");
}

/* ── mint: not finished, and saying so ───────────────────────────────────── */

async function makeMint() {
  const list = loadBookings();
  say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings + creditor payments to ${CREDITOR}.\n`);
  if (DRY) return say("Dry run — Tramada was never opened.\n");

  const made = await createBookings(list);
  const rows = [];
  for (const b of made) {
    // Only a costed segment is payable. The hotel-only booking has no costing,
    // so there is nothing owed to the creditor and nothing to pay — said out
    // loud rather than failing, because it is a fact about the booking.
    if (!b.dueCents) {
      say(`     – booking ${b.bookingNo} owes ${CREDITOR} nothing — no payment raised.`);
      continue;
    }
    say(`Paying ${CREDITOR} from booking ${b.bookingNo} (about $${core.money(b.dueCents)})…`);
    try {
      const out = await runCreditorPayment({
        bookingNo: b.bookingNo,
        creditor: CREDITOR,
        payment: {
          transactionType: "EFT",              // the statement shows these as ET
          /* "AUTO", not the figure worked out from bookings.json.
             The payment is allocated with "ALL", which fills every payable row
             in full, so the amount has to BE that total. Deriving it here
             instead is what sank three live receipts on the TravelPay side —
             the fixture's arithmetic and Tramada's disagreed and every one was
             refused. What is payable is a fact the form already knows. */
          amount: "AUTO",
          reference: ref("MP", b.bookingNo),
          paymentDate: new Date().toISOString().slice(0, 10),
          allocation: "ALL",
        },
        callbacks: {
          onProgress: (p, m) => console.log(`       [${String(p).padStart(3)}%] ${m}`),
          onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222."),
        },
      });
      const paymentNo = out.payment && out.payment.paymentNo;
      if (!paymentNo) throw new Error("no payment number came back");
      // The amount Tramada actually filed, not the one asked for — with "AUTO"
      // they are the same by construction, and a CSV row that disagrees with
      // the payment it names would reconcile as a difference that isn't real.
      const amount = (out.staged && out.staged.amount) || core.money(b.dueCents);
      say(`     ✓ ${paymentNo} for $${amount}`);
      /* Mint's Transaction Reference IS the payment number Tramada issued —
         `P.0000004123` in the client's own export, and `P.0000000161` on
         statement page 9. Writing anything else here would produce a file that
         reconciles nothing and looks like a broken matcher. */
      rows.push({
        "From Company": "Royal Automobile Association (RAA) of S.A. Incorporated",
        "From Company Number": "M363355",
        "To Company ": CREDITOR,
        "To Company Number": "",
        "Transaction Reference": paymentNo,
        Amount: amount,
        Currency: "AUD",
        Status: "Pending at Bank",
        "Recipient Reference": ref("MP", b.bookingNo),
        "Sender Reference": ref("MP", b.bookingNo),
        "Settlement Amt": "",
        "Statement Date": new Date().toISOString().slice(0, 10),
      });
    } catch (err) {
      console.error(`     ✗ ${core.tidyError(err.message)}`);
    }
  }
  if (!rows.length) die("No payments were raised, so there is nothing to write.");

  const cols = Object.keys(rows[0]);
  const out = csvOut("mint-payments.csv");
  fs.writeFileSync(out, [
    cols.map(csvField).join(","),
    ...rows.map((r) => cols.map((c) => csvField(r[c])).join(",")),
  ].join("\n") + "\n");

  // Prove it before promising it: the file has to survive the parser the run
  // will actually use, or the fixture is a fixture of nothing.
  const grid = core.csvGrid(fs.readFileSync(out, "utf8"));
  const parsed = core.parseMintRows(grid.headers, grid.rows);
  say(`\n  ${shortPath(out)} — ${rows.length} row${rows.length === 1 ? "" : "s"}, ` +
    `${parsed.rows.length} readable by the run's own parser` +
    (parsed.problems.length ? `, ${parsed.problems.length} held back` : "") + ".");
  if (parsed.rows.length !== rows.length) {
    die("The file it just wrote does not parse cleanly — that is a bug here, not in the run.");
  }
  say("Load it on the Mint card and press Start run — it will look for these payments.\n");
}

/** One CSV field, quoted only when it has to be. */
function csvField(v) {
  const t = String(v == null ? "" : v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/* ── ipsi: bookings, then YOUR receipts, then the file ───────────────────── */

/** Drive the Finance Receipts search once and read what is waiting. */
async function readWaitingReceipts(quiet) {
  const browser = await chromium.connectOverCDP(
    `http://${process.env.CDP_HOST || "127.0.0.1"}:${process.env.CDP_PORT || 9222}`);
  let page;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    const popup = await searchIssueReceipts(page, {
      debtorCode: IPSI_DEBTOR,
      toDate: new Date().toISOString().slice(0, 10),
    }, quiet ? () => {} : (m) => say("  " + m));
    return await readReceiptsToReconcile(popup);
  } finally {
    try { if (page) await page.close(); } catch { /* already gone */ }
    try { await browser.close(); } catch { /* CDP: drops the connection */ }
  }
}

/**
 * Bookings, then a pause for a human, then the settlement file.
 *
 * The bookings ARE created here, exactly like the other three. What cannot be
 * automated is the receipt: an IPSI settlement covers **Credit Card Swipe**
 * receipts, and Tramada's swipe path types a real card number into its card
 * form. So the script makes the bookings, tells you which ones, and waits while
 * you raise the receipts against them — the same "the human does this bit and
 * we wait" shape `ensureLoggedIn` already uses for signing in.
 *
 * Then it reads what is waiting and writes a file pointing at it. Only receipts
 * against the bookings THIS run created are included, so an unrelated receipt
 * sitting on the screen does not wander into the fixture.
 *
 * `--read-only` skips the bookings and takes whatever is already waiting.
 */
async function makeIpsi() {
  const readOnly = has("--read-only");
  let mine = null;

  if (!readOnly) {
    const list = loadBookings();
    say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings.`);
    say("The receipts are yours to raise: an IPSI settlement covers Credit Card Swipe");
    say("receipts, and that form wants a real card number.\n");
    if (DRY) return say("Dry run — Tramada was never opened.\n");
    const made = await createBookings(list);
    mine = new Set(made.map((b) => String(b.bookingNo)));

    console.log("");
    say("──────────────────────────────────────────────────────────────");
    say("NOW, IN TRAMADA, raise a Credit Card Swipe receipt against each of:");
    for (const b of made) say(`     booking ${b.bookingNo}   ($${core.money(b.dueCents || 0)} outstanding)`);
    say(`Receipt category: Client Payment Receipt · Debtor ${IPSI_DEBTOR}`);
    say("──────────────────────────────────────────────────────────────\n");
  } else if (DRY) {
    return say("Dry run — would read whatever is already waiting.\n");
  }

  // Poll rather than demand the receipts already exist. Ten minutes is the same
  // patience `ensureLoggedIn` shows a person signing in.
  const deadline = Date.now() + 10 * 60 * 1000;
  let waiting = [];
  let first = true;
  for (;;) {
    let all = [];
    try { all = await readWaitingReceipts(!first); }
    catch (err) { die(`Could not read the Finance Receipts screen: ${core.tidyError(err.message)}`); }
    waiting = mine ? all.filter((r) => mine.has(String(r.bookingNo))) : all;
    if (waiting.length) break;
    if (Date.now() > deadline) {
      die(readOnly
        ? `Nothing is waiting to be reconciled for ${IPSI_DEBTOR}.`
        : "No receipts appeared against those bookings in ten minutes.\n\n" +
          "  The bookings are made and listed in created-bookings-ipsi.json. Raise the\n" +
          "  receipts whenever you like, then: node make-fixtures.js ipsi --read-only");
    }
    if (first) say(`Waiting for receipts against ${mine ? "those bookings" : IPSI_DEBTOR}… (checking every 20s)`);
    first = false;
    await new Promise((r) => setTimeout(r, 20000));
  }

  say(`\n  ${waiting.length} receipt${waiting.length === 1 ? "" : "s"} waiting.`);

  const today = new Date().toISOString().slice(0, 10);
  const rows = waiting.map((r, i) => ({
    "Transaction Reference": ref("IP", String(i + 1).padStart(4, "0")),
    "Transaction Time stamp": today,
    "Transaction Type": "1",
    "Transaction Status": "APPROVED",
    Channel: "terminal",
    "Card Holder Name": r.cardHolder || "Cardholder name",
    "Transaction Amount": core.money(core.cents(r.receiptAmount)),
    "Settlement Date": today,
    /* The receipt's OWN reference when it has one — that is what the run
       matches on. Without one (two of four on the live screen) a synthesised
       value that cannot match, so the row exercises the Booking No. + Amount
       fallback on purpose. One file, both paths. */
    "Merchant Reference": r.reference || ref(r.bookingNo, String(i + 1).padStart(4, "0")),
    "Card Type": "VISA",
    "Custom 5": "Purchase (1)",
    "Booking Number": r.bookingNo,
    "Settlement Amount": "",
    "Tramada Payment Number": "",
  }));
  const total = rows.reduce((a, x) => a + (core.cents(x["Transaction Amount"]) || 0), 0);
  // The file states its own settlement total on ONE row, as the client's does.
  rows[rows.length - 1]["Settlement Amount"] = core.money(total);

  const cols = Object.keys(rows[0]);
  const out = csvOut("ipsi-payments.csv");
  fs.writeFileSync(out, [cols.map(csvField).join(","),
    ...rows.map((r) => cols.map((c) => csvField(r[c])).join(","))].join("\n") + "\n");

  // Prove it against the parser AND the matcher the run will use.
  const grid = core.csvGrid(fs.readFileSync(out, "utf8"));
  const parsed = core.parseIpsiRows(grid.headers, grid.rows);
  const matched = parsed.rows.map((row) => core.matchIpsiAgainstReceipts(row, waiting));
  const onRef = matched.filter((m) => m.matched && m.on === "reference").length;
  const onBkg = matched.filter((m) => m.matched && m.on === "booking").length;

  say(`\n  ${shortPath(out)} — ${rows.length} row${rows.length === 1 ? "" : "s"}, $${core.money(total)}.`);
  say(`     ${parsed.rows.length} readable, ${matched.filter((m) => m.matched).length} match what is on screen ` +
      `(${onRef} on reference, ${onBkg} on booking).`);
  if (!parsed.settlement.agrees) die("The file it just wrote does not add up to its own settlement figure.");
  if (matched.some((m) => !m.matched)) say("     ⚠ some rows do not match — that is a bug here, not in the run.");
  say("\n  Load it on the IPSI card and press Start run.\n");
}

/* ── the command ─────────────────────────────────────────────────────────── */

/**
 * All three, ONE AFTER THE OTHER.
 *
 * Never in parallel, and that is not a preference. `runFullBooking`,
 * `runTramadaReceipt` and `runCreditorPayment` each open their own CDP
 * connection and call `browser.close()` in their finally — and over CDP that
 * tears down the SHARED Chrome, not a private one. Two of these running at once
 * would close the browser out from under each other with real bookings,
 * receipts and payments already created. The same reason a combined
 * reconciliation run does its reports in order.
 *
 * One fixture failing does not stop the next: they are independent, and two out
 * of three files is better than none.
 */
async function makeAll() {
  const order = ["bpay", "travelpay", "mint", "ipsi"];
  const outcome = [];
  for (const what of order) {
    console.log(`\n  ── ${what} ${"─".repeat(Math.max(0, 60 - what.length))}\n`);
    WHAT = what;                       // so created-bookings-<what>.json is named right
    try {
      await JOBS[what]();
      outcome.push([what, "done"]);
    } catch (err) {
      console.error(`\n  ${what} failed: ${core.tidyError(err.message)}\n`);
      outcome.push([what, `failed — ${core.tidyError(err.message)}`]);
    }
  }
  console.log("\n  ── summary ───────────────────────────────────────────────\n");
  for (const [what, how] of outcome) console.log(`     ${what.padEnd(10)} ${how}`);
  console.log("");
  if (outcome.some(([, how]) => how !== "done")) process.exitCode = 1;
}

const JOBS = { bpay: makeBpay, travelpay: makeTravelPay, mint: makeMint, ipsi: makeIpsi, all: makeAll };

/* Exported so the reference scheme can be tested without opening Tramada. The
   run below is behind `require.main`, so requiring this file creates nothing. */
module.exports = { RUN, ref, costedCents, bpayCents };

if (require.main === module) (async () => {
  if (!JOBS[WHAT]) {
    die(
      "Which fixture?\n\n" +
      "    node make-fixtures.js bpay        bookings + costings, then the BPay CSV\n" +
      "    node make-fixtures.js travelpay   bookings + costings + receipts, then the TravelPay CSV\n" +
      "    node make-fixtures.js mint        bookings + costings + creditor payments, then the Mint CSV\n" +
      "    node make-fixtures.js ipsi        bookings, then waits for your swipe receipts, then the IPSI CSV\n" +
      "    node make-fixtures.js all         all four, one after the other\n\n" +
      "  --dry-run   say what it would create, touch nothing\n" +
      "  --limit N   only the first N bookings in the file\n" +
      "  --file      a bookings JSON other than bookings.json\n" +
      "  --creditor  who the Mint payments go to (default READY ROOMS)\n" +
      "  --out-dir   where the CSVs land (default csv_uploads/)\n" +
      "  --debtor    whose card receipts the IPSI file covers (default MASTER)\n" +
      "  --read-only for `ipsi`: skip the bookings, use what is already waiting\n" +
      "  --tag XXXXX pin this run's reference tag instead of a random one"
    );
  }
  console.log("");
  // Said out loud, once: every reference this run writes carries this tag, so
  // one search in Tramada finds the whole run — and a later run cannot be
  // mistaken for it.
  say(`run tag ${RUN} — references look like ${ref("TP", "13196")}\n`);
  await JOBS[WHAT]();
})().catch((e) => { console.error("\n  Failed:", e.message, "\n"); process.exit(1); });

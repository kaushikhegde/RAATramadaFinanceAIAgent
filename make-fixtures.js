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
 * created-bookings-{bpay,travelpay,mint,ipsi}.json.
 *
 * ── The file is written AS THE WORK HAPPENS ──────────────────────────────────
 *
 * A row goes down the moment the thing it describes exists, and the file is
 * rewritten each time. Not at the end, behind `if (!rows.length) die(...)` —
 * that is what a Mint run did after creating two real bookings and failing at
 * the payment form: no file, two bookings, nothing naming them.
 *
 * A column that can only come from a later step — a receipt number, a `P.`
 * number — is left blank and filled in when that step succeeds. If it never
 * does, the row still names a real booking and a real amount, and the run says
 * which rows need a value pasted in by hand.
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
 *              reference the receipt was raised under — TP-{tag}-{booking} —
 *              because that is what a real TravelPay file carries there and it
 *              is what the statement page shows in its Reference column.
 *
 *   mint       bookings + costings + PAYMENTS → csv_uploads/mint-payments.csv
 *              Real creditor payments to READY ROOMS. Each row's Transaction
 *              Reference is the `P.` number Tramada issued.
 *
 *   ipsi       bookings + costings, then the file → csv_uploads/ipsi-payments.csv
 *              It does NOT go looking for your receipts. The Merchant
 *              Transaction Reference column is left blank for you to paste
 *              in once you have raised the Credit Card Swipe receipts.
 *
 *   all        the four above, in order. Never in parallel — see makeAll().
 *
 * ── Why `ipsi` raises no receipts ───────────────────────────────────────────
 *
 * The bookings ARE created, like the other three. The RECEIPTS are not: an IPSI
 * settlement covers **Credit Card Swipe** receipts, and Tramada's swipe path
 * types a real card number into its card form. That is yours to do.
 *
 * It used to create the bookings and then poll Tramada's Finance Receipts
 * screens — chooser, search, popup — for ten minutes waiting for those receipts
 * to appear, and write nothing if they did not. It no longer looks them up at
 * all: the file is written from the bookings, with Merchant Reference blank for
 * you. That column is what the run matches on, and a value invented here would
 * produce a file that reconciles nothing and looks like a broken matcher.
 *
 * ── Mint pays money OUT ─────────────────────────────────────────────────────
 *
 * `mint` raises real CREDITOR PAYMENTS through `tramada-payment.js`, mapped
 * live on 10-08-2026. That is money leaving the trust account, so it only pays
 * what the FORM says is payable, it never ticks the form's remittance email,
 * and it never re-clicks Issue while waiting.
 *
 * It receipts the client FIRST. A costed segment is not payable to a creditor
 * until the client's money has been received and allocated against it — money
 * in before money out — and skipping that leaves the payment form with an
 * empty Segments To Allocate table.
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
/* No playwright here any more. Every browser step goes through one of the
   tramada-* modules, which each open and close their own CDP connection. The
   IPSI fixture used to reach for chromium directly to drive the Finance
   Receipts search; it does not look receipts up at all now. */

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

/** One CSV field, quoted only when it has to be. */
function csvField(v) {
  const t = String(v == null ? "" : v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/**
 * A CSV that is on disk from the first row onwards.
 *
 * The fixtures used to build every row in memory and write the file at the very
 * end, guarded by `if (!rows.length) die("nothing to write")`. So a Mint run
 * that created two REAL bookings in Tramada and then failed at the payment
 * form wrote no file at all — the bookings existed, cost real work, and the
 * only record of them was a booking-numbers JSON and the scrollback.
 *
 * Now a row is added the moment the thing it describes exists, and the file is
 * rewritten each time. Rewriting rather than appending because a later step
 * fills fields in on a row that is already down — the payment number lands on
 * a row written when the booking was made.
 *
 * `blanks` names the columns a later step is supposed to fill. Any row still
 * missing one at the end is reported by name, so "you fill in the reference"
 * is something the run tells you rather than something you have to notice.
 */
function csvWriter(name, cols, blanks = []) {
  const out = csvOut(name);
  const rows = [];
  const flush = () => fs.writeFileSync(out, [
    cols.map(csvField).join(","),
    ...rows.map((r) => cols.map((c) => csvField(r[c])).join(",")),
  ].join("\n") + "\n");
  return {
    path: out,
    rows,
    /** Put a row down now. Returns it, so a later step can fill fields in. */
    add(row) { rows.push(row); flush(); return row; },
    /** A row changed — write the file again. */
    update() { flush(); },
    /** Which rows are still waiting on a human, and for what. */
    unfilled() {
      return rows
        .map((r, i) => ({ i, row: r, missing: blanks.filter((c) => !String(r[c] || "").trim()) }))
        .filter((x) => x.missing.length);
    },
  };
}

/**
 * Say which rows still need a hand, and where to get the value.
 *
 * A file with a blank column in it is only useful if you are told the column is
 * blank. Silence here would be the same mistake as writing no file at all,
 * just quieter.
 */
function reportUnfilled(csv, column, whereFrom) {
  const gaps = csv.unfilled();
  if (!gaps.length) return;
  console.log("");
  say(`  ${gaps.length} row${gaps.length === 1 ? " has" : "s have"} no ${column} yet — fill in ${whereFrom}:`);
  for (const g of gaps) {
    const bkg = g.row["Booking Number"] || g.row["Booking No"] ||
      String(g.row["Additional Reference"] || "").split("-").pop().trim() || "?";
    const amt = g.row["Transaction Amount"] || g.row["Base Amount"] || g.row.Amount || "";
    say(`     row ${g.i + 1}: booking ${bkg}${amt ? ` · $${amt}` : ""}` +
      (g.row["Failure Reason"] ? `  (${g.row["Failure Reason"]})` : ""));
  }
  say(`  The rest of ${path.basename(csv.path)} is already correct.`);
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

/**
 * Every booking in the file, written down as they come back.
 *
 * `onEach(record, sourceBooking)` runs the moment a booking exists, before the
 * next one is started. That is where the report file's row gets written — a
 * booking that Tramada has and the CSV has not is a booking nobody can
 * reconcile and nobody will remember making.
 */
async function createBookings(list, onEach) {
  const made = [];
  /* Named per fixture. One shared created-bookings.json meant `all` finished
     with only the last fixture's numbers in it, and the bookings the other two
     had made were findable nowhere. */
  const outPath = path.join(OUT_DIR, `created-bookings-${WHAT}.json`);
  for (const [i, b] of list.entries()) {
    try {
      const bookingNo = await createBooking(b, i, list.length);
      const record = {
        bookingNo, label: b.label || null, clientCode: b.clientCode,
        // Carried through so the report file can be written from what the
        // booking is actually costed at.
        dueCents: costedCents(b), index: i,
      };
      made.push(record);
      // After EVERY booking, not at the end: a run that dies on the third has
      // still created the first two, and a number that only existed in a dead
      // process's memory is a booking nobody can find again.
      fs.writeFileSync(outPath, JSON.stringify(made, null, 2));
      if (onEach) onEach(record, b);
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

  // A BPay row needs nothing but the booking and an amount, so it is written
  // the moment the booking exists — not after the last one, where a failure
  // three bookings in used to throw away the two that worked.
  const csv = csvWriter("tramada-statement-lines.csv",
    ["Date", "Reference", "Rec/Pay Type", "Amount", "Booking No"]);
  const meta = [];
  const made = await createBookings(list, (b) => {
    const cents = bpayCents(list[b.index] || {}, b.index);
    csv.add({
      Date: new Date().toISOString().slice(0, 10),
      Reference: ref("BP", b.bookingNo),
      "Rec/Pay Type": "Debtor Payment Receipt",
      Amount: core.money(cents),
      "Booking No": b.bookingNo,
    });
    meta.push({ due: b.dueCents, cents });
    say(`     → ${shortPath(csv.path)} now has ${csv.rows.length} row(s)`);
  });
  if (!made.length) return;
  const rows = csv.rows.map((r, i) => ({ ...r, _due: meta[i].due, _cents: meta[i].cents }));
  const out = csv.path;

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

  const TP_COLS = ["Processing Date", "Merchant Settlement Date", "MerchantCompanyName",
    "Base Amount", "Customer Fee", "Processed Amount", "Payment Method", "Transaction Status",
    "Payment Reference", "Processor Reference", "Failure Reason", "Additional Reference"];
  /* Payment Reference is the receipt number Tramada issues, so it is the one
     thing here that cannot be known when the booking is made. The row goes
     down anyway, with that column blank, and is filled in when the receipt
     comes back. A receipt that fails leaves a row naming a real booking and a
     real amount — something to fill in by hand — instead of nothing at all. */
  const csv = csvWriter("travelpay-payments.csv", TP_COLS, ["Payment Reference"]);
  const today = new Date().toISOString().slice(0, 10);

  const made = await createBookings(list, (b) => {
    csv.add({
      "Processing Date": today,
      "Merchant Settlement Date": today,
      MerchantCompanyName: "Monarto Resort Pty Ltd",
      "Base Amount": core.money(b.dueCents || 148088),
      "Customer Fee": "0",
      "Processed Amount": core.money(b.dueCents || 148088),
      "Payment Method": "BankAccount",
      "Transaction Status": "Successful",
      "Payment Reference": "",
      "Processor Reference": "",
      "Failure Reason": "",
      "Additional Reference": `Client Name - ${b.bookingNo}`,
    });
    say(`     → ${shortPath(csv.path)} now has ${csv.rows.length} row(s)`);
  });

  for (const [i, b] of made.entries()) {
    const row = csv.rows[i];
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
      /* Payment Reference is TRAVELPAY's number, not Tramada's.
         The client's own export carries `31282716` there — a merchant gateway
         id — and it reaches Tramada because it is typed into the receipt's
         Reference field, which is where the statement page shows it. So the
         reference this run typed IS the Payment Reference.

         It used to be `core.receiptKey(receiptNo).replace(/^[A-Z]+/, "")` —
         `R.0000009413` reduced to `9413` — which made the file match itself
         against the statement's Trans. No column and proved nothing about a
         real TravelPay file, whose Payment Reference can never be a Tramada
         receipt number. */
      const paymentRef = ref("TP", b.bookingNo);
      say(`     ✓ ${receiptNo} → Payment Reference ${paymentRef}`);
      row["Payment Reference"] = paymentRef;
      // The processor's own id in the real file (`PR.46nyrd`). Tramada's
      // receipt number is the only second id a fixture has, and nothing
      // matches on this column, so it is the traceable thing to put here.
      row["Processor Reference"] = receiptNo;
      csv.update();
    } catch (err) {
      console.error(`     ✗ ${core.tidyError(err.message)}`);
      row["Failure Reason"] = core.tidyError(err.message);
      csv.update();
    }
  }
  if (!csv.rows.length) return say("No bookings were created, so there is nothing to write.\n");
  const out = csv.path;

  // Prove it before promising it: the file has to survive the parser the run
  // will use, or the fixture is a fixture of nothing.
  const parsed = core.parseTravelPayRows(...(({ headers, rows: rs }) => [headers, rs])(
    core.csvGrid(fs.readFileSync(out, "utf8"))));
  say(`\n  ${shortPath(out)} — ${csv.rows.length} row${csv.rows.length === 1 ? "" : "s"}, ` +
    `${parsed.rows.length} readable by the run's own parser` +
    (parsed.problems.length ? `, ${parsed.problems.length} held back` : "") + ".");
  reportUnfilled(csv, "Payment Reference", "the receipt number, digits only");
  say("Load it on the TravelPay card and press Start run — it will look for these receipts.\n");
}

/* ── mint: RECEIPT FIRST, then the payment ───────────────────────────────── */

/**
 * The client's money comes IN before the creditor's goes OUT. Always.
 *
 * This is the step the first real Mint run skipped, and the form said so as
 * plainly as it could:
 *
 *     The payment form's segment table has no "Creditor Payable" column
 *
 * — because the table had no rows at all. A costed segment is not payable to
 * the creditor until the client's receipt has been taken and allocated against
 * it. That is trust accounting, not a Tramada quirk: you cannot pay a supplier
 * out of money you have not received. So a booking that has only been costed
 * shows an empty Segments To Allocate table, and the creditor payment form has
 * nothing to offer.
 *
 * (The creditor dropdown still lists READY ROOMS, which is what made this
 * confusing — `#creditor` offers creditors the booking is COSTED to, not ones
 * it can pay right now. The field map used to claim otherwise; it was an
 * assumption, and it is corrected there now.)
 *
 * So Mint does what a real day does: receipt the client, then pay the creditor.
 */
async function makeMint() {
  const list = loadBookings();
  say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings + receipts + creditor payments to ${CREDITOR}.\n`);
  if (DRY) return say("Dry run — Tramada was never opened.\n");

  const MINT_COLS = ["From Company", "From Company Number", "To Company ", "To Company Number",
    "Transaction Reference", "Amount", "Currency", "Status", "Recipient Reference",
    "Sender Reference", "Settlement Amt", "Statement Date"];
  /* Transaction Reference IS the `P.` number Tramada issues, so it is blank
     until the payment goes through. The row still goes down when the booking is
     made: two real bookings once existed with no file naming them at all,
     because the old code built every row in memory and gave up at the end. */
  const csv = csvWriter("mint-payments.csv", MINT_COLS, ["Transaction Reference"]);
  const today = new Date().toISOString().slice(0, 10);

  const made = await createBookings(list, (b) => {
    csv.add({
      "From Company": "Royal Automobile Association (RAA) of S.A. Incorporated",
      "From Company Number": "M363355",
      "To Company ": CREDITOR,
      "To Company Number": "",
      "Transaction Reference": "",
      Amount: core.money(b.dueCents || 0),
      Currency: "AUD",
      Status: "Pending at Bank",
      "Recipient Reference": ref("MP", b.bookingNo),
      "Sender Reference": ref("MP", b.bookingNo),
      "Settlement Amt": "",
      "Statement Date": today,
      // Not a column — dropped before the file is written, kept so a half-done
      // row can still say which booking it belongs to.
      "Booking No": b.bookingNo,
    });
    say(`     → ${shortPath(csv.path)} now has ${csv.rows.length} row(s)`);
  });

  for (const [i, b] of made.entries()) {
    const row = csv.rows[i];
    // Only a costed segment is payable. A booking with no costing owes the
    // creditor nothing and there is nothing to receipt either — said out loud
    // rather than failing, because it is a fact about the booking.
    if (!b.dueCents) {
      say(`     – booking ${b.bookingNo} owes ${CREDITOR} nothing — no receipt, no payment.`);
      continue;
    }

    // 1. The money in. Without this the payment form has nothing payable.
    const amountIn = core.money(b.dueCents);
    say(`Receipting booking ${b.bookingNo} for $${amountIn} (so ${CREDITOR} becomes payable)…`);
    try {
      const receipted = await runTramadaReceipt({
        username: process.env.TRAMADA_USERNAME,
        password: process.env.TRAMADA_PASSWORD,
        bookingNo: b.bookingNo,
        receipt: {
          transactionType: "EFT",
          amount: amountIn,
          reference: ref("MR", b.bookingNo),
          dateReceived: new Date().toISOString().slice(0, 10),
          allocation: "ALL",
        },
        dryRun: false,
        callbacks: { onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222.") },
      });
      const receiptNo = (receipted && receipted.receipt && receipted.receipt.receiptNo) || "";
      if (!receiptNo) throw new Error("no receipt number came back");
      say(`     ✓ ${receiptNo} received and allocated`);
    } catch (err) {
      // No receipt means nothing is payable, so the payment would fail with the
      // empty-table message. Say why here instead, and move on.
      console.error(`     ✗ receipt failed, so there is nothing to pay: ${core.tidyError(err.message)}`);
      continue;
    }

    // 2. The money out.
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
      row["Transaction Reference"] = paymentNo;
      row.Amount = amount;
      csv.update();
    } catch (err) {
      console.error(`     ✗ ${core.tidyError(err.message)}`);
      csv.update();
    }
  }
  if (!csv.rows.length) return say("No bookings were created, so there is nothing to write.\n");
  const out = csv.path;

  // Prove it before promising it: the file has to survive the parser the run
  // will actually use, or the fixture is a fixture of nothing.
  const grid = core.csvGrid(fs.readFileSync(out, "utf8"));
  const parsed = core.parseMintRows(grid.headers, grid.rows);
  const filled = csv.rows.length - csv.unfilled().length;
  say(`\n  ${shortPath(out)} — ${csv.rows.length} row${csv.rows.length === 1 ? "" : "s"}, ` +
    `${parsed.rows.length} readable by the run's own parser` +
    (parsed.problems.length ? `, ${parsed.problems.length} held back` : "") + ".");
  // Only the rows that actually name a payment have to parse. A row still
  // waiting on its `P.` number is expected to be held back — that is the
  // parser doing its job, not a bug here.
  if (filled && parsed.rows.length < filled) {
    die("The file it just wrote does not parse cleanly — that is a bug here, not in the run.");
  }
  reportUnfilled(csv, "Transaction Reference", "the P. number from Tramada");
  say("Load it on the Mint card and press Start run — it will look for these payments.\n");
}

/* ── ipsi: bookings, then the file — YOU raise the receipts ─────────────── */

/**
 * Bookings, and the settlement file straight after — YOU raise the receipts.
 *
 * The bookings ARE created here, exactly like the other three. What cannot be
 * automated is the receipt: an IPSI settlement covers **Credit Card Swipe**
 * receipts, and Tramada's swipe path types a real card number into its card
 * form. That is yours to do.
 *
 * ── This no longer goes and finds them ───────────────────────────────────────
 *
 * It used to create the bookings, then poll Tramada's Finance Receipts screens
 * — chooser, search, popup — every twenty seconds for ten minutes, waiting for
 * your receipts to appear, and only then write the file. Three things wrong
 * with that. It made the fixture depend on the same popup flow the RUN drives,
 * so a fault there broke both. It could pick up a receipt somebody else raised.
 * And if you did not raise the receipts inside ten minutes it wrote nothing at
 * all, having created real bookings.
 *
 * So now the file is written from the bookings, the moment each one exists.
 * Every column the fixture can know is filled in; **Transaction Reference is
 * left blank for you** to paste in once you have raised the receipt. That
 * column is what the run matches on, and inventing a value would produce a file
 * that reconciles nothing and looks like a broken matcher. (Merchant Reference
 * is not read at all — two of the four rows on the live screen had none, and
 * requiring it threw those rows away before anything looked at them.)
 */
async function makeIpsi() {
  const list = loadBookings();
  say(`${list.length} booking${list.length === 1 ? "" : "s"} → bookings + costings, then the file.`);
  say("The receipts are yours to raise: an IPSI settlement covers Credit Card Swipe");
  say("receipts, and that form wants a real card number.\n");
  if (DRY) return say("Dry run — Tramada was never opened.\n");

  const IPSI_COLS = ["Transaction Reference", "Transaction Time stamp", "Transaction Type",
    "Transaction Status", "Channel", "Card Holder Name", "Transaction Amount", "Settlement Date",
    "Merchant Reference", "Card Type", "Custom 5", "Booking Number", "Settlement Amount",
    "Tramada Payment Number"];
  // Transaction Reference is what the run matches on now, so THAT is the one
  // left blank for you. Merchant Reference is not read at all.
  const csv = csvWriter("ipsi-payments.csv", IPSI_COLS, ["Transaction Reference"]);
  const today = new Date().toISOString().slice(0, 10);

  const made = await createBookings(list, (b, src) => {
    csv.add({
      // YOURS to fill in — the reference the swipe receipt was raised under.
      "Transaction Reference": "",
      "Transaction Time stamp": today,
      "Transaction Type": "1",
      "Transaction Status": "APPROVED",
      Channel: "terminal",
      "Card Holder Name": [src && src.booking && (src.booking.passengers || [])[0]]
        .filter(Boolean).map((p) => `${p.firstName} ${p.lastName}`)[0] || "Cardholder name",
      "Transaction Amount": core.money(b.dueCents || 0),
      "Settlement Date": today,
      // Not read by the run. Left blank rather than invented.
      "Merchant Reference": "",
      "Card Type": "VISA",
      "Custom 5": "Purchase (1)",
      "Booking Number": b.bookingNo,
      "Settlement Amount": "",
      "Tramada Payment Number": "",
    });
    say(`     → ${shortPath(csv.path)} now has ${csv.rows.length} row(s)`);
  });
  if (!csv.rows.length) return say("No bookings were created, so there is nothing to write.\n");

  // The file states its own settlement total on ONE row, as the client's does.
  const total = csv.rows.reduce((a, r) => a + (core.cents(r["Transaction Amount"]) || 0), 0);
  csv.rows[csv.rows.length - 1]["Settlement Amount"] = core.money(total);
  csv.update();

  const out = csv.path;
  // Prove it against the parser the run will use. The rows are held back for
  // want of a Merchant Reference — that is expected and is what you are about
  // to fix — so what is checked here is that the file is READABLE and adds up.
  const grid = core.csvGrid(fs.readFileSync(out, "utf8"));
  const parsed = core.parseIpsiRows(grid.headers, grid.rows);
  say(`\n  ${shortPath(out)} — ${csv.rows.length} row${csv.rows.length === 1 ? "" : "s"}, $${core.money(total)}.`);
  if (!parsed.settlement.agrees) die("The file it just wrote does not add up to its own settlement figure.");

  console.log("");
  say("──────────────────────────────────────────────────────────────");
  say("NOW, IN TRAMADA, raise a Credit Card Swipe receipt against each of:");
  for (const [i, b] of made.entries()) {
    say(`     row ${i + 1}   booking ${b.bookingNo}   $${core.money(b.dueCents || 0)}`);
  }
  say(`Receipt category: Client Payment Receipt · Debtor ${IPSI_DEBTOR}`);
  say("");
  say(`Then put each receipt's reference in the Transaction Reference column of`);
  say(`${shortPath(out)} — that column is what the run matches on. A row left`);
  say("blank falls back to matching on Booking Number and amount.");
  say("──────────────────────────────────────────────────────────────");
  say("\n  Then load it on the IPSI card and press Start run.\n");
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
module.exports = { RUN, ref, costedCents, bpayCents, csvWriter, csvField, csvOut };

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

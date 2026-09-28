/**
 * make-dvc-bookings.js — REAL sandbox bookings paid on the Westpac DVC card, and
 * the two spreadsheets that reconcile against them 100%.
 *
 *   npm run start:chrome                           # once, and sign into Tramada in it
 *   npm run fixtures:dvc:tramada -- --dry-run      # say what it would create, touch nothing
 *   npm run fixtures:dvc:tramada -- --limit 1      # one booking — try the chain small
 *   npm run fixtures:dvc:tramada                   # all of them
 *   npm run fixtures:dvc:tramada -- --date 2026-09-24   # a settlement day not run before gets a fresh
 *                                                       # batch of real bookings; a day already run is
 *                                                       # resumed, never re-booked or duplicated
 *
 *   --date YYYY-MM-DD   settlement date written into the Westpac file (default today)
 *   --account retail|corporate   default retail — see ACCOUNTS
 *   --card "<label>"    the DVC card AS TRAMADA'S DROPDOWN SHOWS IT
 *                       (default $DVC_CARD, else "Westpac DVC VCC")
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `make-dvc-fixtures.js` writes the two DVC spreadsheets offline, and they are
 * perfect for the matcher and useless for Tramada: booking 140221 does not exist
 * in the sandbox, so the Issue Payment → Agency CC Reimbursement grid came back
 * empty and steps 14-16 of docs/dvc.md had never had a row to tick. This makes
 * the rows — the shape RAA's own screenshot of that grid shows (23-09-2026):
 * CRU / HTL / TUR costings, one per booking, each charged to the DVC card.
 *
 * ── The chain, per booking ───────────────────────────────────────────────────
 *
 *   1. booking + ONE costed segment        runFullBooking, receipt: null
 *   2. the client's money IN               Client Payment Receipt, EFT, allocated
 *   3. the DVC card pays the supplier      tramada-agency-cc.js — "Issue Agency
 *                                          Credit Card Transaction", Balance Due
 *
 * Step 2 comes first for the reason field-map "Nothing is payable until the
 * client has paid" gives: trust accounting. The reimbursement comes OUT of the
 * trust account, and an agency cannot reimburse its card from money a client
 * has not yet paid in.
 *
 * THE CLEAN BOOKINGS carry ONE segment, so one Westpac line is one grid row is
 * one costing. THE WRONG-AMOUNT BOOKINGS (RAA, 23-09-2026) carry a flight, its
 * ticket costing and a hotel — three segments, never more — paid on the card as
 * TWO charges, one per creditor. Their flight line is right; their hotel line is
 * written into the Westpac file at a DIFFERENT amount from what Tramada holds:
 *
 *   deposit-sized   less than the hotel costs → "Please check: deposit or
 *                   incorrect amount" — only a person can tell which
 *   over-charged    more than it costs, and not the 3% fee → "Amount not match"
 *
 * Both must come back flagged, and the day must then go back to a person by
 * email with nothing entered in Tramada (RAA's drawing, 23-09-2026). The
 * `-corrected` Westpac file is the re-upload after the fix: that run reaches
 * Tramada and saves the session. The other messy cases (one-to-many, merchant
 * fees) are the offline fixture's job.
 *
 * ── Every figure in the files came back from Tramada ─────────────────────────
 *
 * The booking numbers are the ones Tramada issued, and the Tramada file's amount
 * is what the Agency CC form said the segment's Balance Due was, as charged
 * (§3). The only invented values are the ones the bank would supply and the
 * sandbox cannot: the Westpac account number, the consultant initials, a MASKED
 * card tail (XXXX-XXXX-XXXX-nnnn) — and, for the two wrong-amount lines, the
 * Westpac amount itself, which is the error being seeded and is named as such
 * in the output. No card number exists anywhere here (§4).
 *
 * Records land in tools/created-bookings-dvc.json and both CSVs in csv_uploads/
 * AFTER EACH STEP, not at the end — a run that dies on booking 3 has made two
 * real bookings, and they must be findable.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("../recon-core");
const { runFullBooking, runAddSegments, runReadBookingState, closeSegmentPage } = require("../tramada-segments");
const { runTramadaReceipt } = require("../tramada-receipt");
const { runAgencyCcTransaction } = require("../tramada-agency-cc");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

const DRY = has("--dry-run");
const RESUME = has("--resume");
const LIMIT = valueOf("--limit", null) == null ? null : parseInt(valueOf("--limit"), 10);
const SETTLEMENT = valueOf("--date", new Date().toISOString().slice(0, 10));
const CARD = valueOf("--card", process.env.DVC_CARD || "Westpac DVC VCC");
const CSV_DIR = path.join(__dirname, "..", "csv_uploads");
const RECORDS = path.join(__dirname, "created-bookings-dvc.json");
/* Named for their day, so the 23/09 pair a session was already saved from is
   never overwritten by a later day's. */
const WESTPAC_OUT = path.join(CSV_DIR, `dvc-westpac-live-${SETTLEMENT}.csv`);
const TRAMADA_OUT = path.join(CSV_DIR, `dvc-tramada-live-${SETTLEMENT}.csv`);
const WESTPAC_FIXED_OUT = path.join(CSV_DIR, `dvc-westpac-live-${SETTLEMENT}-corrected.csv`);
/* The card transaction's own date: the settlement day, or today if that is
   still ahead — Tramada dates a transaction when it happened, and a card
   cannot have been charged tomorrow. */
const CHARGED_ON = SETTLEMENT > new Date().toISOString().slice(0, 10)
  ? new Date().toISOString().slice(0, 10) : SETTLEMENT;

/* The Westpac headers exactly as `make-dvc-fixtures.js` writes them — the
   client's own export, minus PAX Name, plus Remarks. */
const WESTPAC_HEADERS = [
  "ACCOUNT NUMBER", "SETTLEMENT DATE", "MERCHANT", "CARD REQUEST DATE",
  "BILLING CURRENCY", "TRANSACTION AMOUNT (AUD)", "AGENT INITIALS", "STORE CODE",
  "SUPPLIER NAME", "SUPPLIER REF", "TRAMADA NUMBER", "SEGMENT TYPE", "CARD NUMBER",
  "REMARKS",
];
const TRAMADA_HEADERS = [
  "Seg. Type", "Booking No.", "Supplier Reference - Passenger Name - Supplier/Hotel Name",
  "Segment Date", "Balance Due", "Supplier Reference No",
];

/* EITHER ACCOUNT TYPE REACHES STEP 13's GRID — measured 23-09-2026.
 *
 * Both RETAIL bookings (GRAY/SPIDER, Agency CC CLIENT receipt, 15899/15908/
 * 15911/15914) and a CORPORATE one (GRAY/MEGAN DR, Agency CC DEBTOR receipt,
 * 15917) came back on Finance → Issue Payment → Agency CC Reimbursement, in one
 * grid. They looked missing for an hour because Go OPENS THE RESULTS IN A NEW
 * TAB (finance-debtor-refund-payment.htm) and the search tab stays blank.
 *
 * The client and receipt category follow the account type, exactly as
 * make-fixtures.js CLIENT_FOR / CATEGORY_FOR / ACCOUNT_FOR do (§4d): a retail
 * booking cannot take a Debtor receipt, a corporate one cannot take a Client
 * receipt. `--account corporate` exists so both kinds can be on the grid. */
const ACCOUNT = valueOf("--account", "retail").toLowerCase();
const ACCOUNTS = {
  corporate: {
    client: "GRAY/MEGAN DR", pax: "GRAY/MEGAN DR", receiptCategory: "DEBTOR_PAYMENT_RECEIPT",
    overrides: { accountType: "CORPORATE", corporateDebtor: "RAA of SA Limited (Retail)", retailDebtor: "" },
  },
  retail: {
    client: "GRAY/SPIDER", pax: "GRAY/SPIDER MS", receiptCategory: "CLIENT_PAYMENT_RECEIPT",
    overrides: { accountType: "RETAIL", retailDebtor: "RAA of SA Limited (Retail)", corporateDebtor: "" },
  },
};
if (!ACCOUNTS[ACCOUNT]) { console.error(`--account is corporate or retail, not "${ACCOUNT}"`); process.exit(1); }
const { client: CLIENT, pax: CLIENT_PAX } = ACCOUNTS[ACCOUNT];
const OVERRIDES = ACCOUNTS[ACCOUNT].overrides;

/* The plan. Creditors are typed IN FULL: "ACCOR" alone picked
   "[RTHDQ43124] ACCOR TI…" out of the autocomplete on booking 15902, and "ADL"
   as a City Code picked "(AER) ADLER SOCHI, RUSSIA" — both "worked" and the
   hotel form then refused to save without saying why.

   Creditors are ones the sandbox's creditor autocomplete actually
   offered on 23-09-2026 ([PRIN] Princess Cruise Lines, [ACCOR] ACCOR ASIA
   PACIFIC, [READY] READY ROOMS, [WENDY] WENDY WU TOURS) — a creditor the form
   does not list stops the segment with needsCreditor, which a fixture has
   nobody to answer. `payer` is the creditor as the Agency CC form's #creditor
   select names it, matched by label. */
const PLAN = [
  {
    label: "CRU Princess 799.80", segType: "CRU", westpacType: "CRUISE",
    merchant: "PRINCESS CRUISES", supplierName: "PRINCESS CRUISES", supplier: "Princess Cruises",
    creditor: "PRINCESS", payer: "Princess Cruise Lines", ref: "785K3G",
    booking: { originCode: "SYD", destinationCode: "SYD", departureDate: "2026-10-09", returnDate: "2026-10-16" },
    segment: { kind: "cruise", supplierName: "Princess Cruises", creditor: "PRINCESS", cruiseName: "South Pacific", departurePort: ["SYD", "Sydney"],
      embarkDate: "2026-10-09", disembarkDate: "2026-10-16", amount: "799.80" },
    initials: "BC", shop: "ADL", tail: "4117",
  },
  {
    label: "HTL Ibis 174.10", segType: "HTL", westpacType: "HOTEL",
    merchant: "ACCOR* IBIS", supplierName: "ACCOR", supplier: "Ibis Adelaide",
    creditor: "ACCOR ASIA PACIFIC", payer: "ACCOR ASIA PACIFIC", ref: "HB63868",
    booking: { originCode: "SYD", destinationCode: "ADL", departureDate: "2026-10-16", returnDate: "2026-10-17" },
    segment: { kind: "hotel", hotelName: "Ibis Adelaide", creditor: "ACCOR ASIA PACIFIC", cityCandidates: ["Adelaide"],
      checkInDate: "2026-10-16", checkOutDate: "2026-10-17", rate: "174.10", rooms: 1 },
    initials: "BC", shop: "ADL", tail: "6320",
  },
  {
    label: "HTL Ready Rooms 1526.00", segType: "HTL", westpacType: "HOTEL",
    merchant: "READY ROOMS", supplierName: "READY ROOMS", supplier: "Park Plaza Victoria",
    creditor: "READY ROOMS", payer: "READY ROOMS", ref: "C2813097",
    booking: { originCode: "ADL", destinationCode: "MEL", departureDate: "2026-10-31", returnDate: "2026-11-02" },
    segment: { kind: "hotel", hotelName: "Park Plaza Victoria", creditor: "READY ROOMS", cityCandidates: ["Melbourne"],
      checkInDate: "2026-10-31", checkOutDate: "2026-11-02", rate: "763.00", rooms: 1 },
    initials: "KH", shop: "WEST", tail: "9054",
  },
  {
    label: "TUR Wendy Wu 474.75", segType: "TUR", westpacType: "TOUR",
    merchant: "WENDY WU TOURS", supplierName: "WENDY WU", supplier: "Wendy Wu Tours",
    creditor: "WENDY WU", payer: "WENDY WU TOURS", ref: "7WR4HQ",
    booking: { originCode: "ADL", destinationCode: "SYD", departureDate: "2027-02-16", returnDate: "2027-02-17" },
    segment: { kind: "tour", supplierName: "Wendy Wu Tours", creditor: "WENDY WU", description: "Sydney day tour", city: "SYD",
      startDate: "2027-02-16", finishDate: "2027-02-16", amount: "474.75" },
    initials: "KH", shop: "WEST", tail: "2281",
  },

  /* ── WRONG AMOUNTS: hotel + flight, three segments ─────────────────────────
     A flight segment is not allocatable until costed, so the TICKET costing is
     the flight's grid row (field map §4b). Two creditors, so the Agency CC form
     lists one row for each and the card pays them as two charges — which is
     what DVC is: one virtual card per transaction.

     QF and VA are typed as the BRACKETED CODE the autocomplete shows
     ("[QF] QANTAS"), because "QANTAS" also matches "[QFF] QANTAS FREQUENT
     FLYER" and six others on a word boundary — the same collision the client
     code picker hit with GRAY/MEGAN DR and DR1. */
  {
    label: "HTL+TKT deposit-sized hotel charge",
    booking: { originCode: "ADL", destinationCode: "MEL", departureDate: "2026-11-12", returnDate: "2026-11-14" },
    segments: [
      { kind: "flight", airline: "QF", flightNumber: "680", class: "Economy", fromCity: "ADL", toCity: "MEL",
        departureDate: "2026-11-12", departureTime: "07:00", arrivalDate: "2026-11-12", arrivalTime: "08:35", status: "HK" },
      { kind: "hotel", hotelName: "Park Plaza Victoria", creditor: "READY ROOMS", cityCandidates: ["Melbourne"],
        checkInDate: "2026-11-12", checkOutDate: "2026-11-14", rate: "210.00", rooms: 1, reference: "C2813455" },
    ],
    costings: [{ creditor: "QF", airline: "QF", class: "Economy", fare: "236.40", passengerType: "Adult", fareType: "Published" }],
    lines: [
      { segType: "TKT", westpacType: "AIR TICKET", merchant: "QANTAS AIRWAYS", supplierName: "QANTAS",
        supplier: "Qantas", payer: "QANTAS", ref: "QF7K2M", tail: "5190" },
      /* $150.00 against a 2-night $420.00 hotel. A person has to decide whether
         that is the deposit or a charge that should have been $420.00. */
      { segType: "HTL", westpacType: "HOTEL", merchant: "READY ROOMS", supplierName: "READY ROOMS",
        supplier: "Park Plaza Victoria", payer: "READY ROOMS", ref: "C2813455", tail: "5191",
        westpacAmount: "150.00", seeded: "deposit-sized — less than the hotel costs" },
    ],
    initials: "BC", shop: "ADL",
  },
  {
    label: "HTL+TKT over-charged hotel",
    booking: { originCode: "ADL", destinationCode: "SYD", departureDate: "2026-11-19", returnDate: "2026-11-20" },
    segments: [
      { kind: "flight", airline: "VA", flightNumber: "431", class: "Economy", fromCity: "ADL", toCity: "SYD",
        departureDate: "2026-11-19", departureTime: "09:10", arrivalDate: "2026-11-19", arrivalTime: "11:15", status: "HK" },
      { kind: "hotel", hotelName: "Ibis Sydney World Square", creditor: "ACCOR ASIA PACIFIC", cityCandidates: ["Sydney"],
        checkInDate: "2026-11-19", checkOutDate: "2026-11-20", rate: "189.00", rooms: 1, reference: "HB64102" },
    ],
    costings: [{ creditor: "VA", airline: "VA", class: "Economy", fare: "198.00", passengerType: "Adult", fareType: "Published" }],
    lines: [
      { segType: "TKT", westpacType: "AIR TICKET", merchant: "VIRGIN AUSTRALIA", supplierName: "VIRGIN AUSTRALIA",
        supplier: "Virgin Australia", payer: "VIRGIN AUSTRALIA", ref: "VA4R8T", tail: "6208" },
      /* $214.50 against a $189.00 night: $25.50 over, and 3% of $189.00 is
         $5.67, so it is not BR06's merchant fee either. Charged MORE, so it
         cannot be a deposit — it is plainly wrong on one side or the other. */
      { segType: "HTL", westpacType: "HOTEL", merchant: "ACCOR* IBIS", supplierName: "ACCOR",
        supplier: "Ibis Sydney World Square", payer: "ACCOR ASIA PACIFIC", ref: "HB64102", tail: "6209",
        westpacAmount: "214.50", seeded: "over-charged — more than the hotel costs, and not the 3% fee" },
    ],
    initials: "KH", shop: "WEST",
  },
];

/* THREE SEGMENTS A BOOKING, AT MOST (RAA, 23-09-2026) — refused before a
   browser opens, not discovered after a booking exists. */
for (const p of PLAN) {
  const n = (p.segments || [p.segment]).length + (p.costings || []).length;
  if (n > 3) throw new Error(`"${p.label}" has ${n} segments; the fixture allows three a booking.`);
}

/**
 * Every plan as the same shape: segments, costings, and the card charges
 * (`lines`) that pay them. The single-segment plans above predate `lines` and
 * are written the short way; this is the one place that knows both.
 */
function linesOfPlan(p) {
  if (p.lines) return p.lines;
  return [{ segType: p.segType, westpacType: p.westpacType, merchant: p.merchant, supplierName: p.supplierName,
    supplier: p.supplier, payer: p.payer, ref: p.ref, tail: p.tail }];
}

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };
const csvField = (v) => { const t = String(v == null ? "" : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const ddmmyyyy = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const shortPath = (p) => path.relative(path.join(__dirname, ".."), p);

/** Everything the booking is costed at — what the client is receipted for. */
function bookingCosted(p) {
  /* THE WHOLE BOOKING, NOT ONE ROW. The client receipt allocates with "ALL",
     which is Select All — every allocatable row filled in full — and three
     TravelPay receipts once died on exactly this: receipted for the fare while
     Select All also ticked the hotel (field map §4b). */
  const segs = (p.segments || [p.segment]).filter((x) => x.kind !== "flight");
  const cents = segs.reduce((a, x) => a + core.cents(costedAmount(x)), 0) +
    (p.costings || []).reduce((a, c) => a + core.cents(c.fare), 0);
  return core.money(cents);
}

/** One segment's costed amount. */
function costedAmount(seg) {
  if (seg.kind === "hotel") {
    const nights = Math.round((Date.parse(seg.checkOutDate) - Date.parse(seg.checkInDate)) / 86400000);
    return core.money(core.cents(seg.rate) * nights * (seg.rooms || 1));
  }
  return core.money(core.cents(seg.amount));
}

/* ALWAYS READ WHAT IS ALREADY MADE. This used to start from nothing unless
   --resume was passed, so a plain re-run — the natural thing to type after
   adding a plan — would have made every booking again and overwritten the
   record of the first ones. Real bookings are never re-made by default;
   `--resume` is kept so older command lines still work. */
function loadRecords() {
  void RESUME;
  try { return JSON.parse(fs.readFileSync(RECORDS, "utf8")); } catch { return []; }
}
function saveRecords(records) { fs.writeFileSync(RECORDS, JSON.stringify(records, null, 2)); }

/** Both CSVs, rewritten from the records every time one of them changes. */
function writeCsvs(records) {
  fs.mkdirSync(CSV_DIR, { recursive: true });
  /* EVERY booking made, whichever account: the Finance grid lists them all in
     one search, and a Westpac file missing some would leave rows the day
     never paid. */
  /* One row per CARD CHARGE, not per booking — a hotel + flight booking is two
     charges. A record from before `lines` existed is its own single line. */
  /* ONE SETTLEMENT DAY PER PAIR OF FILES. Every record remembers the day it
     was charged for, and the files hold that day only — a Westpac report is one
     business day (BR02), and a day that already has its Payment Session must
     not be re-uploaded carrying new lines (docs/dvc.md, one session per
     settlement date). Records from before this field existed were all 23/09. */
  const done = [];
  for (const r of records) {
    if ((r.settlement || "2026-09-23") !== SETTLEMENT) continue;
    for (const l of (r.lines || [r])) if (l.charged) done.push({ ...r, ...l, bookingNo: r.bookingNo, pax: r.pax });
  }
  const settle = ddmmyyyy(SETTLEMENT);
  const w = [WESTPAC_HEADERS, ...done.map((r) => [
    /* Account number and card tail are the bank's, invented for the sandbox.
       The AMOUNT is what Tramada charged — except on a line seeded to be wrong,
       where it is the seeded figure, which is the whole point of that line. */
    "3910882", settle, `${r.merchant}* ${r.ref}`, settle, "AUD", r.westpacAmount || r.amount, r.initials, r.shop,
    r.supplierName, r.ref, r.bookingNo, r.westpacType, `XXXX-XXXX-XXXX-${r.tail}`, "",
  ])];
  const t = [TRAMADA_HEADERS, ...done.map((r) => [
    r.segType, r.bookingNo, `${r.ref} - ${r.ref} - ${r.pax || CLIENT_PAX} - ${r.supplier}`, settle, r.amount, r.ref,
  ])];
  fs.writeFileSync(WESTPAC_OUT, w.map((row) => row.map(csvField).join(",")).join("\n") + "\n");
  /* THE SAME DAY, FIXED — every seeded line back at what Tramada charged. It is
     the second upload of the fix-and-re-upload loop (RAA, 23-09-2026): the run
     reopens the day's session, ticks the lines that are right now, saves it
     again, and emails that the day is ready to Issue. */
  if (done.some((r) => r.westpacAmount)) {
    const fixed = [WESTPAC_HEADERS, ...done.map((r) => [
      "3910882", settle, `${r.merchant}* ${r.ref}`, settle, "AUD", r.amount, r.initials, r.shop,
      r.supplierName, r.ref, r.bookingNo, r.westpacType, `XXXX-XXXX-XXXX-${r.tail}`, "",
    ])];
    fs.writeFileSync(WESTPAC_FIXED_OUT, fixed.map((row) => row.map(csvField).join(",")).join("\n") + "\n");
  }
  fs.writeFileSync(TRAMADA_OUT, t.map((row) => row.map(csvField).join(",")).join("\n") + "\n");
}

/** Prove the files reconcile with the run's OWN parsers and matcher, or say why not. */
function verify(records) {
  const wg = core.csvGrid(fs.readFileSync(WESTPAC_OUT, "utf8"));
  const tg = core.csvGrid(fs.readFileSync(TRAMADA_OUT, "utf8"));
  const w = core.parseDvcRows(wg.headers, wg.rows);
  const t = core.parseTramadaCcRows(tg.headers, tg.rows);
  const day = core.filterDvcSettlementDate(w.rows, SETTLEMENT).rows;
  const out = core.reconcileDvc(day, t.rows);
  say(`\n  Reconciled with the run's own code: ${out.summary.matched}/${out.summary.total} clean, ` +
    `${out.summary.matchedForReview} flagged, ${out.summary.unmatched} unmatched.`);
  /* WHAT "RIGHT" MEANS HERE: every line clean EXCEPT the ones seeded wrong, and
     every one of those flagged. A seeded line coming back clean is the matcher
     ticking a wrong amount — the one outcome this fixture exists to catch. */
  const seeded = new Set();
  for (const r of records) {
    for (const l of (r.lines || [])) if (l.seeded && l.charged) seeded.add(`${r.bookingNo}|${l.westpacAmount}`);
  }
  let right = true;
  for (const r of out.rows) {
    const isSeeded = seeded.has(`${r.bookingNo}|${r.amount}`);
    const flagged = !r.matched || !!r.remark;
    if (isSeeded && !flagged) { right = false; say(`     ✗ booking ${r.bookingNo} $${r.amount} was seeded wrong and came back CLEAN`); }
    else if (!isSeeded && flagged) { right = false; say(`     ✗ booking ${r.bookingNo} $${r.amount}: ${r.remark || r.why}`); }
    else if (flagged) say(`     ✓ booking ${r.bookingNo} $${r.amount} flagged, as seeded: ${core.dvcRemarksCell(r)}`);
  }
  return right;
}

const cb = (tag) => ({
  onProgress: (p, m) => console.log(`       ${tag} ${m === undefined ? p : m}`),
  onError: (m) => console.error(`       ERROR: ${m}`),
  onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222 — I'll wait, and I never type credentials."),
});

async function one(plan, rec, records) {
  // 1. Booking + segment.
  const segmentOnBooking = async () => {
    const st = await runReadBookingState({ bookingNo: rec.bookingNo, callbacks: cb("[check]") });
    const n = (st.segments || []).filter((x) => String(x.segType).toUpperCase() === plan.segType).length;
    /* TWO IS AS WRONG AS NONE. Bookings 15902 and 15905 each came back with
       the hotel saved twice (a Save re-clicked on a form that had in fact
       saved), and receipting one of those allocates both rows — the one
       Westpac line would then face two grid rows. Stop and say so. */
    if (n > 1) throw new Error(`booking ${rec.bookingNo} has ${n} ${plan.segType} segments, not one — fix it in Tramada`);
    return n === 1;
  };
  const seg = { ...plan.segment, reference: plan.ref, confirmationNumber: plan.ref };
  if (!rec.bookingNo) {
    await runFullBooking({
      clientCode: CLIENT,
      booking: { ...plan.booking, adults: 1, tripType: "return", tramadaOverrides: OVERRIDES },
      segments: [seg],
      costings: [],
      receipt: null,
      dryRunReceipt: true,
      callbacks: {
        ...cb("[book]"),
        onStage: (name, d) => {
          if (name === "booking" && d && d.bookingNo) {
            rec.bookingNo = String(d.bookingNo);
            saveRecords(records);
            say(`     → booking ${rec.bookingNo}`);
          }
        },
      },
    }).finally(() => closeSegmentPage());
  } else if (!rec.segmentSaved && !(await segmentOnBooking())) {
    /* RESUMING A BOOKING WHOSE SEGMENT NEVER SAVED. Read first, add only if
       it is genuinely not there: `runFullBooking`'s own resume only counts
       flights and hotels, so it would add a second cruise or tour. */
    say(`     booking ${rec.bookingNo} has no ${plan.segType} yet — adding it.`);
    await runAddSegments({ bookingNo: rec.bookingNo, segments: [seg], callbacks: cb("[seg]") })
      .finally(() => closeSegmentPage());
  }
  /* ASSERT, DON'T ASSUME (§3). A segment form that Tramada refused was once
     reported saved (booking 15899 — see segmentFormSaved), and the next step
     then failed on a booking with nothing on it. Read the itinerary back. */
  if (!(await segmentOnBooking())) {
    throw new Error(`booking ${rec.bookingNo} has no ${plan.segType} segment after saving it`);
  }
  rec.segmentSaved = true;
  saveRecords(records);

  // 2. The client's money in.
  if (!rec.receiptNo) {
    const r = await runTramadaReceipt({
      bookingNo: rec.bookingNo,
      receipt: {
        transactionType: "EFT", amount: rec.costed, reference: `DVR-${rec.bookingNo}`,
        dateReceived: new Date().toISOString().slice(0, 10), allocation: "ALL",
      },
      receiptCategory: ACCOUNTS[ACCOUNT].receiptCategory,
      dryRun: false,
      callbacks: cb("[receipt]"),
    });
    rec.receiptNo = (r && r.receipt && r.receipt.receiptNo) || (r && r.skipped && "already filed") || "";
    if (!rec.receiptNo) throw new Error("the client receipt came back with no receipt number");
    saveRecords(records);
    say(`     ✓ client receipt ${rec.receiptNo} for $${rec.costed}`);
  }

  // 3. The DVC card pays the supplier.
  if (!rec.charged) {
    const a = await runAgencyCcTransaction({
      bookingNo: rec.bookingNo, creditor: plan.payer, cardLabel: CARD, amount: "AUTO",
      reference: plan.ref, dateReceived: CHARGED_ON, callbacks: cb("[dvc]"),
    });
    rec.agencyReceiptNo = (a.receipt && a.receipt.receiptNo) || "";
    rec.amount = core.money(core.cents(a.amount));
    rec.charged = true;
    saveRecords(records);
    writeCsvs(records);
    say(`     ✓ ${rec.agencyReceiptNo} — $${rec.amount} on the DVC card`);
  }
}

/** Does this settlement day carry any line seeded to be wrong? */
function seededToday(records) {
  return records.some((r) => (r.settlement || "2026-09-23") === SETTLEMENT &&
    (r.lines || []).some((l) => l.seeded && l.charged));
}

/**
 * A booking paid as SEVERAL card charges — the hotel + flight plans. Same chain
 * as `one`, with the last step once per creditor.
 *
 * NO RESUME-BY-ADDING for these. `one` can add a missing segment to a booking
 * it made; a three-segment booking with some of them missing is a booking to
 * look at, because re-adding the wrong one is exactly how 15902 and 15905 each
 * ended up with their hotel twice.
 */
async function oneMulti(plan, rec, records) {
  const want = linesOfPlan(plan);
  const onBooking = async () => {
    const st = await runReadBookingState({ bookingNo: rec.bookingNo, callbacks: cb("[check]") });
    /* THE COSTINGS TABLE, AND ONLY THAT ONE. A hotel costs itself on its own
       form, so it is listed in the itinerary AND the costings — counting both
       read booking 15920's one hotel as two and refused a correct booking. The
       costings table holds exactly the rows the card can pay: the hotel and the
       ticket, never the uncosted flight segment. */
    const count = (type) => (st.costings || [])
      .filter((x) => String(x.segType).toUpperCase() === type).length;
    for (const l of want) {
      const n = count(l.segType);
      if (n !== 1) {
        throw new Error(`booking ${rec.bookingNo} has ${n} ${l.segType} rows, not one — fix it in Tramada ` +
          "before this charges anything against it");
      }
    }
  };

  // 1. Booking, flight, ticket costing, hotel.
  if (!rec.bookingNo) {
    await runFullBooking({
      clientCode: CLIENT,
      booking: { ...plan.booking, adults: 1, tripType: "return", tramadaOverrides: OVERRIDES },
      segments: plan.segments.map((x) => ({ ...x, confirmationNumber: x.reference })),
      costings: plan.costings,
      receipt: null,
      dryRunReceipt: true,
      callbacks: {
        ...cb("[book]"),
        onStage: (name, d) => {
          if (name === "booking" && d && d.bookingNo) {
            rec.bookingNo = String(d.bookingNo);
            saveRecords(records);
            say(`     → booking ${rec.bookingNo}`);
          }
        },
      },
    }).finally(() => closeSegmentPage());
  }
  // ASSERT, DON'T ASSUME (§3) — one of each, read back off the booking.
  await onBooking();
  rec.segmentSaved = true;
  saveRecords(records);

  // 2. The client's money in, for the whole booking (see bookingCosted).
  if (!rec.receiptNo) {
    const r = await runTramadaReceipt({
      bookingNo: rec.bookingNo,
      receipt: {
        transactionType: "EFT", amount: rec.costed, reference: `DVR-${rec.bookingNo}`,
        dateReceived: new Date().toISOString().slice(0, 10), allocation: "ALL",
      },
      receiptCategory: ACCOUNTS[ACCOUNT].receiptCategory,
      dryRun: false,
      callbacks: cb("[receipt]"),
    });
    rec.receiptNo = (r && r.receipt && r.receipt.receiptNo) || (r && r.skipped && "already filed") || "";
    if (!rec.receiptNo) throw new Error("the client receipt came back with no receipt number");
    saveRecords(records);
    say(`     ✓ client receipt ${rec.receiptNo} for $${rec.costed}`);
  }

  // 3. One DVC charge per creditor — each its own virtual card, as DVC is.
  for (const l of rec.lines) {
    if (l.charged) continue;
    const a = await runAgencyCcTransaction({
      bookingNo: rec.bookingNo, creditor: l.payer, cardLabel: CARD, amount: "AUTO", segType: l.segType,
      reference: l.ref, dateReceived: CHARGED_ON, callbacks: cb(`[dvc ${l.segType}]`),
    });
    l.agencyReceiptNo = (a.receipt && a.receipt.receiptNo) || "";
    l.amount = core.money(core.cents(a.amount));
    l.charged = true;
    saveRecords(records);
    writeCsvs(records);
    say(`     ✓ ${l.segType} ${l.agencyReceiptNo} — $${l.amount} on the DVC card` +
      (l.westpacAmount ? `; the Westpac file says $${l.westpacAmount} (SEEDED: ${l.seeded})` : ""));
  }
  rec.charged = rec.lines.every((l) => l.charged);
  saveRecords(records);
}

(async () => {
  core.assertCardLabel(CARD, "--card");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SETTLEMENT)) die(`--date wants YYYY-MM-DD, got "${SETTLEMENT}"`);
  const plan = LIMIT != null ? PLAN.slice(0, LIMIT) : PLAN;

  say(`${plan.length} booking(s) for client ${CLIENT}, each: booking + its costings → client receipt → ` +
    `one Agency CC transaction per creditor on "${CARD}". Settlement date ${SETTLEMENT}.`);
  for (const p of plan) {
    say(`   - ${p.label}  (receipted $${p.lines ? bookingCosted(p) : costedAmount(p.segment)})`);
    for (const l of linesOfPlan(p)) {
      say(`       ${l.segType} paid to ${l.payer} on the DVC card` +
        (l.westpacAmount ? ` — Westpac file SEEDED at $${l.westpacAmount}: ${l.seeded}` : ""));
    }
  }
  if (DRY) return say("\n  Dry run — Tramada was never opened.\n");

  const records = loadRecords();
  for (const [i, p] of plan.entries()) {
    /* KEYED ON SETTLEMENT TOO, NOT JUST LABEL + ACCOUNT. Matching on label alone
       meant a brand new --date still found the previous day's already-`charged`
       record and skipped it — the run never re-booked, and writeCsvs (which
       DOES filter by settlement) then had nothing dated today to write, so the
       CSV came out as a header with no rows. Every settlement date the plan has
       not yet been run for gets its own fresh set of real bookings; the same
       date re-run still resumes the partial one instead of duplicating it. */
    let rec = records.find((r) => r.label === p.label && (r.account || "retail") === ACCOUNT &&
      (r.settlement || "2026-09-23") === SETTLEMENT);
    if (!rec) {
      rec = p.lines
        ? { label: p.label, account: ACCOUNT, settlement: SETTLEMENT, client: CLIENT, index: i, initials: p.initials, shop: p.shop,
            pax: CLIENT_PAX, costed: bookingCosted(p), lines: p.lines.map((l) => ({ ...l, charged: false })) }
        : { label: p.label, account: ACCOUNT, settlement: SETTLEMENT, client: CLIENT, index: i, segType: p.segType, westpacType: p.westpacType, merchant: p.merchant,
            supplierName: p.supplierName, supplier: p.supplier, ref: p.ref, initials: p.initials, shop: p.shop,
            tail: p.tail, pax: CLIENT_PAX, costed: costedAmount(p.segment) };
      records.push(rec);
    }
    if (rec.charged) { say(`[${i + 1}/${plan.length}] ${p.label} — already done (booking ${rec.bookingNo}).`); continue; }
    say(`\n[${i + 1}/${plan.length}] ${p.label}`);
    try {
      await (p.lines ? oneMulti(p, rec, records) : one(p, rec, records));
    } catch (err) {
      saveRecords(records);
      writeCsvs(records);
      console.error(`     ✗ stopped: ${core.tidyError(err.message)}`);
      console.error(`       Progress is in ${shortPath(RECORDS)}; fix it and re-run with --resume.`);
      process.exitCode = 1;
      break;
    }
  }

  writeCsvs(records);
  const n = records.filter((r) => (r.settlement || "2026-09-23") === SETTLEMENT)
    .reduce((a, r) => a + (r.lines || [r]).filter((l) => l.charged).length, 0);
  say(`\n  ${shortPath(WESTPAC_OUT)} and ${shortPath(TRAMADA_OUT)} — ${n} line(s).`);
  if (n) {
    const green = verify(records);
    if (!green) process.exitCode = 1;
    say(`Upload both on the DVC card with settlement date ${SETTLEMENT}. ` + (seededToday(records)
      ? "This day has lines seeded wrong: the run emails the errors and enters nothing in Tramada. " +
        `Then upload ${shortPath(WESTPAC_FIXED_OUT)} (the fix) — that run saves the session.\n`
      : `All ${n} charge(s) are on the Issue Payment grid and reconcile, so the run ticks them all and ` +
        "saves the session.\n"));
  }
})().catch((e) => die(e.stack || e.message));

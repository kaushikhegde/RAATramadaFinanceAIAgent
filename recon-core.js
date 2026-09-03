/**
 * recon-core.js — the decisions the reconciliation run makes, with no browser
 * anywhere near them.
 *
 * Two things happen in a run and both are judgements about money:
 *
 *   1. ALLOCATION — the receipt form allocates PER SEGMENT, so a receipt places
 *      what it can reach: full cover, a partial payment against the first
 *      segments, or nothing when the booking owes nothing. Three outcomes,
 *      not two.
 *   2. RECONCILIATION — does the RECEIPT NUMBER this run was handed appear as a
 *      `Trans. No` among the statement's transactions, at the same amount?
 *
 * Both live here rather than inside the Playwright module so they can be tested
 * against captured values offline (CLAUDE.md §7), and so the rule is written
 * down once instead of being implied by the order of some clicks.
 */

/* ── money ───────────────────────────────────────────────────────────────── */

/**
 * An amount as whole cents, or null if it can't be read.
 *
 * Integer cents, never floats: `1.15 * 100` is `114.99999999999999`, and a
 * comparison that says two equal amounts differ would file a matching receipt
 * as unallocated. Nothing here rounds a number it merely failed to parse —
 * unreadable is null, and null never equals anything.
 */
function cents(v) {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[$,\s]/g, "").replace(/(CR|DR)$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

function money(c) {
  return c == null ? "" : (c / 100).toFixed(2);
}

/* ── references ──────────────────────────────────────────────────────────── */

/**
 * A reference reduced to what two systems can be expected to agree on.
 *
 * Case and internal spacing only. Nothing else is stripped: `VIX122334` and
 * `NW` and `Trip File Tsfr 1105` are all real references from one statement
 * page, and a "helpful" normaliser that dropped punctuation or digits would
 * make `Deposit - Jill Shields` collide with any other deposit for her.
 *
 * The ORIGINAL string is always what gets reported. This is only ever the
 * comparison key.
 */
function refKey(v) {
  return String(v == null ? "" : v).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A receipt number reduced to what the two screens agree on.
 *
 * **This, not the reference, is what reconciles a row.** The receipt form hands
 * back a number — `R.0000009403` — and that same number is the reconciliation
 * page's `Trans. No`. Matching on the reference instead was matching the CSV's
 * text against a free-text column that a person types, on rows the run did not
 * create; the receipt number is the identity of the thing the run actually
 * filed, issued by Tramada itself.
 *
 * Punctuation and case are dropped and the digits are unpadded, so `R.0000009403`,
 * `r.0000009403` and `R9403` are one key. That is safe here in a way it would
 * never be for a reference: this is a machine-issued identifier with a fixed
 * shape, not something a consultant typed.
 */
function receiptKey(v) {
  const s = String(v == null ? "" : v).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const m = s.match(/^([A-Z]*)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : s;
}

/* ── the CSV ─────────────────────────────────────────────────────────────── */

/** One CSV line into fields, honouring quotes and doubled quotes. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * The import CSV → rows the run can act on.
 *
 * Columns are found BY HEADER NAME, not by position. The file is hand-editable
 * and a column inserted in the middle would otherwise silently shift every
 * amount one to the left — which, on a file that files receipts, is the worst
 * possible failure because every row still looks plausible.
 *
 * Returns `{ rows, problems }`. A row that cannot be acted on is never quietly
 * dropped: it comes back in `problems` so the UI can show it.
 */
/*
 * `receipt no` is an alias of `reference`, not a column of its own.
 *
 * The guide calls this column "Receipt No" throughout — step 16 says to type
 * "the numbers from the Receipt No column" into the receipt's Reference field.
 * The code has always called it `reference`, because Reference is where the
 * value lands. A file headed RECEIPT NO used to be rejected outright with
 * "the header is missing: reference", which reads as a broken file rather than
 * a naming difference.
 *
 * `recPayType` is OPTIONAL. The guide's BPay file has no such column, and the
 * value is only ever echoed back into the report — nothing decides on it. A
 * missing one is blank, not a rejected file.
 */
const HEADERS = {
  date: ["date", "date received", "b/pay file date", "bpay file date"],
  reference: ["reference", "reference number", "ref", "receipt no", "receipt no.", "receiptno", "receipt number"],
  recPayType: ["rec/pay type", "recpaytype", "payment type", "type"],
  amount: ["amount"],
  bookingNo: ["booking no", "booking no.", "booking number", "bookingno", "booking reference", "booking", "tramada bkg no"],
};

/** Columns the file may leave out entirely. */
const OPTIONAL_HEADERS = ["recPayType"];

function parseReconCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], problems: [{ line: 0, why: "the file is empty" }] };
  const grid = csvGrid(text);
  return parseReconRows(grid.headers, grid.rows);
}

/**
 * The same rows, out of a WORKBOOK rather than a CSV.
 *
 * Finance's BPay file is whatever their bank and their spreadsheet produce,
 * and the guide only ever calls it "a spreadsheet". A run used to accept an
 * .xlsx from Mint, IPSI and TravelPay and refuse one from BPay, which is a
 * distinction nobody outside this code could have predicted.
 *
 * `rows` is an array of cell arrays, `headers` their column names — exactly
 * what `csvGrid` and `xlsx-lite`'s `readSheet` both hand back, so one parser
 * serves both containers.
 */
function parseReconRows(headers, sheetRows) {
  if (!headers || !headers.length) return { rows: [], problems: [{ line: 0, why: "the file is empty" }] };

  const header = (headers || []).map((h) => String(h == null ? "" : h).trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  const missing = Object.entries(col)
    .filter(([k, i]) => i < 0 && !OPTIONAL_HEADERS.includes(k))
    .map(([k]) => k);
  if (missing.length) {
    return { rows: [], problems: [{ line: 1, why: `the header is missing: ${missing.join(", ")}` }] };
  }

  // A workbook cell can be a number, a Date or undefined; a CSV field is always
  // a string. Everything downstream reads text, so this is the one place it is
  // made text — and an empty cell is "" rather than "undefined".
  const at = (f, i) => (i < 0 || f[i] == null ? "" : String(f[i]).trim());

  /* THE WHOLE FILE COMES THROUGH, not just the five columns the run acts on.
   *
   * Finance's spreadsheet has columns this code has no opinion about — a
   * customer name, an internal note, whatever their bank puts in it — and the
   * file they get back is supposed to be THEIR file with three columns filled
   * in, not a new five-column one that happens to share some values. So every
   * column is kept, in its original order and under its original heading, and
   * the run reads its five out of the same row.
   *
   * A blank heading is skipped, and a repeated one is suffixed: a spreadsheet
   * with two columns called "Amount" would otherwise silently lose one. */
  const columns = [];
  const seen = new Set();
  (headers || []).forEach((h, i) => {
    const name = String(h == null ? "" : h).trim();
    if (!name) { columns.push(null); return; }
    let unique = name, n = 2;
    while (seen.has(unique.toLowerCase())) unique = `${name} (${n++})`;
    seen.add(unique.toLowerCase());
    columns.push(unique);
  });
  const kept = columns.filter(Boolean);

  const rows = [];
  const problems = [];
  for (let i = 0; i < (sheetRows || []).length; i++) {
    const f = sheetRows[i] || [];
    const cells = {};
    columns.forEach((name, j) => { if (name) cells[name] = at(f, j); });
    const row = {
      // The line number a person would count to in the file: the header is 1.
      line: i + 2,
      // Straight out of a workbook this is an Excel serial (46204) — measured
      // on RAA's own "B/PAY FILE DATE" column, which `xlsx-lite` deliberately
      // does not convert (see `serialDate`). Mint and TravelPay already do
      // this; BPay's own date column did not, so a real .xlsx (as opposed to
      // the hand-written CSV fixture) showed the raw serial number instead of
      // a date. `serialDate` leaves a CSV's already-formatted text untouched.
      date: serialDate(at(f, col.date)),
      reference: at(f, col.reference),
      recPayType: at(f, col.recPayType),
      amount: at(f, col.amount),
      bookingNo: at(f, col.bookingNo),
      amountCents: cents(at(f, col.amount)),
      // Everything the file said, under the headings it said it with.
      cells,
      // Filled in from Tramada as the run goes: steps 7 and 9, and whichever
      // business rule the row lands on. Present from the start so every row
      // has the same shape and the report always has the columns.
      consultant: "",
      shop: "",
      remark: "",
    };
    const why = [];
    if (!row.reference) why.push("no reference");
    if (row.amountCents == null) why.push(`unreadable amount "${row.amount}"`);
    if (!row.bookingNo) why.push("no booking number");

    /* A row that says NOTHING in any of the columns this code reads is not a
       transaction missing its booking number — it is a spacer, or the row a
       spreadsheet carries a TOTAL and a transaction count on. RAA's own file
       puts those on the last data row, but a blank one is a change away.
       Remarking it "No booking number found" would put an instruction to
       Finance beside a line that is not a payment. It is still carried into the
       export, because whatever it holds is theirs. */
    const blank = !row.reference && !row.bookingNo && row.amountCents == null;
    if (blank) {
      problems.push({ line: row.line, why: "nothing in it to reconcile", row, blank: true });
    } else if (why.length) {
      // BR01: a line with no booking number is not silently absent from what
      // Finance gets back. It is not runnable, so it stays out of `rows` — but
      // it carries its own remark and the report puts it back.
      row.remark = !row.bookingNo ? REMARKS.noBooking : REMARKS.review;
      problems.push({ line: row.line, why: why.join("; "), row });
    } else rows.push(row);
  }

  /* The file may ALREADY have Consultant, Shop or Remarks columns — the guide
     talks about "the Remarks column" as something that exists. Where it does,
     whatever was in it is the starting value, so an operator's own note is not
     wiped by a blank. */
  for (const r of rows.concat(problems.map((p) => p.row).filter(Boolean))) {
    const pick = (want) => {
      const name = kept.find((c) => normaliseHeading(c) === want);
      return name ? r.cells[name] || "" : "";
    };
    r.consultant = r.consultant || pick("consultant");
    r.shop = r.shop || pick("shop");
    r.remark = r.remark || pick("remarks");
  }

  return { rows, problems, columns: kept };
}

/** Headings compared the way a person would: case, spaces and dots ignored. */
function normaliseHeading(h) {
  return String(h == null ? "" : h).trim().toLowerCase().replace(/[\s._-]+/g, "");
}

/*
 * What the run adds to the file, and what each column is called if it has to be
 * created. Order is the order they are appended in.
 */
const EXPORT_FIELDS = [
  { field: "consultant", heading: "Consultant" },     // step 7
  { field: "shop", heading: "Shop" },                 // step 9
  { field: "remark", heading: "Remarks" },            // BR01-BR11
  { field: "receiptNo", heading: "Receipt No" },
  { field: "allocation", heading: "Allocation" },
  { field: "reconciliation", heading: "Reconciled" },
  { field: "why", heading: "Why" },
];

/**
 * The file Finance gets back: THEIR spreadsheet, with the run's columns filled
 * in — not a new file that happens to share some values.
 *
 * Every original column survives, in its original order, under its original
 * heading. Where the file already HAS a Consultant, Shop or Remarks column the
 * run writes into it rather than appending a second one with the same name;
 * where it does not, the column is added on the end.
 *
 * THE INPUT COLUMNS ARE OFF LIMITS, and that is not fussiness. The guide calls
 * the reference column "Receipt No", so on a file headed that way an
 * unqualified match would write Tramada's receipt number over the reference the
 * row was found by — destroying the input while looking like it filled a column
 * in. Anything already claimed by the parser keeps its own value, and the run's
 * version appends beside it under a name that says whose it is.
 */
function buildExportGrid(rows, columns, opts = {}) {
  const base = (columns || []).filter(Boolean);
  const claimed = new Set((opts.inputColumns || []).map(normaliseHeading));

  const headings = base.slice();
  const source = new Map();          // heading → how to get its value
  for (const h of headings) source.set(h, { cell: h });

  for (const { field, heading } of EXPORT_FIELDS) {
    /* Work out what this column WOULD be called, then look for it — in that
       order, and it matters. Doing it the other way round means a file that
       already has a "Tramada Receipt No" column (because it is an export being
       fed back in, which is exactly what happens when somebody fixes a cell in
       Excel and re-uploads) gets a second one every time it goes round.
       Deciding the name first makes the whole thing idempotent: export, edit,
       re-upload, export again, and the columns are the same columns. */
    const taken = headings.some(
      (h) => normaliseHeading(h) === normaliseHeading(heading) && claimed.has(normaliseHeading(h))
    );
    const target = taken ? `Tramada ${heading}` : heading;
    const found = headings.find(
      (h) => normaliseHeading(h) === normaliseHeading(target) && !claimed.has(normaliseHeading(h))
    );
    if (found) { source.set(found, { field }); continue; }
    headings.push(target);
    source.set(target, { field });
  }

  const body = (rows || []).map((r) => headings.map((h) => {
    const from = source.get(h) || {};
    if (from.field) return String(r[from.field] == null ? "" : r[from.field]);
    const cells = r.cells || {};
    return String(cells[h] == null ? "" : cells[h]);
  }));

  return { headings, rows: body };
}

/** The headings the parser itself claims, so an export never writes over one. */
function inputColumnsOf(columns) {
  const names = [];
  for (const c of (columns || []).filter(Boolean)) {
    const low = String(c).trim().toLowerCase();
    if (Object.values(HEADERS).some((aliases) => aliases.includes(low))) names.push(c);
  }
  return names;
}

/**
 * Which columns of an export grid hold money, so a workbook can format them.
 *
 * By heading, and only the ones this code knows are money — the file's own
 * Amount column, and nothing else. A column called "Rate" or "Qty" belongs to
 * Finance and is left exactly as they wrote it.
 */
function moneyColumnsOf(headings) {
  const names = HEADERS.amount;
  return (headings || []).reduce((acc, h, i) => {
    if (names.includes(String(h == null ? "" : h).trim().toLowerCase())) acc.push(i);
    return acc;
  }, []);
}

/** One grid → CSV text, quoted the way a spreadsheet expects. */
function gridToCsv(grid) {
  const q = (v) => {
    const s = v == null ? "" : String(v);
    // A leading =, + or - makes a spreadsheet try to evaluate the cell, and a
    // leading zero is dropped from a reference like 0041 unless it is quoted.
    return /[",\n]/.test(s) || /^[\s+=@-]/.test(s) || /^0\d/.test(s)
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [grid.headings.map(q).join(",")]
    .concat((grid.rows || []).map((r) => r.map(q).join(",")))
    .join("\n") + "\n";
}

/* ── the BPay business rules ─────────────────────────────────────────────── */

/*
 * The Remarks column has a CLOSED vocabulary.
 *
 * Every string here is quoted verbatim from the guide's Business Rules table.
 * Finance reads this column to decide what to do next, and a sentence that is
 * merely similar — "no outstanding amount" for "No outstanding amount found" —
 * cannot be filtered, counted or trusted the same way. The prose explanation
 * still goes in `why`; this column stays a vocabulary.
 */
const REMARKS = {
  noBooking: "No booking number found",                                  // BR01
  departurePassed: "Please review, departure date has passed",           // BR02
  noOutstanding: "No outstanding amount found",                          // BR03
  noOutstandingPassed: "No outstanding amount found, departure date has passed", // BR04
  wrongDebtor: "Please review, incorrect debtor found",                  // BR05
  allocate: "Please allocate",                                           // BR09, BR10
  overpayment: "Overpayment, please check",                              // BR11
  // Not in the guide. Used only where the guide has no case: the page did not
  // give us something a rule needs, so the rule cannot be applied and a person
  // has to look. Never used to paper over a rule that DID apply.
  review: "Please review",
  /* Also not in the guide, and deliberately its own string rather than a plain
     "Please review". The guide assumes every BPay booking can take a Debtor
     Payment Receipt; one that cannot is a booking whose CLIENT is a retail
     account rather than a debtor account, and that is a specific thing for
     somebody to go and look at — not a general "something was odd here". */
  noDebtorReceipt: "Please review, Debtor Payment Receipt not available",
  /* TravelPay, 03-09-2026. A row whose Payment Reference is blank used to be
     held back at upload and never appeared in the reconciliation at all — the
     settlement was in the file, the screen showed nothing, and the only clue
     was a count in the upload note. It is detected now and flagged here
     instead. Its own string rather than a plain "Please review", because the
     thing to do about it is specific: find the reference. */
  noReference: "No payment reference in the file",
  /* An earlier run filed this receipt, so this one did not open the booking and
     could not see whether the money was ever allocated. It still reconciles —
     a rerun has to be able to finish — but the row says so rather than showing
     a clean, blank Remarks cell that claims more than was checked. */
  filedEarlier: "Filed by an earlier run — allocation not checked",
};

/*
 * Step 11 — the receipt category a BPay payment is raised under.
 *
 * `#receiptCategory` sits on the booking's Receipts list and decides which form
 * Add / Issue opens. What it OFFERS depends on the client's account type:
 * a debtor-account client gets the Debtor variants, a retail one gets the
 * Client variants, and the two lists never overlap. Measured 17-Aug-2026 on
 * bookings 13115 (GRAY/MEGAN DR) and 13394 (GRAY/SPIDER MS).
 *
 * `label` is what the reconcile screen's Rec/Pay Type filter calls the same
 * thing — step 30 — and they have to agree or the run files under one name and
 * searches under another.
 */
const BPAY_RECEIPT = {
  value: "DEBTOR_PAYMENT_RECEIPT",
  label: "Debtor Payment Receipt",
};

/**
 * "[WEST] RAA West Croydon" → "WEST".
 *
 * The guide says the shortcode is enough. Pure, and here rather than inside a
 * page.evaluate, so the one thing that turns a branch label into the value
 * Finance reads can be tested without a browser.
 */
function branchCode(label) {
  const s = String(label == null ? "" : label).trim();
  const m = s.match(/\[([A-Za-z0-9]+)\]/);
  return m ? m[1] : s;
}

/** BR05 — the only debtor a BPay receipt may be raised against. */
const RETAIL_DEBTOR = "RAA of SA Limited (Retail)";

/**
 * Is this date before today?
 *
 * Tramada writes dd-mm-yyyy and dd/mm/yyyy; a spreadsheet may hand over
 * yyyy-mm-dd. All three are read, in UTC, at day granularity — a departure at
 * any hour today is "today", not "passed".
 *
 * Unreadable is `null`, never `false`. A false here would say "the departure
 * has not passed" about a date nobody parsed, and BR02/BR04 would go unraised.
 */
function isPastDate(value, today) {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const now = toIsoDate(today) || new Date().toISOString().slice(0, 10);
  return iso < now;
}

/** dd-mm-yyyy | dd/mm/yyyy | yyyy-mm-dd | Date → yyyy-mm-dd, or "" */
function toIsoDate(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  /* TWO-DIGIT YEARS, day first.
   *
   * RAA's own BPay export writes 07-01-26 for the 7th of January 2026, and
   * until this was here that read as nothing at all — which meant the date the
   * receipt was filed under was whatever Tramada made of the string, and any
   * rule that compares dates simply never fired.
   *
   * Day first, not month first: this is an Australian bank file and 07-01-26
   * is January, not July. Nothing in the file says which, so it is written down
   * here rather than inferred — a file that ever arrives month-first will need
   * its own column name, not a cleverer guess.
   *
   * 00-69 is 20xx and 70-99 is 19xx, the POSIX window. A travel booking dated
   * 1970 is a typo either way; one dated 2069 is somebody's grandchild's
   * honeymoon and still parses.
   */
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (m) {
    const yy = Number(m[3]);
    const year = yy <= 69 ? 2000 + yy : 1900 + yy;
    return `${year}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  return "";
}
function pad2(n) { return String(n).padStart(2, "0"); }

/**
 * Steps 4, 5 and 6 — may this row have a receipt raised against it at all?
 *
 * The order is the guide's order, and the order matters: the balance decides
 * whether to stop (BR03/BR04) before the debtor is even looked at, and a stop
 * wins over a warning. Where both a warning and a stop apply, the Remarks
 * column takes the STOP — that is the one telling Finance what to do — and the
 * warning survives in `reason`, which is the prose the dashboard shows.
 *
 *   outstanding + future   → proceed, no remark
 *   outstanding + past     → proceed, "Please review, departure date has passed"   BR02
 *   nothing owing + future → STOP,    "No outstanding amount found"                BR03
 *   nothing owing + past   → STOP,    "No outstanding amount found, departure…"    BR04
 *   wrong debtor           → STOP,    "Please review, incorrect debtor found"      BR05
 *
 * Anything unreadable STOPS. Not because the guide says so — it has no such
 * case — but because the alternative is filing a real receipt on the strength
 * of a field nobody managed to read, and this whole flow moves money.
 */
function decidePreReceipt({ depDate, debtor, outstandingCents, today } = {}) {
  const stop = (remark, reason) => ({ proceed: false, remark, reason });

  if (outstandingCents == null) {
    return stop(REMARKS.review,
      "the amount outstanding on this booking could not be read, so no receipt was raised");
  }

  const passed = isPastDate(depDate, today);
  if (passed == null) {
    return stop(REMARKS.review,
      `the departure date could not be read (it reads "${depDate == null ? "" : depDate}"), ` +
      "so no receipt was raised");
  }

  // BR03 / BR04 — nothing owing stops the receipt, and the remark says whether
  // the departure had also gone.
  if (outstandingCents <= 0) {
    return passed
      ? stop(REMARKS.noOutstandingPassed, "the booking has nothing outstanding and the departure date has passed")
      : stop(REMARKS.noOutstanding, "the booking has nothing outstanding");
  }

  // BR05 — right money, wrong debtor. Compared on trimmed, case-folded text:
  // the page renders it with its own spacing and this is a name, not a code.
  const found = String(debtor || "").trim();
  if (found.toLowerCase() !== RETAIL_DEBTOR.toLowerCase()) {
    return stop(REMARKS.wrongDebtor,
      `the debtor is "${found || "(blank)"}", not ${RETAIL_DEBTOR}`);
  }

  // BR02 — owing, but the departure has gone. Receipt proceeds; Finance is told.
  if (passed) {
    return {
      proceed: true, remark: REMARKS.departurePassed,
      reason: `$${money(outstandingCents)} outstanding, but the departure date ${depDate} has passed`,
    };
  }

  return { proceed: true, remark: "", reason: `$${money(outstandingCents)} outstanding` };
}

/**
 * BR12 — "Only 1 bank statement to be created each day."
 *
 * Keyed on the STATEMENT DATE, not on today. That is what makes the rule and
 * the guide's own holiday note agree: when SA has a Monday public holiday,
 * Finance comes back on Tuesday and uploads two files, one for Monday and one
 * for Tuesday. Those are two statement dates, so they are two pages, uploaded
 * on one day — and this does not stand in their way. Two runs of the SAME
 * day's file are one date, and the second one is the mistake this catches.
 *
 * Returns the page already holding that date, or null.
 */
function pageForDate(pages, statementDate) {
  return pagesForDate(pages, statementDate)[0] || null;
}

/**
 * EVERY statement for that date, because there can be more than one.
 *
 * Measured on the live Trust account, 17-Aug-2026: pages 10, 11 and 12 all
 * carry 12-08-2026. So "the existing statement already created for the day"
 * (MINT BR03, TravelPay BR03) is not always a single thing, and picking the
 * first is picking one of three at random — on a screen where the next click
 * ticks transactions and commits them.
 *
 * `pageForDate` keeps its old single answer for BR12, where the question is
 * only "is this date taken?". Anything that has to OPEN one asks this and stops
 * when the answer is ambiguous.
 */
function pagesForDate(pages, statementDate) {
  const want = toIsoDate(statementDate);
  if (!want) return [];
  return (pages || []).filter((p) => p && toIsoDate(p.statementDate) === want);
}

/**
 * BR14 — the order Finance reads the file in: Shop, then Consultant.
 *
 * Alphabetical, case-insensitively, and blanks last rather than first: a row
 * whose branch could not be read is an exception, and exceptions belong at the
 * bottom of the page and not above ADL. Rows that tie on both keep the order
 * they came in, so the file still reads as the file that was uploaded.
 */
/**
 * IPSI step 19 — "Finalised and reconciled CSV file will be ordered in sequence
 * of ascending booking numbers".
 *
 * NOT `sortForFinance`, which orders by Shop then Consultant: that is BPay's
 * BR14 and IPSI has neither column. The IPSI export was going out in upload
 * order, which is whatever order IPSI's own download happened to be in.
 *
 * Numeric where the booking number is a number, so 99 comes before 100 rather
 * than after it the way a string sort would put it. Booking numbers that are
 * not plain digits (`B128297` appears in the TravelPay data) fall back to a
 * text compare, and rows with no booking number at all go LAST — they are the
 * ones needing attention and a person should not have to scroll past them to
 * find the work.
 */
function sortIpsiForExport(rows) {
  const num = (v) => {
    const t = String(v == null ? "" : v).trim();
    if (!t) return null;
    return /^\d+$/.test(t) ? Number(t) : t.toLowerCase();
  };
  return (rows || [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const an = num(a.r.bookingNo), bn = num(b.r.bookingNo);
      if (an == null && bn == null) return a.i - b.i;   // both blank: leave them be
      if (an == null) return 1;                          // blanks last
      if (bn == null) return -1;
      const bothNumbers = typeof an === "number" && typeof bn === "number";
      if (bothNumbers) return an === bn ? a.i - b.i : an - bn;
      const as = String(an), bs = String(bn);
      return as === bs ? a.i - b.i : (as < bs ? -1 : 1);
    })
    .map((x) => x.r);
}

function sortForFinance(rows) {
  const key = (v) => String(v == null ? "" : v).trim().toLowerCase();
  return (rows || [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const as = key(a.r.shop), bs = key(b.r.shop);
      if (!as !== !bs) return as ? -1 : 1;
      if (as !== bs) return as < bs ? -1 : 1;
      const ac = key(a.r.consultant), bc = key(b.r.consultant);
      if (!ac !== !bc) return ac ? -1 : 1;
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/* ── decision 1: allocate, or don't ──────────────────────────────────────── */

/**
 * What the receipt form still has outstanding, in cents.
 *
 * `readAllocatableSegments` returns one row per costed segment with its
 * `debtorDue`; the total left to allocate is their sum. A segment whose due
 * cannot be read makes the TOTAL unreadable rather than being treated as zero —
 * a silent zero would make an unmatched amount look matched and allocate a
 * receipt that should have been left alone.
 */
/**
 * Step 5 — is there an outstanding amount on this booking?
 *
 * The sum of the POSITIVE dues. Two differences from `totalLeftToAllocate`,
 * and both are deliberate:
 *
 *   · a booking with no segments at all is 0, not null — "nothing outstanding"
 *     is exactly what that means, and it is what BR03/BR04 need to fire;
 *   · a credit (negative due) does not net off against another segment's debt.
 *     A booking owing 200 on one segment and holding 50 in credit on another
 *     still has an outstanding amount, and BR03 must not stop the receipt.
 *
 * A due that cannot be read still poisons the whole answer to `null`, because
 * the alternative is treating an unreadable figure as nothing owed and
 * withholding a receipt for money that was actually banked.
 */
function outstandingFrom(segments) {
  if (!Array.isArray(segments) || !segments.length) return 0;
  let sum = 0;
  for (const s of segments) {
    const c = cents(s && s.debtorDue);
    if (c == null) return null;
    if (c > 0) sum += c;
  }
  return sum;
}

function totalLeftToAllocate(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  let sum = 0;
  for (const s of segments) {
    const c = cents(s && s.debtorDue);
    if (c == null) return null;
    sum += c;
  }
  return sum;
}

/**
 * Choose which WHOLE segments a receipt settles.
 *
 * Segments are never part-paid. A segment is either ticked — settling its full
 * Debtor Due, which is what ticking auto-fills — or left alone. So the job is
 * to pick the combination of complete segments whose total is the largest that
 * does not exceed the receipt:
 *
 *   $500 against 200 + 200  →  both, 400 settled, 100 of the receipt left over
 *   $300 against 200 + 200  →  one; 400 would exceed the receipt
 *   $200 against 200 + 200  →  the one it matches exactly
 *   $100 against 200 + 200  →  none; the receipt is filed and ticks nothing
 *
 * Two things fall out of "never exceed", and both matter. Nothing is ever typed
 * into an allocation box — ticking fills it — so the whole class of
 * silently-dropped-value bugs cannot apply here. And Seg Total stays at or
 * below Amt Rcvd, so the form's `Unalloc` can never go negative.
 *
 * All combinations are tried, not just a greedy sweep: against 50 + 200 a $200
 * receipt should settle the 200 outright, where taking the cheapest first would
 * settle the 50 and strand the rest. Bookings carry a handful of segments, so
 * the exhaustive search is free; past FEW_ENOUGH it falls back to
 * cheapest-first, which is the same answer in every case anyone will meet.
 *
 * Ties go to the cheapest segments — your "lowest Debtor Due first" — so
 * 200 against 100 + 100 + 200 clears the two hundreds rather than the one.
 */
const FEW_ENOUGH = 16;

function chooseSegments(amountCents, dues) {
  // Cheapest first: makes the greedy fallback right, and makes the tie-break
  // fall out of preferring earlier indexes.
  const asc = dues
    .map((d, i) => ({ ...d, i }))
    .filter((d) => d.due > 0)
    .sort((a, b) => (a.due - b.due) || (a.i - b.i));
  if (!asc.length) return [];

  if (asc.length > FEW_ENOUGH) {
    const out = [];
    let left = amountCents;
    for (const d of asc) {
      if (d.due <= left) { out.push(d); left -= d.due; }
    }
    return out;
  }

  let best = [];
  let bestTotal = 0;
  for (let mask = 1; mask < (1 << asc.length); mask++) {
    let total = 0;
    const pick = [];
    for (let b = 0; b < asc.length; b++) {
      if (mask & (1 << b)) { total += asc[b].due; pick.push(asc[b]); }
    }
    if (total > amountCents) continue;
    // Strictly greater only, so the FIRST subset reaching a total wins — and
    // because `asc` is cheapest-first, the earlier mask is the cheaper set.
    if (total > bestTotal) { bestTotal = total; best = pick; }
  }
  return best;
}

/**
 * What to do with one receipt — BR07 to BR11.
 *
 * THE RULE IS "EXACT, OR NOTHING", and it is narrower than it used to be.
 * There are exactly three ways a box gets ticked:
 *
 *   BR07  the receipt equals ONE segment exactly        → tick that one
 *   BR08  the receipt equals ALL the segments added     → tick them all
 *   BR11  the receipt is MORE than all of them added    → tick them all, and
 *                                                         say "Overpayment"
 *
 * Everything else — BR09 and BR10 — ticks nothing and asks a person, whether
 * the amount happens to fit some combination of segments or fits none of them.
 *
 * This deliberately replaces the earlier best-fit behaviour, which settled the
 * largest combination that did not exceed the receipt: $300 against 200 + 200
 * used to tick one of them and report "Part allocated". It no longer does. An
 * allocation nobody sanctioned is harder to unpick than one nobody made, and
 * the guide is explicit that the ambiguous case belongs to a human. The receipt
 * is still FILED either way (the money is banked and must be recorded); only
 * the allocation waits.
 *
 * `allocation` is what runTramadaReceipt takes: "ALL" for the proven Select All
 * path, an array of `{segId, amount}` for one named segment, or `[]` to file
 * the receipt and tick nothing.
 */
function decideAllocation(csvAmountCents, segments) {
  const no = (reason, remark = "") =>
    ({ allocate: false, allocation: [], status: "Not allocated", remark, reason });

  if (csvAmountCents == null) return no("the CSV amount could not be read", REMARKS.review);
  if (!Array.isArray(segments) || !segments.length) {
    return no("the booking has nothing outstanding to allocate against");
  }

  const dues = segments.map((s) => ({ segId: s && s.segId, due: cents(s && s.debtorDue) }));
  if (dues.some((d) => d.due == null)) {
    // An unreadable due is never treated as zero — that reads as "nothing owed"
    // and would tick a segment for an amount nobody has seen.
    return no("the amount outstanding on the receipt form could not be read", REMARKS.review);
  }

  const owing = dues.filter((d) => d.due > 0);
  if (!owing.length) return no("the booking has nothing outstanding to allocate against");

  const total = owing.reduce((a, d) => a + d.due, 0);
  const all = `all ${owing.length} segment${owing.length === 1 ? "" : "s"}`;

  /* BR11 — MORE MONEY THAN THE BOOKING OWES, and what happens next depends on
     how many segments there are. RAA, 29-Aug:

         "When overpayment amount found:
            If only 1 segment, then allocate
            If 2 or more segment, then do not allocate"

     Before this, an overpayment ticked EVERY segment and reported "Part
     allocated" whatever the count. The distinction RAA is drawing is about who
     decides where the extra money sits: with one segment there is only one
     place it can go, so the machine can settle it. With two or more, spreading
     an overpayment across them is a judgement about which booking segment is
     really overpaid — and getting that wrong puts money against the wrong
     segment of a real customer's booking. That is a person's call.

     So the multi-segment case ticks NOTHING and asks for a human, rather than
     allocating and leaving a remark for someone to notice later. */
  if (csvAmountCents > total) {
    if (owing.length === 1) {
      const only = owing[0];
      return {
        allocate: true, allocation: [{ segId: only.segId, amount: money(only.due) }],
        status: "Allocated", remark: REMARKS.overpayment,
        reason: `$${money(csvAmountCents)} is more than the $${money(total)} outstanding — ` +
          `the one segment is settled and $${money(csvAmountCents - total)} of this receipt ` +
          `stays unallocated`,
      };
    }
    return no(
      `$${money(csvAmountCents)} is more than the $${money(total)} outstanding across ` +
      `${owing.length} segments — which segment is overpaid is a decision for a person, ` +
      `so nothing was ticked`,
      REMARKS.overpayment
    );
  }

  // BR08 — exactly what is owed, across every segment.
  if (csvAmountCents === total) {
    return {
      allocate: true, allocation: "ALL", status: "Allocated", remark: "",
      reason: `$${money(total)} settles ${all} exactly`,
    };
  }

  // BR07 — exactly one segment. First match in the form's own order, so the
  // segment ticked is the one a person reading the screen would tick.
  const single = owing.find((d) => d.due === csvAmountCents);
  if (single) {
    return {
      allocate: true, allocation: [{ segId: single.segId, amount: money(single.due) }],
      status: "Allocated", remark: "",
      reason: `$${money(csvAmountCents)} settles segment ${single.segId} exactly`,
    };
  }

  // BR09 / BR10 — no tick either way. The two are told apart only in the prose,
  // because they mean different things to whoever picks the row up: one is an
  // amount that fits a combination nobody authorised, the other fits nothing.
  const combination = chooseSegments(csvAmountCents, dues);
  const fits = combination.reduce((a, d) => a + d.due, 0) === csvAmountCents && combination.length > 0;
  if (fits) {
    return no(
      `$${money(csvAmountCents)} matches ${combination.length} of the ${owing.length} segments added together, ` +
      `but not one on its own and not ${all} — left for a person to allocate`,
      REMARKS.allocate
    );
  }
  const cheapest = Math.min(...owing.map((d) => d.due));
  // Named separately from the generic "fits nothing" case below: an amount
  // smaller than every segment can never be allocated, no matter which
  // combination is tried, so the person picking the row up should be told
  // that up front rather than left to work it out from a list of totals.
  if (csvAmountCents < cheapest) {
    return no(
      `$${money(csvAmountCents)} is less than the cheapest segment, which owes $${money(cheapest)} ` +
      `— left for a person to allocate`,
      REMARKS.allocate
    );
  }
  return no(
    `$${money(csvAmountCents)} matches no segment and does not match the $${money(total)} outstanding ` +
    `(the cheapest segment owes $${money(cheapest)}) — left for a person to allocate`,
    REMARKS.allocate
  );
}

/* ── decision 2: reconciled, or not ──────────────────────────────────────── */

/**
 * Does this CSV line appear on the statement, at the same amount?
 *
 * Reference first, then amount — and the two are reported separately, because
 * "the reference isn't there at all" and "it's there for a different amount"
 * are different problems with different fixes, and collapsing them into one
 * "not reconciled" throws away the only clue.
 *
 * A reference appearing more than once is NOT an error: a match against any of
 * them at the right amount reconciles. But it is reported, because two lines
 * sharing a reference is how a double payment hides.
 */
function matchAgainstStatement(row, statementRows) {
  // Nothing was filed, so there is nothing to look for. Saying "not reconciled"
  // here would blame the statement for a receipt that was never created.
  if (!row.receiptNo) {
    return {
      reconciled: false, status: "Not reconciled",
      reason: "no receipt number came back, so there is nothing to look for",
    };
  }

  const key = receiptKey(row.receiptNo);
  const hits = (statementRows || []).filter((t) => receiptKey(t.transNo) === key);
  if (!hits.length) {
    return {
      reconciled: false, status: "Not reconciled",
      reason: `receipt ${row.receiptNo} is not among the transactions on this page`,
    };
  }
  const exact = hits.find((t) => cents(t.amount) === row.amountCents);
  if (!exact) {
    const seen = hits.map((t) => `$${money(cents(t.amount))}`).join(", ");
    return {
      reconciled: false, status: "Not reconciled",
      reason: `receipt ${row.receiptNo} is on the statement at ${seen}, not $${money(row.amountCents)}`,
      duplicates: hits.length > 1 ? hits.length : undefined,
    };
  }

  /* On the statement at the right amount is not the same question as
     PROPERLY ALLOCATED. BR11 tills an overpayment (ticks every segment, money
     left over) and BR09/BR10 tick nothing (the amount matched no segment, or
     matched a combination nobody authorised) — in both cases the receipt is
     real and it IS the money on this statement line, but nobody has told
     Tramada what it is actually for. Calling that "Reconciled" said the day's
     work on this line was done when a person still has to open the booking
     and decide. `row.why` already carries decideAllocation's own detail (the
     dollar figures, which segment is short) — folded in here rather than
     dropped, because this is the last thing written to `why` before the
     screen renders it. No `transNo` is returned either: this line is not
     ticked on the statement page, the same as any other row a person still
     has to look at. */
  /* "ALREADY FILED" IS NOT AN UNCLEAN ALLOCATION, and treating it as one made
     a rerun unable to reconcile anything.

     First run: the receipt is filed and allocated, `allocation` reads
     "Allocated", the line ticks. Run the SAME file again — which is exactly
     what RAA's workflow does, "press Rerun or similar function to run the
     reconciliation process again" — and the receipt is already on the booking,
     so nothing is filed a second time and `allocation` reads "Already filed".
     That is the run being careful, not a problem with the row. But it is not
     the string "Allocated", so this guard refused every one of them: observed
     01-Sep, "0 of 10 reconciled" with three real receipts sitting on page 18
     at exactly the right amounts.

     A rerun that can never finish is worse than useless — it is the mode
     Finance is told to use after fixing errors. So an already-filed receipt
     reconciles on the same evidence a freshly-filed one does: it is a real
     receipt, it is on this page, and the amount agrees to the cent (checked
     above — a receipt on the page for the WRONG amount has already returned
     by this point). What it does not carry is a fresh allocation decision from
     THIS run, so it says so in the reason rather than claiming this run did
     the work. */
  const alreadyFiled = row.allocation === "Already filed";
  if (row.allocation && row.allocation !== "Allocated" && !alreadyFiled) {
    return {
      reconciled: false, status: "Not reconciled",
      reason: `receipt ${row.receiptNo} found on the statement at $${money(row.amountCents)}, ` +
        `but left Not reconciled — ${row.allocation.toLowerCase()}: ${row.why || row.remark || "the allocation was not a clean match"}`,
      duplicates: hits.length > 1 ? hits.length : undefined,
    };
  }

  return {
    reconciled: true, status: "Reconciled",
    reason: `receipt ${row.receiptNo} found at $${money(row.amountCents)}` +
      (alreadyFiled ? " — filed by an earlier run, not this one" : ""),
    transNo: exact.transNo || null,
    duplicates: hits.length > 1 ? hits.length : undefined,
  };
}

/* ── the new statement page ──────────────────────────────────────────────── */

/**
 * The page number for a NEW reconciliation statement.
 *
 * Highest existing page plus one — never reusing a page, which is the whole
 * point of "it has to be a new reconciliation page". Derived from what the
 * search screen actually returned rather than remembered between runs, because
 * a second run in the same day must land on the page after the one the first
 * run created.
 */
function nextPageNumber(existingPages) {
  const nums = (existingPages || [])
    .map((p) => parseInt(String(typeof p === "object" ? p.pageNo : p).trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return 1;
  return Math.max(...nums) + 1;
}

/** Tramada writes dates dd-mm-yyyy. Accepts ISO or dd-mm-yyyy, returns dd-mm-yyyy. */
function toTramadaDate(v) {
  const s = String(v == null ? "" : v).trim();
  /* Everything goes through toIsoDate first, so every shape the files actually
     carry — 2026-01-07, 07/01/2026, and RAA's own 07-01-26 — comes out as the
     dd-mm-yyyy Tramada's date fields expect. A two-digit year used to be handed
     to Tramada untouched, and what a finance system does with "07-01-26" in a
     date field is its business, not something to find out on a live receipt.
     Anything still unreadable is passed through rather than mangled: the field
     read-back will catch it and say so. */
  const iso = toIsoDate(s);
  if (iso) return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  return s;
}

/**
 * The same date, `days` earlier, as `yyyy-mm-dd`.
 *
 * Reads either shape this project passes around — `2026-08-12` from a form, or
 * `12-08-2026` as Tramada writes it — because the caller genuinely may have
 * either, and reading one as the other would search a range months away.
 *
 * UTC arithmetic, so it cannot slide an hour across a daylight-saving boundary
 * and land on the wrong day. Month and year ends fall out of that for free:
 * 2 days before 2026-03-01 is 2026-02-27.
 *
 * A date it cannot read comes back EMPTY, never a guess. Empty means "no From
 * date" — a wide search and a slow one, but an honest one. A wrong From is a
 * search that quietly misses receipts.
 */
function daysBefore(value, days) {
  const s = String(value == null ? "" : value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  let y, m, d;
  if (iso) [, y, m, d] = iso;
  else if (dmy) [, d, m, y] = dmy;
  else return "";
  const n = Number(days);
  if (!Number.isFinite(n)) return "";
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) - n * 86400000);
  const p = (x) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/* ── reading a Tramada grid ──────────────────────────────────────────────── */

/**
 * Column indexes BY HEADER NAME.
 *
 * Tramada's Bank Statements grid opens with an **Action** column of icon links:
 *
 *   Action | Bank Account | Page No | Statement Date | Opening | Closing | …
 *
 * Counting from zero put `pageNo` on "TRUST" and shifted every other field one
 * to the left. Nine rows of existing pages were then read as nine unreadable
 * page numbers, discarded, and answered as "no statements — start at page 1",
 * for an account whose grid was showing 1 through 9 on screen at the time.
 *
 * Same rule as `parseReconCsv`, same reason: a column inserted at the front
 * shifts every value while each row still looks perfectly plausible. This lives
 * here, not inside a `page.evaluate`, so it can be tested against captured
 * headers instead of against a live portal.
 *
 * A name matches exactly, or as a prefix — "trans. no" finds "Trans. No ▲▼"
 * once the sort arrows are in the cell text. `fallbacks` supplies a position
 * for a column whose header cannot be found at all; without one the key comes
 * back `-1` and `rowsByHeader` leaves it empty rather than guessing.
 */
function mapColumns(headers, spec, fallbacks) {
  const hs = (headers || []).map((h) =>
    String(h == null ? "" : h).replace(/\s+/g, " ").trim().toLowerCase());
  /* SPACES IN A HEADING ARE NOT PART OF THE HEADING.
   *
   * TravelPay's standard template writes them closed up — `PaymentReference`,
   * `ProcessedAmount` — while the spec here spells them open, and the two never
   * met: "paymentreference" is not "payment reference" and does not start with
   * it either, so the column came back -1 and the file was refused as missing a
   * column it plainly had (POC feedback, TravelPay 02).
   *
   * The evidence this had been met before is three lines up in
   * TRAVELPAY_COLUMNS: `toCompany` lists BOTH "merchantcompanyname" and
   * "merchant company name". That is this bug, patched one column at a time.
   * Fixing the matcher fixes it for every column of every report at once —
   * MINT's "Transaction ID", IPSI's "Booking Number" and the rest are all one
   * template revision away from the same thing.
   *
   * Tried in order, so nothing that matched before can start matching something
   * else now: exact, then prefix, then the same two ignoring spaces. */
  const tight = hs.map((h) => h.replace(/\s+/g, ""));
  const fb = fallbacks || {};
  const out = {};
  for (const [key, names] of Object.entries(spec || {})) {
    let idx = -1;
    for (const name of names) {
      const want = String(name).toLowerCase();
      const wantTight = want.replace(/\s+/g, "");
      idx = hs.indexOf(want);
      if (idx < 0) idx = hs.findIndex((h) => h.startsWith(want));
      if (idx < 0) idx = tight.indexOf(wantTight);
      if (idx < 0) idx = tight.findIndex((h) => h.startsWith(wantTight));
      if (idx >= 0) break;
    }
    out[key] = idx >= 0 ? idx : (key in fb ? fb[key] : -1);
  }
  return out;
}

/** Grid rows (arrays of cell text) into objects, using `mapColumns`. */
function rowsByHeader(headers, rows, spec, fallbacks) {
  const cols = mapColumns(headers, spec, fallbacks);
  return (rows || []).map((cells) => {
    const out = {};
    for (const [key, i] of Object.entries(cols)) {
      out[key] = i >= 0 && cells && cells[i] != null ? String(cells[i]) : "";
    }
    return out;
  });
}

/** The Bank Statements search grid. */
const STATEMENT_COLUMNS = {
  account: ["bank account", "account"],
  pageNo: ["page no", "page"],
  statementDate: ["statement date", "date"],
  opening: ["opening balance", "opening"],
  closing: ["closing balance", "closing"],
};

/** The reconciliation screen's transaction grid. */
const TRANSACTION_COLUMNS = {
  date: ["date"],
  transNo: ["trans. no", "trans no", "transaction number"],
  recPayType: ["rec/pay type"],
  transType: ["trans type"],
  reference: ["reference"],
  payee: ["receipt for", "receipt for/payment to", "payee"],
  debit: ["debit"],
  credit: ["credit"],
};

// Measured 06-Aug-2026. Only used if a header cannot be read at all.
const TRANSACTION_FALLBACK = {
  date: 0, transNo: 1, recPayType: 2, transType: 3,
  reference: 4, payee: 5, debit: 6, credit: 7,
};

/* ── the Mint daily settlement ───────────────────────────────────────────── */

/**
 * The three columns the Mint run uses, by header name.
 *
 * The sample's header is literally `"To Company "`, with a trailing space —
 * `mapColumns` trims, which is the only reason it matches. The other thirteen
 * columns are read and ignored; naming the three the run needs is what keeps a
 * reordered export from quietly shifting them.
 */
const MINT_COLUMNS = {
  transNo: ["transaction reference", "transaction ref", "transaction id", "trans no", "trans. no"],
  amount: ["amount"],
  toCompany: ["to company", "company"],
  /* WHERE A MINT ROW'S BOOKING NUMBER LIVES, and it is not a guess — the MINT
     payments guide says it outright: "Sender Reference is the Booking Number
     from Tramada", "Recipient Reference is the Reference number from Tramada".
     Neither is required and neither is matched on; they are read so the results
     table can NAME the booking a settlement belongs to. Without them a Mint row
     had no booking number anywhere on it and the Booking column sat empty on
     every row while the row reconciled perfectly well. */
  senderReference: ["sender reference", "sender ref"],
  recipientReference: ["recipient reference", "recipient ref"],
};

/* The three the run actually needs. The two reference columns are optional:
   a file without them still reconciles, it just cannot say which booking. */
const MINT_REQUIRED = ["transNo", "amount", "toCompany"];

/**
 * A CSV as a header row plus data rows — the same shape `xlsx-lite.readSheet`
 * returns, so `parseMintRows` does not care which one it was given.
 *
 * Mint exports as a workbook, but a CSV of the same columns is easier to hand-
 * write for a test, so the Mint card takes either. Which parser runs is decided
 * by the file's own container (a zip starts `PK`), never by its name or its
 * contents — that is the demo's detector and it is not coming back.
 */
function csvGrid(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { headers: [], rows: [] };
  const grid = lines.map(splitCsvLine);
  /* Mint's "Download Copy" export leads with a title band — "Total Outgoing
     Amount" and its own total, one populated column each in an otherwise-wide
     row, sometimes with a blank row either side — ahead of the row that
     actually names "From Company", "Amount" and the rest. A genuine header
     row always names more than one column of a row that HAS more than one;
     a title or a total figure never does. The "row has more than one column"
     guard is what keeps this from eating a genuinely single-column sheet,
     where the header names exactly one thing on every row, on purpose. */
  let head = 0;
  while (head < grid.length - 1 &&
    grid[head].length > 1 && grid[head].filter((c) => c.trim() !== "").length <= 1) head++;
  return {
    headers: grid[head].map((h) => h.trim()),
    rows: grid.slice(head + 1),
  };
}

/**
 * A Mint workbook's rows → rows the run can check.
 *
 * Unlike the BPay CSV this files NOTHING. There is no booking number and no
 * receipt to raise: these are settlements Tramada already knows about, and the
 * only question is whether each one reached the statement page.
 *
 * A row with no transaction reference cannot be looked for, so it comes back in
 * `problems` rather than being dropped — a quietly shortened file reads as
 * "that was all there was".
 */
function parseMintRows(headers, gridRows) {
  const cols = mapColumns(headers, MINT_COLUMNS);
  const missing = MINT_REQUIRED.filter((k) => cols[k] < 0);
  if (missing.length) {
    const want = missing.map((k) => MINT_COLUMNS[k][0]).join(", ");
    return { rows: [], problems: [{ line: 1, why: `the sheet has no column for: ${want}` }] };
  }

  const rows = [];
  const problems = [];
  (gridRows || []).forEach((cells, i) => {
    const row = {
      line: i + 2,                       // +1 for the header, +1 for 1-based
      transNo: String(cells[cols.transNo] == null ? "" : cells[cols.transNo]).trim(),
      amount: String(cells[cols.amount] == null ? "" : cells[cols.amount]).trim(),
      toCompany: String(cells[cols.toCompany] == null ? "" : cells[cols.toCompany]).trim(),
    };
    const at = (key) => (cols[key] >= 0 && cells[cols[key]] != null ? String(cells[cols[key]]).trim() : "");
    /* Sender first — the guide says that IS the booking number. Recipient is
       the Tramada reference, which on a file like our own fixture carries the
       booking too (MP-{tag}-{booking}), so it is worth a second look before
       giving up. Same extractor TravelPay already uses on the same shape. */
    row.senderReference = at("senderReference");
    row.recipientReference = at("recipientReference");
    row.bookingNo = bookingFromReference(row.senderReference) ||
      bookingFromReference(row.recipientReference) || "";
    row.rawAmount = row.amount;
    row.amountCents = cents(row.amount);
    /**
     * The amount is normalised to two places for DISPLAY.
     *
     * A workbook stores what the binary float actually holds, so `10383.96`
     * comes out of the XML as the string `10383.959999999999`, and the inbox
     * showed exactly that next to a company name. The comparison was never
     * affected — `cents()` rounds — but a money column that reads
     * `30086.639999999999` looks like a fault in the file the agent is about to
     * act on. The raw text is kept in `rawAmount` so nothing is lost.
     */
    if (row.amountCents != null) row.amount = money(row.amountCents);
    const why = [];
    if (!row.transNo) why.push("no transaction reference");
    if (row.amountCents == null) why.push(`unreadable amount "${row.rawAmount}"`);
    if (why.length) {
      // Same as BPay's own remark: carried ON the row, not just the problem
      // wrapper, because the run's results table reads a row's Remarks cell
      // off `remark`, not off `problems`.
      row.remark = REMARKS.review;
      problems.push({ line: row.line, why: why.join("; "), row });
    } else rows.push(row);
  });
  return { rows, problems };
}

/**
 * Is this Mint settlement on the statement page?
 *
 * **The transaction reference being present is what decides it.** That was the
 * instruction and it is the right one: Mint's reference IS the transaction
 * number Tramada posted it under, so finding it means the settlement reached
 * the page. Nothing is filed and nothing is allocated.
 *
 * The amount and the company are still compared, and a difference is reported
 * without failing the row — a settlement that arrived for a different figure is
 * something to chase, but it did arrive, and calling that "not reconciled"
 * would read exactly like one that never came.
 */
function matchMintAgainstStatement(row, statementRows) {
  const key = receiptKey(row.transNo);
  const hits = (statementRows || []).filter((t) => receiptKey(t.transNo) === key);
  if (!hits.length) {
    return {
      reconciled: false, status: "Not reconciled",
      reason: `${row.transNo} is not among the transactions on this page`,
    };
  }

  const notes = [];
  // Prefer a transaction that agrees on the money, so the reported one is the
  // best match rather than merely the first.
  const onAmount = hits.find((t) => cents(t.amount) === row.amountCents);
  const hit = onAmount || hits[0];
  if (row.amountCents != null && !onAmount) {
    notes.push(`the page says $${money(cents(hit.amount))}, the file says $${money(row.amountCents)}`);
  }
  if (row.toCompany && hit.payee && refKey(hit.payee) !== refKey(row.toCompany)) {
    notes.push(`paid to "${hit.payee}", the file says "${row.toCompany}"`);
  }

  /* TRAMADA'S OWN BOOKING NUMBER, off the statement row's Reference column —
     the payment was raised under a reference carrying it, and the statement
     grid has no booking column of its own. Same principle as IPSI's step 15:
     what was actually FOUND beats what the file claimed, and where the two
     disagree the results table shows both. Empty when the reference carries no
     booking, which is not a failure — the row still reconciled. */
  return {
    reconciled: true, status: "Reconciled",
    reason: `${row.transNo} found on the page` + (notes.length ? ` — ${notes.join("; ")}` : ""),
    transNo: hit.transNo || null,
    bookingNo: bookingFromDelimitedReference(hit.reference) || undefined,
    mismatch: notes.length ? notes.join("; ") : undefined,
    duplicates: hits.length > 1 ? hits.length : undefined,
  };
}

/**
 * A TravelPay settlement row against the statement page.
 *
 * **TravelPay's Payment Reference is TRAVELPAY's number, not Tramada's.** The
 * client's own export carries `31282716` and `31282311` — merchant gateway
 * transaction ids. Tramada's `Trans. No` is an `R.` receipt number and can
 * never equal one of those, so the Mint matcher — which compares Payment
 * Reference against `Trans. No` — could only ever match a file whose Payment
 * Reference had been made to hold a Tramada receipt number.
 *
 * Our own fixture was doing exactly that. It wrote `9413` into the column the
 * real file fills with `31282716`, matched itself, and proved nothing about the
 * real thing. That is how this went unnoticed.
 *
 * Where a merchant's reference DOES land on the statement is the **Reference**
 * column, because that is where it is typed when the receipt is raised. So that
 * is looked at first.
 *
 * `Trans. No` is still tried after it. It costs nothing, it is what the older
 * fixture files carry, and a row found either way is really on the page. Which
 * one it matched on is reported rather than glossed over.
 */
function matchTravelPayAgainstStatement(row, statementRows) {
  const rows = statementRows || [];

  /* NO REFERENCE, NO MATCH — and say so rather than looking.
     `refKey("")` is "", which would match every statement row whose own
     Reference is blank: the run would report a settlement reconciled against
     whichever unrelated line happened to have an empty cell. These rows reach
     the matcher at all only since 03-09-2026, when a blank Payment Reference
     stopped being a reason to drop the row at upload, so this guard arrived
     with them. The row is reported, flagged, and NOT reconciled. */
  if (!String(row.transNo || "").trim()) {
    return {
      reconciled: false, status: "Not reconciled",
      remark: REMARKS.noReference,
      reason: `the file carries no payment reference for ` +
        (row.bookingNo ? `booking ${row.bookingNo}` : "this row") +
        `, so there is nothing to look for on the statement page`,
    };
  }

  const want = refKey(row.transNo);

  const describe = (hit, on, hits) => {
    const notes = [];
    if (row.amountCents != null && cents(hit.amount) !== row.amountCents) {
      notes.push(`the page says $${money(cents(hit.amount))}, the file says $${money(row.amountCents)}`);
    }
    /* The company is NOT compared, and that is deliberate — the two columns
       hold different things.

       TravelPay's `MerchantCompanyName` is RAA's own merchant account,
       "Monarto Resort Pty Ltd" on every row of the client's export. The
       statement's "Receipt For/Payment To" is the CLIENT the receipt was taken
       from, "GRAY/SPIDER MS". They disagree on every row by design, so
       comparing them the way the Mint matcher does — where To Company really is
       the creditor being paid — would flag a difference on all of them and
       train you to ignore the column that exists to catch a real one. */
    return {
      reconciled: true, status: "Reconciled", on,
      reason: `${row.transNo} found on the page` +
        (on === "transNo" ? " as a transaction number" : " in the Reference column") +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
      transNo: hit.transNo || null,
      // Same as Mint: the statement grid has no booking column, but the receipt
      // was raised under a reference carrying one. What was FOUND, next to what
      // the file claimed.
      bookingNo: bookingFromDelimitedReference(hit.reference) || undefined,
      mismatch: notes.length ? notes.join("; ") : undefined,
      duplicates: hits.length > 1 ? hits.length : undefined,
    };
  };

  if (want) {
    /* The digits alone, unpadded — `R.0000009413` and `9413` both reduce to
       "9413". `receiptKey` does NOT: it keeps the letters, so `R.0000009413`
       is "R9413" and a file carrying the bare number misses. The old fixture
       wrote exactly that bare number and claimed in a comment that the two
       "meet in the middle". They never did, and TravelPay reconciled nothing.
       Only used when the file's value is all digits, so it cannot loosen the
       match for a reference that is real text. */
    const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "");
    const numeric = /^\d+$/.test(String(row.transNo || "").trim());
    const lookups = [
      ["reference", (t) => refKey(t.reference) === want],
      ["transNo", (t) => refKey(t.transNo) === want ||
        receiptKey(t.transNo) === receiptKey(row.transNo) ||
        (numeric && !!digits(row.transNo) && digits(t.transNo) === digits(row.transNo))],
    ];
    for (const [on, hit] of lookups) {
      const hits = rows.filter(hit);
      if (!hits.length) continue;
      // Prefer one that agrees on the money, so the reported hit is the best
      // match rather than merely the first — the rule every matcher here uses.
      const onAmount = hits.find((t) => cents(t.amount) === row.amountCents);
      return describe(onAmount || hits[0], on, hits);
    }
  }

  return {
    reconciled: false, status: "Not reconciled", on: null,
    reason: `${row.transNo || "(no payment reference)"} is not on this page — ` +
      "not in the Reference column and not as a transaction number",
  };
}

/* ── receipts already on a booking ───────────────────────────────────────── */

/**
 * The Booking Receipts grid, by header name.
 *
 *   Action | Receipt No. | Receipt Category | Receipt Type | Trans. Type |
 *   Received From | Reference | Date Received | Amount | Allocated
 */
const BOOKING_RECEIPT_COLUMNS = {
  receiptNo: ["receipt no.", "receipt no"],
  receiptCategory: ["receipt category"],
  receiptType: ["receipt type"],
  transType: ["trans. type", "trans type"],
  receivedFrom: ["received from"],
  reference: ["reference"],
  dateReceived: ["date received"],
  amount: ["amount"],
  allocated: ["allocated"],
};

/**
 * Is this receipt already on the booking?
 *
 * **Reference AND amount, both.** Either one alone is not a duplicate:
 * a booking can legitimately take two receipts for the same amount on
 * different references, and one reference can be followed by a correcting
 * receipt for a different figure. It is the pair that says "this exact receipt
 * has already been filed", and filing it again takes the money twice.
 *
 * Reference is compared as text, case- and space-insensitive, because it is
 * typed. Amount is compared in cents, because "394.00" and "394" are the same
 * money and neither is a float here.
 *
 * A row with no reference matches nothing — a blank cell must never look like
 * a blank request.
 */
function findFiledReceipt(rows, { reference, amount, amountCents } = {}) {
  const wantRef = refKey(reference);
  const wantCents = amountCents != null ? amountCents : cents(amount);
  if (!wantRef || wantCents == null) return null;
  const hits = (rows || []).filter((r) =>
    refKey(r.reference) === wantRef && cents(r.amount) === wantCents);
  if (!hits.length) return null;
  return { ...hits[0], duplicates: hits.length > 1 ? hits.length : undefined };
}

/** Counts for the Mint inbox. There is no allocation, so there is no column. */
function summariseMint(results) {
  const r = results || [];
  return {
    total: r.length,
    reconciled: r.filter((x) => x.reconciliation === "Reconciled").length,
    notReconciled: r.filter((x) => x.reconciliation === "Not reconciled").length,
    mismatched: r.filter((x) => x.mismatch).length,
    failed: r.filter((x) => x.error).length,
  };
}

/* ── errors, made fit to show a person ───────────────────────────────────── */

/**
 * A Playwright failure, shortened to the sentence that says what went wrong.
 *
 * Raw messages carry a `Call log:` block and ANSI colour codes. Put one in a
 * table cell and the cell becomes a paragraph of escape sequences with the real
 * reason buried in the middle — which is exactly what the reconciliation inbox
 * showed the first time a run failed, so the row said nothing usable.
 *
 * The one part of the log worth keeping is what intercepted a click: "blocked
 * by <div>" is the difference between a selector that is wrong and an overlay
 * that was in the way.
 */
function tidyError(msg) {
  const raw = String(msg == null ? "" : msg);
  let m = raw;
  const cut = m.search(/\n\s*(Call log:|=+\s*logs\s*=+|\[2m)/);
  if (cut > 0) m = m.slice(0, cut);
  const blocker = raw.match(/<([a-z0-9-]+)[^>]*>[^<]*<\/\1>\s*intercepts pointer events/i)
    || raw.match(/from <([a-z0-9-]+)[^>]*>[^<]*subtree intercepts pointer events/i);
  if (blocker) m += ` (blocked by <${blocker[1]}>)`;
  // Strip any colour codes that survived the cut, then collapse the whitespace
  // the log's indentation leaves behind.
  m = m.replace(/\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 400);

  // Modules wrap a lower-level failure as `... [${err.message}]`, and that
  // inner message is usually the one carrying the call log — so the cut lands
  // INSIDE the brackets and leaves one hanging open. The inbox showed
  // "…ECONNREFUSED 127.0.0.1:9222" with nothing closing it. Close it rather
  // than drop the fragment: the sentence before the bracket is what the agent
  // needs, and the bracket is what a developer needs.
  const opens = (m.match(/\[/g) || []).length;
  const closes = (m.match(/\]/g) || []).length;
  if (opens > closes) m += "…]".repeat(opens - closes);
  return m;
}

/* ── the TravelPay merchant settlement ───────────────────────────────────── */

/**
 * The three columns the TravelPay run uses, by header name.
 *
 * **`Payment Reference` is what reconciles a row**, not `Processor Reference`
 * and not `Customer Reference` — all three are in the file and only one of them
 * is what Tramada posts the transaction under.
 *
 * The amount is `Processed Amount`, which is `Base Amount` + `Customer Fee`.
 * The sample's fees are all zero so the two columns agree there, and they will
 * not agree on the first row that carries a fee: the bank moved the processed
 * figure, so that is the figure to reconcile against.
 */
const TRAVELPAY_COLUMNS = {
  transNo: ["payment reference"],
  amount: ["processed amount"],
  toCompany: ["merchantcompanyname", "merchant company name", "merchant name"],
  status: ["transaction status"],
  reference: ["additional reference"],
  failure: ["failure reason"],
  date: ["processing date"],
  settlementDate: ["merchant settlement date"],
};

/**
 * An Excel serial number as `yyyy-mm-dd`.
 *
 * TravelPay's Processing Date arrives as `46204`, because that is what a
 * workbook stores and `xlsx-lite` deliberately does not convert dates — turning
 * one back needs the number format out of styles.xml, and until now nothing
 * needed one. TravelPay does.
 *
 * The epoch is 1899-12-30, not 1900-01-01: Excel believes 1900 was a leap year,
 * and the two-day offset is how everybody else's code stays compatible with
 * that. Anything that is not a plain positive number comes back untouched —
 * a date this does not recognise is reported, never reformatted into a wrong
 * one.
 */
function serialDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * The booking number buried in TravelPay's `Additional Reference`.
 *
 * The real values are `"Client Name -  128380"` and `"Client Name - B128297  "`
 * — a doubled space in one, trailing spaces on the other, and a `B` prefix on
 * only one of them. Nothing here is filed against that booking (the run checks,
 * it does not write), so this is for showing a person which booking a
 * settlement belongs to; it is deliberately not used to match.
 */
function bookingFromReference(v) {
  const m = String(v == null ? "" : v).trim().match(/([A-Za-z]?\d{4,})\s*$/);
  return m ? m[1] : "";
}

/**
 * The same, but only from a reference SHAPED like one — `TP-4C6P4-14636`.
 *
 * For the Tramada statement's Reference column, where the loose rule above is
 * actively dangerous: a real TravelPay Payment Reference is a bare merchant
 * gateway id (`31282716`), and `bookingFromReference` happily returns it as a
 * booking number. That reads as "Tramada says this settled against booking
 * 31282716" — a number nobody entered, in a column that claims to be Tramada's
 * own. §3: never invent a number.
 *
 * So: a delimiter and a trailing number, or nothing.
 *
 *   TP-4C6P4-14636  → 14636
 *   31282716        → ""      (a gateway id, not a booking)
 *   R.0000009413    → ""      (a receipt number, not a booking)
 */
function bookingFromDelimitedReference(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/-/.test(s)) return "";
  return bookingFromReference(s);
}

/**
 * A TravelPay export's rows → rows the run can check.
 *
 * Like Mint, this files NOTHING: these are settlements Tramada already holds
 * and the only question is whether each reached the statement page.
 *
 * A transaction that did not succeed is HELD BACK rather than checked. It never
 * reached the bank, so it cannot be on the statement, and calling it "not
 * reconciled" would put a failure on the screen that reads exactly like a
 * settlement that went missing. The reason it gives is TravelPay's own.
 */
function parseTravelPayRows(headers, gridRows) {
  const cols = mapColumns(headers, TRAVELPAY_COLUMNS);
  const missing = ["transNo", "amount"].filter((k) => cols[k] < 0);
  if (missing.length) {
    const want = missing.map((k) => TRAVELPAY_COLUMNS[k][0]).join(", ");
    return { rows: [], problems: [{ line: 1, why: `the sheet has no column for: ${want}` }] };
  }

  const at = (cells, key) => (cols[key] >= 0 && cells[cols[key]] != null ? String(cells[cols[key]]).trim() : "");
  const rows = [];
  const problems = [];
  (gridRows || []).forEach((cells, i) => {
    const row = {
      line: i + 2,                       // +1 for the header, +1 for 1-based
      transNo: at(cells, "transNo"),
      amount: at(cells, "amount"),
      toCompany: at(cells, "toCompany"),
      status: at(cells, "status"),
      reference: at(cells, "reference"),
      // Straight out of a workbook these are Excel serials (46204); out of the
      // CSV they are already dates. serialDate leaves anything that is not a
      // plain number alone, so one call covers both containers.
      date: serialDate(at(cells, "date")),
      settlementDate: serialDate(at(cells, "settlementDate")),
    };
    row.bookingNo = bookingFromReference(row.reference);
    row.rawAmount = row.amount;
    row.amountCents = cents(row.amount);
    // Same reason as Mint: a workbook hands back what the float actually holds,
    // so 10383.96 arrives as "10383.959999999999".
    if (row.amountCents != null) row.amount = money(row.amountCents);

    const why = [];
    let unusable = false;

    /* A MISSING PAYMENT REFERENCE IS A FLAG, NOT A REASON TO DROP THE ROW.
       Asked for 03-09-2026: "flag only in the reconciliation that it doesn't
       have reference, still detect it when uploaded."

       It used to be held back, which meant a settlement that was really in the
       file never reached the screen — the same mistake IPSI made and undid:
       "a row is only unusable when there is NOTHING to match it by ... which
       threw away rows that would have matched perfectly well on their booking
       number". So the row survives as long as something still names it.

       Status can say "Successful" while the reference is blank — seen on a row
       where the receipt run's own browser timed out mid-click after Tramada had
       already marked the transaction successful. Failure Reason is the only
       place that survives, so it is read even though the status check below
       would not have caught this row. */
    if (!row.transNo) {
      const reason = at(cells, "failure");
      row.noReference = true;
      if (!row.bookingNo) {
        why.push(reason
          ? `no payment reference and no booking number — ${reason}`
          : "no payment reference and no booking number — nothing to name this row by");
        unusable = true;
      }
    }

    if (row.amountCents == null) { why.push(`unreadable amount "${row.rawAmount}"`); unusable = true; }
    /* Held back, and deliberately: it never reached the bank, so it cannot be
       on the statement, and calling it "not reconciled" would put a failure on
       the screen that reads exactly like a settlement that went missing. */
    if (row.status && !/^success/i.test(row.status)) {
      const reason = at(cells, "failure");
      why.push(`the transaction was "${row.status}"${reason ? ` — ${reason}` : ""}, so it never reached the bank`);
      unusable = true;
    }

    if (unusable) {
      // Same as BPay's own remark: carried ON the row, not just the problem
      // wrapper, because the run's results table reads a row's Remarks cell
      // off `remark`, not off `problems`.
      row.remark = REMARKS.review;
      problems.push({ line: row.line, why: why.join("; "), row });
    } else {
      // Detected, and carrying its flag into the reconciliation.
      if (row.noReference) row.remark = REMARKS.noReference;
      rows.push(row);
    }
  });
  return { rows, problems };
}

/* ── the IPSI merchant settlement ────────────────────────────────────────── */

/**
 * IPSI's columns, by header name. Thirty-four of them; six matter.
 *
 * `Merchant Reference` is the match key, and it does NOT have one shape:
 *
 *   Purchase (37 rows)  128388-171850          booking, then a time
 *   Capture  (10 rows)  R82EQ6F8-JoanneMChapma-raa-2911
 *   Refund   (2 rows)   2dfa06e7-6454-445a-...   a bare GUID
 *
 * So the reference is tried first and `Booking Number` is the fallback — see
 * `matchIpsiAgainstReceipts`. `Transaction Reference` is IPSI's own id and is
 * unique across the file, but it is not what Tramada holds.
 */
const IPSI_COLUMNS = {
  transNo: ["transaction reference"],
  /* THE MATCH KEY IS Transaction Reference — the same column as `transNo`, and
     deliberately so. It used to be `Merchant Reference`, and two of the four
     rows on the live screen had none, so those rows were held back before
     anything looked at them. Transaction Reference is IPSI's own id for the
     transaction, it is on every row, and it is what gets typed into the
     receipt's Reference field when the Credit Card Swipe receipt is raised.
     Merchant Reference is not read at all now. */
  reference: ["transaction reference"],
  // "Booking Number" is the already-cleaned spreadsheet's name for this
  // column; IPSI's own raw export calls it just "Booking" — same pairing as
  // `kind` below. Both read so either shape parses.
  bookingNo: ["booking number", "booking"],
  amount: ["transaction amount"],
  // "Custom 5" is the ALREADY-CLEANED spreadsheet's name for this column;
  // IPSI's own raw "Download Copy" export calls the same thing "Transaction
  // Type User Friendly". Both are read so either shape parses.
  kind: ["custom 5", "transaction type user friendly"],
  typeCode: ["transaction type"],
  status: ["transaction status"],
  settlementDate: ["settlement date"],
  settlementAmount: ["settlement amount"],
  tramadaPaymentNo: ["tramada payment number"],
  // Same cleaned-vs-raw pairing: "Card Holder Name" is the cleaned name,
  // IPSI's own export calls it "Cardholder".
  cardHolder: ["card holder name", "cardholder"],
  linked: ["linked transaction"],
};

/** Refunds are `Transaction Type` 20 — `Custom 5` spells it "Refund (20)". */
const isRefund = (row) => String(row.typeCode).trim() === "20" || /refund/i.test(row.kind || "");

/**
 * PreAuths are `Transaction Type` 10 — a card-authorisation hold, not money
 * that moved. Reconciliation Guide — IPSI, step 7: every PreAuth is deleted
 * before anything downstream sees the file, because whatever it authorised
 * shows up again as its own Capture (`Transaction Type` 9) once the merchant
 * actually takes the payment — ticking the PreAuth too would count the same
 * money twice.
 */
const isPreAuth = (row) => String(row.typeCode).trim() === "10" || /preauth/i.test(row.kind || "");

/** The guide's own words, verbatim — BR06, BR07, BR08 and step 14/BR10. */
/**
 * MUST AN IPSI ROW MATCH ON ITS REFERENCE, OR WILL ITS BOOKING DO?
 *
 * `true` — a row whose Transaction Reference is on no receipt is NOT
 * reconciled, even when its booking number finds the money at exactly the
 * right amount. Asked for on 02-09-2026: "if payment reference is not found,
 * do not reconcile it, it should be an error."
 *
 * THIS IS STRICTER THAN RAA'S OWN RULE AND THAT IS DELIBERATE, so the two
 * things it costs are written down rather than discovered later:
 *
 *   - The guide's step 14 says "continue to next step" for a reference
 *     mismatch, not "click Cancel". BR10 treats it as a note on an otherwise
 *     good tick. This overrides that.
 *   - CAPTURES. Ten of the forty-nine rows in the client's own settlement file
 *     are Captures, whose merchant reference is a different shape entirely and
 *     never matches. Under this rule a fifth of a real settlement stops being
 *     reconciled — the money is still found, on the booking, at the right
 *     amount, and is reported as an error anyway.
 *
 * Set it to `false` to go back to BR10: matched, ticked, and remarked. The
 * remark is the same either way; only `matched` changes.
 */
const IPSI_REFERENCE_REQUIRED = true;

const IPSI_REMARKS = {
  booking: "Booking number mismatch or not found",   // BR06
  amount: "Incorrect amount",                          // BR07
  reference: "Incorrect payment reference",            // step 14 / BR10
  total: "Incorrect total amount",                     // BR08 — what TICKED vs entered
  /* Step 9's own words — NOT the same check as `total` above, and not the
     same sentence either, on purpose (the same distinction Mint/TravelPay
     already draw between their file-level and Tramada-level totals): this one
     is the FILE's own total against the entered Transaction Total, checked
     before Tramada is touched at all. */
  fileTotal: "Total transaction amounts does not match.",   // step 9 / BR01
};

/** BR03 — a transaction line is a match within three cents either way. */
const IPSI_LINE_TOLERANCE_CENTS = 3;
/** BR08 — the total allocated in Tramada is a match within twenty cents. */
const IPSI_TOTAL_TOLERANCE_CENTS = 20;

/**
 * An IPSI export → rows the run can act on, plus the day's own settlement.
 *
 * Reconciliation Guide — IPSI, steps 5-7, run here rather than left for a
 * human to have already done to the file:
 *
 *   - a Refund (`Transaction Type` 20) has its amount FLIPPED NEGATIVE. IPSI's
 *     raw export carries it as a plain positive figure, same as a purchase;
 *     a refund that stayed positive would inflate the settlement instead of
 *     explaining why it fell short of it. Refunds ARE part of an IPSI run —
 *     they tick against *Payments* To Reconcile, a different table to the one
 *     purchases and captures tick, but a table all the same. (Until this
 *     change they were excluded outright, on the reasoning that the screen
 *     this run drives has nothing to tick a refund against — true of
 *     *Receipts* To Reconcile, false of the *Payments* table beside it.)
 *   - a PreAuth (`Transaction Type` 10) is dropped. It is a hold, not money
 *     that moved; whatever it authorised shows up again as its own Capture.
 *   - anything not `APPROVED` (a Decline, a Void) is dropped — unchanged from
 *     before, since that check already did what step 6 asks for.
 *
 * The file states its own `Settlement Amount` on one row, and the sum of every
 * row (refunds included, they carry their sign) should equal it. That is a free
 * cross-check on a file about to produce a receipt for real money, so it is
 * returned as `settlement` and the caller can refuse when it disagrees.
 */
function parseIpsiRows(headers, gridRows) {
  const cols = mapColumns(headers, IPSI_COLUMNS);
  const missing = ["reference", "amount"].filter((k) => cols[k] < 0);
  if (missing.length) {
    const want = missing.map((k) => IPSI_COLUMNS[k][0]).join(", ");
    return { rows: [], problems: [{ line: 1, why: `the sheet has no column for: ${want}` }], settlement: null };
  }

  const at = (cells, key) =>
    (cols[key] >= 0 && cells[cols[key]] != null ? String(cells[cols[key]]).trim() : "");
  const rows = [];
  const problems = [];
  let statedCents = null;
  let statedBy = "";
  let everyRowCents = 0;

  (gridRows || []).forEach((cells, i) => {
    const row = {
      line: i + 2,
      transNo: at(cells, "transNo"),
      reference: at(cells, "reference"),
      bookingNo: at(cells, "bookingNo"),
      amount: at(cells, "amount"),
      kind: at(cells, "kind"),
      typeCode: at(cells, "typeCode"),
      status: at(cells, "status"),
      cardHolder: at(cells, "cardHolder"),
      linked: at(cells, "linked"),
      settlementDate: serialDate(at(cells, "settlementDate")),
    };
    row.rawAmount = row.amount;
    row.amountCents = cents(row.amount);
    row.isRefund = isRefund(row);
    // Step 5 — flip a refund's amount negative. Guarded on `> 0` so a file
    // that arrives ALREADY flipped (the reconciled example, and any file this
    // run has already touched once) is not flipped a second time.
    if (row.amountCents != null && row.isRefund && row.amountCents > 0) {
      row.amountCents = -row.amountCents;
    }
    if (row.amountCents != null) {
      row.amount = money(row.amountCents);
      everyRowCents += row.amountCents;
    }

    // The settlement total and the payment number sit on ONE row of the file,
    // not on every one. Whichever row carries them, they describe the day.
    const stated = cents(at(cells, "settlementAmount"));
    if (stated != null) { statedCents = stated; statedBy = row.transNo; }
    const paid = at(cells, "tramadaPaymentNo");
    if (paid) row.tramadaPaymentNo = paid;

    const why = [];
    let dataIssue = false;
    /* A row is only unusable when there is NOTHING to match it by. It used to
       be held back for a missing Merchant Reference — a column this no longer
       reads — which threw away rows that would have matched perfectly well on
       their booking number. */
    if (!row.reference && !row.bookingNo) {
      why.push("no transaction reference and no booking number — nothing to match it by");
      dataIssue = true;
    }
    if (row.amountCents == null) { why.push(`unreadable amount "${row.rawAmount}"`); dataIssue = true; }
    let wrongType = false;
    if (row.status && !/^approved$/i.test(row.status)) {
      why.push(`not a desired transaction type — the transaction is "${row.status}", not approved`);
      wrongType = true;
    }
    if (isPreAuth(row)) {
      why.push("not a desired transaction type — PreAuth (10) is a hold, not a settled transaction, so its Capture carries the money");
      wrongType = true;
    }
    if (why.length) {
      // Same as BPay's own remark: carried ON the row, not just the problem
      // wrapper, because the run's results table reads a row's Remarks cell
      // off `remark`, not off `problems`.
      row.remark = REMARKS.review;
      /* A row held back ONLY for being the wrong transaction type (a PreAuth,
         a Decline, a Void) was never going to reconcile no matter what the
         file said — there is nothing for a person to fix, so it does not
         belong in the results table as its own row the way a genuine data
         problem does. The page counts it in the upload note instead. */
      row.excludedType = wrongType && !dataIssue;
      problems.push({ line: row.line, why: why.join("; "), row });
    } else rows.push(row);
  });

  return {
    rows,
    problems,
    settlement: {
      // Every row, refunds included — they carry their own sign, which is why
      // the two together are what the bank actually settled.
      everyRowCents,
      statedCents,
      statedBy,
      agrees: statedCents == null ? null : statedCents === everyRowCents,
      paymentNo: (gridRows || []).length ? (rows.find((r) => r.tramadaPaymentNo) || {}).tramadaPaymentNo || "" : "",
    },
  };
}

/**
 * Guide step 4 — keep only the one settlement date this run is FOR.
 *
 * IPSI's own export has a padding quirk: pulling one day's transactions
 * returns that day plus the one either side of it (the guide's own example —
 * asking for 13/08 also returns 12/08 and 14/08). The settlement date is typed
 * in on a later screen than the upload, which is why this runs separately from
 * `parseIpsiRows` rather than inside it — by upload time nobody has said which
 * day this run is for yet.
 *
 * A row whose own settlement date cannot be read is KEPT, not thrown away —
 * an unreadable date is not evidence the row belongs to some OTHER day.
 */
function filterIpsiSettlementDate(rows, wantedDate) {
  const want = toIsoDate(wantedDate);
  if (!want) return { rows: rows || [], excluded: [] };
  const kept = [];
  const excluded = [];
  for (const r of rows || []) {
    const got = toIsoDate(r.settlementDate);
    if (got && got !== want) {
      excluded.push({ ...r, why: `settled ${got}, not ${want} — this run is for one settlement date` });
    } else {
      kept.push(r);
    }
  }
  return { rows: kept, excluded };
}

/**
 * One IPSI row against Tramada's "Receipts To Reconcile" list.
 *
 * Merchant Reference first, Booking No. second. The fallback is not politeness:
 * ten of the forty-nine rows in the client's own file are Captures, whose
 * merchant reference is a different shape entirely, and matching those on
 * reference alone would leave a fifth of the settlement unticked with no
 * explanation. Amount has to agree either way — four bookings appear twice in
 * one file, so the booking on its own does not identify a row.
 *
 * BR03 allows a three-cent variance per line — a card processor's own rounding,
 * not a reason to hold up a settlement over fractions of a cent. A row matched
 * only by falling back to its booking gets `remark: IPSI_REMARKS.reference`
 * (BR10) alongside `matched: true` — the guide's step 14 says "continue to next
 * step" for this one, not "click Cancel", so it is a note on an otherwise-good
 * tick, not a reason to withhold one.
 */
function matchIpsiAgainstReceipts(row, receipts) {
  const list = receipts || [];
  const sameMoney = (r) => {
    const c = cents(r.receiptAmount);
    return c != null && row.amountCents != null &&
      Math.abs(c - row.amountCents) <= IPSI_LINE_TOLERANCE_CENTS;
  };
  // The closest of possibly several candidates — a booking can appear twice in
  // one file, and the nearest amount is the one worth naming a $ gap against.
  const closestDiffCents = (candidates) => Math.min(
    ...candidates.map((r) => Math.abs((cents(r.receiptAmount) || 0) - (row.amountCents || 0))));

  const byRef = list.filter((r) => r.reference && refKey(r.reference) === refKey(row.reference));
  const refHit = byRef.find(sameMoney);
  if (refHit) {
    return { matched: true, on: "reference", receipt: refHit,
      reason: `matched on reference ${row.reference} at $${money(row.amountCents)}` };
  }
  if (byRef.length) {
    return { matched: false, on: "reference", candidates: byRef,
      remark: `${IPSI_REMARKS.amount} — a difference of $${money(closestDiffCents(byRef))}`,
      reason: `reference ${row.reference} is on the list at $${byRef.map((r) => money(cents(r.receiptAmount))).join(", $")}, not $${money(row.amountCents)}` };
  }

  const byBooking = list.filter((r) => r.bookingNo && refKey(r.bookingNo) === refKey(row.bookingNo));
  const bookHit = byBooking.find(sameMoney);
  if (bookHit) {
    /* The money IS here — right booking, right amount — and it is still an
       error, because the reference the file named is on no receipt. See
       IPSI_REFERENCE_REQUIRED for what that costs and how to undo it. The
       receipt is still handed back so the row can name what it found. */
    return { matched: !IPSI_REFERENCE_REQUIRED, on: "booking", receipt: bookHit,
      remark: IPSI_REMARKS.reference,
      reason: `no receipt carries reference ${row.reference}` +
        (IPSI_REFERENCE_REQUIRED
          ? `, so it is not reconciled — booking ${row.bookingNo} does hold $${money(row.amountCents)}`
          : `, matched on booking ${row.bookingNo} at $${money(row.amountCents)}`) };
  }
  if (byBooking.length) {
    return { matched: false, on: "booking", candidates: byBooking,
      remark: `${IPSI_REMARKS.amount} — a difference of $${money(closestDiffCents(byBooking))}`,
      reason: `booking ${row.bookingNo} is on the list at $${byBooking.map((r) => money(cents(r.receiptAmount))).join(", $")}, not $${money(row.amountCents)}` };
  }
  return { matched: false, on: null, remark: IPSI_REMARKS.booking,
    reason: `nothing on the list carries reference ${row.reference} or booking ${row.bookingNo}` };
}

/**
 * One IPSI refund against Tramada's "Payments To Reconcile" list — the table
 * beside Receipts To Reconcile, for money going back OUT rather than in.
 *
 * Same shape as `matchIpsiAgainstReceipts`, deliberately: reference first,
 * booking second, three cents of tolerance either way (BR03 does not carve out
 * an exception for refunds). The one real difference is the amount column —
 * this table's own is `Due Amount`, and BOTH sides are compared as absolute
 * figures. Measured live 21-Aug-2026: this screen's own Due Amount is itself
 * NEGATIVE for a payment (`-1302.15` on a real row) — a refund reduces what is
 * due, and Tramada shows that as a negative figure, the same sign this file
 * already stores the refund's own amount in (guide step 5). Comparing the
 * absolute value on both sides, rather than trusting either one's sign to
 * mean the same thing forever, is what survives that.
 */
function matchIpsiAgainstPayments(row, payments) {
  const list = payments || [];
  const want = Math.abs(row.amountCents || 0);
  const sameMoney = (r) => {
    const c = cents(r.dueAmount);
    return c != null && Math.abs(Math.abs(c) - want) <= IPSI_LINE_TOLERANCE_CENTS;
  };
  // The closest of possibly several candidates — same reasoning as the
  // receipts-side matcher above.
  const closestDiffCents = (candidates) => Math.min(
    ...candidates.map((r) => Math.abs(Math.abs(cents(r.dueAmount) || 0) - want)));

  const byRef = list.filter((r) => r.reference && refKey(r.reference) === refKey(row.reference));
  const refHit = byRef.find(sameMoney);
  if (refHit) {
    return { matched: true, on: "reference", payment: refHit,
      reason: `matched refund on reference ${row.reference} at $${money(want)}` };
  }
  if (byRef.length) {
    return { matched: false, on: "reference", candidates: byRef,
      remark: `${IPSI_REMARKS.amount} — a difference of $${money(closestDiffCents(byRef))}`,
      reason: `reference ${row.reference} is on the Payments list at $${byRef.map((r) => money(Math.abs(cents(r.dueAmount) || 0))).join(", $")}, not $${money(want)}` };
  }

  const byBooking = list.filter((r) => r.bookingNo && refKey(r.bookingNo) === refKey(row.bookingNo));
  const bookHit = byBooking.find(sameMoney);
  if (bookHit) {
    return { matched: !IPSI_REFERENCE_REQUIRED, on: "booking", payment: bookHit,
      remark: IPSI_REMARKS.reference,
      reason: `no payment carries reference ${row.reference}` +
        (IPSI_REFERENCE_REQUIRED
          ? `, so it is not reconciled — booking ${row.bookingNo} does hold the $${money(want)} refund`
          : `, matched refund on booking ${row.bookingNo} at $${money(want)}`) };
  }
  if (byBooking.length) {
    return { matched: false, on: "booking", candidates: byBooking,
      remark: `${IPSI_REMARKS.amount} — a difference of $${money(closestDiffCents(byBooking))}`,
      reason: `booking ${row.bookingNo} is on the Payments list at $${byBooking.map((r) => money(Math.abs(cents(r.dueAmount) || 0))).join(", $")}, not $${money(want)}` };
  }
  return { matched: false, on: null, remark: IPSI_REMARKS.booking,
    reason: `nothing on the Payments list carries reference ${row.reference} or booking ${row.bookingNo} for this refund` };
}

/**
 * Step 9 / BR01 — the settlement file's OWN total against the NUVEI figure a
 * human read off the bank statement and typed in, to the cent, checked before
 * Tramada is touched at all. NOT the same check as BR08 below: this is the
 * file against the human, BR08 is Tramada's own ticked total against the
 * human, and a settlement can fail one without the other.
 *
 * `rows` is what `parseIpsiRows` already kept — PreAuths and anything not
 * approved are gone, and a refund's `amountCents` already carries its sign —
 * so summing it here is exactly "what this run is about to act on", not the
 * raw file. Summed in integer cents, never by re-parsing dollar strings: a run
 * of floats added as floats is exactly how "to the cent" quietly stops being
 * true.
 */
function checkIpsiFileTotal(rows, entered) {
  const fileCents = (rows || []).reduce((a, r) => a + (r.amountCents || 0), 0);
  const want = cents(entered);
  if (want == null) {
    return { checked: false, ok: null, remark: "", fileCents, enteredCents: null,
      reason: "no Transaction Total was entered" };
  }
  if (fileCents === want) {
    return { checked: true, ok: true, remark: "", fileCents, enteredCents: want,
      reason: `the file's own total of $${money(fileCents)} matches the $${money(want)} Transaction Total entered, to the cent` };
  }
  return {
    checked: true, ok: false, remark: IPSI_REMARKS.fileTotal, fileCents, enteredCents: want,
    reason: `the file totals $${money(fileCents)} but $${money(want)} was entered — a difference of $${money(Math.abs(fileCents - want))}`,
  };
}

/**
 * BR08 — what was actually ticked in Tramada against the Transaction Total a
 * human typed off the NUVEI statement, twenty cents of tolerance either way.
 *
 * That is wider than a single line's three cents (BR03) on purpose — this is
 * the WHOLE settlement's rounding, not one card's. Guide step 18: past this
 * tolerance the run stops, names "Incorrect total amount", and does not go
 * near the Rounding Remaining checkbox or Issue.
 */
function checkIpsiAllocatedTotal(allocatedCents, entered) {
  const want = cents(entered);
  if (want == null) {
    return { checked: false, ok: null, remark: "", reason: "no Transaction Total was entered" };
  }
  const got = allocatedCents || 0;
  const diff = Math.abs(got - want);
  if (diff <= IPSI_TOTAL_TOLERANCE_CENTS) {
    return {
      checked: true, ok: true, remark: "", enteredCents: want, allocatedCents: got,
      reason: `the $${money(got)} ticked in Tramada is within $0.20 of the $${money(want)} Transaction Total entered`,
    };
  }
  return {
    checked: true, ok: false, remark: IPSI_REMARKS.total, enteredCents: want, allocatedCents: got,
    reason: `the $${money(got)} ticked in Tramada differs from the $${money(want)} Transaction Total ` +
      `entered by $${money(diff)}, more than the $0.20 allowed`,
  };
}

/** What an IPSI run made of its file. */
function summariseIpsi(results) {
  const r = results || [];
  const ticked = r.filter((x) => x.ticked);
  return {
    total: r.length,
    ticked: ticked.length,
    unmatched: r.filter((x) => !x.ticked).length,
    onReference: r.filter((x) => x.matchedOn === "reference").length,
    onBooking: r.filter((x) => x.matchedOn === "booking").length,
    // The receipt is for what it ALLOCATES, which is the rows that were ticked
    // — not the file's headline settlement figure.
    allocatedCents: ticked.reduce((a, x) => a + (x.amountCents || 0), 0),
  };
}

/* ── the reports this system knows ───────────────────────────────────────── */

/**
 * One place that says what each report IS.
 *
 * Server, run and page all need the same three facts about a report — what it
 * is filtered to on the reconcile page, whether it writes anything, and how a
 * row is matched. Held once here, because a fourth report added in three places
 * is a fourth report added correctly in two of them.
 */
/*
 * WHICH COLUMN THE PAGE IS SORTED BY, per report, because the guides differ:
 *
 *   MINT step 10       Sort by 'Reference'
 *   TravelPay step 10  Sort by 'Receipt For/Payment To'
 *   BPay               Date, descending — the receipts it just filed are newest
 *
 * And SORT BEFORE FILTER in every case (MINT BR04, TravelPay BR04): sorting
 * rebuilds the list and drops the filter, so the other order leaves every
 * transaction showing and reads as a filter that matched a great many rows.
 */
const SORT_BY = {
  bpay: { by: "Date", order: "Descending" },
  mint: { by: "Reference", order: "Ascending" },
  travelpay: { by: "Receipt For/Payment To", order: "Ascending" },
};

const REPORTS = {
  bpay: {
    key: "bpay",
    title: "BPay receipts",
    /* Step 30, and the same name the receipt is FILED under (step 11) — they
       have to agree, or the run raises a receipt under one type and searches
       the statement page under another. `BPAY_RECEIPT.label` is that one name.
       Was "Client Payment Receipt" until 17-Aug-2026, when it turned out the
       type on offer depends on the client's account and a BPay booking's
       client is a debtor account. */
    recPayType: BPAY_RECEIPT.label,
    files: true,                          // one real receipt per row
  },
  mint: {
    key: "mint",
    title: "Mint daily settlement",
    recPayType: "Creditor Payment",
    files: false,
  },
  ipsi: {
    key: "ipsi",
    title: "IPSI merchant settlement",
    /* IPSI does NOT reconcile against a bank statement page. It ticks receipts
       that already exist on Tramada's Finance Merchant Payment Receipt screen
       and issues ONE receipt covering them, so it has no recPayType and cannot
       join a combined run — there is no shared page for it to share. */
    recPayType: null,
    files: false,
    issuesReceipt: true,
  },
  travelpay: {
    key: "travelpay",
    title: "TravelPay merchant settlement",
    /* CREDITOR PAYMENT, per the TravelPay guide's step 9 — corrected
       17-Aug-2026. It read "Client Payment Receipt, confirmed 10-08-2026", and
       that confirmation was taken against receipts THIS REPO's own fixtures had
       created, which is precisely how the BPay receipt type went wrong too. A
       TravelPay settlement pays a merchant — Monarto Resort in RAA's own dummy
       file — and money leaving to a supplier is a Creditor Payment. Same filter
       as Mint, which is why the combined run groups by filter rather than by
       report. */
    recPayType: "Creditor Payment",
    files: false,
  },
};

/**
 * WHAT ORDER A COMBINED RUN GOES IN — and BPay is first, deliberately.
 *
 * RAA's POC feedback, BPAY 01: "If more than 1 statement for different payment
 * type is being upload (e.g. BPAY and Mint), and user hit Start run, BPAY
 * reconciliation should start first, after it finishes, then run the next
 * automation."
 *
 * That is not a preference. BPay is what CREATES the day's bank statement;
 * Mint and TravelPay reconcile against the statement it created. Run them the
 * other way round and the second report opens a page that does not exist yet,
 * or worse, creates a second one for the same day.
 *
 * This used to be `Object.keys(REPORTS)` — the run order was whatever order
 * somebody happened to type the REPORTS object literal in. It was correct, but
 * only by luck: alphabetising that object, or adding a new report above `bpay`,
 * would have silently made Mint run first. Nothing would have thrown and no
 * test would have failed; the only symptom would have been a wrong
 * reconciliation, found by Finance, days later.
 *
 * The browser has its own copy of this list in `recon-wire.html` (it numbers
 * the rows before the server ever sees them, and `n` has to mean the same thing
 * at both ends). `test/test-run-order.js` reads that file and fails if the two
 * lists drift apart.
 */
const RUN_ORDER = ["bpay", "mint", "ipsi", "travelpay"];

/* A report defined but never ordered would be dropped from every combined run
   without a word. Caught at require time rather than at 3pm on a Friday. */
{
  const ordered = [...RUN_ORDER].sort().join(",");
  const defined = Object.keys(REPORTS).sort().join(",");
  if (ordered !== defined) {
    throw new Error(
      `RUN_ORDER and REPORTS disagree: RUN_ORDER has [${RUN_ORDER.join(", ")}], ` +
      `REPORTS defines [${Object.keys(REPORTS).join(", ")}]. ` +
      `Every report needs a place in the run order — add it to RUN_ORDER in recon-core.js.`
    );
  }
  if (RUN_ORDER[0] !== "bpay") {
    throw new Error("RUN_ORDER must start with bpay — it creates the statement the others reconcile against.");
  }
}

/**
 * Which matcher a report reconciles with, and which column it reads.
 *
 * This lives here, once, because it was decided in two different places and
 * they disagreed. `runMintReconciliation` serves both check-only reports and
 * chose by `o.source`; the combined run chose by `REPORTS[k].files`. A run that
 * reached the second path — or an older server still holding the first version
 * in memory — matched a TravelPay row against `Trans. No`, a column its Payment
 * Reference can never appear in, and reported "not among the transactions on
 * this page" about a row sitting first on the page.
 *
 * One table, named columns, and a test that reads it.
 */
/*
 * MINT and TravelPay now go through ONE matcher with two vocabularies.
 *
 * Both guides ask the same three-way question — reference, amount, supplier —
 * and both say do not tick unless all three agree. The old per-report matchers
 * ticked on the reference alone and wrote the disagreement into a column
 * nobody had to act on, which on a committed bank statement is a tick against
 * a payment whose amount nobody confirmed.
 *
 * `matchAgainstStatement` stays as BPay's: it is looking for a receipt THIS RUN
 * filed and knows its number, which is a different question.
 */
const MATCHERS = {
  bpay: { fn: matchAgainstStatement, column: "Trans. No", what: "the receipt number it was handed" },
  mint: {
    fn: (row, statement, opts) =>
      matchCreditorRow(row, statement, { ...opts, remarks: MINT_REMARKS }),
    column: "Reference",
    what: "the Transaction ID, its amount and its supplier",
  },
  travelpay: {
    fn: (row, statement, opts) =>
      matchCreditorRow(row, statement, { ...opts, remarks: TRAVELPAY_REMARKS }),
    column: "Reference",
    what: "the Payment Reference, its amount and its merchant",
  },
};

/** The matcher for a report, defaulting to Mint's — the older behaviour. */
function matcherFor(source) {
  return (MATCHERS[source] || MATCHERS.mint).fn;
}

/**
 * A report's remark vocabulary, for the checks that are not row matching.
 *
 * A FUNCTION rather than a field on MATCHERS: the vocabularies are declared
 * further down this file, so a field would be read before it exists. The
 * matcher's own `fn` gets away with it only because a closure body runs later.
 */
function remarksFor(source) {
  return source === "travelpay" ? TRAVELPAY_REMARKS : MINT_REMARKS;
}

/** What to tell the person the run is about to look for, and where. */
function matchesOn(source) {
  const m = MATCHERS[source] || MATCHERS.mint;
  return `matched on ${m.what}, in the statement's ${m.column} column`;
}

/* ── the run's own summary ───────────────────────────────────────────────── */

/** Counts for the UI's filter chips, from the finished result rows. */
function summarise(results) {
  const r = results || [];
  return {
    total: r.length,
    allocated: r.filter((x) => x.allocation === "Allocated").length,
    partAllocated: r.filter((x) => x.allocation === "Part allocated").length,
    notAllocated: r.filter((x) => x.allocation === "Not allocated").length,
    reconciled: r.filter((x) => x.reconciliation === "Reconciled").length,
    notReconciled: r.filter((x) => x.reconciliation === "Not reconciled").length,
    both: r.filter((x) => x.allocation === "Allocated" && x.reconciliation === "Reconciled").length,
    failed: r.filter((x) => x.error).length,
  };
}

/* ── the run history, and what the dashboard makes of it ─────────────────── */

/**
 * A filename safe to write into `uploads/`, stamped so two uploads of the same
 * report on the same day do not overwrite each other.
 *
 * The name comes from a browser file picker, so it is whatever the operating
 * system allowed — slashes, `..`, colons, a leading dot, the lot. It is reduced
 * to its basename and then to the characters a filename is allowed to be. The
 * stamp is passed IN rather than read from the clock so this stays pure and the
 * tests can pin it.
 */
function uploadName(original, stamp) {
  const base = String(original == null ? "" : original).split(/[\\/]/).pop() || "report";
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "report";
  return `${stamp}-${safe}`;
}

/** An ISO instant as `20260810-143002`, for stamping a filename or a run id. */
function stampOf(iso) {
  const s = String(iso == null ? "" : iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : s.replace(/[^0-9]/g, "").slice(0, 14);
}

/**
 * What a run moved, in money.
 *
 * Reconciled and unreconciled are counted SEPARATELY rather than one being
 * derived from the other, because a row can be neither: a receipt that failed
 * outright never reached the statement and is not "unreconciled money sitting
 * on the page", it is money that was never filed. Three buckets, not two.
 */
function runTotals(rows) {
  const r = rows || [];
  // The parsed cents if the row carries them, the raw text only as a fallback.
  // Never round-trip through a float to get back to a number we already had.
  const of = (x) => (Number.isFinite(x.amountCents) ? x.amountCents : cents(x.amount)) || 0;
  const sum = (xs) => xs.reduce((a, x) => a + of(x), 0);
  const failed = r.filter((x) => x.error);
  const done = r.filter((x) => !x.error);
  return {
    rows: r.length,
    amountCents: sum(r),
    reconciledCents: sum(done.filter((x) => x.reconciliation === "Reconciled")),
    unreconciledCents: sum(done.filter((x) => x.reconciliation !== "Reconciled")),
    failedCents: sum(failed),
  };
}

/**
 * The rows a person still has to do something about, worst first.
 *
 * Feeds the overview's "Need your reaction" table, which the design ranks by
 * dollar impact — so that is what this ranks by, not by row order. A row that
 * reconciled cleanly is not here; a row nobody looked at because the run died
 * before reaching it is, because "not checked" needs a person exactly as much
 * as "not found" does.
 */
function needsReaction(runs, limit = 8) {
  const out = [];
  for (const run of runs || []) {
    for (const r of run.rows || []) {
      const failed = !!r.error;
      const missing = r.reconciliation && r.reconciliation !== "Reconciled";
      const odd = !!r.mismatch;
      if (!failed && !missing && !odd) continue;
      out.push({
        runId: run.id,
        source: run.source,
        stream: run.source === "mint" ? "Mint" : "BPay",
        // The booking is what a person acts on for BPay; Mint has no booking,
        // so its own reference is the handle.
        item: r.bookingNo || r.transNo || r.receiptNo || r.reference || `row ${r.n}`,
        ref: r.reference || r.transNo || "",
        issue: failed ? "Receipt failed"
          : odd ? "Difference on the page"
          : r.reconciliation === "Not checked" ? "Never checked — the run stopped"
          : "Not on the statement page",
        amountCents: (Number.isFinite(r.amountCents) ? r.amountCents : cents(r.amount)) || 0,
        variance: r.mismatch || "",
        proposal: r.why || "",
        kind: failed || missing ? "need" : "rev",
      });
    }
  }
  return out.sort((a, b) => b.amountCents - a.amountCents).slice(0, limit);
}

/**
 * Every run, as the Run overview screen needs it.
 *
 * Pure: a list of stored runs in, the dashboard's figures out. It lives here
 * with the other decisions so the numbers on the screen are tested offline
 * rather than eyeballed against a mockup — the overview is the one screen whose
 * being wrong is invisible, because every figure on it looks like a figure.
 */
function overviewFrom(runs) {
  const all = (runs || []).slice().sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const done = all.filter((r) => r.status === "done");
  const add = (key) => all.reduce((a, r) => a + ((r.totals && r.totals[key]) || 0), 0);

  return {
    runs: all.length,
    completed: done.length,
    failed: all.filter((r) => r.status === "failed").length,
    running: all.filter((r) => r.status === "running").length,
    // A combined run counts under EVERY report it carried, because it really
    // did run them all. Built from REPORTS so a fourth one appears here without
    // anybody remembering to add it.
    bySource: Object.fromEntries(Object.keys(REPORTS).map((k) =>
      [k, all.filter((r) => sourceBreakdown(r)[k].rows > 0).length])),
    rows: all.reduce((a, r) => a + ((r.totals && r.totals.rows) || 0), 0),
    amountCents: add("amountCents"),
    reconciledCents: add("reconciledCents"),
    unreconciledCents: add("unreconciledCents"),
    receiptsFiled: all.reduce(
      (a, r) => a + ((r.rows || []).filter((x) => x.receiptNo).length), 0),
    transactionsCommitted: all.reduce(
      (a, r) => a + ((r.committed && r.committed.ticked) || 0), 0),
    lastRun: all[0] || null,
    // Newest first, unabridged. The overview needs the last run that actually
    // READ the statement balances, and that is not always the last run — one
    // that failed before reaching the reconcile screen never saw them.
    recentFull: all.slice(0, 20),
    // Worst first across the last few runs — yesterday's unmatched receipt is
    // still unmatched this morning, so it belongs on the list.
    needsReaction: needsReaction(all.slice(0, 5)),
    // The newest run's own log, newest line first. Only that run's: a timeline
    // stitched from several is a timeline nobody can follow.
    activity: ((all[0] || {}).activity || []).slice().reverse(),
    recent: all.slice(0, 20).map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt || null,
      source: r.source,
      file: (r.file && r.file.name) || "",
      statementDate: r.statementDate || "",
      pageNumber: r.pageNumber || null,
      status: r.status,
      error: r.error || null,
      rows: (r.totals && r.totals.rows) || 0,
      // Per report, because one run can now carry both.
      streams: sourceBreakdown(r),
      // Cents, so the screen formats this the same way it formats the tiles.
      // Handing out a pre-formatted string is how one money column ends up with
      // thousands separators and the one beside it without.
      amountCents: (r.totals && r.totals.amountCents) || 0,
      amount: money((r.totals && r.totals.amountCents) || 0),
      reconciled: (r.summary && r.summary.reconciled) || 0,
      committed: !!(r.committed && r.committed.done),
    })),
  };
}

/**
 * Counts for a run that carried BOTH reports.
 *
 * The two halves do different things, so a single flat count lies about one of
 * them: only BPay rows can be allocated, and counting Mint's four settlements
 * as "not allocated" would put four failures on a screen where nothing failed.
 * Allocation figures come from the BPay rows only; reconciliation covers both.
 */
function summariseCombined(results) {
  const r = results || [];
  // Only a report that FILES can be allocated. Counting the ones that merely
  // check as "not allocated" would put failures on a screen where nothing
  // failed — so the split is by what the report does, not by its name.
  const bpay = r.filter((x) => REPORTS[x.src] ? REPORTS[x.src].files : x.src !== "mint");
  const mint = r.filter((x) => !bpay.includes(x));
  const counted = Object.keys(REPORTS)
    .map((k) => [k, r.filter((x) => x.src === k).length])
    .filter(([, n]) => n);
  return {
    total: r.length,
    bpay: bpay.length,
    mint: mint.length,
    byReport: Object.fromEntries(counted),
    perReport: counted.map(([k, n]) => `${n} ${REPORTS[k].title}`).join(", "),
    allocated: bpay.filter((x) => x.allocation === "Allocated").length,
    partAllocated: bpay.filter((x) => x.allocation === "Part allocated").length,
    notAllocated: bpay.filter((x) => x.allocation === "Not allocated").length,
    reconciled: r.filter((x) => x.reconciliation === "Reconciled").length,
    notReconciled: r.filter((x) => x.reconciliation === "Not reconciled").length,
    mismatched: r.filter((x) => x.mismatch).length,
    both: bpay.filter((x) => x.allocation === "Allocated" && x.reconciliation === "Reconciled").length,
    failed: r.filter((x) => x.error).length,
  };
}

/**
 * A run's rows split by which report they came from.
 *
 * A combined run is one record with two kinds of row in it, and the overview's
 * stream cards are per report — so the split is read off the rows' own `src`,
 * falling back to the run's source for every run recorded before combined runs
 * existed.
 */
function sourceBreakdown(run) {
  const out = {};
  for (const k of Object.keys(REPORTS)) out[k] = { rows: 0, reconciled: 0 };
  for (const r of (run && run.rows) || []) {
    // The row's own source, falling back to the run's for every run recorded
    // before a row knew which report it came from.
    const key = REPORTS[r.src] ? r.src : (REPORTS[run.source] ? run.source : "bpay");
    out[key].rows++;
    if (r.reconciliation === "Reconciled") out[key].reconciled++;
  }
  return out;
}



/* ═══════════════════════════════════════════════════════════════════════════
 * MINT and TravelPay — the two guides' shared shape
 *
 * Both reconcile CREDITOR PAYMENTS that Tramada already holds. Neither files
 * anything. Both ask the same question of every row, and it is a THREE-WAY
 * question (MINT BR05, TravelPay BR05):
 *
 *     the transaction reference, the amount, AND the supplier
 *
 * all have to agree before the checkbox is ticked. Any one of them failing
 * means DO NOT TICK and write a remark (MINT BR06, TravelPay BR07).
 *
 * That is stricter than this code used to be. `matchMintAgainstStatement`
 * returned `reconciled: true` with a `mismatch` note when the money or the
 * payee disagreed — the row was ticked on the strength of the reference alone
 * and the disagreement went into a column nobody had to act on. On a run that
 * commits a bank statement, that is a tick against a payment whose amount
 * nobody confirmed.
 * ══════════════════════════════════════════════════════════════════════════ */

/*
 * The remark vocabularies, verbatim from each guide.
 *
 * They are NOT the same strings and must not be merged: MINT's step 12 says
 * "Transaction totals do not match" for a row whose amount is wrong, where
 * TravelPay's says "Transaction amount does not match". Finance filters this
 * column, so a tidy-up that unified them would be a change to a shared
 * vocabulary made by a programmer for aesthetic reasons.
 */
const MINT_REMARKS = {
  reference: "Transaction ID does not match or not found",   // step 12
  amount: "Transaction totals do not match",                 // step 12
  supplier: "Supplier does not match",                       // step 12
  total: "Total transaction amounts does not match.",        // step 14, 20-Aug
};

const TRAVELPAY_REMARKS = {
  reference: "Transaction ID does not match or not found",   // step 12
  amount: "Transaction amount does not match",               // step 12
  negative: "Not entered, transaction amount is negative",   // BR06
  supplier: "Supplier does not match",                       // step 12
  total: "Total transaction amounts does not match.",        // step 13, 20-Aug
};

/**
 * The OTHER total, and the other sentence — MINT BR08, TravelPay BR09, both
 * unchanged by the 20-Aug update and identical to each other.
 *
 * The 20-Aug guides ask for two different comparisons and give each its own
 * words, and they are not interchangeable:
 *
 *   the step  the spreadsheet's own total  vs the figure a human typed
 *             → "Total transaction amounts does not match."
 *   the BR    what was ticked in TRAMADA   vs the figure a human typed
 *             → "Transaction Total does not match."
 *
 * The first catches a bad file or a mistyped figure. Only the second catches a
 * payment that left the bank and was never recorded in Tramada — the file and
 * the typed figure can agree perfectly while a line is missing off the page.
 * Confirmed with RAA 20-Aug: both checks, both wordings.
 */
const TRAMADA_TOTAL_REMARK = "Transaction Total does not match.";

/**
 * The supplier name cheat sheet — two columns, spreadsheet name → Tramada name.
 *
 * Both guides call for it, and the reason is in the files themselves: MINT
 * names companies by their LEGAL ENTITY and Tramada names creditors by their
 * TRADING NAME. RAA's own dummy file contains
 *
 *     Viva Holidays II Limited T/A Ready Rooms
 *
 * against a Tramada creditor called READY ROOMS. The row is perfectly fine and
 * can never match on text. "T/A" is the file telling you so.
 *
 * Headings are read by name so the file can be maintained in Excel and gain
 * columns without breaking. Anything after the first two is ignored, and a
 * blank line is a blank line rather than a mapping of "" to "".
 */
const CHEAT_SHEET_COLUMNS = {
  from: [
    "spreadsheet name", "supplier", "supplier name", "mint name", "travelpay name",
    "from", "name",
    // RAA's own sheet, received 20-Aug-2026. One sheet, both reports — which is
    // why the heading names them both.
    "supplier name in mint / travelpay", "supplier name in mint/travelpay",
  ],
  to: [
    "tramada creditor", "tramada name", "creditor", "tramada", "to", "maps to",
    // "TRY THESE", plural. See `cheatSheetCandidates`.
    "in tramada - try these", "in tramada – try these", "in tramada — try these",
    "in tramada try these",
  ],
};

/**
 * One cell of the "IN TRAMADA - TRY THESE" column → the creditor names to try.
 *
 * The heading is plural and RAA's sheet means it:
 *
 *     Circuit Travel Pty Ltd  →  Cosmos Tours, Globus, Avalon Waterways
 *     RCL CRUISES LTD         →  Royal Caribbean / Celebrity Cruises
 *
 * so one row can name several creditors and the row matches if Tramada's name is
 * any of them.
 *
 * THE WHOLE CELL IS ALWAYS KEPT as a candidate as well as the pieces, so
 * splitting can only ever add a name and never lose one. That matters because
 * company names contain both separators — "Broome, Kimberley & Beyond Pty Ltd"
 * has the comma, "Viva Holidays II Limited T/A Ready Rooms" has the slash. The
 * slash only separates with space around it (" / "), which is how this sheet
 * writes it and is never how "T/A" or "P/L" is written.
 */
function cheatSheetCandidates(cell) {
  const whole = String(cell == null ? "" : cell).trim();
  if (!whole) return [];
  const out = [whole];
  for (const piece of whole.split(/\s+\/\s+|,/)) {
    const t = piece.trim();
    if (t && !out.some((s) => supplierKey(s) === supplierKey(t))) out.push(t);
  }
  return out;
}

/**
 * @param input CSV text, or a sheet already read as `{ headers, rows }` — the
 *   cheat sheet arrives as .xlsx as often as .csv and both guides accept either.
 */
function parseCheatSheet(input) {
  const grid = typeof input === "string"
    ? csvGrid(input)
    : { headers: (input && input.headers) || [], rows: (input && input.rows) || [] };
  if (!grid.headers.length) return { pairs: [], problems: [{ line: 0, why: "the file is empty" }] };
  const head = grid.headers.map((h) => String(h || "").trim().toLowerCase().replace(/\s+/g, " "));
  let from = head.findIndex((h) => CHEAT_SHEET_COLUMNS.from.includes(h));
  let to = head.findIndex((h) => CHEAT_SHEET_COLUMNS.to.includes(h));
  /* A two-column file with headings nobody recognises is almost certainly still
     the right file — left column theirs, right column Tramada's. Taken that way
     rather than refused, because the alternative is an error message about
     column names on a file a person can see is correct. */
  let positional = false;
  if (from < 0 && to < 0 && grid.headers.length === 2) { from = 0; to = 1; positional = true; }
  if (from < 0 || to < 0) {
    return {
      pairs: [],
      problems: [{ line: 1, why: "the header needs a spreadsheet-name column and a Tramada-creditor column" }],
    };
  }

  const pairs = [];
  const problems = [];
  grid.rows.forEach((r, i) => {
    const a = String((r[from] == null ? "" : r[from])).trim();
    const b = String((r[to] == null ? "" : r[to])).trim();
    if (!a && !b) return;                       // a spacer line is not a mapping
    if (!a || !b) {
      problems.push({ line: i + 2, why: `half a mapping — "${a}" → "${b}"` });
      return;
    }
    pairs.push({ from: a, to: b, try: cheatSheetCandidates(b) });
  });

  /* THE FIRST LINE IS ALWAYS A HEADING, and on a file that has none that costs
     a mapping. Said out loud rather than guessed at: deciding "this row looks
     like data, not a heading" would be a rule that is right most of the time,
     and the times it is wrong it silently drops or invents a supplier mapping.
     A named problem the person can fix in ten seconds is better. */
  if (positional) {
    problems.push({
      line: 1,
      why: `no recognised heading, so "${grid.headers[0]}" → "${grid.headers[1]}" was read as ` +
        `the heading row. Add a heading line like "Spreadsheet Name,Tramada Creditor" if it was a mapping.`,
      heading: true,
    });
  }
  return { pairs, problems, positional };
}

/**
 * The cheat sheet as a lookup, keyed the way names are compared.
 *
 * `index.near` is a SECOND lookup on a loosened key, and it exists only to tell
 * somebody which row they nearly hit. It never makes a match — see `relaxedKey`.
 */
function cheatSheetIndex(pairs) {
  const index = new Map();
  const near = new Map();
  for (const p of pairs || []) {
    const k = supplierKey(p.from);
    if (!k) continue;
    const names = (p.try && p.try.length ? p.try : [p.to]).filter(Boolean);
    index.set(k, (index.get(k) || []).concat(names));
    const r = relaxedKey(p.from);
    if (r) near.set(r, (near.get(r) || []).concat([p.from]));
  }
  index.near = near;
  return index;
}

/**
 * A loosened form of a name, used for ONE thing: naming the cheat-sheet row a
 * supplier nearly matched.
 *
 * It never makes a match. RAA's file says "Trafalgar Tours (Aust) Pty Ltd" and
 * the sheet says "Trafalgar Tours"; those are probably the same company and
 * probably is not good enough to tick money onto a committed bank statement. So
 * the row still stops, and the remark says which line to add to the sheet —
 * which is a ten-second fix by someone who knows, instead of a guess by
 * something that doesn't.
 */
function relaxedKey(name) {
  return supplierKey(name)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\b(pty|proprietary)\s+(ltd|limited)\b/g, " ")
    .replace(/\bp\/l\b/g, " ")
    .replace(/\b(ltd|limited|inc|incorporated)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How two supplier names are compared: case, surrounding space and repeated
 * inner space only.
 *
 * DELIBERATELY NOT CLEVER. No stripping of "Pty Ltd", no fuzzy distance. Two
 * creditors can differ by one word and be different companies, and a tick puts
 * money against one of them on a committed bank statement. Everything the text
 * cannot settle goes to the cheat sheet, which is a human's decision written
 * down — and if it is not in there, the row is not ticked and says why.
 */
function supplierKey(name) {
  return String(name == null ? "" : name).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Does the spreadsheet's supplier name mean the same creditor as Tramada's?
 *
 * Exact first, then the cheat sheet. Returns `{ ok, via }` so the reason can
 * say which — "matched via the cheat sheet" is a different fact to "matched"
 * and the person reading a remark deserves to know it was a mapping.
 */
function supplierMatches(fileName, tramadaName, index) {
  const a = supplierKey(fileName);
  const b = supplierKey(tramadaName);
  if (!a || !b) return { ok: false, via: "missing" };
  if (a === b) return { ok: true, via: "exact" };
  const mapped = (index && index.get(a)) || [];
  if (mapped.some((m) => supplierKey(m) === b)) return { ok: true, via: "cheat sheet" };

  /* THE SHEET'S NAME IS OFTEN SHORTER THAN TRAMADA'S.

     RAA's cheat sheet carries trading names; Tramada's creditor records carry
     the fuller registered ones. Measured against the live sandbox on 01-Sep:

         sheet "Wendy Wu"         → Tramada "WENDY WU TOURS"
         sheet "Royal Caribbean"  → Tramada "ROYAL CARIBBEAN INTERNATIONAL"
         sheet "Busabout"         → Tramada "BUSABOUT AUSTRALIA"

     Exact equality refused all three, so a correctly mapped supplier came back
     "cheat sheet disagrees" and the row went unreconciled. That is not a
     fixture problem — the same three names are in RAA's production sheet.

     So a mapped name also matches when it is a WHOLE-WORD PREFIX of what the
     page says. Prefix, not substring: "Rail" must not match "Railbookers", and
     the boundary check is what stops it. Four characters minimum, so a stub
     like "AA" cannot sweep up half the creditor list. The other direction is
     allowed too — a sheet entry longer than Tramada's own name. */
  const startsWholeWord = (shortName, longName) => {
    if (!shortName || !longName) return false;
    if (shortName.length < 4) return false;
    if (!longName.startsWith(shortName)) return false;
    // supplierKey strips punctuation, so a boundary here is the end or a space.
    return longName.length === shortName.length || /\s/.test(longName.charAt(shortName.length));
  };
  const loose = mapped.find((m) => {
    const mk = supplierKey(m);
    return startsWholeWord(mk, b) || startsWholeWord(b, mk);
  });
  if (loose) return { ok: true, via: "cheat sheet (Tramada's name is longer)", mapped: loose };

  if (mapped.length) return { ok: false, via: "cheat sheet disagrees", tried: mapped };
  /* Not in the sheet. If a row is nearly it, say which — the fix is one line. */
  const close = ((index && index.near && index.near.get(relaxedKey(fileName))) || [])
    .filter((n) => supplierKey(n) !== a);
  return close.length
    ? { ok: false, via: "not in the cheat sheet", near: close[0] }
    : { ok: false, via: "not in the cheat sheet" };
}

/**
 * One row of a MINT or TravelPay file against the statement page — BR05.
 *
 * Three gates, in the guides' own order, and the FIRST failure is the remark.
 * A row whose reference is not on the page has nothing to compare an amount
 * against, so reporting "amount does not match" as well would be noise.
 *
 * `negative` is TravelPay's BR06 and is checked before anything else: a
 * negative processed amount is a refund, it is not entered, and the guide gives
 * it its own words.
 */
function matchCreditorRow(row, statementRows, opts = {}) {
  const words = opts.remarks || MINT_REMARKS;
  const index = opts.cheatSheet || null;
  const no = (remark, reason) =>
    ({ reconciled: false, status: "Not reconciled", remark, reason });

  // TravelPay BR06 — a negative amount is never entered.
  if (words.negative && row.amountCents != null && row.amountCents < 0) {
    return no(words.negative,
      `the file says $${money(row.amountCents)} — a negative amount is not entered`);
  }

  /* THE REFERENCE COLUMN, which is what both guides actually name.
   *
   *   MINT step 12       "Value in the 'Reference' column in Tramada should
   *                       match 'Transaction ID' (column E) in spreadsheet"
   *   TravelPay step 12  "...should match 'Payment Reference' (column Q)"
   *
   * Not Trans. No. Measured on page 13, 17-Aug-2026, a row reads
   *
   *   Trans. No   R.0000009444        Tramada's own number
   *   Reference   BP-HM51N-13316      the id the payment was made under
   *
   * and it is the second one a MINT or TravelPay file carries. Matching on
   * Trans. No would compare a bank's transaction id against a Tramada receipt
   * number and never find anything — which is exactly what the first version of
   * this function did.
   *
   * Trans. No is still accepted as a second place to look, and the reason says
   * which column answered: both are unique on the page, and a run that found
   * the id somewhere unexpected should say so rather than silently succeed or
   * silently fail. */
  const want = refKey(row.transNo);
  const onReference = (statementRows || []).filter((t) => refKey(t.reference) === want);
  const onTransNo = onReference.length ? []
    : (statementRows || []).filter((t) => receiptKey(t.transNo) === receiptKey(row.transNo));
  const hits = onReference.length ? onReference : onTransNo;
  const foundIn = onReference.length ? "Reference" : "Trans. No";
  if (!want || !hits.length) {
    return no(words.reference,
      `${row.transNo || "(no reference)"} is not in the Reference column of this page`);
  }

  /* Prefer a hit that agrees on the money, so a duplicated reference reports
     the one that actually matches rather than whichever came first. */
  const onAmount = hits.find((t) => cents(t.amount) === row.amountCents);
  const hit = onAmount || hits[0];

  if (row.amountCents == null || !onAmount) {
    return no(words.amount,
      `the page says $${money(cents(hit.amount))}, the file says ` +
      `$${row.amountCents == null ? "?" : money(row.amountCents)}`);
  }

  const supplier = supplierMatches(row.toCompany, hit.payee, index);
  if (!supplier.ok) {
    /* Say what would fix it. "Supplier does not match" on its own sends someone
       to Tramada to look up a creditor the sheet already half knows about. */
    const hint = supplier.near
      ? ` (the sheet has "${supplier.near}" — add this exact name to it if they are the same creditor)`
      : supplier.tried && supplier.tried.length
        ? ` (the sheet says to try ${supplier.tried.map((t) => `"${t}"`).join(", ")})`
        : "";
    return no(words.supplier,
      `the page pays "${hit.payee || "(blank)"}", the file says "${row.toCompany || "(blank)"}"` +
      ` — ${supplier.via}${hint}`);
  }

  return {
    reconciled: true, status: "Reconciled", remark: "",
    reason: `${row.transNo} found in the ${foundIn} column at $${money(row.amountCents)} ` +
      `to "${hit.payee}"` +
      (supplier.via === "cheat sheet" ? " (supplier matched via the cheat sheet)" : ""),
    // What the run TICKS by, which is the page's own transaction number.
    transNo: hit.transNo || null,
    duplicates: hits.length > 1 ? hits.length : undefined,
  };
}

/**
 * The 20-Aug step — the SPREADSHEET's own total against the figure a human
 * typed off the bank statement.
 *
 * A RUN-LEVEL check, not a row one: it says something about the upload, not
 * about any particular payment, so it is reported once and never repeated down
 * every row's Remarks.
 *
 * Both totals are in cents and compared with `===`, like every other money
 * comparison here. An unreadable entry is not silently treated as agreement.
 */
function checkTransactionTotal(rows, entered, opts = {}) {
  const words = opts.remarks || MINT_REMARKS;
  const want = cents(entered);
  if (want == null) {
    return { checked: false, remark: "", reason: "no Transaction Total was entered" };
  }
  const amounts = (rows || []).map((r) => (r ? r.amountCents : null));
  if (amounts.some((c) => c == null)) {
    return {
      checked: false, remark: "",
      reason: "some rows have an unreadable amount, so the file's total cannot be added up",
    };
  }
  const got = amounts.reduce((a, c) => a + c, 0);
  if (got === want) {
    return { checked: true, ok: true, remark: "", enteredCents: want, fileCents: got,
      reason: `the file totals $${money(got)}, which is the Transaction Total entered` };
  }
  return {
    checked: true, ok: false, remark: words.total,
    enteredCents: want, fileCents: got,
    reason: `the file totals $${money(got)} but the Transaction Total entered is ` +
      `$${money(want)} — a difference of $${money(Math.abs(got - want))}`,
  };
}

/**
 * What a run says when the day has no bank statement — a HARD STOP.
 *
 * MINT and TravelPay reconcile the page the BPay run creates and never create
 * one themselves (BR03 in both guides, BR12 in BPay's). So the absence of a
 * statement is not something to work around: the run ends without a tick, and
 * the person is told which run to do first rather than left to work it out.
 *
 * Here rather than in the browser code so the wording can be asserted — it is
 * the sentence somebody reads at 8am when the day will not start.
 */
/* How each report names itself when it is refused for want of a statement.
   IPSI is deliberately absent — see the comment inside noStatementMessage. */
const REPORT_TITLE_FOR_REFUSAL = { mint: "MINT", travelpay: "TravelPay" };

function noStatementMessage(source, statementDate, pages, accountLabel = "The account") {
  /* THE MOST RECENT FIVE, and they have to actually be the most recent.
     This was `.slice(-5)` on the list as Tramada hands it over — which is
     NEWEST FIRST, so it took the five at the END and called them recent. A live
     Mint run on an account with 17 statement pages reported "the most recent
     statements are 20-03-2020 (page 5) … 29-02-2020 (page 1)": the five OLDEST,
     from six years earlier, while pages 6-17 sat there unmentioned. Finance
     reads that as a dead account rather than a missing day.

     Sorted here rather than trusting the caller's order, because the two
     callers reach this from different screens and only one of them controls
     the sort. */
  const recent = (pages || [])
    .slice()
    .sort((a, b) => (Number(b.pageNo) || 0) - (Number(a.pageNo) || 0))
    .slice(0, 5)
    .map((p) => `${toTramadaDate(p.statementDate) || p.statementDate} (page ${p.pageNo})`);
  return (
    // The first sentence is the wording RAA asked for in the POC feedback
    // (BPAY 01) and is quoted exactly; the rest is the detail that makes it
    // actionable rather than just a refusal.
    `BPAY needs to be reconciled first for today. ` +
    `${accountLabel} has no bank statement for ${toTramadaDate(statementDate)}, and ` +
    /* IPSI CANNOT REACH THIS AND MUST NOT. Confirmed by RAA 28-Aug: "IPSI can
       still run by itself because it doesn't reference the Tramada bank
       statement." The POC feedback line for BPAY 02 names IPSI alongside Mint
       and TravelPay, but the condition it attaches — no bank statement for the
       day — describes a document IPSI never opens. It reconciles on the Finance
       Receipts screens (`REPORTS.ipsi.recPayType` is null, which is what routes
       it away from the statement-page flow), so it is exempt by design, not by
       oversight.

       The ternary below used to read `travelpay ? "TravelPay" : "MINT"`, so an
       IPSI source arriving here would have called itself MINT. That is now
       impossible to reach, and if it ever does the sentence says which report
       it really was instead of blaming the wrong one. */
    `${REPORT_TITLE_FOR_REFUSAL[source] || String(source || "That report").toUpperCase()} ` +
    `reconciles the statement the BPay run creates ` +
    `rather than creating one itself. ` +
    (recent.length ? `The most recent statements are ${recent.join(", ")}.` : "There are no statements at all.")
  );
}

/**
 * MINT BR08 / TravelPay BR09 — what was TICKED IN TRAMADA against the figure a
 * human typed.
 *
 * The other half of the pair, and the one that finds a missing payment. The
 * file can total exactly what the bank statement says while a line never made
 * it into Tramada at all: the first check compares two documents to each other
 * and both can be right about money that is not there.
 *
 * Only the rows this run ticked are counted, decided with RAA 20-Aug. A
 * statement page carries BPay receipts and the other report's payments too, so
 * the page's own total is not this report's total and never was.
 *
 * `ticked` are transaction numbers as the page shows them; `statementRows` is
 * the page as it was read. A ticked row whose amount cannot be read stops the
 * check rather than failing it — a guess must not accuse anyone.
 */
function checkTickedTotal(statementRows, ticked, entered) {
  const want = cents(entered);
  if (want == null) {
    return { checked: false, remark: "", reason: "no Transaction Total was entered" };
  }
  const byKey = new Map();
  for (const r of statementRows || []) {
    const k = receiptKey(r && r.transNo);
    if (k) byKey.set(k, r);
  }

  let got = 0;
  const unreadable = [];
  const absent = [];
  for (const t of ticked || []) {
    const row = byKey.get(receiptKey(t));
    if (!row) { absent.push(t); continue; }
    const c = cents(row.amount);
    if (c == null) { unreadable.push(t); continue; }
    got += c;
  }
  if (unreadable.length || absent.length) {
    return {
      checked: false, remark: "",
      reason: `the Tramada total could not be added up — ` +
        (unreadable.length ? `${unreadable.length} ticked row(s) have an unreadable amount` : "") +
        (unreadable.length && absent.length ? " and " : "") +
        (absent.length ? `${absent.length} could not be found back on the page` : ""),
    };
  }
  if (got === want) {
    return { checked: true, ok: true, remark: "", enteredCents: want, tramadaCents: got,
      reason: `the ${(ticked || []).length} transaction(s) ticked in Tramada total ` +
        `$${money(got)}, which is the Transaction Total entered` };
  }
  const short = want - got;
  return {
    checked: true, ok: false, remark: TRAMADA_TOTAL_REMARK,
    enteredCents: want, tramadaCents: got,
    reason: `the ${(ticked || []).length} transaction(s) ticked in Tramada total $${money(got)} ` +
      `but the Transaction Total entered is $${money(want)} — ` +
      `$${money(Math.abs(short))} ${short > 0 ? "is not on the page" : "more than expected"}`,
  };
}

module.exports = {
  cents, money, refKey, receiptKey,
  summariseCombined, sourceBreakdown,
  uploadName, stampOf, runTotals, needsReaction, overviewFrom,
  splitCsvLine, parseReconCsv, parseReconRows,
  normaliseHeading, buildExportGrid, inputColumnsOf, moneyColumnsOf, gridToCsv, EXPORT_FIELDS,
  REMARKS, RETAIL_DEBTOR, BPAY_RECEIPT, branchCode, isPastDate, toIsoDate, decidePreReceipt, sortForFinance, pageForDate, pagesForDate,
  outstandingFrom, totalLeftToAllocate, chooseSegments, decideAllocation,
  matchAgainstStatement,
  nextPageNumber, toTramadaDate,
  daysBefore,
  mapColumns, rowsByHeader, sortIpsiForExport,
  STATEMENT_COLUMNS, TRANSACTION_COLUMNS, TRANSACTION_FALLBACK,
  MINT_COLUMNS, csvGrid, parseMintRows, matchMintAgainstStatement, summariseMint,
  matchTravelPayAgainstStatement, MATCHERS, matcherFor, matchesOn, SORT_BY,
  BOOKING_RECEIPT_COLUMNS, findFiledReceipt,
  TRAVELPAY_COLUMNS, parseTravelPayRows, serialDate, bookingFromReference,
  bookingFromDelimitedReference, REPORTS, RUN_ORDER,
  IPSI_COLUMNS, IPSI_REMARKS, IPSI_REFERENCE_REQUIRED, isPreAuth, parseIpsiRows, matchIpsiAgainstReceipts,
  matchIpsiAgainstPayments, filterIpsiSettlementDate, checkIpsiFileTotal, checkIpsiAllocatedTotal, summariseIpsi,
  tidyError,
  summarise,
  MINT_REMARKS, TRAVELPAY_REMARKS, CHEAT_SHEET_COLUMNS,
  parseCheatSheet, cheatSheetIndex, supplierKey, supplierMatches,
  cheatSheetCandidates, relaxedKey,
  matchCreditorRow, checkTransactionTotal, checkTickedTotal,
  TRAMADA_TOTAL_REMARK, remarksFor, noStatementMessage,
};

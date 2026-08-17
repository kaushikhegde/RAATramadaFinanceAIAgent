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
const HEADERS = {
  date: ["date", "date received", "b/pay file date"],
  /* "receipt no" is the BPAY SPREADSHEET's column and it is this field, not
     `receiptNo`. Step 16 takes the number from the spreadsheet's "Receipt No"
     column and types it into Tramada's *Reference* field; `receiptNo` on a
     result row is the different number Tramada hands BACK (`R.0000009444`).
     Two columns, similar names, opposite directions — which is why the export
     calls Tramada's one "Tramada Receipt No" and never just "Receipt No". */
  reference: ["reference", "reference number", "ref", "receipt no", "receipt number"],
  recPayType: ["rec/pay type", "recpaytype", "payment type", "type"],
  amount: ["amount"],
  bookingNo: ["booking no", "booking number", "bookingno", "booking reference", "booking", "booking no."],
};

/**
 * The BPay rows, from a GRID — a CSV's lines or a workbook's cells.
 *
 * Split out from `parseReconCsv` because step 1 says "prepares BPAY transaction
 * into a spreadsheet", and a spreadsheet is a .xlsx. BPay was the one report
 * whose file had to be a CSV, so Finance's actual workbook could not be
 * uploaded at all — every other report already read either container through
 * `xlsx-lite`. One rule, two containers, and the rule is here.
 */
function parseReconRows(headers, gridRows) {
  const header = (headers || []).map((h) => String(h == null ? "" : h).trim().toLowerCase());
  if (!header.length) return { rows: [], problems: [{ line: 0, why: "the file is empty" }] };

  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  /* `recPayType` is OPTIONAL and the rest are not.
   *
   * It is display only — nothing matches on it, nothing is typed from it. It
   * was required because the first BPay files were built by `statement-csv.js`,
   * which is a scrape of the reconcile screen and therefore has the column. The
   * spreadsheet RAA Finance actually sends has Booking no., Receipt No, Amount
   * and Date and no Rec/Pay Type anywhere, so requiring it rejected the real
   * file with "the header is missing: recPayType" and no way forward. */
  const OPTIONAL = ["recPayType"];
  const missing = Object.entries(col)
    .filter(([k, i]) => i < 0 && !OPTIONAL.includes(k))
    .map(([k]) => k);
  if (missing.length) {
    return { rows: [], problems: [{ line: 1, why: `the header is missing: ${missing.join(", ")}` }] };
  }

  const rows = [];
  const problems = [];
  // A workbook cell can be a number; a CSV field is always a string. Everything
  // downstream types these into a form, so they are strings from here on.
  const at = (cells, key) =>
    col[key] < 0 ? "" : String(cells[col[key]] == null ? "" : cells[col[key]]).trim();

  (gridRows || []).forEach((cells, i) => {
    const row = {
      line: i + 2,                       // +1 for the header, +1 for 1-based
      date: at(cells, "date"),
      reference: at(cells, "reference"),
      recPayType: at(cells, "recPayType"),
      amount: at(cells, "amount"),
      bookingNo: at(cells, "bookingNo"),
    };
    row.amountCents = cents(row.amount);
    const why = [];
    if (!row.reference) why.push("no reference");
    if (row.amountCents == null) why.push(`unreadable amount "${row.amount}"`);
    if (!row.bookingNo) why.push("no booking number");
    if (why.length) problems.push({ line: row.line, why: why.join("; "), row });
    else rows.push(row);
  });
  return { rows, problems };
}

/** The same rule, over a CSV. */
function parseReconCsv(text) {
  const grid = csvGrid(text);
  if (!grid.headers.length) return { rows: [], problems: [{ line: 0, why: "the file is empty" }] };
  return parseReconRows(grid.headers, grid.rows);
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
 * The exact words that go in the spreadsheet's Remarks column.
 *
 * Written once, here, because a person reading the returned file sorts and
 * filters on these strings by eye and Finance's guide quotes them verbatim.
 * "Please allocate" typed a second time as "please allocate" is a remark that
 * silently stops grouping with its own kind.
 */
const REMARKS = {
  NO_BOOKING: "No booking number found",                              // BR01
  DEPARTED: "Please review, departure date has passed",               // BR02
  NO_OUTSTANDING: "No outstanding amount found",                      // BR03
  NO_OUTSTANDING_DEPARTED: "No outstanding amount found, departure date has passed", // BR04
  WRONG_DEBTOR: "Please review, incorrect debtor found",              // BR05
  ALLOCATE: "Please allocate",                                        // BR09, BR10
  OVERPAYMENT: "Overpayment, please check",                           // BR11
};

/** The only debtor a BPAY receipt may be raised against (BR05). */
const REQUIRED_DEBTOR = "RAA of SA Limited (Retail)";

/**
 * Payer Name on every BPAY receipt (BR06).
 *
 * The literal word, not the booking's client name. Finance identifies these
 * receipts as a group by this field; taking the traveller's name — which is
 * what the receipt module does by default — made each one look like an
 * unrelated over-the-counter payment.
 */
const BPAY_PAYER_NAME = "BPAY";

/** Today as `dd-mm-yyyy`, the shape every Tramada screen uses. */
function today(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * Two debtor names, compared the way a person compares them.
 *
 * Case and surrounding/internal whitespace only — the brackets and the "of"
 * are load-bearing. `RAA of SA Limited` and `RAA of SA Limited (Retail)` are
 * different debtors and a normaliser that stripped punctuation would file a
 * receipt against the wrong one, which is BR05's whole purpose.
 */
function sameDebtor(a, b) {
  const k = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().toLowerCase();
  return k(a) === k(b) && k(a) !== "";
}

/**
 * A Tramada date to a sortable YYYYMMDD number, or null.
 *
 * Accepts `dd-mm-yyyy` (what Tramada renders), `dd/mm/yyyy` and ISO
 * `yyyy-mm-dd`. Day-first is assumed for the two-then-four shapes because that
 * is what every Tramada screen in this system serves; nothing here guesses
 * between `03-04-2026` as March and as April by looking at which number could
 * be a month, because that guess is wrong half the time and silently.
 */
function dateKey(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
  return null;
}

/** Is this departure date strictly before today? Unreadable dates are not. */
function hasDeparted(departureDate, today) {
  const d = dateKey(departureDate);
  const t = dateKey(today);
  // An unreadable date is never "in the past". Guessing here would attach
  // "departure date has passed" to a booking nobody has looked at.
  if (d == null || t == null) return false;
  return d < t;
}

/**
 * May this booking be receipted at all? (Steps 4–6, BR01–BR05.)
 *
 * Runs BEFORE the receipt form is opened, in the order Finance's guide runs it:
 * the balance decides whether there is anything to receipt, and only then is
 * the debtor checked. A booking that owes nothing never reaches the debtor
 * test, because the guide sends it straight back to the next row.
 *
 * `balanceCents` is the booking summary's **Client/Debtor Balance**, not the
 * receipt form's segment dues. They answer different questions: the balance is
 * "does this booking owe anything at all", which is what decides whether a
 * receipt is raised; the segment dues decide what that receipt can settle.
 * A booking can owe money with no allocatable segment on the form, and the
 * guide still wants the receipt raised — see "AI Agent can continue to receipt
 * even when unable to allocate to the segments".
 *
 * Returns `{ proceed, remarks[], reason }`. `remarks` is a list because a
 * booking can carry an exception and still be receipted (BR02).
 */
function decideBookingEligibility(booking, today) {
  const b = booking || {};

  if (!b.found) {
    return { proceed: false, remarks: [REMARKS.NO_BOOKING],
      reason: `booking ${b.bookingNo || "(blank)"} could not be found in Tramada` };
  }

  const departed = hasDeparted(b.departureDate, today);

  // An unreadable balance is NOT nothing-outstanding. Treating it as zero would
  // skip a booking that owes money and write "No outstanding amount found"
  // against it, which reads as a checked fact rather than a failed read.
  if (b.balanceCents == null) {
    return { proceed: false, remarks: [REMARKS.ALLOCATE],
      reason: `the Client/Debtor Balance on booking ${b.bookingNo} could not be read ` +
        `(it reads "${b.balance == null ? "" : b.balance}")` };
  }

  if (b.balanceCents <= 0) {
    return {
      proceed: false,
      remarks: [departed ? REMARKS.NO_OUTSTANDING_DEPARTED : REMARKS.NO_OUTSTANDING],
      reason: `booking ${b.bookingNo} has no outstanding amount ` +
        `(Client/Debtor Balance $${money(b.balanceCents)})` +
        (departed ? `, and departed ${b.departureDate}` : ""),
    };
  }

  if (!sameDebtor(b.debtor, REQUIRED_DEBTOR)) {
    return { proceed: false, remarks: [REMARKS.WRONG_DEBTOR],
      reason: `booking ${b.bookingNo} is against "${b.debtor || ""}", not ${REQUIRED_DEBTOR}` };
  }

  // Outstanding and the right debtor — receipt it. A departure already gone by
  // is a remark, not a refusal (BR02).
  return {
    proceed: true,
    remarks: departed ? [REMARKS.DEPARTED] : [],
    reason: `booking ${b.bookingNo} owes $${money(b.balanceCents)} to ${REQUIRED_DEBTOR}` +
      (departed ? `, departed ${b.departureDate}` : ""),
  };
}

/**
 * What to do with one receipt. (Step 17, BR07–BR11.)
 *
 * THIS USED TO BE A SUBSET-SUM SEARCH and it is not one any more. The old rule
 * picked whichever combination of whole segments came closest to the receipt
 * without exceeding it, so $300 against 200 + 200 settled one of them and came
 * back "Part allocated". Finance's BPAY guide does not allow that: BR09 and
 * BR10 say a receipt that does not land on a clean boundary ticks NOTHING and
 * goes back to a person with "Please allocate". Deciding which of two identical
 * segments a part-payment belongs to is exactly the judgement the guide
 * reserves for a human, and the old code was making it silently and filing it.
 *
 * So there are three ways to tick, and one way not to:
 *
 *   amount == one segment's due    tick that segment          Allocated
 *   amount == every segment summed tick them all              Allocated
 *   amount >  every segment summed tick them all              Allocated + "Overpayment, please check"
 *   anything else                  tick nothing               Not allocated + "Please allocate"
 *
 * The receipt is filed either way. "AI Agent can continue to receipt even when
 * unable to allocate to the segments" — the money reached the bank and the
 * receipt records that; only the allocation waits for a person.
 *
 * `allocation` is what runTramadaReceipt takes: "ALL" when every segment is
 * selected (the proven Select All path), an array of `{segId, amount}` for a
 * single segment, or `[]` to file the receipt and tick nothing.
 *
 * "Part allocated" is no longer reachable from here. `summarise` still counts
 * it, because a stored run from before this change can still hold one.
 */
function decideAllocation(csvAmountCents, segments) {
  const nothing = (reason, remark) => ({
    allocate: false, allocation: [], status: "Not allocated",
    reason, remarks: remark ? [remark] : [],
  });

  if (csvAmountCents == null) {
    return nothing("the CSV amount could not be read", REMARKS.ALLOCATE);
  }
  if (!Array.isArray(segments) || !segments.length) {
    return nothing("the booking has nothing outstanding to allocate against", REMARKS.ALLOCATE);
  }

  const dues = segments.map((s) => ({ segId: s && s.segId, due: cents(s && s.debtorDue) }));
  if (dues.some((d) => d.due == null)) {
    // An unreadable due is never treated as zero — that reads as "nothing owed"
    // and would tick a segment for an amount nobody has seen.
    return nothing("the amount outstanding on the receipt form could not be read", REMARKS.ALLOCATE);
  }

  const owing = dues.filter((d) => d.due > 0);
  if (!owing.length) {
    return nothing("the booking has nothing outstanding to allocate against", REMARKS.ALLOCATE);
  }

  const total = owing.reduce((a, d) => a + d.due, 0);

  // BR08 first, and BR11 with it: both tick everything, and checking "all of
  // them" before "one of them" keeps a single-segment booking on the proven
  // Select All path instead of hand-ticking the only row there is.
  if (csvAmountCents === total) {
    return {
      allocate: true, allocation: "ALL", status: "Allocated", remarks: [],
      reason: `$${money(total)} settles all ${owing.length} segment${owing.length === 1 ? "" : "s"} exactly`,
    };
  }
  if (csvAmountCents > total) {
    return {
      allocate: true, allocation: "ALL", status: "Allocated", remarks: [REMARKS.OVERPAYMENT],
      reason: `$${money(csvAmountCents)} is more than the $${money(total)} outstanding across ` +
        `all ${owing.length} segment${owing.length === 1 ? "" : "s"} — all of them are settled and ` +
        `$${money(csvAmountCents - total)} of this receipt stays unallocated`,
    };
  }

  // BR07. Ties are possible — two segments can owe the same amount — and the
  // guide gives no way to tell them apart, so the FIRST one on the form is
  // taken and the ambiguity is said out loud in the reason rather than being
  // presented as a choice that was reasoned about.
  const exact = owing.filter((d) => d.due === csvAmountCents);
  if (exact.length) {
    const pick = exact[0];
    return {
      allocate: true, allocation: [{ segId: pick.segId, amount: money(pick.due) }],
      status: "Allocated", remarks: [],
      reason: `$${money(csvAmountCents)} settles segment ${pick.segId} exactly` +
        (exact.length > 1
          ? ` — ${exact.length} segments owe this amount and the first on the form was taken`
          : ""),
    };
  }

  // BR09 / BR10 — everything else. No partial allocation, no subset search.
  return nothing(
    `$${money(csvAmountCents)} is neither one whole segment nor all $${money(total)} of them ` +
    `(the segments owe $${owing.map((d) => money(d.due)).join(", $")}) — nothing was ticked`,
    REMARKS.ALLOCATE
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
  return {
    reconciled: true, status: "Reconciled",
    reason: `receipt ${row.receiptNo} found at $${money(row.amountCents)}`,
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
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
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
  const fb = fallbacks || {};
  const out = {};
  for (const [key, names] of Object.entries(spec || {})) {
    let idx = -1;
    for (const name of names) {
      const want = String(name).toLowerCase();
      idx = hs.indexOf(want);
      if (idx < 0) idx = hs.findIndex((h) => h.startsWith(want));
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
  transNo: ["transaction reference", "transaction ref", "trans no", "trans. no"],
  amount: ["amount"],
  toCompany: ["to company", "company"],
};

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
  return {
    headers: splitCsvLine(lines[0]).map((h) => h.trim()),
    rows: lines.slice(1).map((l) => splitCsvLine(l)),
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
  const missing = Object.entries(cols).filter(([, i]) => i < 0).map(([k]) => k);
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
    if (why.length) problems.push({ line: row.line, why: why.join("; "), row });
    else rows.push(row);
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

  return {
    reconciled: true, status: "Reconciled",
    reason: `${row.transNo} found on the page` + (notes.length ? ` — ${notes.join("; ")}` : ""),
    transNo: hit.transNo || null,
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
    if (!row.transNo) why.push("no payment reference");
    if (row.amountCents == null) why.push(`unreadable amount "${row.rawAmount}"`);
    if (row.status && !/^success/i.test(row.status)) {
      const reason = at(cells, "failure");
      why.push(`the transaction was "${row.status}"${reason ? ` — ${reason}` : ""}, so it never reached the bank`);
    }
    if (why.length) problems.push({ line: row.line, why: why.join("; "), row });
    else rows.push(row);
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
  bookingNo: ["booking number"],
  amount: ["transaction amount"],
  kind: ["custom 5"],
  typeCode: ["transaction type"],
  status: ["transaction status"],
  settlementDate: ["settlement date"],
  settlementAmount: ["settlement amount"],
  tramadaPaymentNo: ["tramada payment number"],
  cardHolder: ["card holder name"],
  linked: ["linked transaction"],
};

/** Refunds are `Transaction Type` 20 — `Custom 5` spells it "Refund (20)". */
const isRefund = (row) => String(row.typeCode).trim() === "20" || /refund/i.test(row.kind || "");

/**
 * An IPSI export → rows the run can act on, plus the day's own settlement.
 *
 * REFUNDS ARE NOT PART OF AN IPSI RUN. They are money going back out to a
 * cardholder — each one links to a purchase from an EARLIER settlement, and the
 * screen this run drives ticks *Receipts* To Reconcile, which is money coming
 * in. There is nothing there to tick against a refund. They are held back and
 * reported so a person can see them, never silently dropped.
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
    /* A row is only unusable when there is NOTHING to match it by. It used to
       be held back for a missing Merchant Reference — a column this no longer
       reads — which threw away rows that would have matched perfectly well on
       their booking number. */
    if (!row.reference && !row.bookingNo) {
      why.push("no transaction reference and no booking number — nothing to match it by");
    }
    if (row.amountCents == null) why.push(`unreadable amount "${row.rawAmount}"`);
    if (row.status && !/^approved$/i.test(row.status)) {
      why.push(`the transaction is "${row.status}", not approved`);
    }
    if (isRefund(row)) {
      why.push(
        `this is a refund of $${money(Math.abs(row.amountCents || 0))}` +
        (row.linked ? ` against ${row.linked}` : "") +
        " — refunds are money going back out and are not part of an IPSI run"
      );
    }
    if (why.length) problems.push({ line: row.line, why: why.join("; "), row });
    else rows.push(row);
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
 * One IPSI row against Tramada's "Receipts To Reconcile" list.
 *
 * Merchant Reference first, Booking No. second. The fallback is not politeness:
 * ten of the forty-nine rows in the client's own file are Captures, whose
 * merchant reference is a different shape entirely, and matching those on
 * reference alone would leave a fifth of the settlement unticked with no
 * explanation. Amount has to agree either way — four bookings appear twice in
 * one file, so the booking on its own does not identify a row.
 */
function matchIpsiAgainstReceipts(row, receipts) {
  const list = receipts || [];
  const sameMoney = (r) => cents(r.receiptAmount) === row.amountCents;

  const byRef = list.filter((r) => r.reference && refKey(r.reference) === refKey(row.reference));
  const refHit = byRef.find(sameMoney);
  if (refHit) {
    return { matched: true, on: "reference", receipt: refHit,
      reason: `matched on reference ${row.reference} at $${money(row.amountCents)}` };
  }
  if (byRef.length) {
    return { matched: false, on: "reference", candidates: byRef,
      reason: `reference ${row.reference} is on the list at $${byRef.map((r) => money(cents(r.receiptAmount))).join(", $")}, not $${money(row.amountCents)}` };
  }

  const byBooking = list.filter((r) => r.bookingNo && refKey(r.bookingNo) === refKey(row.bookingNo));
  const bookHit = byBooking.find(sameMoney);
  if (bookHit) {
    return { matched: true, on: "booking", receipt: bookHit,
      reason: `no receipt carries reference ${row.reference}, matched on booking ${row.bookingNo} at $${money(row.amountCents)}` };
  }
  if (byBooking.length) {
    return { matched: false, on: "booking", candidates: byBooking,
      reason: `booking ${row.bookingNo} is on the list at $${byBooking.map((r) => money(cents(r.receiptAmount))).join(", $")}, not $${money(row.amountCents)}` };
  }
  return { matched: false, on: null,
    reason: `nothing on the list carries reference ${row.reference} or booking ${row.bookingNo}` };
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
const REPORTS = {
  bpay: {
    key: "bpay",
    title: "BPay receipts",
    /* CLIENT PAYMENT RECEIPT, NOT DEBTOR PAYMENT RECEIPT — verified live on the
       sandbox 17-08-2026, and it disagrees with Finance's BPAY guide.
     *
     * The guide's steps 11 and 30 both say "Debtor Payment Receipt". On the
     * booking Receipts screen the dropdown beside Add / Issue Receipt is
     * `#receiptCategory`, and it offers exactly four things:
     *
     *     Client Payment Receipt | Agency CC Client Receipt |
     *     Migration Client Payment Receipt | Creditor Refund Receipt
     *
     * There is no Debtor Payment Receipt on it. A Debtor Payment Receipt is
     * raised in the Debtors module against a debtor ACCOUNT, and has no
     * booking and therefore no "Segments to Allocate" — which is step 17, the
     * step the whole run exists for. The reconcile screen's Rec/Pay Type
     * filter does list Debtor Payment Receipt among its fifteen types, so the
     * name in the guide is real; it just is not what a booking can raise.
     *
     * Confirmed from the other end too: the receipts this system has already
     * filed (R.0000009444/5/6, references BP-HM51N-133xx) sit on statement
     * page 13 as Client Payment Receipt, trans type ET.
     *
     * `openReceiptForm` selects this by label and throws with the list the
     * page actually offers if it is not there — so if RAA's production really
     * does have a Debtor Payment Receipt on the booking form, the first run
     * says so instead of quietly filing under something else. */
    receiptCategory: "Client Payment Receipt",
    recPayType: "Client Payment Receipt",
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
    // Client Payment Receipt, confirmed 10-08-2026 — the same type the BPay
    // receipts land under, NOT the Finance Merchant Payment Receipt its name
    // suggests. On a combined run that means BPay and TravelPay share one
    // filter pass and Mint gets its own.
    recPayType: "Client Payment Receipt",
    files: false,
  },
};

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
const MATCHERS = {
  bpay: { fn: matchAgainstStatement, column: "Trans. No", what: "the receipt number it was handed" },
  mint: { fn: matchMintAgainstStatement, column: "Trans. No", what: "the P. payment number" },
  travelpay: { fn: matchTravelPayAgainstStatement, column: "Reference", what: "TravelPay's own payment reference" },
};

/** The matcher for a report, defaulting to Mint's — the older behaviour. */
function matcherFor(source) {
  return (MATCHERS[source] || MATCHERS.mint).fn;
}

/** What to tell the person the run is about to look for, and where. */
function matchesOn(source) {
  const m = MATCHERS[source] || MATCHERS.mint;
  return `matched on ${m.what}, in the statement's ${m.column} column`;
}

/* ── the spreadsheet that goes back to Finance ───────────────────────────── */

/**
 * The updated BPAY spreadsheet's columns (steps 34–35).
 *
 * The file Finance uploaded, with the four things the run learned added:
 * Consultant, Shop, the receipt number Tramada issued, and Remarks.
 *
 * "Tramada Receipt No", never "Receipt No". The spreadsheet's own "Receipt No"
 * column is the BPAY reference that gets typed INTO Tramada, and `parseReconCsv`
 * reads it as `reference`. Two columns called Receipt No in one file would mean
 * re-uploading this export mapped Tramada's `R.0000009444` into the reference
 * field and filed every receipt against a number Finance never sent.
 */
const BPAY_EXPORT_COLUMNS = [
  ["date", "Date"],
  ["reference", "Receipt No"],
  ["amount", "Amount"],
  ["bookingNo", "Booking No"],
  ["consultant", "Consultant"],
  ["shop", "Shop"],
  ["receiptNo", "Tramada Receipt No"],
  ["allocation", "Allocation"],
  ["reconciliation", "Reconciled"],
  ["remark", "Remarks"],
];

/**
 * One row's Remarks cell.
 *
 * Joined with "; " because a row can carry more than one (BR02 and BR11 both
 * apply to a departed booking that was overpaid) and the guide has one column.
 * Duplicates are dropped — a retried row that collected "Please allocate"
 * twice reads as one problem, not two.
 */
function remarkCell(row) {
  const list = (row && row.remarks) || [];
  return [...new Set(list.filter(Boolean).map((s) => String(s).trim()))].join("; ");
}

/**
 * Sort the finished rows the way step 34 / BR14 asks: Shop, then Consultant.
 *
 * Case-insensitive, and blanks sort LAST rather than first. A booking whose
 * branch could not be read is the one a person most needs to see, and ""
 * sorting to the top of an alphabetical list buries it under whatever comes
 * next while looking deliberate. The original row number breaks ties, so the
 * order is total — two rows for the same consultant keep the order Finance
 * sent them in, which is how they will be checked off.
 */
function sortForFinance(rows) {
  const key = (v) => String(v == null ? "" : v).trim().toLowerCase();
  return [...(rows || [])].sort((a, b) => {
    const as = key(a.shop);
    const bs = key(b.shop);
    if (as !== bs) {
      if (!as) return 1;
      if (!bs) return -1;
      return as < bs ? -1 : 1;
    }
    const ac = key(a.consultant);
    const bc = key(b.consultant);
    if (ac !== bc) {
      if (!ac) return 1;
      if (!bc) return -1;
      return ac < bc ? -1 : 1;
    }
    return (a.n || 0) - (b.n || 0);
  });
}

/** One CSV cell, quoted only when it has to be. */
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The updated BPAY spreadsheet, as CSV text.
 *
 * EVERY row is here, including the ones no receipt was raised for. That is the
 * point of the Remarks column: "No outstanding amount found" against a row is
 * the answer Finance needs, and a file that quietly contained only the rows
 * that worked would read as though the rest had never been sent.
 */
function bpayExportCsv(rows) {
  const out = [BPAY_EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(",")];
  for (const r of sortForFinance(rows)) {
    out.push(BPAY_EXPORT_COLUMNS
      .map(([key]) => csvCell(key === "remark" ? remarkCell(r) : r[key]))
      .join(","));
  }
  return out.join("\n") + "\n";
}

/**
 * The export's filename — ONE PER DAY, overwritten.
 *
 * Finance asked for no history of these: re-upload the day's spreadsheet after
 * a correction and the new export replaces the old one, so there is never a
 * question of which of two files is the current one. The RAW upload is still
 * archived per run under `uploads/` (CLAUDE.md §6b) — that is the evidence of
 * what arrived, and it is a different thing from the working file that goes
 * back out.
 */
function bpayExportName(statementDate) {
  const k = dateKey(statementDate);
  return `bpay-reconciliation-${k == null ? "undated" : k}.csv`;
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

module.exports = {
  cents, money, refKey, receiptKey,
  summariseCombined, sourceBreakdown,
  uploadName, stampOf, runTotals, needsReaction, overviewFrom,
  splitCsvLine, parseReconCsv, parseReconRows,
  totalLeftToAllocate, decideAllocation,
  REMARKS, REQUIRED_DEBTOR, BPAY_PAYER_NAME, today,
  sameDebtor, dateKey, hasDeparted, decideBookingEligibility,
  BPAY_EXPORT_COLUMNS, remarkCell, sortForFinance, bpayExportCsv, bpayExportName,
  matchAgainstStatement,
  nextPageNumber, toTramadaDate,
  daysBefore,
  mapColumns, rowsByHeader,
  STATEMENT_COLUMNS, TRANSACTION_COLUMNS, TRANSACTION_FALLBACK,
  MINT_COLUMNS, csvGrid, parseMintRows, matchMintAgainstStatement, summariseMint,
  matchTravelPayAgainstStatement, MATCHERS, matcherFor, matchesOn,
  BOOKING_RECEIPT_COLUMNS, findFiledReceipt,
  TRAVELPAY_COLUMNS, parseTravelPayRows, serialDate, bookingFromReference, REPORTS,
  IPSI_COLUMNS, parseIpsiRows, matchIpsiAgainstReceipts, summariseIpsi,
  tidyError,
  summarise,
};

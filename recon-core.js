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
  date: ["date"],
  reference: ["reference", "reference number", "ref"],
  recPayType: ["rec/pay type", "recpaytype", "payment type", "type"],
  amount: ["amount"],
  bookingNo: ["booking no", "booking number", "bookingno", "booking reference", "booking"],
};

function parseReconCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], problems: [{ line: 0, why: "the file is empty" }] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    return { rows: [], problems: [{ line: 1, why: `the header is missing: ${missing.join(", ")}` }] };
  }

  const rows = [];
  const problems = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const row = {
      line: i + 1,
      date: f[col.date] || "",
      reference: f[col.reference] || "",
      recPayType: f[col.recPayType] || "",
      amount: f[col.amount] || "",
      bookingNo: f[col.bookingNo] || "",
      amountCents: cents(f[col.amount]),
    };
    const why = [];
    if (!row.reference) why.push("no reference");
    if (row.amountCents == null) why.push(`unreadable amount "${row.amount}"`);
    if (!row.bookingNo) why.push("no booking number");
    if (why.length) problems.push({ line: row.line, why: why.join("; "), row });
    else rows.push(row);
  }
  return { rows, problems };
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
 * What to do with one receipt.
 *
 * Three outcomes:
 *   Allocated       the receipt settled segments worth exactly its own amount
 *   Part allocated  some segments settled, but not the whole receipt
 *   Not allocated   nothing fitted; the receipt is still filed, ticking nothing
 *
 * `allocation` is what runTramadaReceipt takes: "ALL" when every segment is
 * selected (the proven Select All path), an array of `{segId, amount}` for a
 * subset, or `[]` to file the receipt and tick nothing.
 */
function decideAllocation(csvAmountCents, segments) {
  if (csvAmountCents == null) {
    return { allocate: false, allocation: [], status: "Not allocated", reason: "the CSV amount could not be read" };
  }
  if (!Array.isArray(segments) || !segments.length) {
    return {
      allocate: false, allocation: [], status: "Not allocated",
      reason: "the booking has nothing outstanding to allocate against",
    };
  }

  const dues = segments.map((s) => ({ segId: s && s.segId, due: cents(s && s.debtorDue) }));
  if (dues.some((d) => d.due == null)) {
    // An unreadable due is never treated as zero — that reads as "nothing owed"
    // and would tick a segment for an amount nobody has seen.
    return {
      allocate: false, allocation: [], status: "Not allocated",
      reason: "the amount outstanding on the receipt form could not be read",
    };
  }

  const owing = dues.filter((d) => d.due > 0);
  if (!owing.length) {
    return {
      allocate: false, allocation: [], status: "Not allocated",
      reason: "the booking has nothing outstanding to allocate against",
    };
  }

  const picked = chooseSegments(csvAmountCents, dues);
  const placed = picked.reduce((a, d) => a + d.due, 0);

  if (!picked.length) {
    const cheapest = Math.min(...owing.map((d) => d.due));
    return {
      allocate: false, allocation: [], status: "Not allocated",
      reason: `no segment is small enough — the cheapest still owes $${money(cheapest)} ` +
        `against a receipt of $${money(csvAmountCents)}`,
    };
  }

  const everySegment = picked.length === owing.length;
  const allocation = everySegment
    ? "ALL"
    : picked.map((d) => ({ segId: d.segId, amount: money(d.due) }));
  const which = `${picked.length} segment${picked.length === 1 ? "" : "s"}` +
    (everySegment ? " (all of them)" : ` of ${owing.length}`);

  if (placed === csvAmountCents) {
    return {
      allocate: true, allocation, status: "Allocated",
      reason: `$${money(placed)} settles ${which} exactly`,
    };
  }
  return {
    allocate: true, allocation, status: "Part allocated",
    reason: `$${money(placed)} settles ${which}; ` +
      `$${money(csvAmountCents - placed)} of this receipt stays unallocated ` +
      `(no combination of whole segments reaches $${money(csvAmountCents)})`,
  };
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
  reference: ["merchant reference"],
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
    if (!row.reference) why.push("no merchant reference");
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
  splitCsvLine, parseReconCsv,
  totalLeftToAllocate, chooseSegments, decideAllocation,
  matchAgainstStatement,
  nextPageNumber, toTramadaDate,
  mapColumns, rowsByHeader,
  STATEMENT_COLUMNS, TRANSACTION_COLUMNS, TRANSACTION_FALLBACK,
  MINT_COLUMNS, csvGrid, parseMintRows, matchMintAgainstStatement, summariseMint,
  matchTravelPayAgainstStatement, MATCHERS, matcherFor, matchesOn,
  TRAVELPAY_COLUMNS, parseTravelPayRows, serialDate, bookingFromReference, REPORTS,
  IPSI_COLUMNS, parseIpsiRows, matchIpsiAgainstReceipts, summariseIpsi,
  tidyError,
  summarise,
};

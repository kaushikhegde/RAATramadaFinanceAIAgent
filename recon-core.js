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

module.exports = {
  cents, money, refKey, receiptKey,
  splitCsvLine, parseReconCsv,
  totalLeftToAllocate, chooseSegments, decideAllocation,
  matchAgainstStatement,
  nextPageNumber, toTramadaDate,
  mapColumns, rowsByHeader,
  STATEMENT_COLUMNS, TRANSACTION_COLUMNS, TRANSACTION_FALLBACK,
  MINT_COLUMNS, csvGrid, parseMintRows, matchMintAgainstStatement, summariseMint,
  tidyError,
  summarise,
};

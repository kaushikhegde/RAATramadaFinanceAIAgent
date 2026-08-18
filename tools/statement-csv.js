/**
 * statement-csv.js — turn scraped bank-statement rows into the import CSV, and
 * put booking numbers on them.
 *
 *   node statement-csv.js --rows statement-rows.json
 *   node statement-csv.js --rows statement-rows.json --bookings created-bookings.json
 *   node statement-csv.js --rows statement-rows.json --bookings created-bookings.json --limit 6
 *
 * Columns, in this order:
 *
 *   Date, Reference, Rec/Pay Type, Amount, Booking No
 *
 * ── Where the rows come from ─────────────────────────────────────────────
 *
 * `--rows` is a JSON array captured off the reconcile screen. Nothing in this
 * file invents one: CLAUDE.md §3 — no amounts or references that did not come
 * back from a real page. Until the Finance screen is mapped (map-reconcile.js),
 * that file is produced by the capture step, not by this one.
 *
 * Each row is `{ date, reference, recPayType, amount, transType?, payee? }`.
 * Extra keys are ignored; a row with no reference is dropped and counted,
 * because a reference is the only thing that makes a line matchable — the payee
 * is nearly useless as a signal here (CONTEXT.md §4: the Debtor Payment Receipt
 * type has only two payees ever).
 *
 * ── About the booking numbers ────────────────────────────────────────────
 *
 * `--bookings` assigns real Tramada booking numbers across the rows. THEY ARE
 * NOT THE REAL BOOKING FOR EACH RECEIPT — nothing in a bank line says which
 * booking it belongs to; that is the matching problem this file is feeding, not
 * one it solves. Fine for a mockup or an import smoke-test, wrong for measuring
 * a matcher's accuracy. The same warning bit CONTEXT.md §4 already carries, now
 * next to the code that does it.
 *
 * The assignment is SEEDED and therefore repeatable: the same rows and the same
 * booking numbers produce the same CSV every time. An import you can't re-run
 * and get the same file from is one you can't debug.
 */

const fs = require("fs");
const path = require("path");

const COLUMNS = ["Date", "Reference", "Rec/Pay Type", "Amount", "Booking No"];

/* ── the pure parts (exported, and tested offline) ───────────────────────── */

/**
 * One CSV field.
 *
 * Quoted whenever it holds a comma, quote, newline — or a LEADING ZERO or `+`,
 * which Excel eats on the way in. References like `0012` and `+61...` are real,
 * and a reference silently changed by the spreadsheet is worse than one that
 * failed to import: it imports, and matches the wrong thing.
 */
function csvField(v) {
  const s = v == null ? "" : String(v);
  const needsQuote = /[",\n\r]/.test(s) || /^[\s+=@-]/.test(s) || /^0\d/.test(s);
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const out = [COLUMNS.join(",")];
  for (const r of rows) out.push(COLUMNS.map((c) => csvField(r[c])).join(","));
  // Trailing newline: a file without one appends its last row to the first row
  // of whatever it is concatenated with.
  return out.join("\n") + "\n";
}

/** `1,056.93` / `$1,056.93` / `1056.93 CR` → `1056.93`. Anything else → "". */
function normaliseAmount(v) {
  if (v == null || v === "") return "";
  const n = Number(String(v).replace(/[$,\s]/g, "").replace(/\s*(CR|DR)$/i, ""));
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/**
 * Tramada writes `31-07-2026`; the import wants ISO. Left alone when it is
 * already ISO, and returned unchanged when it is neither — a date this doesn't
 * recognise is reported rather than reformatted into a wrong one.
 */
function normaliseDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dMon = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})$/);
  if (dMon) {
    const M = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const i = M.indexOf(dMon[2].toLowerCase());
    if (i >= 0) return `${dMon[3]}-${String(i + 1).padStart(2, "0")}-${dMon[1].padStart(2, "0")}`;
  }
  return s;
}

/**
 * A tiny deterministic PRNG. `Math.random()` would give a different CSV on
 * every run from identical inputs, which makes an import impossible to
 * reproduce or diff.
 */
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spread booking numbers across rows.
 *
 * Every booking is used at least once before any is used twice — with 6 rows
 * and 3 bookings, a plain random pick leaves a booking unreferenced about a
 * fifth of the time, and an import fixture that never mentions one of its
 * bookings tests less than it looks like it does.
 */
function assignBookings(rows, bookingNos, seed = 1, opts = {}) {
  const pool = (bookingNos || []).map(String).filter(Boolean);
  if (!pool.length) return rows.map((r) => ({ ...r, "Booking No": "" }));

  // `inOrder` pairs row 1 with booking 1, row 2 with booking 2, and wraps.
  // Random pairing is fine for a mockup, but it makes the allocation outcome
  // random too — and a run where every row happens to land on a booking whose
  // outstanding doesn't match its amount comes back entirely "Not allocated"
  // and demonstrates nothing. In order, the amounts in bookings.json can be
  // set so the run exercises BOTH paths on purpose.
  const order = opts.inOrder ? pool.slice() : (() => {
    const rand = seeded(seed);
    const s = pool.slice();
    for (let i = s.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [s[i], s[j]] = [s[j], s[i]];
    }
    return s;
  })();

  return rows.map((r, i) => ({
    ...r,
    // Round-robin: whichever order the pool is in, every booking gets used.
    "Booking No": order[i % order.length],
  }));
}

/** Scraped rows → CSV rows. Returns the kept rows plus what was dropped and why. */
function buildRows(raw, { limit = null } = {}) {
  const dropped = [];
  const kept = [];
  for (const [i, r] of (raw || []).entries()) {
    const reference = String(r.reference == null ? "" : r.reference).trim();
    const amount = normaliseAmount(r.amount);
    if (!reference) { dropped.push({ i, why: "no reference" }); continue; }
    if (!amount) { dropped.push({ i, why: `unreadable amount "${r.amount}"` }); continue; }
    kept.push({
      Date: normaliseDate(r.date),
      Reference: reference,
      "Rec/Pay Type": String(r.recPayType || r.type || "").trim(),
      Amount: amount,
      "Booking No": "",
    });
    if (limit && kept.length >= limit) break;
  }
  return { rows: kept, dropped };
}

module.exports = { csvField, toCsv, normaliseAmount, normaliseDate, seeded, assignBookings, buildRows, COLUMNS };

/* ── the command ─────────────────────────────────────────────────────────── */

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

  const rowsPath = valueOf("--rows", null);
  const bookingsPath = valueOf("--bookings", null);
  const outPath = path.resolve(valueOf("--out", path.join(__dirname, "..", "fixtures", "tramada-statement-lines.csv")));
  const limit = valueOf("--limit", null) ? parseInt(valueOf("--limit"), 10) : null;
  const seed = parseInt(valueOf("--seed", "1"), 10);

  const bail = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

  if (!rowsPath) {
    bail(
      "I need the scraped statement rows: --rows statement-rows.json\n\n" +
      "  That file does not exist yet — the Finance → Bank Statement screen has\n" +
      "  never been mapped, so nothing can read it. Run `node map-reconcile.js`\n" +
      "  first; it captures the screen and the scraper gets written from that.\n\n" +
      "  Nothing here will invent rows (CLAUDE.md §3)."
    );
  }

  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.resolve(rowsPath), "utf8")); }
  catch (e) { bail(`Can't read ${rowsPath}: ${e.message}`); }
  if (!Array.isArray(raw)) bail(`${rowsPath} should be a JSON array of rows.`);

  const { rows, dropped } = buildRows(raw, { limit });
  if (!rows.length) bail(`No usable rows in ${rowsPath} (${dropped.length} dropped).`);

  let bookingNos = [];
  if (bookingsPath) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.resolve(bookingsPath), "utf8")); }
    catch (e) { bail(`Can't read ${bookingsPath}: ${e.message}`); }
    bookingNos = (Array.isArray(doc) ? doc : doc.bookings || [])
      .map((b) => (typeof b === "string" ? b : b && b.bookingNo))
      .filter(Boolean);
    if (!bookingNos.length) bail(`${bookingsPath} has no booking numbers in it.`);
  }

  const inOrder = args.includes("--in-order");
  const final = bookingNos.length ? assignBookings(rows, bookingNos, seed, { inOrder }) : rows;
  fs.writeFileSync(outPath, toCsv(final));

  console.log(`\n  ${path.basename(outPath)} — ${final.length} row${final.length === 1 ? "" : "s"}`);
  // Say what was dropped out loud. A silently shortened import file reads as
  // "that's all there was".
  if (dropped.length) {
    console.log(`  Dropped ${dropped.length}: ${[...new Set(dropped.map((d) => d.why))].join("; ")}`);
  }
  if (limit && raw.length > limit) console.log(`  Stopped at --limit ${limit} of ${raw.length} rows.`);
  if (bookingNos.length) {
    console.log(`  Booking numbers assigned from ${path.basename(bookingsPath)}: ${bookingNos.join(", ")}` +
      (inOrder ? " (in order)" : ` (seed ${seed})`));
    console.log("  ⚠ Neither pairing is the real booking behind each receipt — nothing in a bank");
    console.log("    line says which booking it belongs to. Fine for a run-through, wrong for");
    console.log("    measuring a matcher.");
  } else {
    console.log("  Booking No left blank — pass --bookings created-bookings.json to fill it.");
  }
  console.log("");
}

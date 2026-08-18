/**
 * run-bookings.js — create every booking in a JSON file, in one command.
 *
 *   npm run start:chrome              # once, and sign into Tramada in it
 *   node run-bookings.js --dry-run    # say what it would create, touch nothing
 *   node run-bookings.js --limit 1    # just the first one — try the chain small
 *   node run-bookings.js              # create them all
 *
 * Pure Tramada. Each booking gets a header, its flight and hotel segments, and
 * a ticket costing for the flight. No Room-Res, no insurance, no receipt.
 *
 * Everything below drives `runFullBooking` (tramada-segments.js) — the same
 * path the chat uses, so there is one implementation of "make a booking" and
 * not a second one that drifts. `receipt: null` keeps it out of the money.
 *
 * ── The booking numbers ──────────────────────────────────────────────────
 *
 * Written to `created-bookings.json` as they come back, AFTER EACH BOOKING —
 * not at the end. A run that dies on the third booking has still created the
 * first two, and a number that only existed in a dead process's memory is a
 * booking nobody can find again.
 *
 * `statement-csv.js --bookings created-bookings.json` picks that file up.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { runFullBooking } = require("../tramada-segments");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, dflt) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

// --limit runs only the first N of the file. Trying the whole chain end to end
// is worth doing with ONE booking first: the same three outcomes are reachable
// against a single booking's two segments, and a run that goes wrong has left
// one booking behind instead of three.
const LIMIT = valueOf("--limit", null) ? parseInt(valueOf("--limit"), 10) : null;
const IN = path.resolve(valueOf("--file", path.join(__dirname, "..", "fixtures", "bookings.json")));
const OUT = path.resolve(valueOf("--out", path.join(__dirname, "..", "created-bookings.json")));
const DRY = has("--dry-run");

function load() {
  let raw;
  try { raw = fs.readFileSync(IN, "utf8"); }
  catch { die(`Can't read ${IN}. Point me at the file with --file, or copy bookings.json.`); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { die(`${path.basename(IN)} isn't valid JSON: ${e.message}`); }
  const list = Array.isArray(doc) ? doc : doc.bookings;
  if (!Array.isArray(list) || !list.length) die(`${path.basename(IN)} has no "bookings" array.`);
  return LIMIT ? list.slice(0, LIMIT) : list;
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/**
 * Refuse a booking that can't succeed BEFORE opening a browser.
 *
 * Tramada reports a missing client code as a generic validation failure three
 * pages in, by which point a booking header may already exist. Everything
 * checkable from the file is checked here, where the cost of being wrong is a
 * message instead of a half-made booking.
 */
function check(b, i) {
  const where = `booking ${i + 1}${b.label ? ` (${b.label})` : ""}`;
  const bad = [];
  if (!b.clientCode) bad.push("clientCode");
  if (!b.booking) bad.push("booking");
  else {
    for (const f of ["originCode", "destinationCode", "departureDate"]) {
      if (!b.booking[f]) bad.push(`booking.${f}`);
    }
  }
  for (const [n, seg] of (b.segments || []).entries()) {
    if (!seg.kind) bad.push(`segments[${n}].kind`);
    // A hotel with no creditor stops mid-form to ask, which this runner has no
    // way to answer — it is not a conversation. Better to say so up front.
    if (seg.kind === "hotel" && !seg.creditor) bad.push(`segments[${n}].creditor (hotel)`);
    if (seg.kind === "hotel" && !seg.cityCode) bad.push(`segments[${n}].cityCode (hotel)`);
  }
  for (const [n, c] of (b.costings || []).entries()) {
    if (!c.creditor) bad.push(`costings[${n}].creditor`);
  }
  if (bad.length) die(`${where} is missing: ${bad.join(", ")}`);
  return where;
}

function describe(b) {
  const segs = (b.segments || []).map((s) =>
    s.kind === "flight"
      ? `flight ${[s.airline, s.flightNumber].filter(Boolean).join(" ")} ${s.fromCity}→${s.toCity} ${s.departureDate}`
      : s.kind === "hotel"
        ? `hotel "${s.hotelName}" ${s.cityCode} ${s.checkInDate}→${s.checkOutDate} @ ${s.rate}`
        : s.kind
  );
  const costs = (b.costings || []).map((c) => `costing ${c.airline || ""} ${c.fare} via ${c.creditor}`);
  return [`client ${b.clientCode}`, ...segs, ...costs];
}

(async () => {
  const list = load();
  list.forEach(check);

  console.log(`\n  ${list.length} booking${list.length === 1 ? "" : "s"} from ${path.basename(IN)}` +
    (LIMIT ? `  (--limit ${LIMIT})` : "") + (DRY ? "  (dry run — nothing will be created)" : "") + "\n");
  list.forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.label || b.clientCode}`);
    for (const line of describe(b)) console.log(`       ${line}`);
  });
  console.log("");

  if (DRY) {
    console.log("  Dry run — Tramada was never opened. Drop --dry-run to create these.\n");
    return;
  }

  const auth = { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD };
  const created = [];

  for (const [i, b] of list.entries()) {
    const tag = `[${i + 1}/${list.length}] ${b.label || b.clientCode}`;
    console.log(`  ${tag}`);
    try {
      const res = await runFullBooking({
        ...auth,
        clientCode: b.clientCode,
        booking: b.booking,
        segments: b.segments || [],
        costings: b.costings || [],
        // No receipt from this runner, ever. Creating bookings and taking money
        // are different decisions and this one is not authorised to make the
        // second. dryRunReceipt stays true so nothing can commit even if a
        // receipt is put in the file by mistake.
        receipt: null,
        dryRunReceipt: true,
        callbacks: {
          onProgress: (p, m) => console.log(`       [${String(p).padStart(3)}%] ${m}`),
          onStage: (name, d) => {
            if (name === "booking" && d && d.bookingNo) console.log(`       → booking ${d.bookingNo}`);
          },
          onError: (m) => console.error(`       ERROR: ${m}`),
          onNeedLogin: () =>
            console.log("       Sign into Tramada in the Chrome on port 9222 — I'll wait, and I never type credentials."),
        },
      });

      if (!res || !res.bookingNo) throw new Error("finished without returning a booking number");
      created.push({
        bookingNo: String(res.bookingNo),
        label: b.label || null,
        clientCode: b.clientCode,
        segments: (res.segments || []).length || (b.segments || []).length,
        costings: (res.costings || []).length || (b.costings || []).length,
      });
      // Written after EVERY booking: a crash on the next one must not lose this
      // one's number.
      fs.writeFileSync(OUT, JSON.stringify(created, null, 2));
      console.log(`       ✓ booking ${res.bookingNo}\n`);
    } catch (err) {
      // A question only a human can answer (creditor, city) reaches here as a
      // needs* error. This runner cannot ask, so it says which booking stopped
      // and on what, and leaves the rest of the file alone.
      const needs =
        (err && err.needsCreditor && `creditor for "${err.needsCreditor.supplierName || "a supplier"}"`) ||
        (err && err.needsCity && `city code (tried ${(err.needsCity.tried || []).join(", ") || "everything"})`) ||
        null;
      console.error(`       ✗ stopped: ${err.message}`);
      if (needs) console.error(`         It needs a ${needs}. Put it in ${path.basename(IN)} and re-run.`);
      console.error(`         ${created.length} booking(s) created so far are in ${path.basename(OUT)}.\n`);
      if (created.length) fs.writeFileSync(OUT, JSON.stringify(created, null, 2));
      process.exit(1);
    }
  }

  console.log(`  ✅ ${created.length} booking${created.length === 1 ? "" : "s"}: ${created.map((c) => c.bookingNo).join(", ")}`);
  console.log(`     Written to ${path.basename(OUT)}.`);
  console.log(`     Next: node statement-csv.js --bookings ${path.basename(OUT)}\n`);
})().catch((e) => {
  console.error("\n  Failed:", e.message, "\n");
  process.exit(1);
});

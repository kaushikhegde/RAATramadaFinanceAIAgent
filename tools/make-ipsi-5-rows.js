/**
 * make-ipsi-5-rows.js — 5 real bookings + costings matching the rows of
 * csv_uploads/IPSI_sample_10rows_FILTERED.csv (the 5 that survive filtering).
 *
 * Bookings + costings only, NO receipts — IPSI settlements cover Credit Card
 * Swipe receipts, and Tramada's swipe form wants a real card number. This
 * project never touches card data (CLAUDE.md §4). Raising the swipe receipts
 * (and refunds) against these bookings is yours to do by hand, exactly as
 * make-fixtures.js's own "ipsi" mode already expects.
 *
 * Run: node tools/make-ipsi-5-rows.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("../recon-core");
const { runFullBooking } = require("../tramada-segments");

const say = (m) => console.log(`  ${m}`);
const CHECKPOINT = path.join(__dirname, "created-bookings-ipsi-5.json");

const callbacks = {
  onProgress: (p, m) => console.log(`       [${String(p).padStart(3)}%] ${m}`),
  onError: (m) => console.error(`       ERROR: ${m}`),
  onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222 — waiting."),
};

// Already-completed rows from a previous attempt, keyed by row index (1-based).
const ALREADY_DONE = {};

// Matches csv_uploads/IPSI_sample_10rows_FILTERED.csv, amount as absolute
// value (a costing is just a positive amount owed; purchase vs refund only
// matters once a human raises the actual swipe receipt/refund by hand).
const ROWS = [
  { row: 1, txnRef: "1792412290cXt4Z", type: "Purchase", fare: "1289.00",
    route: { originCode: "MEL", destinationCode: "SYD", departureDate: "2026-11-10", returnDate: "2026-11-13" },
    flight: { airline: "QF", flightNumber: "401" } },
  { row: 2, txnRef: "1792414402eZv8B", type: "Purchase", fare: "245.90",
    route: { originCode: "SYD", destinationCode: "BNE", departureDate: "2026-11-14", returnDate: "2026-11-17" },
    flight: { airline: "VA", flightNumber: "820" } },
  { row: 3, txnRef: "1792415588fAw1C", type: "Refund", fare: "890.00",
    route: { originCode: "BNE", destinationCode: "CNS", departureDate: "2026-11-18", returnDate: "2026-11-21" },
    flight: { airline: "QF", flightNumber: "947" } },
  { row: 4, txnRef: "1792416730gBx3D", type: "Refund", fare: "65.40",
    route: { originCode: "MEL", destinationCode: "OOL", departureDate: "2026-11-22", returnDate: "2026-11-25" },
    flight: { airline: "QF", flightNumber: "735" } },
  { row: 5, txnRef: "1792420418jEa9G", type: "Purchase", fare: "79.50",
    route: { originCode: "SYD", destinationCode: "PER", departureDate: "2026-11-26", returnDate: "2026-11-29" },
    flight: { airline: "QF", flightNumber: "775" } },
];

function buildBooking(r) {
  return {
    clientCode: "GRAY/SPIDER",
    booking: { ...r.route, adults: 1, passengers: [{ firstName: "Spider", lastName: "Gray", type: "adult" }] },
    segments: [{
      kind: "flight", airline: r.flight.airline, flightNumber: r.flight.flightNumber, class: "Economy",
      fromCity: r.route.originCode, toCity: r.route.destinationCode,
      departureDate: r.route.departureDate, departureTime: "09:00",
      arrivalDate: r.route.departureDate, arrivalTime: "11:00", status: "HK",
    }],
    costings: [{ creditor: "READY ROOMS", airline: r.flight.airline, class: "Economy", fare: r.fare, passengerType: "Adult", fareType: "Published" }],
  };
}

async function main() {
  const made = { ...ALREADY_DONE };

  for (const r of ROWS) {
    if (made[r.row] && made[r.row].bookingNo) {
      say(`row ${r.row} (${r.type} $${r.fare}) already done — booking ${made[r.row].bookingNo}`);
      continue;
    }
    const b = buildBooking(r);
    say(`\n[row ${r.row}] ${r.type} $${r.fare} — ref ${r.txnRef}`);
    const state = made[r.row] || {};

    try {
      const res = await runFullBooking({
        clientCode: b.clientCode, booking: b.booking, segments: b.segments, costings: b.costings,
        existingBookingNo: state.bookingNo || null,
        receipt: null, dryRunReceipt: true, callbacks,
      });
      if (!res || !res.bookingNo) throw new Error("finished without returning a booking number");
      state.bookingNo = String(res.bookingNo);
      made[r.row] = state;
      fs.writeFileSync(CHECKPOINT, JSON.stringify(made, null, 2));
      say(`     ✓ booking ${state.bookingNo}`);
    } catch (err) {
      console.error(`     ✗ stopped on row ${r.row}: ${core.tidyError ? core.tidyError(err.message) : err.message}`);
      made[r.row] = state;
      fs.writeFileSync(CHECKPOINT, JSON.stringify(made, null, 2));
      break;
    }
  }

  say("\nSummary:");
  for (const r of ROWS) {
    const s = made[r.row] || {};
    say(`  row ${r.row}  booking ${s.bookingNo || "NOT CREATED"}  $${r.fare}  ${r.type}  ref ${r.txnRef}`);
  }
  say("\nNext step (by hand, in Tramada): raise a Credit Card Swipe receipt");
  say("(or refund) against each booking above for the amount shown, under");
  say("Debtor MASTER — then this file can actually be reconciled.\n");
}

main().catch((e) => { console.error("\nFailed:", e.message); process.exit(1); });

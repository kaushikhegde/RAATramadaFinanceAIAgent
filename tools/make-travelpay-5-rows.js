/**
 * make-travelpay-5-rows.js — 5 real bookings matching the rows of the user's
 * TRAVELPAY_sample_traceable.xlsx (creditor + fare only; the sample's own
 * booking numbers, 132458 etc., don't exist in this sandbox and can't be
 * chosen — Tramada assigns booking numbers itself).
 *
 * Same pipeline make-fixtures.js travelpay uses: booking -> costing ->
 * Client Payment Receipt -> creditor payment. Client is GRAY/SPIDER (the
 * established retail-account client for TravelPay fixtures — see
 * CLIENT_FOR.travelpay in make-fixtures.js), so it's fine that the sample
 * file names a different client per row.
 *
 * Run: node tools/make-travelpay-5-rows.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("../recon-core");
const { runFullBooking } = require("../tramada-segments");
const { runTramadaReceipt } = require("../tramada-receipt");
const { runCreditorPayment } = require("../tramada-payment");

const say = (m) => console.log(`  ${m}`);
const CHECKPOINT = path.join(__dirname, "created-bookings-travelpay-5.json");
const OUT_CSV = path.join(__dirname, "..", "csv_uploads", "travelpay-5-sample.csv");

const RUN = require("crypto").randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, "0").slice(-5);
const ref = (kind, bookingNo) => `${kind}-${RUN}-${bookingNo}`;

const callbacks = {
  onProgress: (p, m) => console.log(`       [${String(p).padStart(3)}%] ${m}`),
  onError: (m) => console.error(`       ERROR: ${m}`),
  onNeedLogin: () => say("     Sign into Tramada in the Chrome on port 9222 — waiting."),
};

// Already-completed rows from a previous attempt, keyed by row index (1-based).
// { row: { bookingNo, receiptNo, paymentNo } }
// Row 1's booking (14030) was created before the creditor-name fix; it has no
// costing yet (that's what failed) — resume it rather than create a duplicate.
const ALREADY_DONE = {
  1: { bookingNo: "14030", receiptNo: "R.0000009514", paymentNo: "P.0000004171" },
  2: { bookingNo: "14033", receiptNo: "R.0000009515", paymentNo: "P.0000004172" },
  3: { bookingNo: "14036", receiptNo: "R.0000009516", paymentNo: "P.0000004173" },
  // Confirmed via tools/diag-payments.js (booking-payments.htm) after the
  // Issue-click timeout: the payment DID go through, to the deprecated
  // creditor, with no refusal at any step.
  4: { bookingNo: "14039", receiptNo: "R.0000009517", paymentNo: "P.0000004174" },
};

// Real Tramada creditor names, not the sample file's merchant names — the two
// don't match directly (see csv_uploads/Supplier Cheat Sheet UPDATED.xlsx),
// and each was verified live via tools/diag-creditor.js to resolve to exactly
// one creditor before this list was written:
//   "Great Southern Rail Travel Pty Ltd" -> "Great Southern" (GREATSOUT, GREAT SOUTHERN RAILWAY)
//   "RCL CRUISES LTD"                    -> "Royal Caribbean" (ROYAL, ROYAL CARIBBEAN INTERNATIONAL)
//   "Viva Holidays"                      -> "Viva" (VIVA, real name has a double space: "Viva  Holidays")
//   "Contiki"                            -> "Busabout" (BUSABOUT, BUSABOUT AUSTRALIA)
//   "Trafalgar Tours"                    -> "Trafalgar" (TRAFALGA, TRAFALGAR TOURS - DO NOT USE —
//                                          the only match Tramada has right now; used deliberately,
//                                          per instruction, as-is)
const ROWS = [
  { row: 1, creditor: "Great Southern", fare: "4125.00",
    route: { originCode: "MEL", destinationCode: "SYD", departureDate: "2026-10-10", returnDate: "2026-10-13" },
    flight: { airline: "QF", flightNumber: "401" } },
  { row: 2, creditor: "Royal Caribbean", fare: "1980.00",
    route: { originCode: "SYD", destinationCode: "BNE", departureDate: "2026-10-14", returnDate: "2026-10-17" },
    flight: { airline: "VA", flightNumber: "820" } },
  // ADL as origin failed 3 times on the flight-segment form (twice on the
  // #departureCityCode autocomplete itself) against booking 14036 — the
  // route is arbitrary for TravelPay (only creditor + fare matter), so
  // sidestepping the flaky city rather than fighting it again.
  { row: 3, creditor: "Viva", fare: "712.50",
    route: { originCode: "SYD", destinationCode: "PER", departureDate: "2026-10-18", returnDate: "2026-10-21" },
    flight: { airline: "QF", flightNumber: "775" } },
  { row: 4, creditor: "Trafalgar", fare: "3299.90",
    route: { originCode: "BNE", destinationCode: "CNS", departureDate: "2026-10-22", returnDate: "2026-10-25" },
    flight: { airline: "VA", flightNumber: "1290" } },
  { row: 5, creditor: "Busabout", fare: "1450.00",
    route: { originCode: "MEL", destinationCode: "OOL", departureDate: "2026-10-26", returnDate: "2026-10-29" },
    flight: { airline: "QF", flightNumber: "735" } },
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
    costings: [{ creditor: r.creditor, airline: r.flight.airline, class: "Economy", fare: r.fare, passengerType: "Adult", fareType: "Published" }],
  };
}

async function main() {
  const made = { ...ALREADY_DONE };
  const today = new Date().toISOString().slice(0, 10);

  for (const r of ROWS) {
    if (made[r.row] && made[r.row].paymentNo) {
      say(`row ${r.row} (${r.creditor}) already done — booking ${made[r.row].bookingNo}, payment ${made[r.row].paymentNo}`);
      continue;
    }
    const b = buildBooking(r);
    say(`\n[row ${r.row}] ${r.creditor} — $${r.fare}`);
    const state = made[r.row] || {};

    try {
      // Always run this (not just when state.bookingNo is unset) — a resumed
      // booking may have its header saved but be missing its costing, which
      // is exactly what happened to row 1 first time round. With
      // existingBookingNo set, runFullBooking skips whatever segments/
      // costings already exist and adds only what's missing; it is not safe
      // to assume "has a booking number" means "fully costed".
      if (!state.receiptNo) {
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
      }

      if (!state.receiptNo) {
        const receipted = await runTramadaReceipt({
          bookingNo: state.bookingNo,
          receipt: {
            transactionType: "EFT", amount: r.fare, reference: ref("TP", state.bookingNo),
            dateReceived: today, allocation: "ALL",
          },
          receiptCategory: "CLIENT_PAYMENT_RECEIPT",
          dryRun: false, callbacks,
        });
        const receiptNo = receipted && receipted.receipt && receipted.receipt.receiptNo;
        if (!receiptNo) throw new Error("no receipt number came back");
        state.receiptNo = receiptNo;
        made[r.row] = state;
        fs.writeFileSync(CHECKPOINT, JSON.stringify(made, null, 2));
        say(`     ✓ receipt ${receiptNo}`);
      }

      if (!state.paymentNo) {
        const paid = await runCreditorPayment({
          bookingNo: state.bookingNo,
          creditor: r.creditor,
          payment: {
            transactionType: "EFT", amount: "AUTO", reference: ref("TP", state.bookingNo),
            paymentDate: today, allocation: "ALL",
          },
          callbacks,
        });
        const paymentNo = paid && paid.payment && paid.payment.paymentNo;
        if (!paymentNo) throw new Error("no payment number came back");
        state.paymentNo = paymentNo;
        made[r.row] = state;
        fs.writeFileSync(CHECKPOINT, JSON.stringify(made, null, 2));
        say(`     ✓ paid ${r.creditor} → ${paymentNo}`);
      }
    } catch (err) {
      console.error(`     ✗ stopped on row ${r.row}: ${core.tidyError ? core.tidyError(err.message) : err.message}`);
      made[r.row] = state;
      fs.writeFileSync(CHECKPOINT, JSON.stringify(made, null, 2));
      break;
    }
  }

  say("\nSummary:");
  const csvRows = [];
  for (const r of ROWS) {
    const s = made[r.row] || {};
    say(`  row ${r.row}  booking ${s.bookingNo || "NOT CREATED"}  receipt ${s.receiptNo || "-"}  payment ${s.paymentNo || "-"}  $${r.fare}  ${r.creditor}`);
    if (s.bookingNo) {
      csvRows.push({
        "Processing Date": today, "Merchant Settlement Date": today,
        MerchantCompanyName: r.creditor, "Base Amount": r.fare, "Customer Fee": "0", "Processed Amount": r.fare,
        "Payment Method": "BankAccount", "Transaction Status": "Successful",
        "Payment Reference": s.paymentNo || "", "Processor Reference": s.receiptNo || "",
        "Failure Reason": "", "Additional Reference": `Client Name - ${s.bookingNo}`,
      });
    }
  }
  if (csvRows.length) {
    const cols = Object.keys(csvRows[0]);
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
    fs.writeFileSync(OUT_CSV, [cols.join(","), ...csvRows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n");
    say(`\nWritten: ${path.relative(process.cwd(), OUT_CSV)}`);
  }
}

main().catch((e) => { console.error("\nFailed:", e.message); process.exit(1); });

#!/usr/bin/env node
"use strict";

/**
 * Four Tokio files built from the policies REALLY on Tramada's grid.
 *
 * tools/make-fixtures.js invents policy numbers, which is right for testing
 * steps 1-8 — they are pure file work and the numbers are arbitrary. It is
 * useless for steps 12-13, where the whole point is matching against what
 * Tramada actually holds: an invented policy can only ever come back "not
 * found in Tramada", which is a real answer to the wrong question.
 *
 * So this writes the same four files against segments measured off the live
 * Issue Payments grid for [TOKIOMARINE] Tokio Marine, 24-Sep-2026.
 *
 * SELL PRICE IS DERIVED FROM THE NETT, not typed. Tramada shows Creditor
 * Payable; the consolidated sheet computes nett as 70% of sell (BR03). So
 * sell = payable / 0.7, and the pipeline's own arithmetic lands back on the
 * figure Tramada is showing. Typing both invites them to disagree.
 *
 *   node tools/make-tokio-live-fixture.js
 */

const fs = require("fs");
const path = require("path");

/* Measured from the live grid. `payable` is the Creditor Payable column —
   what Tramada says is outstanding, and what BR13 matches against. */
const LIVE = [
  { policy: "220044",   booking: "13817", payable: 175.0,  kind: "travel" },
  { policy: "2203224",  booking: "14267", payable: 131.22, kind: "travel" },
  { policy: "20018654", booking: "128",   payable: 438.32, kind: "travel" },
  /* One of each of the other outcomes, so steps 7-8 still have something to
     do and the card does not look like a list of green ticks. */
  { policy: "2200128",  booking: "306",   payable: 312.06, kind: "retail" },
  { policy: "20046798", booking: "313",   payable: 302.01, kind: "br07" },
];

const OUT = path.join(__dirname, "..", "csv_uploads");
const dmy = (d) => `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
const money = (n) => n.toFixed(2);
const csv = (rows) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
};

/* The month the segments sit in. The grid's Issue/Conf. dates were Sep-2026,
   and deriveReportingMonth reads these columns, so they decide the session
   label the run will use. */
const monthStart = new Date(2026, 8, 1);
const monthEnd = new Date(2026, 8, 30);

const b2b = [];
const payment = [];
const costing = [];
const rcc = [];

for (const s of LIVE) {
  const sell = s.payable / 0.7;            // BR03 in reverse — see above
  const nett = money(s.payable);
  const travelBranch = s.kind !== "retail";

  b2b.push({
    xPolicyNo: s.policy,
    xTRVIssuedDate: dmy(monthStart),
    xUWETransDate: dmy(monthStart),
    xBranch: travelBranch ? "RAA Elizabeth Travel" : "RAA Elizabeth",
    xOriginatingAgent: "BC",
    xSalesAgent: "BC",
    xProductName: "Travel Insurance",
    xSellPriceIncGST: money(sell),
    // Tokio's own figures. BR03 says they are IGNORED, so they are
    // deliberately wrong — a run that reads them instead of computing 30/70
    // fails visibly rather than agreeing by accident.
    xNetPriceIncGST: money(sell * 0.65),
    xCommissionIncGST: money(sell * 0.35),
    xStartDate: dmy(monthStart),
    xEndDate: dmy(monthEnd),
    xStatus: "Issued",
  });

  // In Tramada's own reports unless the row is meant to be Retail-only.
  if (s.kind !== "retail") {
    payment.push({
      "Booking No.": s.booking,
      Reference: s.policy,
      Creditor: "Tokio Marine",
      Amount: nett,
      "Segment Created Date": dmy(monthStart),
    });
    costing.push({
      "Booking No.": s.booking,
      "Segment Reference": s.policy,
      Creditor: "Tokio Marine",
      Cost: nett,
      Invoiced: "Yes",
    });
  }
  // Receipted through Retail — the Retail row, and the BR07 clash.
  if (s.kind === "retail" || s.kind === "br07") {
    rcc.push({
      "Ticket/Booking No.": s.policy,
      "Policy Number": s.policy,
      "Receipted By": "Retail",
      Amount: nett,
    });
  }
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ["tokio-b2b-report.csv", b2b],
  ["tokio-tramada-payment-report.csv", payment],
  ["tokio-tramada-costing-report.csv", costing],
  ["tokio-rcc-report.csv", rcc],
];
for (const [name, rows] of files) {
  fs.writeFileSync(path.join(OUT, name), csv(rows));
  console.log(`  ${name.padEnd(36)} ${rows.length} row(s)`);
}

const travel = LIVE.filter((s) => s.kind === "travel");
console.log(`\n  Built from the LIVE grid. Expect from steps 7-8:`);
console.log(`    ${travel.length} Travel, 1 Retail excluded, 1 exception.`);
console.log(`  Steps 12-13 should tick these against Tokio Marine:`);
for (const s of travel) console.log(`    ${s.policy.padEnd(10)} $${money(s.payable)}  (booking ${s.booking})`);
console.log("");

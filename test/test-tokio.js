"use strict";

/**
 * Tokio Marine, against the numbers in RAA's own example workbooks.
 *
 * Where a figure appears below it was read off the supplied files, not made up:
 * policy 21085663, sell 218.93, commission 65.679, nett 153.251 is the first
 * data row of the AFTER template.
 */

const assert = require("assert");
const t = require("../tokio-core");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

/* ------------------------------------------------------- the policy key */

check("a bare 210-series policy number is taken as-is", () => {
  assert.strictEqual(t.policyKey("21085663"), "21085663");
  assert.strictEqual(t.policyKey(21085663), "21085663");
  assert.strictEqual(t.policyKey("  21085663 "), "21085663");
});

check("the policy is dug out of a Tramada reference", () => {
  // The real shape, read off Tramada Payment Report!C.
  assert.strictEqual(t.policyKey("21087245 - 21087245 - ALTUS/ELIZABETH MRS, ALT"), "21087245");
});

check("it does NOT repeat the template's MID(FIND(\"2\")) bug", () => {
  // The example helper takes the first "2" anywhere and then 8 characters. On
  // a reference that opens with another number containing a 2, that returns
  // eight wrong digits and says nothing — the row then reconciles against a
  // different policy.
  const ref = "INV-2024/77 - 21087245 - ALTUS/ELIZABETH MRS";
  assert.strictEqual(t.policyKey(ref), "21087245");
});

check("a reference with no 210-series number is null, not a guess", () => {
  assert.strictEqual(t.policyKey("BOOKING 74585 - ALTUS/ELIZABETH"), null);
  assert.strictEqual(t.policyKey(""), null);
  assert.strictEqual(t.policyKey(null), null);
});

check("a nine-digit number is not mistaken for a policy", () => {
  assert.strictEqual(t.policyKey("210856631"), null);
});

check("RAAQ quote numbers are recognised and never become policies", () => {
  // RCC!D really carries these — the guide says a consultant never replaced
  // the quote number after payment.
  assert.ok(t.isQuoteNumber("RAAQ-846157711"));
  assert.strictEqual(t.policyKey("RAAQ-846157711"), null);
  assert.ok(!t.isQuoteNumber("21085681"));
});

/* --------------------------------------------------------------- BR03 */

check("commission is 30% and nett is the rest, unrounded", () => {
  // AFTER template, first data row.
  const r = t.calcCommission(218.93);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.commission - 65.679) < 1e-9, "commission " + r.commission);
  assert.ok(Math.abs(r.totalNett - 153.251) < 1e-9, "nett " + r.totalNett);
});

check("commission + nett is exactly the sell price", () => {
  for (const sell of [218.93, 207.51, 1824.53, 833.55, 264.29, 313.21]) {
    const r = t.calcCommission(sell);
    assert.ok(Math.abs(r.commission + r.totalNett - sell) < 1e-9, "split lost money on " + sell);
  }
});

check("Tokio's own net column is not used", () => {
  // Row 1 of the example: xNetPrice is 152.18, RAA Total Nett is 153.251.
  // If anyone wires the calculation to xNetPrice this fails.
  const r = t.calcCommission(218.93);
  assert.notStrictEqual(Number(r.totalNett.toFixed(2)), 152.18);
  assert.strictEqual(Number(r.totalNett.toFixed(3)), 153.251);
});

check("a non-numeric sell price is refused, not treated as zero", () => {
  const r = t.calcCommission("");
  assert.ok(!r.ok);
  assert.ok(/not a number/i.test(r.reason), r.reason);
});

/* ------------------------------------------------- steps 7 and 8 in full */

const cls = (branch, inRcc, inPayment, inCosting) =>
  t.classify({ branch, inRcc, inPayment, inCosting });

check("not Travel + in RCC + not in Tramada -> Retail, removed", () => {
  assert.strictEqual(cls("Elizabeth", true, false, false).outcome, t.OUTCOME.RETAIL);
});

check("not Travel + in RCC + in Tramada -> exception", () => {
  assert.strictEqual(cls("Elizabeth", true, true, false).outcome, t.OUTCOME.EXCEPTION);
  assert.strictEqual(cls("Elizabeth", true, false, true).outcome, t.OUTCOME.EXCEPTION);
});

check("Travel + in RCC + in Tramada -> exception", () => {
  assert.strictEqual(cls("Elizabeth Travel", true, true, false).outcome, t.OUTCOME.EXCEPTION);
});

check("Travel + not in RCC + in Tramada -> Travel, reconciled", () => {
  assert.strictEqual(cls("Elizabeth Travel", false, true, false).outcome, t.OUTCOME.TRAVEL);
  assert.strictEqual(cls("Elizabeth Travel", false, false, true).outcome, t.OUTCOME.TRAVEL);
  assert.strictEqual(cls("Elizabeth Travel", false, true, true).outcome, t.OUTCOME.TRAVEL);
});

check("Travel + not in RCC + not in Tramada -> exception", () => {
  assert.strictEqual(cls("Elizabeth Travel", false, false, false).outcome, t.OUTCOME.EXCEPTION);
});

check("a Travel transaction is NEVER removed as Retail", () => {
  // The costly direction: dropping a Travel line means RAA never gets paid.
  for (const rcc of [true, false]) {
    for (const pay of [true, false]) {
      for (const cost of [true, false]) {
        assert.notStrictEqual(
          cls("West Croydon Travel", rcc, pay, cost).outcome,
          t.OUTCOME.RETAIL,
          `Travel branch removed as Retail for rcc=${rcc} pay=${pay} cost=${cost}`
        );
      }
    }
  }
});

check("the branch test is case-insensitive and matches inside the name", () => {
  assert.strictEqual(cls("PORT LINCOLN TRAVEL", false, true, false).outcome, t.OUTCOME.TRAVEL);
  assert.strictEqual(cls("travel adelaide", false, true, false).outcome, t.OUTCOME.TRAVEL);
});

// The 17-Sep revision's BR07 has no condition on Tramada: a Travel branch
// found in RCC is an exception whether or not Tramada also has it. That closed
// one of the two combinations this module used to flag as uncovered.
check("BR07 — a Travel branch found in RCC is an exception either way", () => {
  for (const inTramada of [true, false]) {
    const r = cls("Elizabeth Travel", true, inTramada, false);
    assert.strictEqual(r.outcome, t.OUTCOME.EXCEPTION, `inTramada=${inTramada}`);
    assert.ok(/BR07/.test(r.remark), r.remark);
    assert.ok(/also found in RCC/i.test(r.remark), r.remark);
    assert.ok(!r.undocumented, "BR07 now covers this — it must not be flagged as uncovered");
  }
});

check("the one combination the guide still does not cover is flagged, not guessed", () => {
  // Branch is not Travel and the policy is in neither RCC nor Tramada. The
  // guide says nothing about it, so neither does this.
  const r = cls("Elizabeth", false, true, false);
  assert.strictEqual(r.outcome, t.OUTCOME.EXCEPTION);
  assert.strictEqual(r.undocumented, true, "not marked as undocumented: " + r.remark);
  assert.ok(/does not cover/i.test(r.remark), r.remark);
});

check("every exception carries the words the guide asks for", () => {
  for (const r of [
    cls("Elizabeth", true, true, false),
    cls("Elizabeth Travel", true, true, false),
    cls("Elizabeth Travel", false, false, false),
  ]) {
    assert.ok(/Please check/.test(r.remark), r.remark);
  }
});

/* --------------------------------------------------- the consolidated sheet */

const B2B = [
  { xPolicyNo: 21085663, xSellPriceIncGST: 218.93, xBranch: "Elizabeth Travel" },
  { xPolicyNo: 21084734, xSellPriceIncGST: 264.29, xBranch: "Port Lincoln Travel" },
  { xPolicyNo: 21085668, xSellPriceIncGST: 313.21, xBranch: "Elizabeth" },
  { xPolicyNo: "", xSellPriceIncGST: 100.0, xBranch: "Adelaide Travel" },
];

const sources = () => ({
  payment: t.indexByPolicy(
    [{ Reference: "21084734 - 21084734 - SMITH/JOHN MR" }],
    (r) => r.Reference
  ),
  costing: t.indexByPolicy([], (r) => r["Segment Reference"]),
  rcc: t.indexByPolicy(
    [{ "Ticket/Booking No.": 21085668 }, { "Ticket/Booking No.": "RAAQ-846157711" }],
    (r) => r["Ticket/Booking No."]
  ),
});

check("the appended columns are the six the guide names, in order", () => {
  assert.deepStrictEqual(t.APPENDED_COLUMNS, [
    "RAA Commission", "RAA Total Nett",
    "Tramada Payment Report", "Tramada Costing Report", "RCC Report",
    "Remarks",
  ]);
});

check("the B2B row itself is never altered", () => {
  const before = JSON.stringify(B2B);
  t.buildConsolidated(B2B, sources());
  assert.strictEqual(JSON.stringify(B2B), before, "the source rows were mutated");
});

check("a missing lookup is written as N/A, not blank", () => {
  const { rows } = t.buildConsolidated(B2B, sources());
  assert.strictEqual(rows[0].appended["Tramada Payment Report"], "N/A");
  assert.strictEqual(rows[0].appended["Tramada Costing Report"], "N/A");
  assert.strictEqual(rows[0].appended["RCC Report"], "N/A");
});

check("a hit writes the policy number", () => {
  const { rows } = t.buildConsolidated(B2B, sources());
  assert.strictEqual(rows[1].appended["Tramada Payment Report"], "21084734");
  assert.strictEqual(rows[2].appended["RCC Report"], "21085668");
});

check("the three buckets add up to every row", () => {
  const c = t.buildConsolidated(B2B, sources());
  assert.strictEqual(c.travel.length + c.retail.length + c.exceptions.length, c.rows.length);
  assert.strictEqual(c.rows.length, B2B.length);
});

check("the example rows land where steps 7 and 8 say", () => {
  const c = t.buildConsolidated(B2B, sources());
  assert.strictEqual(c.rows[0].outcome, t.OUTCOME.EXCEPTION, "Travel, nowhere in Tramada");
  assert.strictEqual(c.rows[1].outcome, t.OUTCOME.TRAVEL, "Travel, in Payment");
  assert.strictEqual(c.rows[2].outcome, t.OUTCOME.RETAIL, "not Travel, in RCC only");
});

check("a row with no readable policy number is an exception with a reason", () => {
  const c = t.buildConsolidated(B2B, sources());
  const bad = c.rows[3];
  assert.strictEqual(bad.outcome, t.OUTCOME.EXCEPTION);
  assert.ok(/could not be read/i.test(bad.appended.Remarks), bad.appended.Remarks);
});

check("a quote number in RCC does not index as a policy", () => {
  const s = sources();
  assert.strictEqual(s.rcc.byPolicy.has("846157711"), false);
  assert.strictEqual(s.rcc.unreadable.length, 1);
  assert.strictEqual(s.rcc.unreadable[0].quote, true);
});

/* ------------------------------------------------- step 12-13, the matching */

check("an exact amount matches", () => {
  const r = t.matchTramadaLine([{ amount: 153.25 }], 153.25);
  assert.ok(r.ok);
});

check("±1% is accepted, just outside is not", () => {
  // 1% of 153.25 is 1.5325.
  assert.ok(t.matchTramadaLine([{ amount: 154.78 }], 153.25).ok, "1.53 over was rejected");
  assert.ok(!t.matchTramadaLine([{ amount: 154.79 }], 153.25).ok, "1.54 over was accepted");
  assert.ok(t.matchTramadaLine([{ amount: 151.72 }], 153.25).ok, "1.53 under was rejected");
});

check("the tolerance scales with the amount, it is not flat", () => {
  // 1% of 1277.17 is 12.77 — a difference that must fail on a small policy.
  assert.ok(t.matchTramadaLine([{ amount: 1287 }], 1277.17).ok);
  assert.ok(!t.matchTramadaLine([{ amount: 163 }], 153.25).ok);
});

check("BR12 — the line matching the AMOUNT wins, not the first line", () => {
  const candidates = [{ id: "extension", amount: 999.0 }, { id: "original", amount: 153.25 }];
  const r = t.matchTramadaLine(candidates, 153.25);
  assert.ok(r.ok);
  assert.strictEqual(r.line.id, "original", "it took the first line rather than the matching one");
});

check("nothing found says so, in the guide's words", () => {
  const r = t.matchTramadaLine([], 153.25);
  assert.ok(!r.ok);
  assert.strictEqual(r.remark, "Policy number not found in Tramada");
});

check("found but out of tolerance says the amount, not the policy", () => {
  const r = t.matchTramadaLine([{ amount: 900 }], 153.25);
  assert.ok(!r.ok);
  assert.strictEqual(r.remark, "Amount does not match in Tramada");
  assert.ok(r.closest, "it did not report the closest line for a human");
});

/* --------------------------------------------------- steps 11 and 14 labels */

check("the payment reference is TOKIO_MMM YYYY", () => {
  assert.strictEqual(t.paymentReference(new Date("2026-07-15")), "TOKIO_JUL 2026");
  assert.strictEqual(t.paymentReference(new Date("2026-12-01")), "TOKIO_DEC 2026");
});

check("the session label is TOKIO_MMM YY — two digits, not four", () => {
  assert.strictEqual(t.sessionLabel(new Date("2026-07-15")), "TOKIO_JUL 26");
  assert.ok(!/2026/.test(t.sessionLabel(new Date("2026-07-15"))));
});

check("a bad date throws rather than labelling a session NaN", () => {
  assert.throws(() => t.paymentReference("not a date"));
  assert.throws(() => t.sessionLabel("not a date"));
});



/* ------------------------------------------ the reporting month, derived */

const mrows = (...dates) => dates.map((d) => ({ xTRVIssuedDate: d }));

check("dates are read in Australian order, never mm/dd", () => {
  // 07/08/2026 is 7 August here. Reading it as 8 July puts the whole report in
  // the wrong month, and the report IS the month.
  const d = t.asDate("07/08/2026");
  assert.strictEqual(d.getMonth(), 7, "month was " + (d.getMonth() + 1));
  assert.strictEqual(d.getDate(), 7);
});

check("ISO, Date objects and Excel serials all read", () => {
  assert.strictEqual(t.asDate("2026-07-01 09:40:50").getMonth(), 6);
  assert.strictEqual(t.asDate(new Date(2026, 6, 1)).getMonth(), 6);
  // 46204 = 1 July 2026 as an Excel serial.
  const x = t.asDate(46204);
  assert.strictEqual(x.getUTCFullYear(), 2026);
  assert.strictEqual(x.getUTCMonth(), 6);
});

check("a small number is not mistaken for a date", () => {
  assert.strictEqual(t.asDate(218.93), null);
  assert.strictEqual(t.asDate(0), null);
});

check("the month comes from the transactions, not from a guess", () => {
  const r = t.deriveReportingMonth(mrows("2026-07-01", "2026-07-15", "2026-07-31"));
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.key, "2026-07");
  assert.strictEqual(r.label, "July 2026");
  assert.strictEqual(r.counted, 3);
  assert.deepStrictEqual(r.warnings, []);
});

check("the COMMONEST month wins, even when a straggler comes first", () => {
  // Order matters here: a straggler is deliberately the first row. Without a
  // sort, "the month" becomes whichever month happened to appear first in the
  // file — and a single early August row would move the whole reconciliation.
  const r = t.deriveReportingMonth(mrows("2026-08-02", "2026-07-01", "2026-07-15", "2026-07-20"));
  assert.strictEqual(r.key, "2026-07", "it took the first month seen rather than the commonest");
  assert.strictEqual(r.counted, 3);
});

check("a few stragglers are counted and named, not silently dropped", () => {
  const r = t.deriveReportingMonth(mrows("2026-07-01", "2026-07-15", "2026-07-20", "2026-08-02"));
  assert.strictEqual(r.key, "2026-07");
  assert.strictEqual(r.outside, 1);
  assert.ok(/1 row\(s\) fall outside July 2026/.test(r.warnings.join(" ")), r.warnings.join(" "));
});

check("two months in one file is flagged, not averaged away", () => {
  const r = t.deriveReportingMonth(mrows("2026-07-01", "2026-07-02", "2026-08-01", "2026-08-02"));
  assert.ok(r.ok);
  assert.ok(/more than one month/i.test(r.warnings.join(" ")), r.warnings.join(" "));
});

check("unreadable dates are reported, not counted as the month", () => {
  const r = t.deriveReportingMonth(mrows("2026-07-01", "", null, "not a date"));
  assert.strictEqual(r.unreadable, 3);
  assert.ok(/no readable date/.test(r.warnings.join(" ")));
});

check("a file with no dates at all refuses rather than picking one", () => {
  const r = t.deriveReportingMonth(mrows("", null));
  assert.ok(!r.ok);
  assert.ok(/cannot be worked out/i.test(r.reason), r.reason);
});

check("it falls back to xUWETransDate when the issued date is blank", () => {
  const r = t.deriveReportingMonth([{ xTRVIssuedDate: "", xUWETransDate: "2026-09-04" }]);
  assert.strictEqual(r.key, "2026-09");
});

check("a month key converts back to a date on the 1st", () => {
  const d = t.monthKeyToDate("2026-07");
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);
  assert.strictEqual(d.getDate(), 1);
});

check("a bad month key throws rather than defaulting to today", () => {
  for (const bad of ["", "2026", "2026-13", "July 2026", null]) {
    assert.throws(() => t.monthKeyToDate(bad), JSON.stringify(bad) + " was accepted");
  }
});

check("the derived month feeds the labels the guide asks for", () => {
  const r = t.deriveReportingMonth(mrows("2026-07-01", "2026-07-20"));
  const d = t.monthKeyToDate(r.key);
  assert.strictEqual(t.paymentReference(d), "TOKIO_JUL 2026");
  assert.strictEqual(t.sessionLabel(d), "TOKIO_JUL 26");
});

console.log("\n" + n + " assertions passed (including the reporting month).");

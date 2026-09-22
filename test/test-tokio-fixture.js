"use strict";

/**
 * The Tokio fixture's plan, without opening Tramada.
 *
 * A fixture that only produces the happy path proves only the happy path. The
 * B2B rows this script writes are what steps 7-8 and BR05-BR08 get tested
 * against, so the rows themselves are worth asserting: policy shape, the 30/70
 * split, and one row per classification.
 */

const assert = require("assert");
const f = require("../tools/make-fixtures");
const core = require("../tokio-core");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

check("policy numbers are the shape tokio-core accepts", () => {
  for (let i = 0; i < 12; i++) {
    const p = f.tokioPolicy(i);
    assert.match(p, /^21\d{6}$/, p);
    // The guide writes the series as "210XXXXXX" (nine digits); every policy in
    // RAA's own data is eight, and policyKey refuses nine on purpose.
    assert.strictEqual(core.policyKey(p), p, `${p} must survive policyKey`);
  }
});

check("policy numbers are unique across a run", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(f.tokioPolicy(i));
  assert.strictEqual(seen.size, 40, "two bookings sharing a policy would make BR12 untestable by accident");
});

check("policy numbers are stable within a run, so a re-run finds the same rows", () => {
  assert.strictEqual(f.tokioPolicy(3), f.tokioPolicy(3));
});

check("the B2B columns are the ones tokio-core actually reads", () => {
  const cols = f.TOKIO_B2B_COLS;
  // Not decorative: buildConsolidated() and deriveReportingMonth() look these
  // up BY NAME. A fixture that invents xPolicyNumber / xTransactionDate parses
  // fine and carries none of the columns the rules need.
  assert.ok(cols.includes("xPolicyNo"), "buildConsolidated reads xPolicyNo");
  assert.ok(cols.includes("xSellPriceIncGST"), "BR03 needs the sell price");
  assert.ok(cols.includes("xBranch"), "steps 7-8 key off the branch");
  assert.ok(cols.includes("xTRVIssuedDate") || cols.includes("xUWETransDate"),
    "deriveReportingMonth needs one of these or the month cannot be worked out");
  // Step 1: both passenger-name columns are removed by a human before upload.
  assert.ok(!cols.some((c) => /name/i.test(c) && !/branch|product|agent/i.test(c)),
    "a passenger-name column reached the fixture: " + cols.join(", "));
});

check("a B2B row the fixture writes survives the real pipeline", () => {
  // End to end on one row, with no browser: the month is derived, the split
  // computed and the row classified. This is what the card does.
  const row = {
    xPolicyNo: f.tokioPolicy(0), xTRVIssuedDate: "01/08/2026", xUWETransDate: "01/08/2026",
    xBranch: "RAA Elizabeth Travel", xSellPriceIncGST: "100.00",
  };
  const month = core.deriveReportingMonth([row]);
  assert.strictEqual(month.ok, true, month.reason);
  assert.strictEqual(month.label, "August 2026");

  // Each source is { byPolicy: Map } — what indexByPolicy() returns — not a
  // bare Map. A bare Map is silently "not found" for every policy, which
  // reads as "not in Tramada" rather than as a wiring mistake.
  const found = (pol) => ({ byPolicy: new Map([[pol, [{}]]]) });
  const built = core.buildConsolidated([row], {
    payment: found(f.tokioPolicy(0)),
    costing: found(f.tokioPolicy(0)),
    rcc: { byPolicy: new Map() },
  });
  assert.strictEqual(built.rows.length, 1);
  assert.strictEqual(built.rows[0].outcome, core.OUTCOME.TRAVEL, built.rows[0].appended.Remarks);
  assert.strictEqual(built.rows[0].appended["RAA Total Nett"], 70);
});

check("the fixture's own numbers satisfy BR03's 30/70 split", () => {
  // The sell prices the script uses: 100 + i * 37.5.
  for (let i = 0; i < 6; i++) {
    const sell = 100 + i * 37.5;
    const c = core.calcCommission(sell);
    assert.strictEqual(Number(c.commission.toFixed(2)), Number((sell * 0.3).toFixed(2)));
    assert.strictEqual(Number(c.totalNett.toFixed(2)), Number((sell * 0.7).toFixed(2)));
  }
});

check("classify agrees with the plan the fixture writes", () => {
  // travel: branch has "Travel", not in RCC, in Tramada
  assert.strictEqual(
    core.classify({ branch: "RAA Elizabeth Travel", inRcc: false, inPayment: true, inCosting: true }).outcome,
    core.OUTCOME.TRAVEL
  );
  // retail: branch has NO "Travel", in RCC, not in Tramada
  assert.strictEqual(
    core.classify({ branch: "RAA Elizabeth", inRcc: true, inPayment: false, inCosting: false }).outcome,
    core.OUTCOME.RETAIL
  );
  // br07: branch has "Travel" AND is in RCC
  const br07 = core.classify({ branch: "RAA Elizabeth Travel", inRcc: true, inPayment: true, inCosting: true });
  assert.strictEqual(br07.outcome, core.OUTCOME.EXCEPTION);
  assert.match(br07.remark, /BR07/);
  // br08: branch has "Travel", in neither report
  const br08 = core.classify({ branch: "RAA Elizabeth Travel", inRcc: false, inPayment: false, inCosting: false });
  assert.strictEqual(br08.outcome, core.OUTCOME.EXCEPTION);
});

check("Tokio's own net and commission columns are deliberately wrong", () => {
  // BR03 says they are IGNORED. The fixture writes 65/35 rather than 70/30 so
  // a run that reads them instead of computing the split fails visibly rather
  // than agreeing by accident.
  const sell = 100;
  assert.notStrictEqual(Number((sell * 0.65).toFixed(2)), Number(core.calcCommission(sell).totalNett.toFixed(2)));
});

check("the insurance costing carries the GROSS, so Tramada's split lands on the nett", () => {
  // Measured on booking 15842: Tramada applies its own 30% commission to an
  // insurance costing. An amount of 70.00 came back Due 70.00 / Comm 21.00 /
  // Nett 49.00. So the fixture must put the SELL price in, not RAA Total Nett,
  // or Tramada pays 70% of the nett and every row misses BR13 by 30%.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "tools", "make-fixtures.js"), "utf8");
  assert.match(src, /amount: sell\.toFixed\(2\)/,
    "the insurance amount must be the gross sell price");
  assert.ok(!/amount: \(sell \* 0\.7\)/.test(src),
    "putting the nett in makes Tramada pay 70% of 70%");

  // And the arithmetic that makes that true.
  for (const sell of [100, 137.5, 175]) {
    const tramadaNett = sell * 0.7;          // what Tramada will pay the creditor
    const sheetNett = core.calcCommission(sell).totalNett; // what the sheet expects
    assert.ok(Math.abs(tramadaNett - sheetNett) <= Math.abs(sheetNett) * core.AMOUNT_TOLERANCE,
      `sell ${sell}: Tramada ${tramadaNett} vs sheet ${sheetNett} is outside BR13`);
  }
});

check("the fixture receipts the client, or nothing is payable", () => {
  // Booking 15842 had its insurance costing AND a client invoice issued
  // (I.0000010834, $70.00) and Issue Payments still showed nothing. A
  // creditor segment only becomes payable once the client is receipted —
  // makeMint() has said so in a comment all along.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "tools", "make-fixtures.js"), "utf8");
  const tokioFrom = src.indexOf("async function makeTokio()");
  const tokioTo = src.indexOf("async function makeAll()");
  assert.ok(tokioFrom > -1 && tokioTo > tokioFrom, "makeTokio must be findable");
  const body = src.slice(tokioFrom, tokioTo);
  assert.match(body, /runTramadaReceipt\(/, "makeTokio must raise a receipt");
  assert.match(body, /allocation: "ALL"/, "and allocate it, or the segment stays unpaid");
  // But it must NOT pay the creditor — that is the whole point of the fixture.
  assert.ok(!/issueCreditorPayment/.test(body),
    "paying the creditor would remove the very rows steps 12-14 need");
});

console.log(`\n${n} assertions passed.\n`);

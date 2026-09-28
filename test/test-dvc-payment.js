/**
 * Steps 12 to 17 — the Tramada Issue Payment half of a DVC run, offline.
 *
 * The reconciliation (steps 4-11) is `test/test-dvc.js`. This is what happens
 * afterwards: which parameters the search is filled with, which rows on the
 * Issue Payment grid may be ticked, and whether the run saves a session or
 * issues the payment.
 *
 * ALL OF IT IS TESTABLE OFFLINE BECAUSE NONE OF IT IS DECIDED IN THE BROWSER.
 * `recon-core` chooses the rows and the verdict; `tramada-dvc.js` only clicks.
 * That is the separation §2 asks for, and this file is what it buys — the
 * allocation logic checked against captured values instead of against a live
 * financial form.
 *
 * The grid rows below are built from the SAME fixture the reconciliation runs
 * on (`fixtures/dvc-tramada.csv`), because the Issue Payment grid and the
 * Agency CC Reimbursement export are two views of the same transactions. The
 * headers are candidates, not a measurement — see ISSUE_PAYMENT_COLUMNS and
 * `tools/probe-dvc-payment.js`.
 */
const fs = require("fs");
const path = require("path");
const C = require("../recon-core");

let pass = 0, fail = 0;
/* The tally, from one place. The jsdom block at the end finishes
   asynchronously, so "print the totals and exit" cannot simply be the last
   statement in the file. */
/* Checks that have to await something (a mailer send, the jsdom block) push
   their promise here; the tally waits for them, so none can be skipped by exiting. */
const pending = [];
function finish() {
  Promise.all(pending).catch((err) => { fail++; console.log(`  ✗ an async check threw: ${err && err.stack}`); })
    .then(() => {
      console.log(`\n  ${pass} passed, ${fail} failed\n`);
      process.exit(fail ? 1 : 0);
    });
}
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function threw(name, fn, re) {
  try { fn(); fail++; console.log(`  ✗ ${name}\n      it did not throw`); }
  catch (err) {
    if (re.test(err.message)) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}\n      threw: ${err.message}`); }
  }
}
const fixture = (name) => path.join(__dirname, "..", "fixtures", name);

console.log("\nBR12's parameters, resolved off a live dropdown");
{
  // The Payment Category list, verbatim from the 18-09-2026 capture of
  // finance-payments-issue.htm in docs/tokio-marine.md.
  /* Verbatim off the live screen, 22-09-2026. SEVEN options, not the six the
     18-09-2026 capture in docs/tokio-marine.md recorded — Finance Trust PD
     Comm. Transfer Payment has been added since, and two of the labels are
     abbreviated differently from how that capture wrote them. Which is the
     whole argument for matching on the label AND keeping the measured value:
     this list moves. */
  const CATEGORY = [
    { value: "", text: "" },
    { value: "CREDITOR_PAYMENT", text: "Creditor Payment" },
    { value: "DEBTOR_REFUND_PAYMENT", text: "Debtor Refund Payment" },
    { value: "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT", text: "Agency CC Reimbursement" },
    { value: "FINANCE_MERCHANT_REFUND_PAYMENT", text: "Finance Merchant Refund Payment" },
    { value: "FINANCE_COMMISSION_RELEASE_TRANSFER_PAYMENT", text: "Finance Comm. Release Transfer Payment" },
    { value: "FINANCE_TRUST_PAY_DIRECT_COMMISSION_TRANSFER_PAYMENT", text: "Finance Trust PD Comm. Transfer Payment" },
  ];
  const got = C.resolveSelectOption(CATEGORY, C.DVC_PAYMENT_PARAMETERS.paymentCategory,
    C.DVC_ISSUE_PAYMENT_OPTIONS.paymentCategory);
  check("BR12's category resolves by its label", [got.value, got.how],
    ["AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT", "label"]);

  /* THE LABEL WINS, NOT THE MEASURED VALUE. A Tramada release that renumbers
     the option still lands on the right row here — which is the whole reason
     §6 says to read what the page says rather than encode today's answer. */
  const renamed = CATEGORY.map((o) => o.value === "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT"
    ? { value: "AGENCY_CC_REIMBURSEMENT", text: "Agency CC Reimbursement" } : o);
  check("a renumbered value is still found by its label",
    C.resolveSelectOption(renamed, "Agency CC Reimbursement", "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT").value,
    "AGENCY_CC_REIMBURSEMENT");

  /* AND THE MEASURED VALUE IS THE FALLBACK. A reworded label — "Agency Credit
     Card Reimbursement", say — is found by the value that was measured. */
  const reworded = CATEGORY.map((o) => o.value === "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT"
    ? { ...o, text: "Agency Credit Card Reimbursement" } : o);
  const byValue = C.resolveSelectOption(reworded, "Agency CC Reimbursement",
    "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT");
  check("a reworded label falls back to the measured value",
    [byValue.value, byValue.how], ["AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT", "measured value"]);

  // Both changed at once is a screen that has to be re-measured, and it says so
  // rather than selecting nothing — which on this form searches EVERY category.
  check("both changed at once is a refusal, not a blank selection",
    C.resolveSelectOption([{ value: "X", text: "Something else" }], "Agency CC Reimbursement",
      "AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT").value, null);

  /* PUNCTUATION IS NOT PART OF A LABEL — measured 22-09-2026 against the live
     screen, and the reason a correct run refused a card that was on the page.
     Left: BR12 and docs/dvc.md, written in Word. Right: what `#creditCard`
     actually offers, verbatim. Character for character these do not match. */
  const CARD_ON_SCREEN = [
    { value: "", text: "" },
    { value: "7", text: "555003....0457 CA - A - Westpac DVC VCC" },   // four dots, hyphens
  ];
  const card = C.resolveSelectOption(CARD_ON_SCREEN, "555003….0457 CA – A – Westpac DVC VCC", null);
  check("BR12's ellipsis and en dashes still find Tramada's dots and hyphens",
    [card.value, card.how], ["7", "label"]);
  check("...and it comes back as the page spells it", card.text,
    "555003....0457 CA - A - Westpac DVC VCC");
  /* WHAT MUST STILL NOT MATCH. Folding punctuation must not fold the thing that
     tells two cards apart, which is the digits and the name. */
  check("a different card is still a different card",
    C.resolveSelectOption(CARD_ON_SCREEN, "555003….9999 CA – A – Westpac DVC VCC", null).value, null);

  /* Tramada writes "[TRUST] Trust Account" where BR12 says "Trust Account".
     Starts-with would never fire on the bracketed code every account carries. */
  const ACCOUNTS = [{ value: "", text: "" }, { value: "1", text: "[TRUST] Trust Account" }];
  check("the bracketed code in front does not stop the match",
    C.resolveSelectOption(ACCOUNTS, "Trust Account", "1").value, "1");
  // Two accounts both containing "Trust" is a guess about which one a day's
  // payments come out of, so it refuses.
  check("two accounts matching is an ambiguity, not a coin toss",
    C.resolveSelectOption([{ value: "1", text: "[TRUST] Trust Account" },
      { value: "2", text: "[TRUST2] Trust Account Two" }], "Trust Account", null).value, null);

  // BR12 wants Level Branch 1 and 2 BLANK, and "" is a real option on those
  // selects. Asking for blank and getting "no match" would refuse the rule.
  const BRANCHES = [{ value: "", text: "" }, { value: "1", text: "[ADL] Adelaide" }];
  check("blank is an answer, not a missing option",
    C.resolveSelectOption(BRANCHES, "", "").how, "blank");

  const SORT = [{ value: "", text: "" }, { value: "BOOKING_NUMBER", text: "Booking Number" },
    { value: "REFERENCE", text: "Reference" }];
  check("Sort by, case-insensitively", C.resolveSelectOption(SORT, "Booking number", "BOOKING_NUMBER").value,
    "BOOKING_NUMBER");
  /* IT COMES BACK IN THE PAGE'S OWN CASING. The match is case-insensitive and
     the answer is not: every error message and progress line quotes this text
     back at a person, and it used to quote it lowercased. */
  check("...and comes back spelled the way the page spells it",
    C.resolveSelectOption(SORT, "booking NUMBER", null).text, "Booking Number");
}

console.log("\n§4 — the one DVC field that names a card");
{
  // BR12's own value, as Tramada's dropdown writes it. Masked already: a BIN
  // and a last four, which is a label on a screen and not a card number.
  check("BR12's masked label is a label", C.assertCardLabel("555003….0457 CA – A – Westpac DVC VCC"),
    "555003….0457 CA – A – Westpac DVC VCC");
  check("so is a four-digit tail", C.assertCardLabel("Westpac DVC VCC 0457"), "Westpac DVC VCC 0457");
  /* A PAN IS NOT. Nothing here takes one, there is no vault and nothing redacts
     this server's socket (§4) — so it is refused before it can be typed into a
     page, repeated by onProgress, or written to the run store. */
  threw("a full card number is refused", () => C.assertCardLabel("5550031234560457"), /§4/);
  threw("...spaced out as well", () => C.assertCardLabel("5550 0312 3456 0457"), /§4/);
  threw("...and hyphenated", () => C.assertCardLabel("5550-0312-3456-0457"), /§4/);
  /* A GUARD THAT FIRES ON CORRECT INPUT GETS TURNED OFF. Counting every digit
     in the string refused BR12's own value as soon as anything numeric was
     added to the end of it — a year, a branch. A card number is thirteen or
     more CONSECUTIVE digits once its separators are gone, and nothing else. */
  check("a card label with a year on the end is still a label",
    C.assertCardLabel("555003….0457 CA – A – Westpac DVC VCC 2026"),
    "555003….0457 CA – A – Westpac DVC VCC 2026");
  check("and one naming two branch numbers",
    C.assertCardLabel("555003….0457 Westpac DVC VCC 14 / 22"),
    "555003….0457 Westpac DVC VCC 14 / 22");
  // An error message is a log line too, so the refusal quotes none of it back.
  try { C.assertCardLabel("5550031234560457"); } catch (err) {
    ok("and the refusal repeats no digits", !/\d{4}/.test(err.message), err.message);
  }
}

console.log("\nthe Issue Payment grid, read by header name");
{
  // Two grids, the same data, a column apart — the point of reading by name.
  const wide = C.parseIssuePaymentRows(
    ["Action", "Booking No.", "Seg. Type", "Reference", "Passenger Name", "Date of Issue", "Amount"],
    [[{}, "140221", "HTL", "HB918204", "LINTON/PAUL MR", "04-09-2026", "612.40"]]);
  const narrow = C.parseIssuePaymentRows(
    ["Booking No.", "Seg. Type", "Reference", "Amount"],
    [["140221", "HTL", "HB918204", "612.40"]]);
  check("an Action column in front changes nothing",
    [wide.rows[0].bookingNo, wide.rows[0].amount], ["140221", "612.40"]);
  check("...and neither does a missing Passenger column",
    [narrow.rows[0].bookingNo, narrow.rows[0].amount], ["140221", "612.40"]);

  /* THE ACTION COLUMN IS THE WHOLE REASON FOR THIS. The Bank Statements grid
     opens with one, and counting from zero put the page number on the word
     TRUST — nine existing pages read as none (§6). Same rule, same test. */
  check("the booking is not read off a position", wide.rows[0].bookingNo, narrow.rows[0].bookingNo);

  // Booking and amount are what BR03 matches on; nothing can be ticked without
  // them, so a grid missing either is named rather than counted past.
  check("a grid with no amount column says so",
    C.parseIssuePaymentRows(["Booking No.", "Seg. Type"], [["140221", "HTL"]]).missingColumns, ["Amount"]);
  check("and one with no booking column too",
    C.parseIssuePaymentRows(["Seg. Type", "Amount"], [["HTL", "612.40"]]).missingColumns, ["Booking No."]);

  // The same float noise the workbook hands back, normalised the same way.
  check("a float is shown as money",
    C.parseIssuePaymentRows(["Booking No.", "Amount"], [["140733", "136.30000000000001"]]).rows[0].amount,
    "136.30");
  // BR10 — Westpac permits "10 digits, numeric only" while Tramada is free to
  // write the same booking as text with a leading zero.
  check("a leading zero is not a different booking",
    C.parseIssuePaymentRows(["Booking No.", "Amount"], [["0140221", "1.00"]]).rows[0].bookingKey, "140221");

  /* The row is carried with ITS OWN CHECKBOX, never its index: ticking a row on
     this portal's reconcile screen reorders the table underneath (§6). */
  const withBox = C.parseIssuePaymentRows(["Booking No.", "Amount"],
    [{ cells: ["140221", "612.40"], selectId: '#chk_9', alreadyTicked: true }]);
  check("the row keeps the selector for its own checkbox",
    [withBox.rows[0].selectId, withBox.rows[0].alreadyTicked], ["#chk_9", true]);
}

/* ─────────────────────────────────────────────────────────────────────────── */

console.log("\nstep 14 — which rows the run may tick, on the real fixtures");

const tcsv = C.csvGrid(fs.readFileSync(fixture("dvc-tramada.csv"), "utf8"));
const wcsv = C.csvGrid(fs.readFileSync(fixture("dvc-westpac.csv"), "utf8"));
const costings = C.parseTramadaCcRows(tcsv.headers, tcsv.rows);
const report = C.parseDvcRows(wcsv.headers, wcsv.rows);
const day = C.filterDvcSettlementDate(report.rows, "2026-09-04");
const run = C.reconcileDvc(day.rows, costings.rows);

/**
 * The Issue Payment grid Tramada would show for BR13's range — the same
 * transactions the Agency CC Reimbursement export holds, which is what that
 * export IS. Column order deliberately unlike the export's, because the two
 * screens have no reason to agree and the reader must not care.
 */
const GRID_HEADERS = ["Booking No.", "Seg. Type", "Reference", "Passenger Name", "Date of Issue", "Amount"];
const gridRows = costings.rows.map((t, i) => ({
  cells: [t.bookingNo, t.segType, t.supplierRef, t.supplierName, "04-09-2026", t.amount],
  selectId: `input[type="checkbox"][name="selected"][value="${1000 + i}"]`,
}));
const grid = C.parseIssuePaymentRows(GRID_HEADERS, gridRows);
check("the grid reads every costing", grid.rows.length, 17);
check("and needs no column it has not got", grid.missingColumns, []);

const plan = C.planDvcPayment(run.rows, grid.rows);
const ticked = plan.rows.filter((r) => r.tick);

/* THE SIX CLEAN MATCHES AND NOTHING ELSE. Step 14: "Do not tick lines flagged
   as exceptions — leave these for the Travel Accounts team to resolve." Every
   number below is a row test-dvc.js has already pinned a verdict on. */
check("only the clean matches are ticked",
  ticked.map((r) => [r.bookingNo, r.amount]),
  [["140221", "612.40"], ["140255", "288.52"], ["140501", "-338.90"],
   ["140733", "136.30"], ["140777", "725.15"], ["140812", "410.00"]]);
check("which is the same count the reconciliation called clean", plan.ticked, run.summary.matched);

// BR04 — the costing is three cents under the card charge, and five is allowed.
check("a costing three cents from its charge is still ticked",
  plan.rows.find((r) => r.bookingNo === "140255").tick, true);

const why = (booking) => {
  const r = plan.rows.find((x) => x.bookingNo === booking && !x.tick);
  return r ? r.why : "(ticked)";
};
// Step 5 downgraded this one: the amounts reconcile, the segment type does not.
ok("a flagged segment type is left, and says which flag", /flagged — Please check: segment type/.test(why("140310")), why("140310"));
// BR06 — the merchant-fee lines are matched AND flagged, so step 14 leaves them.
ok("a merchant fee is left for a person", /Amount \+ Merchant Fee/.test(why("140344")), why("140344"));
/* BR05 — ONE CARD CHARGE OVER THREE COSTINGS. All three grid rows are left.
   Ticking one leg of a one-to-many puts part of a card charge into a payment
   and leaves the rest, which is a wrong number in Tramada rather than a
   missing one. */
check("none of a one-to-many's three costings is ticked",
  plan.rows.filter((r) => r.bookingNo === "140402").map((r) => r.tick), [false, false, false]);
ok("...and each says why", /multiple transaction amount/.test(why("140402")), why("140402"));
// BR05 the other way — three card charges against the one 210.00 costing.
check("nor the costing three charges add up to",
  plan.rows.find((r) => r.bookingNo === "140466").tick, false);

/* A GRID ROW NOBODY PAID IS NOT AN ERROR. BR13 makes the Tramada range two days
   wider than the report on purpose, so the grid legitimately holds costings this
   report says nothing about. If these counted as exceptions, step 17 could never
   fire on any day at all. */
const orphan = plan.rows.find((r) => r.bookingNo === "140901");
check("a costing outside the report is left, and is not an exception",
  [orphan.tick, orphan.exception, orphan.outsideReport], [false, false, true]);
ok("...and says the range is wider on purpose", /BR13/.test(orphan.why), orphan.why);

// The 845.00 costing the 980.00 charge did not match, and the 640.00 CRUISE
// costing that was never there — both on the report, both flagged, both left.
check("the amount error's costing is left as an exception",
  plan.rows.find((r) => r.bookingNo === "140644").exception, true);
/* Nine exceptions and one outsider. 140644's amount error and 140701's missing
   costing are ON the report and flagged, so they are Travel Accounts' to
   resolve; only 140901, which the report never mentions, is the BR13 case. */
check("the tally", [plan.ticked, plan.left, plan.exceptions, plan.outsideReport],
  [6, 11, 10, 1]);

/* THE TWO TOTALS ARE DIFFERENT NUMBERS, ON PURPOSE. The card was charged
   1833.50 and the costings behind those same lines come to 1833.47 — three
   cents of BR04 rounding, which is exactly what step 17's Round Remaining is
   for. Summed in integer cents, never by re-adding dollar strings. */
check("the ticked rows come to Tramada's figure", plan.tickCents, 183347);
check("...and the report's own figure for the same lines", run.summary.tickableCents, 183350);

console.log("\na reopened session: its earlier ticks, and one that is no longer confident");
{
  /* The grid of a REOPENED session comes back with its earlier ticks on.
     Those already ticked and still confident are counted, not re-clicked;
     one ticked earlier and NOT confident now is never unticked — that is a
     judgement about money already in a session — and it keeps the day from
     being complete. */
  const reopenedGrid = grid.rows.map((g) => ({ ...g,
    alreadyTicked: g.bookingNo === "140221" || g.bookingNo === "140644" }));
  const p = C.planDvcPayment(run.rows, reopenedGrid);
  check("a confident row the session already had still counts as ticked",
    p.rows.find((r) => r.bookingNo === "140221").tick, true);
  check("...and is counted as already there", p.alreadyTicked, 1);
  check("a row ticked earlier but no longer confident is named, never unticked",
    p.stale.map((r) => r.bookingNo), ["140644"]);
  const c = C.decideDvcCommit({ plan: p, dvcSummary: { ...run.summary }, statementDate: "2026-09-04",
    dryRun: false, reopened: true });
  ok("...and it keeps the session from being complete", !c.complete &&
    c.errors.some((e) => /ticked in the saved session but no longer match with confidence \(booking 140644/.test(e)),
    c.errors.join(" | "));
}

console.log("\nclean DVC lines that never reached the grid");
{
  // Drop 140733's costing out of the grid: its DVC line is still clean, and
  // BR13's range is meant to contain it, so the consultant has not entered it.
  const short = grid.rows.filter((r) => r.bookingNo !== "140733");
  const p = C.planDvcPayment(run.rows, short);
  check("it is named, not counted", p.missingFromGrid.map((m) => [m.bookingNo, m.amount]),
    [["140733", "136.30"]]);
  check("and it is one tick fewer", p.ticked, 5);
}

console.log("\na clean line never ticks two rows");
{
  /* THE SAME COSTING TWICE ON THE GRID. One clean DVC line claims one costing,
     so it may tick one row — ticking both would pay 612.40 twice, and the
     second payment is real money against a booking that did not owe it. */
  const dup = [
    { n: 1, bookingNo: "140221", bookingKey: "140221", amount: "612.40", amountCents: 61240, selectId: "#a" },
    { n: 2, bookingNo: "140221", bookingKey: "140221", amount: "612.40", amountCents: 61240, selectId: "#b" },
  ];
  const p = C.planDvcPayment(run.rows.filter((r) => r.bookingNo === "140221"), dup);
  check("one clean line ticks one row", p.rows.map((r) => r.tick), [true, false]);
  check("...and the second is left alone", p.tickCents, 61240);
}

console.log("\nis the day done? — every line green, or the email says what is left");
{
  /* THE REAL FIXTURES ARE NOT GREEN, and that is the normal shape of this
     report — the document expects three to six exceptions a run. Since
     23-09-2026 that no longer keeps the run out of Tramada (step 16 / BR14);
     it decides whether the saved session is the WHOLE day, ready to Issue. */
  const gate = C.dvcReconciliationIsGreen(run.summary);
  check("the fixtures' own day is not done", gate.green, false);
  check("and both reasons are named", gate.blockers,
    ["6 DVC lines are not matched", "7 lines are matched but flagged for a person"]);

  const clean = C.dvcReconciliationIsGreen({ total: 18, matched: 18, matchedForReview: 0, unmatched: 0 });
  check("all eighteen matched cleanly is", [clean.green, clean.blockers], [true, []]);
  check("one flagged line out of eighteen is not",
    C.dvcReconciliationIsGreen({ total: 18, matched: 17, matchedForReview: 1, unmatched: 0 }).green, false);
  check("...and nor is one unmatched",
    C.dvcReconciliationIsGreen({ total: 18, matched: 17, matchedForReview: 0, unmatched: 1 }).green, false);
  // BR06 matches a merchant-fee line and records the fee; it is still a flag.
  check("a merchant-fee day is not green",
    C.dvcReconciliationIsGreen({ total: 2, matched: 1, matchedForReview: 1, merchantFee: 1, unmatched: 0 }).green,
    false);
  check("a total that does not reconcile is not",
    C.dvcReconciliationIsGreen({ total: 1, matched: 1, matchedForReview: 0, unmatched: 0 },
      { checked: true, ok: false, reason: "the report totals $10.00 but $20.00 was entered" }).green, false);
  check("...while no total entered is not a failure",
    C.dvcReconciliationIsGreen({ total: 1, matched: 1, matchedForReview: 0, unmatched: 0 },
      { checked: false, ok: null }).green, true);
  /* NOTHING RECONCILED IS NOT "ALL GREEN" — an empty run passes every test
     above by having nothing to fail them, and emailing "ready to issue" about a
     file nobody read is the §6 mistake. */
  check("an empty run is not done",
    C.dvcReconciliationIsGreen({ total: 0, matched: 0, matchedForReview: 0, unmatched: 0 }).green, false);
  check("nor is no summary at all", C.dvcReconciliationIsGreen(null).green, false);
  // BR13's wider Tramada range leaves costings nothing paid; that is expected.
  ok("leftover Tramada costings are not counted",
    C.dvcReconciliationIsGreen({ total: 2, matched: 2, matchedForReview: 0, unmatched: 0 }).green &&
    run.unmatchedTramada.length === 4,
    `unmatchedTramada = ${run.unmatchedTramada.length}`);
}

console.log("\nthe browser gate — spreadsheets first, Tramada once no errors arise (RAA's drawing, 23-09-2026)");
{
  /* RAA's drawing: errors → email a person → they fix the Westpac report and
     re-upload → reconcile again; the Tramada reimbursement starts only when no
     errors arise. The fixtures' day has thirteen, so it goes nowhere near
     Tramada — it goes back to a person. */
  const g = C.dvcTramadaGate(run.summary);
  check("a day with spreadsheet errors does not open Tramada", g.open, false);
  ok("...and says the Westpac report is fixed and re-uploaded first",
    /fixed and re-uploaded first/.test(g.why), g.why);
  check("...naming what is wrong", g.blockers,
    ["6 DVC lines are not matched", "7 lines are matched but flagged for a person"]);
  check("one line out of eighteen is enough to send it back",
    C.dvcTramadaGate({ total: 18, matched: 17, matchedForReview: 1, unmatched: 0 }).open, false);
  check("no errors opens it",
    C.dvcTramadaGate({ total: 18, matched: 18, matchedForReview: 0, unmatched: 0 }).open, true);
  check("a report total that does not agree sends it back too",
    C.dvcTramadaGate({ total: 1, matched: 1, matchedForReview: 0, unmatched: 0 },
      { checked: true, ok: false, reason: "the report totals $10.00 but $20.00 was entered" }).open, false);
  check("nothing reconciled keeps it shut", C.dvcTramadaGate({ total: 0 }).open, false);
  check("...and so does no summary", C.dvcTramadaGate(null).open, false);
}

console.log("\nstep 16 — save the session, or nothing; step 17 is never the agent's");
{
  const plan = { ticked: 4, left: 0, tickCents: 100000, exceptions: 0, missingFromGrid: [], rows: [] };
  const spotless = { total: 4, matched: 4, matchedForReview: 0, unmatched: 0, tickableCents: 100000 };
  const decide = (o) => C.decideDvcCommit({ plan, dvcSummary: spotless, statementDate: "2026-09-04", ...o });

  /* THERE IS NO ISSUE IN THE VOCABULARY. The agent saves the session and a
     person Issues it (RAA, 23-09-2026). Asserted on the constant itself so a
     later change that adds the word back has to delete this test to do it. */
  check("session is the only thing the run can commit", Object.values(C.DVC_COMMIT), ["nothing", "session"]);

  const saved = decide({ dryRun: false });
  check("a clean day saves the session", [saved.action, saved.wanted], ["session", "session"]);
  check("...under step 16's label", saved.sessionLabel, "DVC 04/09/2026");
  check("...and it is the whole day", [saved.complete, saved.errors], [true, []]);
  ok("...ready for Travel Accounts to Issue", /ready for Travel Accounts to Issue/.test(saved.why), saved.why);
  check("rounding nothing advises nothing", saved.roundRemaining, false);

  /* ERRORS DO NOT STOP THE SESSION (step 16, BR14) — they stop ISSUE, which is
     a person's, and the session says so: not complete, do not Issue yet. */
  const dirty = decide({ dryRun: false,
    dvcSummary: { total: 6, matched: 4, matchedForReview: 1, unmatched: 1, tickableCents: 100000 } });
  check("a day with exceptions still saves the confident lines", dirty.action, "session");
  check("...but is not complete, so it may not be Issued", dirty.complete, false);
  check("...and its exceptions travel with it for the email", dirty.errors,
    ["1 DVC line is not matched", "1 line is matched but flagged for a person"]);
  ok("...and says what to check before Issue", /found in Tramada to check before it is Issued/.test(dirty.why), dirty.why);

  const stuck = decide({ dryRun: false, plan: { ...plan, exceptions: 2 } });
  check("grid rows left untouched do not stop the session", [stuck.action, stuck.complete], ["session", false]);
  const orphaned = decide({ dryRun: false,
    plan: { ...plan, missingFromGrid: [{ bookingNo: "140221", amount: "612.40" }] } });
  check("a matched line with no grid row is an error, not a stop", [orphaned.action, orphaned.errors.length],
    ["session", 1]);
  const tooFar = decide({ dryRun: false, plan: { ...plan, tickCents: 99900 } });
  check("a dollar apart still saves, not complete", [tooFar.action, tooFar.complete], ["session", false]);
  ok("...with step 15's remark", /^Total transaction amount does not match/.test(tooFar.errors[0] || ""),
    tooFar.errors.join(" | "));

  /* STEP 17'S ROUND REMAINING is advice now — a person ticks it when they
     Issue. Three cents of BR04 rounding is inside the fifty. */
  const rounding = decide({ dryRun: false, plan: { ...plan, tickCents: 99997 } });
  check("three cents apart advises Round Remaining",
    [rounding.action, rounding.roundRemaining, rounding.diffCents, rounding.complete], ["session", true, 3, true]);

  // A dry run does everything except the click.
  const dry = decide({ dryRun: true });
  check("a dry run saves nothing", [dry.action, dry.wanted, dry.held], ["nothing", "session", "dry run"]);
  check("dryRun defaults to true", C.decideDvcCommit({ plan, dvcSummary: spotless }).action, "nothing");

  /* A DAY THAT ALREADY HAS A SESSION IS RE-CHECKED AND SAVED AGAIN (RAA,
     23-09-2026). It used to be refused outright — "reopen it in Tramada rather
     than saving a second one" — which ended the fix-and-re-upload loop with
     nobody told the day was now ready. */
  const again = decide({ dryRun: false, reopened: true,
    plan: { ...plan, alreadyTicked: 2 } });
  check("a reopened session is saved again", [again.action, again.reopened, again.complete],
    ["session", true, true]);
  check("...counting what this run added", again.added, 2);
  ok("...and says it was re-checked", /^Re-checked Payment Session "DVC 04\/09\/2026": 4 rows ticked \(2 added this run\)/.test(again.why),
    again.why);
  // When the re-check finds it 100%, the email says ready to Issue.
  const ready = C.dvcEmail({ statementDate: "2026-09-04", summary: spotless, rows: [],
    payment: { saved: true, commit: again } });
  check("a re-checked 100% day emails ready to issue", ready.status, "ready to issue");
  ok("...saying it was re-checked", /has been re-checked and saved again in Tramada/.test(ready.text), ready.text);

  /* NOTHING TICKED MEANS NOTHING SAVED — the same rule the statement page
     keeps (§6). An empty session is a record of work nobody did. */
  const empty = decide({ dryRun: false, plan: { ...plan, ticked: 0, tickCents: 0 } });
  check("nothing ticked saves nothing", [empty.action, empty.complete], ["nothing", false]);
  ok("...and says so plainly", /no session was saved/.test(empty.why), empty.why);
  check("no plan at all saves nothing", decide({ dryRun: false, plan: null }).action, "nothing");
}

console.log("\nstep 18 — the email to Travel Accounts");
{
  const summary = run.summary;
  const commitFor = (o) => C.decideDvcCommit({ plan: { ticked: 5, tickCents: 183347, exceptions: 0,
    missingFromGrid: [], rows: [] }, dvcSummary: summary, statementDate: "2026-09-04", dryRun: false, ...o });

  /* A CLEAN DAY: the first line tells Travel Accounts what to do. */
  const cleanSummary = { total: 5, matched: 5, matchedForReview: 0, unmatched: 0, tickableCents: 183350 };
  const cleanCommit = C.decideDvcCommit({ plan: { ticked: 5, tickCents: 183347, exceptions: 0,
    missingFromGrid: [], rows: [] }, dvcSummary: cleanSummary, statementDate: "2026-09-04", dryRun: false });
  const clean = C.dvcEmail({ statementDate: "2026-09-04", summary: cleanSummary,
    rows: run.rows.filter((r) => r.matched && !r.remark), payment: { saved: true, commit: cleanCommit },
    columns: report.columns, runId: "run-1" });
  // Step 18's own subject, with the day after it.
  ok("the subject is the document's, with the day", /^AI Agent DVC reconciliation — 04\/09\/2026/.test(clean.subject),
    clean.subject);
  check("a saved, complete session is ready to issue", clean.status, "ready to issue");
  ok("...and says to open the session and Issue",
    /Payment Session "DVC 04\/09\/2026" has been saved[\s\S]*Issue the payment/.test(clean.text), clean.text);
  ok("...ticking Round Remaining for the three cents", /tick Round Remaining/.test(clean.text), clean.text);
  ok("...and that the agent never presses it", /The agent does not press Issue/.test(clean.text));

  /* SPREADSHEET ERRORS — the drawing's first email. Nothing in Tramada; fix the
     Westpac report and re-upload. */
  const errs = C.dvcEmail({ statementDate: "2026-09-04", summary, rows: run.rows,
    payment: { skipped: true, why: C.dvcTramadaGate(summary).why }, columns: report.columns,
    unmatchedTramada: run.unmatchedTramada });
  check("spreadsheet errors: the subject says fix and re-upload",
    /— errors found — fix and re-upload$/.test(errs.subject), true);
  ok("...and the first line says nothing is in Tramada and what to do",
    /^The 04\/09\/2026 DVC reconciliation found 13 lines that do not reconcile\. Nothing has been entered in Tramada\. Please fix the Westpac discrepancies/.test(errs.text),
    errs.text);
  /* THE PER-LINE BREAKDOWN IS NOT IN THE EMAIL — RAA, 24-09-2026: it is
     already the attachment's Remarks/Reconciled/Why columns for every row
     (dvcReportCsv), and repeating it back in the body just duplicated the
     spreadsheet. The email points at it instead. */
  const nExceptions = run.rows.filter((r) => !r.matched || r.remark).length;
  ok("...pointing at the attachment for the lines to fix, not repeating them",
    errs.text.includes(`See the attachment for the ${nExceptions} lines not ticked`) &&
      !run.rows.some((r) => errs.text.includes(`booking ${r.bookingNo || "(none)"} $${r.amount} —`)),
    errs.text);
  ok("...and lists BR13's leftovers as expected, not as errors", /nothing on the report paid \(expected/.test(errs.text));

  /* THE SPREADSHEETS AGREED, TRAMADA RAISED SOMETHING — the session is saved
     anyway, and the accounts team are told what to check before Issue. */
  const tramadaIssue = C.decideDvcCommit({ plan: { ticked: 5, tickCents: 183347, exceptions: 0, rows: [],
    missingFromGrid: [{ bookingNo: "140733", amount: "136.30" }] }, dvcSummary: cleanSummary,
    statementDate: "2026-09-04", dryRun: false });
  const check1 = C.dvcEmail({ statementDate: "2026-09-04", summary: cleanSummary,
    rows: run.rows.filter((r) => r.matched && !r.remark), payment: { saved: true, commit: tramadaIssue },
    columns: report.columns });
  check("a session saved with Tramada issues says check before issuing",
    /— session saved — check before issuing$/.test(check1.subject), true);
  ok("...and says to open it, make changes, then Issue",
    /Tramada raised 1 thing to check \(below\)\. Please open the session, make any changes needed, and then Issue/.test(check1.text),
    check1.text);
  ok("...naming what Tramada raised", /1 matched line had no row on the Issue Payment grid/.test(check1.text), check1.text);

  /* A 100% day whose session was NOT saved — a Tramada screen that stopped
     the run — still emails, and says why. */
  const none = C.dvcEmail({ statementDate: "2026-09-04", summary: cleanSummary,
    payment: { error: "No results grid on the Issue Payment screen" }, rows: run.rows.filter((r) => r.matched && !r.remark),
    columns: report.columns });
  ok("a clean day with no session says so up front, with the reason",
    /^The 04\/09\/2026 DVC spreadsheets reconciled, but no Payment Session was saved in Tramada — No results grid/.test(none.text),
    none.text);
  ok("a dry run is marked in the subject",
    /\[DRY RUN\]/.test(C.dvcEmail({ statementDate: "2026-09-04", summary, dryRun: true }).subject));

  /* THE ATTACHMENT IS THEIR SPREADSHEET WITH THE REMARKS FILLED IN — the
     existing Remarks column written into, not a second one appended. It rides
     on the errors email, the one a person fixes the Westpac report from. */
  const csv = errs.attachment.content.replace(/^﻿/, "");
  const grid = C.csvGrid(csv);
  check("the attachment keeps every original column, then two of the run's",
    grid.headers, [...report.columns, "Reconciled", "Why"]);
  const at = (h) => grid.headers.indexOf(h);
  const feeRow = grid.rows.find((r) => /Merchant Fee/.test(r[at("REMARKS")] || ""));
  ok("a remark lands in their own REMARKS column", !!feeRow, "no merchant-fee remark in REMARKS");
  check("...and the reconciled column says it needs a check", feeRow && feeRow[at("Reconciled")], "Matched — check");
  check("the attachment is a CSV named for the day", errs.attachment.filename, "dvc-reconciliation-2026-09-04.csv");
  ok("the email carries no card number", !/\d{13,}/.test(errs.text.replace(/[\s-]/g, "")));
}

console.log("\nmailer.js — configuration and delivery, offline");
{
  const mailer = require("../mailer");
  /* NO DEFAULT RECIPIENT. A sandbox run must never mail TAccounts@raa.com.au
     because somebody forgot a variable. */
  // A transport chosen by name, nothing else set, says what it is missing.
  const bare = mailer.config({ MAIL_TRANSPORT: "resend" });
  check("Resend chosen with nothing set is not ready", bare.ready, false);
  check("...and names what is missing", bare.missing, ["DVC_EMAIL_TO", "RESEND_API_KEY"]);
  const full = mailer.config({ RESEND_API_KEY: "re_test", DVC_EMAIL_TO: "x@y; z@w" });
  check("an API key and a recipient are ready, with both recipients, and Resend's sandbox from address by default",
    [full.ready, full.to, full.from], [true, ["x@y", "z@w"], "onboarding@resend.dev"]);
  check("MAIL_FROM overrides the sandbox default",
    mailer.config({ RESEND_API_KEY: "re_test", DVC_EMAIL_TO: "x@y", MAIL_FROM: "dvc@raa.com.au" }).from,
    "dvc@raa.com.au");

  /* MICROSOFT GRAPH (23-09-2026) — this machine's network blocks SMTP on 587,
     so the default road out is HTTPS. A client id is all it needs from .env;
     the sign-in itself lives in the token cache, never a password. */
  const graph = mailer.config({ GRAPH_CLIENT_ID: "00000000-1111-2222-3333-444444444444", DVC_EMAIL_TO: "x@y",
    RESEND_API_KEY: "re_test" });
  check("a Graph client id wins over Resend, and needs no password", [graph.transport, graph.ready, graph.graphTenant],
    ["graph", true, "consumers"]);
  check("...and a tenant can be named for a Microsoft 365 organisation",
    mailer.config({ GRAPH_CLIENT_ID: "x", GRAPH_TENANT: "raa.com.au", DVC_EMAIL_TO: "x@y" }).graphTenant, "raa.com.au");
  check("Graph chosen with no client id names it", mailer.config({ MAIL_TRANSPORT: "graph", DVC_EMAIL_TO: "x@y" }).missing,
    ["GRAPH_CLIENT_ID"]);

  /* THE sendMail BODY. Graph answers a malformed one with a bare 400, so the
     shape is pinned here rather than discovered at the end of a live run. */
  const built = C.dvcEmail({ statementDate: "2026-09-04", summary: run.summary, rows: run.rows,
    columns: report.columns });
  const body = mailer.graphMessage(built, ["a@b", "c@d"]);
  check("the recipients are Graph emailAddress objects",
    body.message.toRecipients, [{ emailAddress: { address: "a@b" } }, { emailAddress: { address: "c@d" } }]);
  check("the body is the HTML email", [body.message.body.contentType, body.message.body.content === built.html],
    ["HTML", true]);
  const att = body.message.attachments[0];
  check("the spreadsheet is a base64 file attachment with a bare MIME type",
    [att["@odata.type"], att.name, att.contentType], ["#microsoft.graph.fileAttachment",
      "dvc-reconciliation-2026-09-04.csv", "text/csv"]);
  check("...that decodes back to the CSV exactly", Buffer.from(att.contentBytes, "base64").toString("utf8"),
    built.attachment.content);
  check("and it is kept in Sent Items", body.saveToSentItems, true);

  /* RESEND'S OWN BODY SHAPE — the HTTPS peer of graphMessage, same reason: a
     malformed request is a bare 400 from Resend too, and it carries the
     sender explicitly, since Resend (unlike Graph) has no signed-in mailbox
     to infer one from. */
  const rbody = mailer.resendMessage(built, ["a@b", "c@d"], "dvc@raa.com.au");
  check("the recipients and sender are plain addresses, not envelope objects",
    [rbody.to, rbody.from], [["a@b", "c@d"], "dvc@raa.com.au"]);
  check("the body is the HTML email", rbody.html, built.html);
  const ratt = rbody.attachments[0];
  check("the spreadsheet is a base64 attachment", ratt.filename, "dvc-reconciliation-2026-09-04.csv");
  check("...that decodes back to the CSV exactly", Buffer.from(ratt.content, "base64").toString("utf8"),
    built.attachment.content);

  /* NOT CONFIGURED IS A REASON, NOT AN ERROR — `send` never throws even with
     nothing set. The reconciliation and any Tramada session are already done
     by the time step 18 runs, and a lost email must not fail work that is
     complete (the same rule the run store keeps, §6b). */
  check("nothing configured at all still names something to fix, not silence",
    mailer.config({}).missing, ["DVC_EMAIL_TO", "RESEND_API_KEY"]);
  pending.push((async () => {
    const res = await mailer.send(built, { env: {} });
    check("an unconfigured send is reported, never thrown", [res.sent, res.skipped],
      [false, true]);
    ok("...and names what is missing", /DVC_EMAIL_TO/.test(res.why) && /RESEND_API_KEY/.test(res.why), res.why);
  })());
}
console.log("\nwhat changed since the last upload of this day");
{
  const before = [
    { cardNumber: "XXXX-4417", bookingNo: "140221", amount: "612.40", segmentType: "HOTEL" },
    { cardNumber: "XXXX-6683", bookingNo: "140612", amount: "176.00", segmentType: "TRANSFER" },
  ];
  /* The fix somebody was asked to make: 140612's booking was not in Tramada,
     and the booking number has been corrected on the re-upload. */
  const after = [
    { cardNumber: "XXXX-4417", bookingNo: "140221", amount: "612.40", segmentType: "HOTEL" },
    { cardNumber: "XXXX-6683", bookingNo: "140613", amount: "176.00", segmentType: "TRANSFER" },
  ];
  const d = C.diffDvcUploads(before, after);
  check("one line differs", [d.count, d.summary], [1, "1 line changed"]);
  check("and it names which field", d.changed[0].fields.map((f) => [f.label, f.from, f.to]),
    [["booking number", "140612", "140613"]]);

  /* KEYED ON THE CARD, NOT THE ROW NUMBER. DVC means one virtual card per
     transaction, so the card is the line's identity — and a row deleted at the
     top would otherwise make every line below it read as changed. */
  check("the key is the card", d.by, "card number");
  const reordered = C.diffDvcUploads(before, [before[1], before[0]]);
  check("re-sorting the file changes nothing", reordered.count, 0);
  ok("...and says so", /identical/.test(reordered.summary), reordered.summary);

  // An added and a removed line are reported apart from a changed one.
  const grew = C.diffDvcUploads(before, before.concat(
    [{ cardNumber: "XXXX-9999", bookingNo: "140700", amount: "50.00" }]));
  check("an added line is not a changed one", [grew.added.length, grew.changed.length], [1, 0]);
  check("and it says what it was", grew.added[0].what, "booking 140700 $50.00");
  const shrank = C.diffDvcUploads(before, [before[0]]);
  check("a removed line too", [shrank.removed.length, shrank.summary], [1, "1 removed"]);

  /* NO CARD NUMBERS, NO IDENTITIES. It falls back to position and SAYS so, so a
     diff read off row numbers is never mistaken for one read off identities —
     the fallback is much weaker and a reader has to know which they are
     looking at. */
  const noCards = C.diffDvcUploads([{ line: 2, amount: "1.00" }], [{ line: 2, amount: "2.00" }]);
  check("with no card numbers it falls back, and says so", [noCards.by, noCards.count],
    ["position", 1]);
  // Duplicated cards cannot identify a line either.
  check("...and duplicated cards are no identity",
    C.diffDvcUploads([{ cardNumber: "a", line: 1 }, { cardNumber: "a", line: 2 }],
      [{ cardNumber: "a", line: 1 }, { cardNumber: "a", line: 2 }]).by, "position");

  // Nothing to compare against is not a diff of nothing.
  check("an empty before is not a diff", C.diffDvcUploads([], after).count, 2);
}

console.log("\nthe card's own copy of all this, in the built page");
{
  /* Static checks against `public/index.html`, the file the browser is actually
     served. Same shape as test-ipsi-card-wiring.js and for the same reason: the
     page is BUILT from design/recon-wire.html, and a control that exists in the
     wire and not in the build is a control nobody can click. */
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const wire = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
  ok("public/index.html has been rebuilt from the wire",
    wire.includes("dvcPaymentBlock") && page.includes("dvcPaymentBlock"), "run npm run build");

  /* NO APPROVAL, NO ISSUE (RAA, 23-09-2026). The run goes straight on to the
     session; there is no second frame and no button that moves money. */
  ok("there is no approval frame any more", !/type: 'dvc_issue'/.test(page) && !/dvc_issue/.test(wire));
  ok("...and no Issue button", !/id="dvcIssueBtn"/.test(page));
  /* THE CARD IS NOT ON THE DASHBOARD (RAA, 23-09-2026). BR12's card is server
     configuration — the same card every day — so the page neither shows it,
     asks for it nor sends it. */
  ok("the dashboard has no Credit Card field", !/dvcCard/.test(page) && !/dvcCard/.test(wire));
  ok("...and the upload frame sends no card", !/creditCard:/.test(page));
  ok("...and no payment opt-in or approval flag", !/tramadaPayment/.test(page) && !/allowIssue/.test(page));
  ok("Start waits only for both files", /dvcBad = on\.includes\('dvc'\) && !pairFile\.dvc;/.test(page));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok("the server takes the card from DVC_CARD, never from the page",
    /String\(process\.env\.DVC_CARD \|\| DVC_CARD_DEFAULT\)/.test(server) && !/msg\.creditCard/.test(server));
  ok("...and its fallback is a masked label, not a card number",
    C.assertCardLabel((server.match(/DVC_CARD_DEFAULT = "([^"]+)"/) || [])[1]) === "555003....0457 CA - A - Westpac DVC VCC");

  /* THE RESULT IS THE SERVER'S. A page that worked out for itself whether a
     session was saved would say something Tramada does not hold. */
  ok("the page draws the server's result, it does not compute one",
    /if \(m\.payment\) dvcResult = \{ \.\.\.m\.payment, email: m\.email \|\| null \};/.test(page));
  ok("...and a new file takes the result away",
    /if \(kind === 'dvc'\) \{ dvcResult = null; dvcDiff = null; \}/.test(page));

  ok("the card says the agent never presses Issue", /It never presses Issue/.test(page));
}

console.log("\nthe screen's own DOM work, against jsdom");
{
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
  if (!JSDOM) {
    console.log("  -- jsdom not installed, skipping (npm i -D jsdom to run these)");
    finish();
  } else {
    const screen = require("../tramada-issue-payments");
    /* A `page` with just the one method these use. Not a mock of Playwright
       (§7) — `page.evaluate(fn)` runs `fn` in the browser, and here it runs in
       jsdom instead. The function under test is the same function. */
    /* EVERY GLOBAL THE CLOSURE REACHES FOR, not just `document`.
       `errorBanner` calls `getComputedStyle`, which is a window global — with
       only `document` swapped it threw a ReferenceError, the function's own
       `.catch(() => "")` swallowed it, and the two assertions that expect an
       empty string passed without running any of the code they name. A harness
       that makes a test pass for the wrong reason is worse than no harness. */
    const pageFor = (html) => {
      const dom = new JSDOM(`<body>${html}</body>`);
      return {
        async evaluate(fn, arg) {
          const prev = { document: global.document, getComputedStyle: global.getComputedStyle };
          global.document = dom.window.document;
          global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
          try { return fn(arg); } finally { Object.assign(global, prev); }
        },
      };
    };

    (async () => {
      /* The results grid is the table with a header row, three named columns
         and a checkbox on its rows. The small table above it is the kind of
         thing a search screen carries for its own controls. */
      const RESULTS = `
        <table><tr><td>Show</td><td><input type="checkbox" id="showAll"></td></tr></table>
        <table>
          <tr><th>Action</th><th>Booking No.</th><th>Seg. Type</th><th>Reference</th><th>Amount</th></tr>
          <tr><td><input type="checkbox" name="selected" value="1001"></td><td>140221</td><td>HTL</td><td>HB918204</td><td>612.40</td></tr>
          <tr><td><input type="checkbox" name="selected" value="1002" checked></td><td>140255</td><td>TRN</td><td>ER-41882</td><td>288.52</td></tr>
        </table>`;
      const g = await screen.readResultsGrid(pageFor(RESULTS));
      check("the results grid is the one with the rows", g.headers,
        ["Action", "Booking No.", "Seg. Type", "Reference", "Amount"]);
      check("both rows come back", g.rows.length, 2);
      /* ADDRESSED BY ITS OWN CHECKBOX, NEVER BY ITS INDEX. Ticking a row on
         this portal's reconcile screen reorders the table underneath (§6). */
      check("each row carries a selector that survives a reorder", g.rows[0].selectId,
        'input[type="checkbox"][name="selected"][value="1001"]');
      check("a box that is already ticked says so", g.rows[1].alreadyTicked, true);

      // And the same grid read by name, end to end.
      const parsed = C.parseIssuePaymentRows(g.headers, g.rows);
      check("the Action column does not become the booking number",
        parsed.rows.map((r) => r.bookingNo), ["140221", "140255"]);

      /* NO GRID IS NOT AN EMPTY GRID. A page with no results table at all comes
         back `found: false` carrying what tables it DID have, so the caller can
         refuse rather than compute a payment from nothing (§6, §3). */
      const none = await screen.readResultsGrid(pageFor("<table><tr><th>Nothing</th></tr></table>"));
      check("a page with no results grid says so, not 'no rows'", none.found, false);

      /* BR12's Credit Card field, which the measured capture of this form does
         not have — it only appears once the category is Agency CC
         Reimbursement. Found by label, by id, or by the card it is offering. */
      const byLabel = await screen.findControl(pageFor(
        `<table><tr><td>Credit Card</td><td><select id="weirdCardId"><option value="7">555003….0457 CA – A – Westpac DVC VCC</option></select></td></tr></table>`),
        { label: "Credit Card", idHint: "card", optionText: "Westpac DVC", tag: "select" });
      check("found by the label beside it", [byLabel.selector, byLabel.how],
        ["#weirdCardId", "adjacent label cell"]);

      const byOption = await screen.findControl(pageFor(
        `<select id="s1"><option>Creditor Payment</option></select>
         <select id="s2"><option value="7">555003….0457 CA – A – Westpac DVC VCC</option></select>`),
        { label: "Credit Card", idHint: "nothinglikethis", optionText: "Westpac DVC VCC", tag: "select" });
      check("or by the card it is already offering", byOption.selector, "#s2");

      /* NOT FOUND IS A REFUSAL WITH EVIDENCE. Without this field the search
         returns every agency card's transactions — a longer list of other
         people's payments that looks exactly like a correct one. */
      const missing = await screen.findControl(pageFor(`<select id="s1"><option>Creditor Payment</option></select>`),
        { label: "Credit Card", idHint: "card", optionText: "Westpac DVC", tag: "select" });
      check("and when it is not there, it says what was", [missing.selector, missing.seen.length], [null, 1]);

      /* AN ERROR NOBODY CAN SEE IS NOT AN ERROR.
         Measured 22-09-2026: this form ships its validation messages as divs
         that are always in the markup and hidden until they apply.
         `#advancedSearchTextAreaErrorDiv` sits there permanently, and reading
         the DOM without asking whether it is visible reported a perfectly good
         search as having failed on an Advanced Search text area that was empty
         and had never been touched. Both strings below are verbatim. */
      const HIDDEN_ERR =
        '<div style="display:none" id="advancedSearchTextAreaErrorDiv" class="errorDiv">' +
        'You cannot put more than 50 values in the Text area. Please use file upload option.</div>';
      check("a hidden validation div is not a complaint",
        await screen.errorBanner(pageFor(HIDDEN_ERR)), "");
      /* ...and the real one, as Tramada marks it up when a search IS rejected:
         table.errors > tr.errors > td.errors > a.error. Caught live. */
      const REAL_ERR =
        '<table class="errors"><tbody><tr class="errors"><td class="errors">' +
        '<a class="error" href="#" data-value="creditor">Creditor Code must be entered</a>' +
        '</td></tr></tbody></table>';
      check("a visible one is", await screen.errorBanner(pageFor(REAL_ERR)),
        "Creditor Code must be entered");
      // A wrapper hiding it counts, which is how the form actually hides them.
      check("...and is hidden by an ancestor, not only by itself",
        await screen.errorBanner(pageFor('<div style="display:none">' + REAL_ERR + "</div>")), "");

      /* The buttons steps 16 and 17 press, found by what they SAY. No id on
         this screen has been measured, and `#issue` on the creditor payment
         form is a different form. */
      const buttons = `<input type="submit" id="goButton" value="Go">
        <input type="button" id="sessBtn" value="Session">
        <input type="submit" id="issueBtn" value="Issue">`;
      /* THE AGENCY CC REIMBURSEMENT GRID, as measured read-only on
         raatravelsandbox 23-09-2026 (bookings 15899 and 15908, created by
         tools/make-dvc-bookings.js). EVERY ROW'S CHECKBOX IS
         id="segmentsToAllocate" — the selector used to be built from the id,
         so every row came back as `#segmentsToAllocate` and ticking any of them
         would have ticked the first. */
      const MEASURED = '<table><tr><th>D</th><th>R</th><th>Seg. Type</th><th>Booking No.</th>' +
        '<th>Reference</th><th>Creditor ID</th><th>Segment Date</th><th>Debtor Receipted</th>' +
        '<th>Reimbursement Due</th><th>Paid Amount</th><th>Balance Due</th><th>Allocate</th><th>A</th></tr>' +
        '<tr><td>*</td><td></td><td>CRU</td><td>15899</td>' +
        '<td>785K3G - 785K3G - GRAY/SPIDER MS - Princess Cruises</td><td>89561</td><td>23-09-2026</td>' +
        '<td>799.80</td><td>799.80</td><td>0.00</td><td>799.80</td>' +
        '<td><input id="allocationAmount_82460" disabled readonly></td>' +
        '<td><input type="checkbox" id="segmentsToAllocate" name="segmentsToAllocate" value="82460"></td></tr>' +
        '<tr><td>*</td><td></td><td>HTL</td><td>15908</td><td>ACCOR</td><td>9</td><td>23-09-2026</td>' +
        '<td>174.10</td><td>174.10</td><td>0.00</td><td>174.10</td>' +
        '<td><input id="allocationAmount_82475" disabled readonly></td>' +
        '<td><input type="checkbox" id="segmentsToAllocate" name="segmentsToAllocate" value="82475"></td></tr>' +
        '</table>';
      const live = await screen.readResultsGrid(pageFor(MEASURED));
      check("duplicate-id checkboxes are told apart by value", live.rows.map((r) => r.selectId), [
        'input[type="checkbox"][name="segmentsToAllocate"][value="82460"]',
        'input[type="checkbox"][name="segmentsToAllocate"][value="82475"]',
      ]);
      const parsedLive = C.parseIssuePaymentRows(live.headers, live.rows);
      check("...and the measured headers give booking, type, date and Balance Due",
        parsedLive.rows.map((r) => [r.bookingNo, r.segType, r.issued, r.amount]),
        [["15899", "CRU", "23-09-2026", "799.80"], ["15908", "HTL", "23-09-2026", "174.10"]]);
      check("...with nothing missing", parsedLive.missingColumns, []);

      // The exact pattern `saveSession` presses with, not a looser one.
      const SESSION = "^\\s*(save\\s+)?session\\s*$";
      const sess = await screen.findButton(pageFor(buttons), SESSION);
      check("the Session button", [sess.selector, sess.text], ["#sessBtn", "Session"]);
      const saveSess = await screen.findButton(pageFor('<button id="ss">Save Session</button>'), SESSION);
      check("...or one that says Save Session", saveSess.selector, "#ss");
      /* NEVER THE ISSUE BUTTON. "Issue Session" would be a button that saves
         AND pays; the pattern must not reach it, and `pressAndCheck` refuses
         anything whose text says issue even if it did. */
      const both = await screen.findButton(pageFor('<button id="is">Issue Session</button>'), SESSION);
      check("...and never one that also issues", both.selector, null);

      // The session label box, by label first (step 16).
      const dvc = require("../tramada-dvc");
      const labelled = await dvc.findSessionLabel(pageFor(
        '<table><tr><td>Session Label</td><td><input type="text" id="sessionLabel"></td></tr></table>'));
      check("the session label box is found by its label", labelled.selector, "#sessionLabel");
      const byId = await dvc.findSessionLabel(pageFor('<input type="text" name="paymentSessionName">'));
      check("...or by a name saying session", byId.selector, 'input[name="paymentSessionName"]');
      /* ANCHORED. A loose /issue/ also matches "Re-issue" and, on this screen,
         the words "Issue Payment" in a heading rendered as a button. */
      const iss = await screen.findButton(pageFor(buttons + `<button id="reissue">Re-issue</button>`), "^issue$");
      check("...and the Issue button, not Re-issue", iss.selector, "#issueBtn");
      const gone = await screen.findButton(pageFor(`<input type="button" id="x" value="Back">`), "^issue$");
      check("a missing button comes back with what there was", [gone.selector, gone.seen.length], [null, 1]);

      finish();
    })().catch((err) => {
      console.log(`  ✗ the DOM checks threw: ${err && err.stack}`);
      process.exit(1);
    });
  }
}

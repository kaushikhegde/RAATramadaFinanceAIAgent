/**
 * BR01–BR14, offline.
 *
 * These are the rules from *Reconciliation Guide — BPAY (daily)*, and they are
 * the reason a receipt gets raised or withheld. The remark strings are asserted
 * CHARACTER FOR CHARACTER against the guide, not by regex: Finance filters and
 * counts this column, and "No outstanding amount" where the guide says "No
 * outstanding amount found" is a different value to anything reading the file.
 */
const C = require("../recon-core");

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("\nthe Remarks vocabulary is the guide's, verbatim");
check("BR01", C.REMARKS.noBooking, "No booking number found");
check("BR02", C.REMARKS.departurePassed, "Please review, departure date has passed");
check("BR03", C.REMARKS.noOutstanding, "No outstanding amount found");
check("BR04", C.REMARKS.noOutstandingPassed, "No outstanding amount found, departure date has passed");
check("BR05", C.REMARKS.wrongDebtor, "Please review, incorrect debtor found");
check("BR09/BR10", C.REMARKS.allocate, "Please allocate");
check("BR11", C.REMARKS.overpayment, "Overpayment, please check");
check("the debtor BR05 demands", C.RETAIL_DEBTOR, "RAA of SA Limited (Retail)");

console.log("\ndates, at day granularity and in three formats");
check("Tramada's dd-mm-yyyy", C.toIsoDate("09-08-2026"), "2026-08-09");
check("Tramada's dd/mm/yyyy", C.toIsoDate("09/08/2026"), "2026-08-09");
check("a spreadsheet's yyyy-mm-dd", C.toIsoDate("2026-08-09"), "2026-08-09");
check("single-digit days pad", C.toIsoDate("9-8-2026"), "2026-08-09");
check("junk is empty, never a guess", C.toIsoDate("next Tuesday"), "");
check("blank is empty", C.toIsoDate(""), "");
// The day either side, and the day itself. "Today or in the future" in the
// guide means a departure today has NOT passed.
check("yesterday has passed", C.isPastDate("16-08-2026", "2026-08-17"), true);
check("today has not", C.isPastDate("17-08-2026", "2026-08-17"), false);
check("tomorrow has not", C.isPastDate("18-08-2026", "2026-08-17"), false);
check("the year boundary is a date, not a string", C.isPastDate("31-12-2025", "2026-01-01"), true);
// null, never false. False would say "the departure has not passed" about a
// date nobody parsed, and BR02/BR04 would quietly never fire.
check("unreadable is null, not false", C.isPastDate("", "2026-08-17"), null);

console.log("\nstep 5 — what counts as an outstanding amount");
check("the positive dues, added", C.outstandingFrom([{ debtorDue: "200.00" }, { debtorDue: "145.54" }]), 34554);
// No segments at all is nothing owed — which is what BR03/BR04 need to fire.
// Not null: null means "could not be read", and would stop the row instead.
check("no segments is nothing owed, not unknown", C.outstandingFrom([]), 0);
check("all settled is nothing owed", C.outstandingFrom([{ debtorDue: "0.00" }]), 0);
// A credit on one segment does not net off a debt on another. The booking DOES
// have an outstanding amount and BR03 must not stop the receipt.
check("a credit does not cancel another segment's debt",
  C.outstandingFrom([{ debtorDue: "200.00" }, { debtorDue: "-50.00" }]), 20000);
check("an unreadable due poisons the answer", C.outstandingFrom([{ debtorDue: "200.00" }, { debtorDue: "n/a" }]), null);

console.log("\nsteps 4-6 — whether a receipt may be raised at all");
const TODAY = "2026-08-17";
const good = { debtor: "RAA of SA Limited (Retail)", today: TODAY };

{
  const d = C.decidePreReceipt({ ...good, depDate: "20-08-2026", outstandingCents: 14554 });
  check("owing, departure ahead — proceeds", [d.proceed, d.remark], [true, ""]);
}
{
  // BR02 — the receipt IS still raised. The remark is a warning, not a stop.
  const d = C.decidePreReceipt({ ...good, depDate: "01-08-2026", outstandingCents: 14554 });
  check("BR02 owing, departure passed — proceeds WITH the remark",
    [d.proceed, d.remark], [true, "Please review, departure date has passed"]);
}
{
  const d = C.decidePreReceipt({ ...good, depDate: "20-08-2026", outstandingCents: 0 });
  check("BR03 nothing owing, departure ahead — stops",
    [d.proceed, d.remark], [false, "No outstanding amount found"]);
}
{
  const d = C.decidePreReceipt({ ...good, depDate: "01-08-2026", outstandingCents: 0 });
  check("BR04 nothing owing, departure passed — stops, and says both",
    [d.proceed, d.remark], [false, "No outstanding amount found, departure date has passed"]);
}
{
  // A credit balance is not an outstanding amount.
  const d = C.decidePreReceipt({ ...good, depDate: "20-08-2026", outstandingCents: -5000 });
  check("a negative balance is nothing owing", d.remark, "No outstanding amount found");
}
{
  const d = C.decidePreReceipt({ debtor: "RAA of SA Limited (Corporate)", today: TODAY, depDate: "20-08-2026", outstandingCents: 14554 });
  check("BR05 wrong debtor — stops",
    [d.proceed, d.remark], [false, "Please review, incorrect debtor found"]);
  ok("and names what it found instead", /Corporate/.test(d.reason), d.reason);
}
{
  const d = C.decidePreReceipt({ debtor: "", today: TODAY, depDate: "20-08-2026", outstandingCents: 14554 });
  check("a blank debtor is a wrong debtor", d.proceed, false);
  ok("and says so rather than printing nothing", /\(blank\)/.test(d.reason), d.reason);
}
{
  // The page renders it with its own spacing and capitalisation.
  const d = C.decidePreReceipt({ debtor: "  raa of sa limited (retail) ", today: TODAY, depDate: "20-08-2026", outstandingCents: 14554 });
  check("spacing and case do not make it a different debtor", d.proceed, true);
}
{
  // ORDER. Nothing owing stops at BR03 before the debtor is looked at, which is
  // the guide's order — step 5 comes before step 6.
  const d = C.decidePreReceipt({ debtor: "Someone Else", today: TODAY, depDate: "20-08-2026", outstandingCents: 0 });
  check("the balance is checked before the debtor", d.remark, "No outstanding amount found");
}
{
  // A stop beats a warning: BR05 wins the column, BR02 survives in the prose.
  const d = C.decidePreReceipt({ debtor: "Someone Else", today: TODAY, depDate: "01-08-2026", outstandingCents: 14554 });
  check("a stop takes the Remarks column", d.remark, "Please review, incorrect debtor found");
}

console.log("\nand nothing is guessed at");
{
  const d = C.decidePreReceipt({ ...good, depDate: "20-08-2026", outstandingCents: null });
  check("an unreadable balance stops the receipt", d.proceed, false);
  ok("and says which field", /outstanding.*could not be read/.test(d.reason), d.reason);
}
{
  const d = C.decidePreReceipt({ ...good, depDate: "", outstandingCents: 14554 });
  check("an unreadable departure date stops the receipt", d.proceed, false);
  ok("and says which field", /departure date could not be read/.test(d.reason), d.reason);
}

console.log("\nBR07-BR11 — exact, or nothing");
{
  const two = [{ segId: "A", debtorDue: "200.00" }, { segId: "B", debtorDue: "200.00" }];

  const one = C.decideAllocation(20000, two);
  check("BR07 exactly one segment — ticks that one", one.allocation, [{ segId: "A", amount: "200.00" }]);
  check("and is a full allocation", one.status, "Allocated");
  check("with no remark to make", one.remark, "");

  const all = C.decideAllocation(40000, two);
  check("BR08 exactly all of them — Select All", all.allocation, "ALL");
  check("also a full allocation", all.status, "Allocated");
  check("also nothing to remark on", all.remark, "");

  // The case that changed. This used to tick one segment and report "Part
  // allocated"; the guide says leave it.
  const partial = C.decideAllocation(30000, two);
  check("BR09 fits a combination but not one and not all — ticks NOTHING", partial.allocation, []);
  check("and is not allocated", partial.status, "Not allocated");
  check("and asks for a person", partial.remark, "Please allocate");

  const nothing = C.decideAllocation(10000, two);
  check("BR10 matches nothing at all — ticks nothing", nothing.allocation, []);
  check("also asks for a person", nothing.remark, "Please allocate");
  ok("and says why: less than the cheapest segment",
    /less than the cheapest segment, which owes \$200\.00/.test(nothing.reason), nothing.reason);

  /* BR11, AS RAA REVISED IT 29-Aug: "When overpayment amount found: if only 1
     segment, then allocate; if 2 or more segment, then do not allocate."
     It used to tick every segment and report "Part allocated" regardless of
     count. Spreading an overpayment across several segments is a judgement
     about which one is really overpaid, and that is a person's call. */
  const overTwo = C.decideAllocation(50000, two);
  check("BR11 overpaid across TWO segments — ticks nothing", overTwo.allocation, []);
  check("and does not allocate", overTwo.status, "Not allocated");
  check("but still flags the overpayment", overTwo.remark, "Overpayment, please check");
  ok("and says why a person has to decide",
    /which segment is overpaid is a decision for a person/.test(overTwo.reason), overTwo.reason);

  const overOne = C.decideAllocation(30000, [{ segId: "A", debtorDue: "200.00" }]);
  check("BR11 overpaid against ONE segment — that one is ticked", overOne.allocation.length, 1);
  check("and it is allocated", overOne.status, "Allocated");
  check("still flagged as an overpayment", overOne.remark, "Overpayment, please check");
  ok("and the leftover is named",
    /\$100\.00 of this receipt stays unallocated/.test(overOne.reason), overOne.reason);
}
{
  // 300 against 100 + 200 DOES total exactly, and that is BR08, not BR09.
  const d = C.decideAllocation(30000, [{ segId: "A", debtorDue: "100.00" }, { segId: "B", debtorDue: "200.00" }]);
  check("an exact total across different sizes is still BR08", d.allocation, "ALL");
  check("allocated", d.status, "Allocated");
}
{
  // One segment, and the receipt matches it: BR07 and BR08 are the same event.
  // Select All is the proven path, so it takes it.
  const d = C.decideAllocation(14554, [{ segId: "A", debtorDue: "145.54" }]);
  check("a single segment paid exactly", d.allocation, "ALL");
  check("allocated", d.status, "Allocated");
}
{
  // Three of 100 and one of 250: 250 matches a segment exactly AND matches
  // 100+100+... no. 250 matches segment D exactly. BR07 wins over any
  // combination, because "one segment exactly" is the first rule that fits.
  const d = C.decideAllocation(25000, [
    { segId: "A", debtorDue: "100.00" }, { segId: "B", debtorDue: "100.00" },
    { segId: "C", debtorDue: "50.00" }, { segId: "D", debtorDue: "250.00" },
  ]);
  check("one exact segment beats a combination that also totals it",
    d.allocation, [{ segId: "D", amount: "250.00" }]);
}
{
  // Segments already settled are not segments. 200 against 200 + 0 is BR08.
  const d = C.decideAllocation(20000, [{ segId: "A", debtorDue: "200.00" }, { segId: "B", debtorDue: "0.00" }]);
  check("a settled segment is not counted", d.allocation, "ALL");
  check("and it is a full allocation", d.status, "Allocated");
}
{
  const d = C.decideAllocation(20000, [{ segId: "A", debtorDue: "" }]);
  check("an unreadable due allocates nothing", d.allocation, []);
  check("and asks for a person rather than guessing", d.remark, "Please review");
}

console.log("\nBR13 — to the cent, with no slack");
{
  // One cent under a segment is not that segment.
  const near = C.decideAllocation(19999, [{ segId: "A", debtorDue: "200.00" }]);
  check("a cent short is not an allocation", near.allocation, []);
  check("and is flagged", near.remark, "Please allocate");
  // One cent over is an overpayment, not a match.
  const over = C.decideAllocation(20001, [{ segId: "A", debtorDue: "200.00" }]);
  check("a cent over is an overpayment", over.remark, "Overpayment, please check");
  ok("of exactly one cent", /\$0\.01 of this receipt stays unallocated/.test(over.reason), over.reason);
}

console.log("\nBR12 — one statement page per statement DATE");
{
  const pages = [
    { pageNo: "9", statementDate: "15-08-2026" },
    { pageNo: "10", statementDate: "17-08-2026" },
  ];
  check("a second run of the same day's file finds the page it already made",
    (C.pageForDate(pages, "17-08-2026") || {}).pageNo, "10");
  check("a different day is free", C.pageForDate(pages, "18-08-2026"), null);
  // The formats on the grid and in the form are not the same shape.
  check("the grid's dd-mm-yyyy and a form's yyyy-mm-dd are the same day",
    (C.pageForDate(pages, "2026-08-17") || {}).pageNo, "10");
  check("no pages at all is free", C.pageForDate([], "17-08-2026"), null);
  // Unreadable is NOT a match. A statement date nobody parsed must not silently
  // block every run by matching the first page in the list.
  check("an unreadable date blocks nothing", C.pageForDate(pages, "whenever"), null);
}
{
  /* The guide's holiday note: SA has a Monday public holiday, Finance comes
     back on Tuesday and uploads two files — one for Monday, one for Tuesday.
     Two statement dates on one calendar day is two pages, and BR12 must not
     stand in the way of the second. */
  const afterMonday = [{ pageNo: "11", statementDate: "17-08-2026" }];
  check("Tuesday's file is not blocked by Monday's page",
    C.pageForDate(afterMonday, "18-08-2026"), null);
}

console.log("\nBR14 — Shop, then Consultant");
{
  const rows = [
    { n: 1, shop: "WEST", consultant: "Zoe Adams" },
    { n: 2, shop: "ADL", consultant: "Priya Nair" },
    { n: 3, shop: "adl", consultant: "Aaron Blake" },
    { n: 4, shop: "COL", consultant: "Mia Chen" },
  ];
  check("shop first, then consultant, case-blind",
    C.sortForFinance(rows).map((r) => r.n), [3, 2, 4, 1]);
}
{
  // A row whose branch could not be read is an exception, and exceptions go to
  // the bottom rather than sorting above ADL on the strength of being empty.
  const rows = [
    { n: 1, shop: "", consultant: "Zoe Adams" },
    { n: 2, shop: "ADL", consultant: "Priya Nair" },
    { n: 3, shop: "", consultant: "Aaron Blake" },
  ];
  check("blank shops sink to the bottom", C.sortForFinance(rows).map((r) => r.n), [2, 3, 1]);
}
{
  const rows = [
    { n: 1, shop: "ADL", consultant: "" },
    { n: 2, shop: "ADL", consultant: "Priya Nair" },
  ];
  check("blank consultants sink within their shop", C.sortForFinance(rows).map((r) => r.n), [2, 1]);
}
{
  // Ties keep the uploaded order, so the file still reads as the file.
  const rows = [
    { n: 1, shop: "ADL", consultant: "Priya Nair" },
    { n: 2, shop: "ADL", consultant: "Priya Nair" },
    { n: 3, shop: "ADL", consultant: "Priya Nair" },
  ];
  check("a tie is stable", C.sortForFinance(rows).map((r) => r.n), [1, 2, 3]);
}
check("no rows sorts to no rows", C.sortForFinance([]), []);

console.log("\nstep 11 / step 30 — the receipt type, and the filter that finds it");
check("the category chosen on the receipts list", C.BPAY_RECEIPT.value, "DEBTOR_PAYMENT_RECEIPT");
check("and what the reconcile screen calls the same thing", C.BPAY_RECEIPT.label, "Debtor Payment Receipt");
/* THE ONE THAT MATTERS. Filing under one name and searching under another
   reconciles nothing while looking like it worked — the receipts are real, the
   filter shows an empty grid, and every row reports "not reconciled". So the
   filter is not allowed to drift from the category. */
check("the filter is the same name the receipt is filed under",
  C.REPORTS.bpay.recPayType, C.BPAY_RECEIPT.label);
check("and it is in Tramada's own vocabulary for that dropdown",
  ["Client Payment Receipt", "Creditor Payment", "Debtor Payment Receipt"]
    .includes(C.REPORTS.bpay.recPayType), true);
// Not in the guide, and its own string rather than a bare "Please review":
// a booking that cannot take this type is a specific thing to go and look at.
check("the remark for a booking that cannot take one",
  C.REMARKS.noDebtorReceipt, "Please review, Debtor Payment Receipt not available");

console.log("\nstep 9 — the shop shortcode");
check("a branch label gives its code", C.branchCode("[WEST] RAA West Croydon"), "WEST");
check("whatever the code is", C.branchCode("[BROKENHILL] RAA Broken Hill"), "BROKENHILL");
check("a label with no code is kept whole", C.branchCode("RAA West Croydon"), "RAA West Croydon");
check("blank stays blank", C.branchCode(""), "");
check("and so does nothing at all", C.branchCode(null), "");
/* The value this reads comes from `options[selectedIndex]` of `#level1Branch`,
   never from the page's text. Reading the text returns the first option in the
   dropdown — "[ADL] RAA Adelaide" — for every booking in the system, because
   innerText renders a <select> as all of its options. Booking 13394 is a West
   Croydon booking that reported ADL, and ADL is a real branch, so the report
   looked right. There is no unit test that can catch that; the defence is the
   selector, and the reason it is a selector is written down in
   tramada-receipt.js's getBookingBranch. */

console.log("\nRAA's own BPay export, column for column");
{
  /* The real header row, from the file RAA sent on 17-Aug-2026. Two things in
     it had never been seen before: a two-digit year, and TOTAL / NO OF TRANX
     riding on the last data row. */
  const p = C.parseReconCsv([
    "B/PAY FILE DATE,CUSTOMER REF,RECEIPT NO,AMOUNT,CONSULTANT,SHOP,TRAMADA BKG NO,REMARKS,TOTAL,NO OF TRANX,Time report sent",
    '07-01-26,1211622,NAB010720263024361197,"1,839.80",,,121162,,,,',
    "07-01-26,938399,BBL010720262118262980,4000.00,,,93839,,,,",
    '07-01-26,1030410,WBC010720268588318INT,"5,912.00",,,103041,,"153,035.86",26,8:41:00 AM',
  ].join("\n"));

  check("every row is runnable", p.rows.length, 3);
  check("the reference is the RECEIPT NO column", p.rows[0].reference, "NAB010720263024361197");
  check("the booking is TRAMADA BKG NO, not CUSTOMER REF", p.rows[0].bookingNo, "121162");
  check("a thousands separator is money, to the cent", p.rows[0].amountCents, 183980);
  check("and so is one without", p.rows[1].amountCents, 400000);
  // CUSTOMER REF is the booking number with a check digit on the end. It is
  // carried, and it is NOT mistaken for the booking.
  check("CUSTOMER REF is carried, not used", p.rows[0].cells["CUSTOMER REF"], "1211622");
  check("and so is a column this code has no opinion about",
    p.rows[2].cells["TOTAL"], "153,035.86");
  check("the file's own CONSULTANT / SHOP / REMARKS are the ones filled in",
    p.columns.filter((c) => /consultant|shop|remarks/i.test(c)),
    ["CONSULTANT", "SHOP", "REMARKS"]);
}
{
  // The date the receipt is filed under. 07-01-26 is the 7th of January.
  check("a two-digit year is read day-first", C.toIsoDate("07-01-26"), "2026-01-07");
  check("and typed into Tramada in full", C.toTramadaDate("07-01-26"), "07-01-2026");
  check("slashes too", C.toIsoDate("07/01/26"), "2026-01-07");
  check("single digits pad", C.toIsoDate("7-1-26"), "2026-01-07");
  // The POSIX window, so a typo lands somewhere obvious rather than nowhere.
  check("69 is 2069", C.toIsoDate("01-01-69"), "2069-01-01");
  check("70 is 1970", C.toIsoDate("01-01-70"), "1970-01-01");
  // Four-digit years must not be caught by the two-digit rule.
  check("a four-digit year still wins", C.toIsoDate("07-01-2026"), "2026-01-07");
  check("and an ISO date is untouched", C.toIsoDate("2026-01-07"), "2026-01-07");
  // A departure date in the file's own format now actually decides something.
  check("BR02 can finally fire on a file-format date",
    C.isPastDate("07-01-26", "2026-08-17"), true);
}
{
  /* A row carrying only a total is not a payment that lost its booking number,
     and must not be remarked as one — Finance would read an instruction beside
     a line that is not a transaction. */
  const p = C.parseReconCsv([
    "B/PAY FILE DATE,RECEIPT NO,AMOUNT,TRAMADA BKG NO,TOTAL",
    "07-01-26,NAB01,1839.80,121162,",
    ',,,,"153,035.86"',
  ].join("\n"));
  check("the totals row is not runnable", p.rows.length, 1);
  check("and carries no remark", p.problems[0].row.remark, "");
  check("but is still carried, totals and all", p.problems[0].row.cells["TOTAL"], "153,035.86");
  ok("and is named as what it is", /nothing in it to reconcile/.test(p.problems[0].why), p.problems[0].why);
}

console.log("\nthe file Finance actually sends");
{
  // The guide calls this column Receipt No throughout. It used to be rejected.
  const p = C.parseReconCsv([
    "B/PAY FILE DATE,Receipt No,Amount,Tramada Bkg No",
    "09-08-2026,CBA0408A1,145.54,13127",
  ].join("\n"));
  check("a Receipt No column is the Reference column", p.rows.length, 1);
  check("and lands in reference", p.rows[0].reference, "CBA0408A1");
  check("Rec/Pay Type is not required", p.rows[0].recPayType, "");
  check("the date column is found under the guide's name", p.rows[0].date, "09-08-2026");
  check("so is the booking number", p.rows[0].bookingNo, "13127");
  check("every row starts with the three columns Finance gets back",
    [p.rows[0].consultant, p.rows[0].shop, p.rows[0].remark], ["", "", ""]);
}
{
  // BR01. The line is not runnable, so it stays out of `rows` — but it comes
  // back carrying its remark, and the report puts it in front of Finance.
  const p = C.parseReconCsv([
    "Date,Reference,Amount,Booking No",
    "09-08-2026,CBA1,145.54,",
  ].join("\n"));
  check("a line with no booking number is not run", p.rows.length, 0);
  check("but it is not lost either", p.problems.length, 1);
  check("and it carries BR01's remark", p.problems[0].row.remark, "No booking number found");
}
{
  const p = C.parseReconCsv([
    "Date,Reference,Amount,Booking No",
    "09-08-2026,,145.54,13127",
  ].join("\n"));
  check("a line missing something else is remarked for review", p.problems[0].row.remark, "Please review");
}
{
  const p = C.parseReconCsv("Date,Amount,Booking No\n09-08-2026,145.54,13127");
  check("a file with no reference column is still refused",
    p.problems[0].why, "the header is missing: reference");
}

/* A RERUN MUST BE ABLE TO FINISH.

   RAA's workflow reruns the same file after Finance fixes errors — the IPSI
   guide's step 17 says so in as many words. On that second pass the receipt is
   already on the booking, so nothing is filed again and `allocation` reads
   "Already filed" rather than "Allocated".

   The guard that keeps an unclean allocation off the statement was matching on
   the string, so it refused those too. Observed live 01-Sep: "0 of 10
   reconciled" with three real receipts sitting on page 18 at exactly the right
   amounts. An already-filed receipt now reconciles on the same evidence a
   fresh one does — real receipt, on this page, amount agreeing to the cent. */
{
  const page = [{ transNo: "R.0000009580", reference: "BP-D1", amount: "145.54" }];
  const row = { receiptNo: "R.0000009580", amountCents: 14554, why: "nothing was filed again" };

  const fresh = C.matchAgainstStatement({ ...row, allocation: "Allocated" }, page);
  const again = C.matchAgainstStatement({ ...row, allocation: "Already filed" }, page);
  check("a receipt this run filed reconciles", fresh.status, "Reconciled");
  check("and so does one an EARLIER run filed", again.status, "Reconciled");
  ok("both are handed to the ticker", !!fresh.transNo && !!again.transNo,
    "a rerun cannot reconcile anything if already-filed receipts are not ticked");
  ok("but the reason says which run filed it",
    /filed by an earlier run/.test(again.reason), again.reason);

  // The money check still comes first — this is what stops it ticking blindly.
  const wrongMoney = [{ transNo: "R.0000009580", reference: "BP-D1", amount: "999.99" }];
  const bad = C.matchAgainstStatement({ ...row, allocation: "Already filed" }, wrongMoney);
  check("already filed but the page disagrees on money — still refused", bad.status, "Not reconciled");
  ok("...and nothing is ticked", !bad.transNo, JSON.stringify(bad));

  // A genuinely unclean allocation is still held back.
  for (const a of ["Not allocated", "Part allocated"]) {
    const m = C.matchAgainstStatement({ ...row, allocation: a }, page);
    check(`"${a}" is still not reconciled`, m.status, "Not reconciled");
    ok(`"${a}" is still not ticked`, !m.transNo);
  }
}

/* AN ALREADY-FILED ROW CARRIES A REMARK, because the run did not check how the
   earlier receipt was allocated. Reconciling on the amount alone is the right
   call — a rerun has to be able to finish — but a blank Remarks cell beside it
   claims the allocation was verified when no booking was opened. */
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "recon-run.js"), "utf8");
  ok("an already-filed row is given a remark",
    /r\.remark = core\.REMARKS\.filedEarlier/.test(src),
    "an unallocated receipt would reconcile with a blank Remarks cell, reading as finished work");
  ok("...and the remark reaches the screen with the row",
    /remark: r\.remark, why: r\.why,\n\s*consultant/.test(src) || /allocation: r\.allocation, remark: r\.remark/.test(src));
  ok("the remark says the allocation was not checked",
    /allocation not checked/.test(C.REMARKS.filedEarlier), C.REMARKS.filedEarlier);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

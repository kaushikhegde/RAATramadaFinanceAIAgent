/**
 * The DVC card reconciliation, offline.
 *
 * DVC is the one report that matches two spreadsheets against each other — the
 * Westpac DVC report and Tramada's Agency CC Reimbursement export — so the
 * whole of it is testable without a browser, and all of it is tested here.
 *
 * Run against BOTH containers of both files. The workbook stores dates as
 * serials and amounts as the float they really are; the CSV has them already
 * formatted. Which parser runs is decided by the file's own container and never
 * by its name, so the two have to come out the same or the card lies about one
 * of them. That is the same check `test-travelpay.js` makes, and it is how
 * `test-xlsx-lite.js` caught a parser bug a hand-written fixture agreed with.
 *
 * The fixtures are `tools/make-dvc-fixtures.js` — shape taken from the client's
 * `DVC_REPORT EXPORT EXAMPLES` workbook (read 22-09-2026), data invented. The
 * rules are docs/dvc.md; BRxx below are its Business Rules table.
 */
const fs = require("fs");
const path = require("path");
const C = require("../recon-core");
const XL = require("../xlsx-lite");

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

const fixture = (name) => path.join(__dirname, "..", "fixtures", name);

console.log("\nthe six ways the report writes a date");
// All five separators-or-none forms are in the client's own August export, in
// one column. Nobody typed them; a card request form and a spreadsheet between
// them produced them.
check("slashes", C.dvcDate("31/07/2026"), "2026-07-31");
check("dots", C.dvcDate("31.07.2026"), "2026-07-31");
check("hyphens", C.dvcDate("28-08-2026"), "2026-08-28");
check("a two-digit year, day first", C.dvcDate("29.08.26"), "2026-08-29");
/* THE ONE THAT MATTERS. `29082026` is a perfectly good Excel serial as far as
   `serialDate` is concerned, and it comes back as a date in the year 81000 — a
   wrong date, silently, in a column a person reads. The no-separator form is
   tried and validated first for exactly this. */
check("no separators at all", C.dvcDate("29082026"), "2026-08-29");
check("...and it is not read as a serial", C.dvcDate("29082026") < "2100-01-01", true);
// Out of a workbook the same column is a serial. 2026 dates are five digits.
check("an Excel serial", C.dvcDate("46262"), "2026-08-28");
check("an ISO date is already one", C.dvcDate("2026-08-28"), "2026-08-28");
/* Year-first is NOT read. As day-first it is day 20 of month 26, which fails
   validation, so it comes back untouched — unreadable rather than off by
   months. Same contract `serialDate` keeps: a date this cannot read is
   reported, never reformatted into a wrong one. */
check("year-first eight digits are refused, not guessed", C.dvcDate("20260829"), "20260829");
check("an impossible day is refused", C.dvcDate("40092026"), "40092026");
check("nothing is nothing", C.dvcDate(""), "");
check("junk is left alone", C.dvcDate("n/a"), "n/a");

console.log("\nthe booking number, as a key");
// BR10: Westpac permits "10 digits, numeric only", while the Tramada export is
// free to write the same booking in a cell formatted as text.
check("digits only", C.dvcBookingKey("140221"), "140221");
check("leading zeros are not a different booking", C.dvcBookingKey("0140221"), "140221");
check("spacing and punctuation are not either", C.dvcBookingKey(" 140-221 "), "140221");
// An empty key must never match anything — a blank booking number is BR08's
// exception, not a wildcard.
check("nothing numeric is no key at all", C.dvcBookingKey("N/A"), "");
check("blank is blank", C.dvcBookingKey(""), "");

console.log("\nBR11 — the segment abbreviations");
check("HOTEL", C.segmentAbbreviation("HOTEL"), "HTL");
// Neither of these is the first three letters, which is why BR11 is a lookup.
check("TRANSFER is TFR, not TRA", C.segmentAbbreviation("TRANSFER"), "TFR");
check("TOUR is TUR, not TOU", C.segmentAbbreviation("TOUR"), "TUR");
check("two words", C.segmentAbbreviation("AIR TICKET"), "TKT");
check("case and spacing do not matter", C.segmentAbbreviation(" air  ticket "), "TKT");
check("a type BR11 never named", C.segmentAbbreviation("MULTIPLE"), "");

console.log("\nstep 5's sense check has three answers, not two");
check("they agree", C.dvcSegmentAgrees("HOTEL", "HTL"), true);
check("they disagree", C.dvcSegmentAgrees("HOTEL", "TKT"), false);
/* ABSTAIN, NOT DISAGREE, and the distinction is the whole point: this check can
   only downgrade a match to "please look at it", so abstaining costs nothing
   and a wrong `false` puts somebody's afternoon on a row that was right. */
check("MULTIPLE is not in the table — no opinion", C.dvcSegmentAgrees("MULTIPLE", "HTL"), null);
check("COS is not in the table either", C.dvcSegmentAgrees("HOTEL", "COS"), null);
/* A package is ONE costing covering several segments — the client's booking
   130729 carries an HTL line and a PKG line against hotel charges on the same
   card. Calling PKG a disagreement would flag a large share of correct matches. */
check("a PACKAGE costing faces anything", C.dvcSegmentAgrees("HOTEL", "PKG"), null);
check("...and still agrees with PACKAGE", C.dvcSegmentAgrees("PACKAGE", "PKG"), true);
check("a blank has no opinion", C.dvcSegmentAgrees("", "HTL"), null);
check("neither does a blank costing", C.dvcSegmentAgrees("HOTEL", ""), null);

console.log("\nthe Westpac DVC report, both containers");
const wxlsx = XL.readSheet(fs.readFileSync(fixture("dvc-westpac.xlsx")));
const wcsv = C.csvGrid(fs.readFileSync(fixture("dvc-westpac.csv"), "utf8"));
const fromXlsx = C.parseDvcRows(wxlsx.headers, wxlsx.rows);
const fromCsv = C.parseDvcRows(wcsv.headers, wcsv.rows);
check("every line read", fromXlsx.rows.length, 21);
check("nothing held back", fromXlsx.problems, []);
check("BR01 is satisfied", fromXlsx.missingColumns, []);
// The workbook stores 136.30 as 136.30000000000001 and hands it back that way.
// Kept as cents and shown back as cents, the same fix Mint and TravelPay make.
check("the workbook's float noise is not what gets shown",
  fromXlsx.rows.find((r) => r.bookingNo === "140733").amount, "136.30");
check("a CSV reads the same as the workbook",
  fromCsv.rows.map((r) => [r.bookingNo, r.amount, r.segmentType, r.settlementDate, r.transactionDate]),
  fromXlsx.rows.map((r) => [r.bookingNo, r.amount, r.segmentType, r.settlementDate, r.transactionDate]));
// BR07 — refunds are the negative lines and nothing else marks them.
check("refunds are the negative lines",
  fromXlsx.rows.filter((r) => r.refund).map((r) => r.amount), ["-338.90", "-212.75"]);
/* A LINE WITH NO BOOKING NUMBER IS STILL A REAL CHARGE. Holding it back at
   upload is the mistake TravelPay and IPSI both made and both undid — the money
   was in the file, the screen showed nothing, and the only clue was a count in
   a note. It comes through carrying BR08's exception instead. */
const noBooking = fromXlsx.rows.filter((r) => !r.bookingKey);
check("a line with no booking number still arrives", noBooking.length, 1);
check("...and it is the consulate fee", noBooking[0].amount, "64.00");

console.log("\nthe cardholder name column is deleted before upload — step 1");
/* So the uploaded file is one column narrower than the sample and every index
   after position 2 moves. A positional reader would put the merchant in the
   settlement date and look entirely plausible doing it. Here the column is put
   BACK, and the answer has to be identical. */
{
  const at = 2;                                     // where PAX Name sits in the sample
  const headers = wcsv.headers.slice();
  headers.splice(at, 0, "PAX Name");
  const rows = wcsv.rows.map((r) => { const c = r.slice(); c.splice(at, 0, "Name"); return c; });
  const withName = C.parseDvcRows(headers, rows);
  check("the same rows, read by header name",
    withName.rows.map((r) => [r.bookingNo, r.amount, r.merchant, r.segmentType]),
    fromCsv.rows.map((r) => [r.bookingNo, r.amount, r.merchant, r.segmentType]));
}

console.log("\nBR01 says which columns must be there, and reports rather than refuses");
{
  /* A missing Segment Type only turns step 5's sense check off; a missing
     Consultant column only means the exception report cannot say whose booking
     it was. Refusing the whole file over either would stop a reconciliation
     that would otherwise have matched every line on booking and amount. */
  const drop = wcsv.headers.indexOf("SEGMENT TYPE");
  const headers = wcsv.headers.filter((_, i) => i !== drop);
  const rows = wcsv.rows.map((r) => r.filter((_, i) => i !== drop));
  const thin = C.parseDvcRows(headers, rows);
  check("the rows still come through", thin.rows.length, 21);
  check("and the missing column is named", thin.missingColumns, ["Segment type"]);
  // The amount is the one column there is no reconciliation without.
  const noAmount = C.parseDvcRows(["TRAMADA NUMBER", "SEGMENT TYPE"], [["140221", "HOTEL"]]);
  check("a file with no amount column is refused", noAmount.rows, []);
  ok("...and says which column", /transaction amount/.test(noAmount.problems[0].why),
    JSON.stringify(noAmount.problems));
}

console.log("\nTramada's Agency CC Reimbursement export, both containers");
const txlsx = XL.readSheet(fs.readFileSync(fixture("dvc-tramada.xlsx")));
const tcsv = C.csvGrid(fs.readFileSync(fixture("dvc-tramada.csv"), "utf8"));
const tFromXlsx = C.parseTramadaCcRows(txlsx.headers, txlsx.rows);
const tFromCsv = C.parseTramadaCcRows(tcsv.headers, tcsv.rows);
check("every costing read", tFromXlsx.rows.length, 17);
check("nothing held back", tFromXlsx.problems, []);
/* The workbook stores the Segment Date as a serial (46262 in the client's own
   file) and the CSV export of the same sheet has it already formatted. Both
   have to land on the same day. */
check("a serial and a formatted date are the same day",
  tFromCsv.rows.map((r) => r.segmentDate), tFromXlsx.rows.map((r) => r.segmentDate));
check("and it is a real date", tFromXlsx.rows[0].segmentDate, "2026-09-04");
check("Balance Due is the amount", tFromXlsx.rows[0].amount, "612.40");
// The last part of "REF - PASSENGER - Supplier", for showing a person which
// costing was matched. Read for display, never for matching (BR03).
check("the supplier is pulled off the end of the description",
  tFromXlsx.rows[0].supplierName, "Staywell Harbour Inn");
// BR01: the supplier reference "is populated only on some lines and must not be
// treated as mandatory", so a costing without one is not a problem row.
check("a costing with no supplier reference is still a costing",
  tFromXlsx.rows.filter((r) => !r.supplierRef).length, 1);
{
  const orphan = C.parseTramadaCcRows(["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "", "100.00"], ["HTL", "140221", "n/a"], ["HTL", "140221", "100.00"]]);
  check("a costing with no booking, or no readable amount, is held back", orphan.rows.length, 1);
  check("and both are reported", orphan.problems.map((p) => p.why),
    ["no booking number", 'unreadable amount "n/a"']);
}

console.log("\nBR02 — one day at a time");
/* The client's own example workbook stacks a MONTH of daily reports in one
   sheet, 31/07 through 31/08, because that is what "drop the CSV into the
   relevant tab" produces over a month. Reconciling all of it would match
   August's cards against a Tramada export pulled for one day. */
const day = C.filterDvcSettlementDate(fromXlsx.rows, "2026-09-04");
check("only the day being run", day.rows.length, 19);
check("the rest are said out loud, not dropped", day.excluded.length, 2);
ok("and each says why", day.excluded.every((r) => /settled 2026-09-03, not 2026-09-04/.test(r.why)),
  JSON.stringify(day.excluded.map((r) => r.why)));
// An unreadable date is not evidence the row belongs to some OTHER day.
check("a row whose date cannot be read is kept",
  C.filterDvcSettlementDate([{ settlementDate: "n/a" }], "2026-09-04").rows.length, 1);
check("no date wanted, nothing filtered",
  C.filterDvcSettlementDate(fromXlsx.rows, "").rows.length, 21);

console.log("\nBR05's arithmetic, on its own");
{
  const items = [{ amountCents: 61250 }, { amountCents: 51960 }, { amountCents: 31620 }];
  check("three that add up", C.dvcSubsetSum(items, 144830, 5).picked.length, 3);
  check("two that do not", C.dvcSubsetSum(items, 99999, 5).picked, null);
  // Smallest subsets first, so a pair that adds up beats a triple that also does.
  check("a pair is preferred over a triple",
    C.dvcSubsetSum([{ amountCents: 100 }, { amountCents: 200 }, { amountCents: 300 }], 300, 5).picked.length, 2);
  /* SAME SIGN ONLY. A refund and a charge that happen to net to the DVC amount
     is arithmetic, not a reconciliation — without this a -739.20 refund and an
     869.20 hotel would "explain" a 130.00 transfer on the same booking. */
  check("a refund and a charge never net to an answer",
    C.dvcSubsetSum([{ amountCents: -73920 }, { amountCents: 86920 }], 13000, 5).picked, null);
  /* A search that runs out of budget says EXHAUSTED rather than "no combination
     exists". Those are different claims and only one of them is true — and the
     run says "could not be checked", not "not matched". */
  const wide = Array.from({ length: 18 }, (_, i) => ({ amountCents: 1000 + i }));
  const broke = C.dvcSubsetSum(wide, 999999, 5, { budget: 50 });
  check("a budget that runs out is not a 'no'", broke, { picked: null, exhausted: true });
  check("BR05's breakdown reads like a sum",
    C.dvcBreakdown(items), "612.50 + 519.60 + 316.20 = 1448.30");
}

console.log("\nthe whole reconciliation, line by line");
const run = C.reconcileDvc(day.rows, tFromXlsx.rows);
const verdict = (booking) => {
  const r = run.rows.find((x) => x.bookingNo === booking);
  return [r.matched, C.dvcRemarksCell(r)];
};

check("a clean match says nothing at all", verdict("140221"), [true, ""]);
// BR04 allows five cents per transaction. 288.55 against a 288.52 costing is
// three, so it matches and carries no remark.
check("three cents is inside BR04's five", verdict("140255"), [true, ""]);
/* Step 5 DOWNGRADES a match, it never refuses one. The costing is a TKT and the
   card says TOUR, so the amounts still reconcile and a person still looks. */
check("a segment type that does not line up is a downgrade, not a refusal",
  verdict("140310"), [true, "Please check: segment type does not match the costing type — TOUR against TKT"]);
// BR06 — 3% of the COSTING, not of the charge: those are different numbers and
// the fee was calculated on the costing.
check("the merchant fee, exactly 3%", verdict("140344"), [true, "Amount + Merchant Fee — 1200.00 + 36.00"]);
check("the merchant fee where 3% is not a whole cent", verdict("140358"), [true, "Amount + Merchant Fee — 93.97 + 2.82"]);
// BR05, step 6 — one card charge covering three costings on one booking.
check("one charge over several costings, with the breakdown",
  verdict("140402"), [true, "Please check: multiple transaction amount found in Tramada — 612.50 + 519.60 + 316.20 = 1448.30"]);
// BR05, step 7 — three seat charges against one air costing.
{
  const seats = run.rows.filter((r) => r.bookingNo === "140466");
  check("several charges against one costing — all three matched", seats.map((r) => r.matched), [true, true, true]);
  check("...and all three carry the same breakdown",
    [...new Set(seats.map((r) => C.dvcRemarksCell(r)))],
    ["Please check: multiple transaction amount found in Tramada — 84.00 + 84.00 + 42.00 = 210.00"]);
  check("...against the one costing", [...new Set(seats.map((r) => r.tramadaAmounts.join()))], ["210.00"]);
}
// BR07 — a refund is matched exactly like any other line; only its sign decides
// what an unmatched one is called.
check("a refund that matches", verdict("140501"), [true, ""]);
check("a refund with no Tramada entry", verdict("140588"), [false, "Refund not found in Tramada"]);
check("a charge whose booking is not in the export", verdict("140612"), [false, "Booking number not found"]);
check("a line with no booking number at all", verdict(""), [false, "Booking number not found"]);
/* BR06's "all other amount errors are noted separately". 980.00 against 845.00
   is 135.00 out and 3% of 845.00 is 25.35, so this is not a fee. The nearest
   unmatched costing goes in the remark so the person opening the row is not
   left to find it themselves. */
check("an amount error that is not the fee", verdict("140644"), [false, "Amount not match — Tramada 845.00, DVC 980.00"]);
check("the booking is there, the costing type is not", verdict("140701"), [false, "Costing not found — CRUISE → CRU"]);
/* BR09 — A DEPOSIT IS NOT AN AMOUNT ERROR. $500 on the card against a $2,000
   costing used to come back "Amount not match", which is true and useless:
   there is nothing to investigate, and what Travel Accounts needs to be told is
   that the amount goes in by hand and the row must NOT be ticked, because
   ticking auto-fills the full 2,000. RAA's own example, 22-09-2026. */
check("a part payment says so, and is not called an amount error",
  verdict("140966"), [false, "Please check: deposit or incorrect amount — DVC 500.00 against a 2000.00 costing, 1500.00 short"]);
ok("...and says not to tick it",
  /by hand; do NOT tick the row/.test(run.rows.find((r) => r.bookingNo === "140966").why),
  run.rows.find((r) => r.bookingNo === "140966").why);
/* A charge LARGER than the costing is still an amount error — pass 3 has
   already taken the 3% fees, so there is nothing left to explain it. */
check("a charge bigger than the costing is still an error", verdict("140644"),
  [false, "Amount not match — Tramada 845.00, DVC 980.00"]);
check("a workbook's float noise still matches", verdict("140733"), [true, ""]);
check("a PACKAGE costing takes a HOTEL charge without complaint", verdict("140777"), [true, ""]);
check("so does a segment type BR11 never named", verdict("140812"), [true, ""]);

check("the tally", run.summary, {
  total: 19, matched: 6, matchedForReview: 7, merchantFee: 2, multiple: 4,
  unmatched: 6, refunds: 2, unmatchedRefunds: 1,
  // BR09/step 14 — only the clean matches are tickable. A remark means a person.
  tickableCents: 183350,
});

/* Costings nobody claimed. Not an error on its own — the Tramada range is two
   days wider than the report (BR13) — but step 19 sends a human looking for
   exactly these, so the exception report has to show them. */
check("the Tramada costings nothing paid",
  run.unmatchedTramada.map((t) => [t.bookingNo, t.amount]),
  [["140644", "845.00"], ["140701", "640.00"], ["140966", "2000.00"], ["140901", "455.75"]]);

console.log("\nthe CSV of both files reconciles identically");
{
  const same = C.reconcileDvc(C.filterDvcSettlementDate(fromCsv.rows, "2026-09-04").rows, tFromCsv.rows);
  check("same verdicts", same.rows.map((r) => [r.matched, C.dvcRemarksCell(r)]),
    run.rows.map((r) => [r.matched, C.dvcRemarksCell(r)]));
  check("same tally", same.summary, run.summary);
}

console.log("\nthe order of the passes is the design");
{
  /* A BOOKING HOLDING TWO COSTINGS OF THE SAME MONEY. With one sweep instead of
     two, the HOTEL charge would take whichever costing happened to be first in
     the file, the AIR TICKET charge would take the other, and BOTH would be
     flagged for review. Taking the segment-agreeing pairs first leaves each
     line with the costing it belongs to and nobody has to look at either. */
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150001", "500.00", "AIR TICKET"], ["150001", "500.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "150001", "500.00"], ["TKT", "150001", "500.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("each charge takes the costing of its own segment type",
    out.rows.map((r) => [r.segmentType, r.tramadaAmounts.join(), C.dvcRemarksCell(r)]),
    [["AIR TICKET", "500.00", ""], ["HOTEL", "500.00", ""]]);
}
{
  /* A COSTING THAT ABSTAINS BEATS ONE THAT DISAGREES. Taking whichever
     candidate happened to be first in the file put "please check: segment type
     does not match" on a row that had a perfectly unobjectionable PKG costing
     sitting one line below it. The disagreeing costing is still taken when it
     is all there is — see the CRUISE line in the fixtures. */
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150008", "500.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["TKT", "150008", "500.00"], ["PKG", "150008", "500.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("the package is taken over the air ticket, and nobody is asked to look",
    [out.rows[0].matched, C.dvcRemarksCell(out.rows[0]), out.unmatchedTramada.map((t) => t.segType)],
    [true, "", ["TKT"]]);
}
{
  /* AN EXACT MATCH MUST NOT BE EATEN BY A SUBSET-SUM THAT ALSO WORKS. 300.00 is
     both a costing in its own right and 100.00 + 200.00, and the passes run in
     the document's order so the exact match is made before anything speculative
     is tried. Reverse them and a correct line reconciles wearing a
     "please check" it never needed. */
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150002", "300.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "150002", "100.00"], ["HTL", "150002", "200.00"], ["HTL", "150002", "300.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("the exact costing wins over the pair that also adds up",
    [out.rows[0].tramadaAmounts.join(), C.dvcRemarksCell(out.rows[0])], ["300.00", ""]);
}
{
  /* TWO GROUPS ON ONE BOOKING. An outbound and a return, each charged per
     passenger. Stopping at the first group found would leave the second set of
     charges to land in the last pass as "Amount not match" — a wrong answer
     rather than a missing one. */
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150003", "40.00", "AIR TICKET"], ["150003", "40.00", "AIR TICKET"],
     ["150003", "75.00", "AIR TICKET"], ["150003", "75.00", "AIR TICKET"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["TKT", "150003", "80.00"], ["TKT", "150003", "150.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("both groups are found", out.rows.map((r) => r.matched), [true, true, true, true]);
  check("and each names its own costing",
    out.rows.map((r) => r.tramadaAmounts.join()), ["80.00", "80.00", "150.00", "150.00"]);
  check("nothing is left over", out.unmatchedTramada, []);
}
{
  /* WHICH COSTING THE AMOUNT ERROR IS MEASURED AGAINST. On a booking holding a
     200.00 hotel and a 995.00 air ticket, a 1000.00 HOTEL charge is nearest the
     air ticket in pure arithmetic — and that is the wrong costing to put in
     front of somebody. The remark names the closest costing OF THE SEGMENT TYPE
     the card says it paid for. */
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150009", "1000.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "150009", "200.00"], ["TKT", "150009", "995.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("the amount error is measured against the hotel, not the nearest number",
    C.dvcRemarksCell(out.rows[0]), "Amount not match — Tramada 200.00, DVC 1000.00");
}
{
  // A refund 3% "over" a charge is not a merchant fee, and the sign check in
  // the fee pass is what stops it being read as one.
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150004", "-103.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "150004", "100.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("a refund never matches a charge as a merchant fee",
    [out.rows[0].matched, C.dvcRemarksCell(out.rows[0])],
    [false, "Amount not match — Tramada 100.00, DVC -103.00"]);
}
{
  // A refund against a refund, with the fee on top, still works — the fee is
  // tested on the magnitudes and the signs have to agree.
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150005", "-103.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"],
    [["HTL", "150005", "-100.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("a refunded merchant fee", C.dvcRemarksCell(out.rows[0]), "Amount + Merchant Fee — -100.00 + 3.00");
}
{
  // BR15 — nothing here resolves a mismatch or moves an amount. A row that the
  // rules cannot settle comes back carrying the money the file gave it.
  const dvc = C.parseDvcRows(
    ["TRAMADA NUMBER", "TRANSACTION AMOUNT (AUD)", "SEGMENT TYPE"],
    [["150006", "980.00", "HOTEL"]]).rows;
  const tram = C.parseTramadaCcRows(
    ["Seg. Type", "Booking No.", "Balance Due"], [["HTL", "150006", "845.00"]]).rows;
  const out = C.reconcileDvc(dvc, tram);
  check("an unresolved row still carries its own amount", out.rows[0].amount, "980.00");
  check("and claims no costing", out.rows[0].tramadaAmounts, []);
}
{
  // A row that reached the matcher with an amount nobody could read is settled
  // before any pass touches it — NaN compares false everywhere and would have
  // landed it in the last pass wearing the wrong sentence.
  const out = C.reconcileDvc(
    [{ bookingNo: "150007", bookingKey: "150007", amount: "n/a", amountCents: null, segmentType: "HOTEL" }],
    []);
  check("an unreadable amount is its own answer", C.dvcRemarksCell(out.rows[0]), "Amount not match");
  ok("...and says so", /could not be read/.test(out.rows[0].why), out.rows[0].why);
}

console.log("\nstep 15 / BR04 — the report's own total");
{
  const t = C.checkDvcTotal(day.rows, "8686.84");
  check("to the cent", [t.checked, t.ok, t.fileCents], [true, true, 868684]);
  // Fifty cents across the whole report, not five: five cents is ONE
  // transaction's allowance and this is nineteen of them.
  check("forty cents out is inside the allowance", C.checkDvcTotal(day.rows, "8687.24").ok, true);
  check("fifty exactly is still inside", C.checkDvcTotal(day.rows, "8687.34").ok, true);
  const over = C.checkDvcTotal(day.rows, "8688.00");
  check("fifty-one is not", over.ok, false);
  check("and it says which remark", over.remark, "Total transaction amount does not match");
  /* "Not entered" and "does not match" are different claims and the person needs
     to hear which one. A blank is not a failure. */
  check("nothing entered is not a failure", C.checkDvcTotal(day.rows, "").checked, false);
}

console.log("\nthe Remarks column is a closed vocabulary");
{
  const known = new Set(Object.values(C.DVC_REMARKS));
  const said = run.rows.map((r) => r.remark).filter(Boolean);
  ok("every remark a run produces is in DVC_REMARKS",
    said.every((r) => known.has(r)), said.filter((r) => !known.has(r)).join(" | "));
  // The cell is the vocabulary term, then BR05's breakdown — never the other
  // way round, or the column cannot be filtered or counted.
  check("the cell leads with the term",
    C.dvcRemarksCell({ remark: "Amount not match", detail: "Tramada 845.00, DVC 980.00" }),
    "Amount not match — Tramada 845.00, DVC 980.00");
  check("no remark, no cell", C.dvcRemarksCell({ remark: "", detail: "x" }), "");
  check("no detail, just the term", C.dvcRemarksCell({ remark: "Costing not found" }), "Costing not found");
}

console.log("\nBR12 and BR13 — the Issue Payment parameters");
check("the payment category", C.DVC_PAYMENT_PARAMETERS.paymentCategory, "Agency CC Reimbursement");
check("the bank account", C.DVC_PAYMENT_PARAMETERS.bankAccount, "Trust Account");
check("both level branches stay blank",
  [C.DVC_PAYMENT_PARAMETERS.levelBranch1, C.DVC_PAYMENT_PARAMETERS.levelBranch2], ["", ""]);
check("sorted by booking number, ascending",
  [C.DVC_PAYMENT_PARAMETERS.sortBy, C.DVC_PAYMENT_PARAMETERS.sortOrder], ["Booking number", "Ascending"]);
/* §4 — CARD NUMBERS NEVER GO ANYWHERE NEAR THIS PROJECT. BR12 names the DVC
   card as a masked number; it is passed in per run instead, and docs/dvc.md
   carries the value Finance selects. This check is what stops somebody
   "completing" the object above by pasting it in. */
ok("no card number is written down here",
  !Object.values(C.DVC_PAYMENT_PARAMETERS).some((v) => /\d{4}/.test(String(v))),
  JSON.stringify(C.DVC_PAYMENT_PARAMETERS));

// BR13 — two days before the statement date, through to today. The wider range
// catches transactions a consultant entered late.
check("the segment-created range", C.dvcDateRange("2026-09-04", "2026-09-06"),
  { from: "2026-09-02", to: "2026-09-06" });
check("it crosses a month end", C.dvcDateRange("2026-03-01", "2026-03-01").from, "2026-02-27");
// An unreadable date comes back with an empty From, never a guessed one: a
// wrong From is a search that quietly misses transactions.
check("an unreadable date gives no From", C.dvcDateRange("n/a", "2026-09-06").from, "");

console.log("\nstep 16 — the payment session label");
// DD/MM/YYYY, and deliberately not this project's usual ISO: a person reopens
// this session from a list in Tramada tomorrow morning.
check("the session name", C.dvcSessionLabel("2026-09-04"), "DVC 04/09/2026");
check("it reads a Tramada-shaped date too", C.dvcSessionLabel("04-09-2026"), "DVC 04/09/2026");
// BR14 says save the session even where exceptions remain, so an unreadable
// date must not stop it — it just does not carry a date nobody entered.
check("no date, no invented date", C.dvcSessionLabel(""), "DVC");

console.log("\nthe report is registered, and cannot be swept into a browser run");
check("DVC is a report", C.REPORTS.dvc.title, "DVC card reconciliation");
check("it has no statement page", C.REPORTS.dvc.recPayType, null);
check("it issues no receipt", C.REPORTS.dvc.issuesReceipt, false);
check("it runs offline", C.REPORTS.dvc.offline, true);
check("it takes two files", Object.keys(C.REPORTS.dvc.pairs), ["westpac", "tramada"]);
check("and it has a place in the run order", C.RUN_ORDER.includes("dvc"), true);
/* `matcherFor` defaults to Mint's matcher for an unknown report, which for DVC
   would match a card line against the Reference column of a page its
   transactions can never appear on and then report the FILE as wrong. Reaching
   it at all means a caller routed a DVC run down the statement-page path. */
{
  let threw = "";
  try { C.matcherFor("dvc"); } catch (e) { threw = e.message; }
  ok("asking for a statement matcher refuses out loud", /does not reconcile against a statement page/.test(threw), threw);
}
/* The same guard in the combined run. `ownFlow` used to be "every report with
   no recPayType", which was only ever a description of IPSI — under that line a
   DVC file would have been handed to IPSI's receipts flow. */
{
  const src = fs.readFileSync(path.join(__dirname, "..", "recon-run.js"), "utf8");
  ok("the combined run buckets by what a report does, not by a missing field",
    /const ownFlow = order\.filter\(\(k\) => core\.REPORTS\[k\]\.issuesReceipt\)/.test(src),
    "ownFlow is back to !recPayType — a DVC file would be run through IPSI's receipts flow");
  ok("...and an unplaced report stops the run", /const unplaced = order\.filter/.test(src));
}

console.log("\nthe browser's copy of what a DVC card is");
{
  const wire = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
  /* The page numbers rows before the server ever sees them, so its RUN_ORDER
     has to be core's — `test-run-order.js` is what pins that. This is the other
     half: the card's OWN facts, which live only in the browser. */
  ok("the page declares a DVC card", /dvc: \{\s*\n\s*title: 'DVC card reconciliation'/.test(wire),
    "SOURCES has no dvc entry — the card would not be drawn at all");
  ok("...with a second slot, declared rather than special-cased",
    /pair: \{\s*\n\s*key: 'tramada'/.test(wire),
    "the second file is a special case in renderSource again — a third two-file report would half work");
  /* `source[kind]` means "loaded and runnable" and every reader of it assumes
     `.file.name`. The pair has to live outside it or dropping the Tramada
     export first puts a half-built entry in there. */
  ok("the second file is held outside `source`", /const pairFile = \{ dvc: null \}/.test(wire),
    "the pair is back in `source` — dropping the Tramada export first would have loaded() count a card that cannot run");
  ok("the run sends both files", /tramadaRows: \(pairFile\.dvc \|\| \{\}\)\.rows/.test(wire),
    "the DVC run frame carries only the Westpac rows — every line would come back 'Booking number not found'");
  ok("DVC runs alone, like IPSI", /const dvcCombo = \(\)/.test(wire));
  ok("...and the button is held while either file is missing", /dvcBad/.test(wire));
  /* THE PAGE THAT IS SERVED IS THE BUILT ONE. `public/index.html` is the mockup
     plus this wiring (`npm run build`), and the rendered checks below drive
     that file — so a wire edit with no rebuild would have them testing the
     previous version and failing somewhere confusing. Caught here instead,
     with the fix in the message. */
  const built = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  ok("public/index.html has been rebuilt from it",
    built.includes("const pairFile = { dvc: null }") && built.includes("const dvcCombo = ()"),
    "the served page is older than design/recon-wire.html — run `npm run build`");
}

console.log("\na wrong amount on a hotel + flight booking — a person decides (RAA, 23-09-2026)");
{
  /* The shape tools/make-dvc-bookings.js seeds into the sandbox: two bookings,
     each a flight + ticket costing + hotel, paid as two card charges. Both
     flights are right; one hotel was charged LESS than it costs, the other
     MORE. Used to read "part payment or deposit" on the first, which decided
     what only a person can know. */
  const W = ["ACCOUNT NUMBER", "SETTLEMENT DATE", "TRANSACTION AMOUNT (AUD)", "SUPPLIER REF",
    "TRAMADA NUMBER", "SEGMENT TYPE", "CARD NUMBER"];
  const T = ["Seg. Type", "Booking No.", "Supplier Reference - Passenger Name - Supplier/Hotel Name",
    "Segment Date", "Balance Due", "Supplier Reference No"];
  const w = [
    ["1", "24/09/2026", "236.40", "QF7K2M", "90001", "AIR TICKET", "XXXX-5190"],
    ["1", "24/09/2026", "150.00", "C2813455", "90001", "HOTEL", "XXXX-5191"],
    ["1", "24/09/2026", "198.00", "VA4R8T", "90002", "AIR TICKET", "XXXX-6208"],
    ["1", "24/09/2026", "214.50", "HB64102", "90002", "HOTEL", "XXXX-6209"],
  ];
  const t = [
    ["TKT", "90001", "QF7K2M - GRAY/SPIDER MS - Qantas", "24/09/2026", "236.40", "QF7K2M"],
    ["HTL", "90001", "C2813455 - GRAY/SPIDER MS - Park Plaza Victoria", "24/09/2026", "420.00", "C2813455"],
    ["TKT", "90002", "VA4R8T - GRAY/SPIDER MS - Virgin Australia", "24/09/2026", "198.00", "VA4R8T"],
    ["HTL", "90002", "HB64102 - GRAY/SPIDER MS - Ibis Sydney", "24/09/2026", "189.00", "HB64102"],
  ];
  const out = C.reconcileDvc(C.parseDvcRows(W, w).rows, C.parseTramadaCcRows(T, t).rows);
  const v = out.rows.map((r) => [r.amount, r.matched && !r.remark, C.dvcRemarksCell(r)]);
  check("both flights are clean", [v[0][1], v[2][1]], [true, true]);
  check("a hotel charged less is a deposit OR a wrong amount — the remark says both",
    v[1], ["150.00", false, "Please check: deposit or incorrect amount — DVC 150.00 against a 420.00 costing, 270.00 short"]);
  ok("...and the reason says only a person can tell", /Only a person can tell/.test(out.rows[1].why), out.rows[1].why);
  check("a hotel charged more, and not the 3% fee, is an amount error",
    v[3], ["214.50", false, "Amount not match — Tramada 189.00, DVC 214.50"]);
  ok("...which cannot be a deposit, and says so", /it is not a deposit/.test(out.rows[3].why), out.rows[3].why);
  /* RAA's DRAWING: the two hotels are spreadsheet errors, so the day goes back
     to a person by email and nothing goes into Tramada — not even the two
     right flights. The corrected re-upload is the run that reaches Tramada. */
  check("the day does not reconcile", C.dvcReconciliationIsGreen(out.summary).green, false);
  check("...so Tramada is not opened", C.dvcTramadaGate(out.summary).open, false);

  /* The two hotel costings go unclaimed too. The email used to list them as
     BR13's harmless leftovers — the very costings a person has to check. */
  const mail = C.dvcEmail({ statementDate: "2026-09-24", summary: out.summary, rows: out.rows,
    unmatchedTramada: out.unmatchedTramada, payment: null });
  ok("the email names both hotels as exceptions", /booking 90001 \$150\.00/.test(mail.text) &&
    /booking 90002 \$214\.50/.test(mail.text), mail.text);
  ok("...and never calls their costings expected leftovers", !/nothing on the report paid/.test(mail.text), mail.text);
  ok("...and counts them as two lines, not one thing", /found 2 lines that do not reconcile/.test(mail.text), mail.text);
}

/* The tally, from one place. The rendered-card block below finishes
   asynchronously, so "print the totals and exit" cannot simply be the last
   statement in the file. */
function finish() {
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

console.log("\nthe card itself, rendered");
{
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
  if (!JSDOM) {
    console.log("  -- jsdom not installed, skipping (npm i -D jsdom to run these)");
    finish();
  } else {
    const page = path.join(__dirname, "..", "public", "index.html");
    const sent = [];
    let sock = null;
    /* The page's own WebSocket, replaced before the script runs. Nothing here
       is a mock of the server: the frames it sends are captured as they are,
       and the answers fed back are built by the same recon-core calls
       `handleReconParse` makes. The point is the CARD's behaviour — that the
       right file reaches the right parser and both halves reach the run. */
    class FakeWS {
      constructor(url) {
        this.url = url; this.readyState = 1; sock = this;
        setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
      }
      send(s) { sent.push(JSON.parse(s)); }
      close() { this.readyState = 3; }
      addEventListener(t, f) { this["on" + t] = f; }
    }
    const dom = new JSDOM(fs.readFileSync(page, "utf8"), {
      runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost:3000/",
      beforeParse(w) {
        w.WebSocket = FakeWS;
        // The overview screen fetches its own data on load; jsdom has no fetch.
        w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      },
    });
    const W = dom.window, D = W.document;
    const $$ = (sel) => D.querySelector(sel);
    const drop = (el, name, text) => {
      const ev = new W.Event("drop", { bubbles: true });
      Object.defineProperty(ev, "dataTransfer", { value: { files: [new W.File([text], name, { type: "text/csv" }) ] } });
      el.dispatchEvent(ev);
    };
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    // The answer the server would send back, built by the parser it would use.
    const parsed = (source, part, name, out, format) => ({
      type: "recon_parsed", source, part, name,
      rows: out.rows, problems: out.problems, columns: out.columns,
      missingColumns: out.missingColumns || [], format,
    });

    (async () => {
      await tick(400);
      /* RE-QUERIED EVERY TIME. `renderSource` rebuilds `#tileGrid`'s innerHTML,
         so a node held across a render is a detached copy of the old card — it
         still answers questions, with yesterday's answers. */
      const card = () => $$('.dz[data-kind="dvc"]');
      const slot = () => $$('[data-kind-part="dvc:tramada"]');
      ok("the DVC card is on the Sources screen", !!card());
      check("every report has a card",
        [...D.querySelectorAll(".dz[data-kind]")].map((e) => e.dataset.kind), C.RUN_ORDER);
      ok("and it has a second slot for the Tramada export", !!slot());
      ok("which says it is still needed", /needed/.test(slot() ? slot().textContent : ""));

      /* THE TRAMADA EXPORT GOES TO THE TRAMADA PARSER. Dropped on the slot, it
         must carry `part` — without it the server reads it with the Westpac
         parser and refuses a perfectly well-formed file as "the sheet has no
         column for: transaction amount (aud)". */
      drop(slot(), "dvc-tramada.csv", fs.readFileSync(fixture("dvc-tramada.csv"), "utf8"));
      await tick(150);
      check("the second slot's upload says which file it is",
        sent.filter((f) => f.type === "recon_parse").map((f) => [f.source, f.part]), [["dvc", "tramada"]]);
      sock.onmessage({ data: JSON.stringify(parsed("dvc", "tramada", "dvc-tramada.csv", tFromCsv, "csv")) });
      await tick(50);

      /* HALF AN UPLOAD IS NOT A RUN. Nothing is "loaded" yet — the Westpac
         report is the report — so Start stays disabled, and the card has to
         say what it is waiting for rather than sitting there silent. */
      check("the run cannot start on the Tramada export alone", $$("#startRun").disabled, true);
      const hint = $$('.rc-hint[data-hint="dvc"]');
      ok("and the card says which file is still missing",
        /Westpac DVC report is needed/.test(hint ? hint.textContent : ""),
        hint ? hint.textContent : "(no hint element)");
      ok("...while the slot that IS filled says so", /loaded/.test(slot().textContent));

      // Now the other half, dropped on the card itself.
      drop(card(), "dvc-westpac.csv", fs.readFileSync(fixture("dvc-westpac.csv"), "utf8"));
      await tick(150);
      const second = sent.filter((f) => f.type === "recon_parse")[1];
      check("the card's own upload carries no part", second && second.part, "");
      sock.onmessage({ data: JSON.stringify(parsed("dvc", "", "dvc-westpac.csv", fromCsv, "csv")) });
      await tick(50);

      const date = $$("#rcDate");
      if (date) { date.value = "2026-09-04"; date.dispatchEvent(new W.Event("input", { bubbles: true })); }
      await tick(50);
      check("with both files the run can start", $$("#startRun").disabled, false);

      $$("#startRun").click();
      await tick(80);
      const run = sent.find((f) => f.type === "recon_run");
      ok("a run was started", !!run);
      check("it is a DVC run", run && run.source, "dvc");
      /* BOTH FILES REACH THE SERVER. This is the check that matters: `rows` is
         the Westpac report and `tramadaRows` is the export it is matched
         against. Send only the first and the server reconciles a correct file
         against nothing. */
      check("carrying the Westpac report", run && run.rows.length, fromCsv.rows.length);
      check("and the Tramada export beside it", run && run.tramadaRows.length, tFromCsv.rows.length);

      dom.window.close();
      finish();
    })().catch((err) => {
      console.log(`  ✗ the rendered card threw: ${err && err.stack}`);
      process.exit(1);
    });
  }
}

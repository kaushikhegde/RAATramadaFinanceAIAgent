/**
 * recon-core.js — the two money decisions, offline.
 *
 * A run files real receipts against real bookings with no second gate, so the
 * rule that decides whether to allocate is the single most consequential piece
 * of logic in this feature. It is pure, and it is tested here against the
 * values the live pages actually produce.
 */
const C = require("../recon-core");
const ESC = String.fromCharCode(27);

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

console.log("\nmoney is counted in cents");
check("plain dollars", C.cents("150.00"), 15000);
check("Tramada's thousands separator", C.cents("1,056.93"), 105693);
check("a dollar sign", C.cents("$145.54"), 14554);
check("a CR suffix", C.cents("790.00 CR"), 79000);
check("whole dollars", C.cents("200"), 20000);
// Floats are why this returns integers. 1.15*100 is 114.99999999999999, and a
// comparison that said two equal amounts differ would file a matching receipt
// as unallocated.
check("no float drift at .15", C.cents("1.15"), 115);
check("nor at .29", C.cents("11.29"), 1129);
ok("a sum of awkward amounts still compares equal",
  C.cents("1.15") + C.cents("11.29") === C.cents("12.44"));
// Unreadable is null, never 0 — a silent zero makes an unmatched amount look
// matched and allocates a receipt that should have been left alone.
check("junk is null, not zero", C.cents("n/a"), null);
check("blank is null", C.cents(""), null);
check("a stray word is null", C.cents("790.00 approx"), null);

console.log("\nreferences compare on case and spacing only");
check("case is ignored", C.refKey("VIX122334"), C.refKey("vix122334"));
check("runs of spaces collapse", C.refKey("Trip File  Tsfr 1105"), "trip file tsfr 1105");
check("surrounding space is trimmed", C.refKey("  NW  "), "nw");
// Nothing else is stripped. A normaliser that dropped punctuation would make
// every deposit for Jill Shields collide with every other one.
ok("punctuation is kept", C.refKey("Deposit - Jill Shields") !== C.refKey("Deposit Jill Shields"));
ok("digits are kept", C.refKey("VIX122334") !== C.refKey("VIX"));

console.log("\nreading the import CSV");
{
  // Verbatim from the file statement-csv.js writes.
  const csv = [
    "Date,Reference,Rec/Pay Type,Amount,Booking No",
    "2021-11-01,Deposit - Jill Shields,Debtor Payment Receipt,150.00,13201",
    '2021-11-20,"Trip File Tsfr, part 2",Debtor Payment Receipt,200.00,13202',
    "2021-11-24,NW,Debtor Payment Receipt,200.00,13203",
  ].join("\n");
  const { rows, problems } = C.parseReconCsv(csv);
  check("every row is read", rows.length, 3);
  check("no problems", problems.length, 0);
  check("the amount becomes cents", rows[0].amountCents, 15000);
  check("the booking number comes through", rows[0].bookingNo, "13201");
  // A quoted comma must stay inside the reference, not split the row into six
  // fields and shift every value one to the left.
  check("a quoted comma stays in the reference", rows[1].reference, "Trip File Tsfr, part 2");
  check("and the amount after it is still the amount", rows[1].amountCents, 20000);
}
{
  // Columns are found by HEADER NAME. This file is hand-editable, and a column
  // inserted in the middle would otherwise shift every amount silently — on a
  // file that files receipts, every row would still look plausible.
  const shifted = [
    "Date,Shop,Reference,Rec/Pay Type,Amount,Booking No",
    "2021-11-01,Adelaide,Deposit - Jill Shields,Debtor Payment Receipt,150.00,13201",
  ].join("\n");
  const { rows } = C.parseReconCsv(shifted);
  check("an inserted column doesn't shift the amount", rows[0].amountCents, 15000);
  check("nor the booking number", rows[0].bookingNo, "13201");
  check("column order doesn't matter",
    C.parseReconCsv("Booking No,Amount,Reference,Date,Rec/Pay Type\n13201,150.00,NW,2021-11-01,Debtor Payment Receipt").rows[0].amountCents, 15000);
}
{
  const { rows, problems } = C.parseReconCsv(
    "Date,Reference,Rec/Pay Type,Amount,Booking No\n" +
    "2021-11-01,,Debtor Payment Receipt,150.00,13201\n" +
    "2021-11-02,NW,Debtor Payment Receipt,n/a,13202\n" +
    "2021-11-03,PROMO,Debtor Payment Receipt,100.00,\n"
  );
  // A row that can't be acted on is never quietly dropped — the UI has to be
  // able to show it, or the run looks like it did less than it was asked to.
  check("unusable rows are held back", rows.length, 0);
  check("and all three are reported", problems.length, 3);
  ok("the missing reference is named", /no reference/.test(problems[0].why), problems[0].why);
  ok("the unreadable amount is named", /unreadable amount/.test(problems[1].why), problems[1].why);
  ok("the missing booking is named", /no booking number/.test(problems[2].why), problems[2].why);
  check("problems carry the line number", problems[0].line, 2);
}
// Rec/Pay Type is optional — the guide's own BPay file has no such column, and
// nothing decides on it. A missing booking number column still refuses the file.
check("a missing header is refused outright",
  C.parseReconCsv("Date,Reference,Amount\n2021-11-01,NW,1.00").problems[0].why,
  "the header is missing: bookingNo");
check("an empty file is refused", C.parseReconCsv("").problems.length, 1);

console.log("\nwhat is left to allocate");
// Shape from readAllocatableSegments() in tramada-receipt.js.
const seg = (due) => ({ segId: "1", segType: "HTL", reference: "x", debtorDue: due });
check("one segment", C.totalLeftToAllocate([seg("220.00")]), 22000);
check("several are summed", C.totalLeftToAllocate([seg("220.00"), seg("330.00")]), 55000);
check("Tramada's commas survive the sum", C.totalLeftToAllocate([seg("1,056.93")]), 105693);
// A due that can't be read makes the TOTAL unreadable rather than being counted
// as zero — otherwise an unmatched amount looks matched.
check("one unreadable due poisons the total", C.totalLeftToAllocate([seg("220.00"), seg("")]), null);
check("no segments at all is null, not zero", C.totalLeftToAllocate([]), null);

console.log("\ndecision 1 — which WHOLE segments the receipt settles");
{
  /* BR07–BR11 are covered rule by rule in test-bpay-rules.js. What is kept
     here are the INVARIANTS that hold whatever the rule says: no segment is
     ever part-paid, and no allocation ever exceeds the receipt. Those are what
     stop the form's Unalloc going negative, and they must survive any future
     change to which boxes get ticked. */
  const two = [{ segId: "A", debtorDue: "200.00" }, { segId: "B", debtorDue: "200.00" }];

  const over = C.decideAllocation(50000, two);
  check("500 takes both segments", over.allocation, "ALL");
  check("but is only PART allocated — 100 of the receipt is left", over.status, "Part allocated");
  ok("and the leftover is named", /\$100\.00 of this receipt stays unallocated/.test(over.reason), over.reason);

  // Changed deliberately, 17-Aug-2026: the guide's BR09 says an amount that is
  // neither one segment nor all of them is left alone for a person.
  const one = C.decideAllocation(30000, two);
  check("300 fits a combination but is not one segment nor all — ticks nothing", one.allocation, []);
  check("and is not allocated", one.status, "Not allocated");

  const exact = C.decideAllocation(20000, two);
  check("200 takes the segment it matches", exact.allocation, [{ segId: "A", amount: "200.00" }]);
  check("and that is a full allocation", exact.status, "Allocated");

  const none = C.decideAllocation(10000, two);
  check("100 takes nothing", none.allocation, []);
  check("the receipt is still filed, unallocated", none.status, "Not allocated");
  ok("and says the cheapest is still too big",
    /cheapest segment owes \$200\.00/.test(none.reason), none.reason);

  // Segments are NEVER part-paid. Every amount written is a segment's full due,
  // which is what ticking auto-fills — so no allocation box is ever typed with
  // a number Tramada did not put there itself.
  for (const [amt, segs] of [[30000, two], [79000, [{ segId: "H", debtorDue: "2160.00" }, { segId: "T", debtorDue: "250.00" }]]]) {
    const d = C.decideAllocation(amt, segs);
    if (Array.isArray(d.allocation)) {
      for (const a of d.allocation) {
        const seg = segs.find((s) => s.segId === a.segId);
        check(`segment ${a.segId} is settled in full, never part-paid`, a.amount, C.money(C.cents(seg.debtorDue)));
      }
    }
  }

  // Never exceed the receipt — this is what keeps the form's Unalloc from
  // going negative, and it is why "whole segments only" is safe at all.
  for (const amt of [1, 4999, 20000, 39999, 40000, 40001, 99999]) {
    const d = C.decideAllocation(amt, two);
    const placed = Array.isArray(d.allocation)
      ? d.allocation.reduce((n, a) => n + C.cents(a.amount), 0)
      : 40000;
    ok(`$${C.money(amt)} never allocates more than it is worth`, placed <= amt, `placed ${C.money(placed)}`);
  }

  // Not a greedy sweep: cheapest-first would settle the 50 and strand the rest.
  const pickBig = C.decideAllocation(20000, [{ segId: "S", debtorDue: "50.00" }, { segId: "L", debtorDue: "200.00" }]);
  check("200 against 50+200 settles the 200, not the 50",
    pickBig.allocation, [{ segId: "L", amount: "200.00" }]);
  check("exactly", pickBig.status, "Allocated");

  /* This used to settle the two hundreds rather than the one two-hundred, on a
     cheapest-first tie-break. BR07 removes the tie: "the exact same value as
     ONE of the segments" is a rule about a single segment, so the 200 wins and
     the ambiguity never arises. The old behaviour ticked two boxes a person
     reading the screen would not have ticked. */
  const tie = C.decideAllocation(20000, [
    { segId: "a", debtorDue: "100.00" }, { segId: "b", debtorDue: "100.00" }, { segId: "c", debtorDue: "200.00" },
  ]);
  check("one exact segment beats two that add up to it",
    tie.allocation, [{ segId: "c", amount: "200.00" }]);

  // Everything selected uses the proven Select All path rather than ticking
  // each row by hand.
  check("all segments means ALL", C.decideAllocation(40000, two).allocation, "ALL");
  check("and that is exact", C.decideAllocation(40000, two).status, "Allocated");

  // The refusals.
  check("nothing outstanding", C.decideAllocation(15000, []).status, "Not allocated");
  check("all segments at zero", C.decideAllocation(15000, [{ segId: "z", debtorDue: "0.00" }]).status, "Not allocated");
  const unreadable = C.decideAllocation(15000, [{ segId: "a", debtorDue: "200.00" }, { segId: "b", debtorDue: "" }]);
  check("an unreadable due refuses outright", unreadable.status, "Not allocated");
  ok("rather than treating it as zero", /could not be read/.test(unreadable.reason), unreadable.reason);
  check("an unreadable CSV amount", C.decideAllocation(null, two).status, "Not allocated");
}

console.log("\ndecision 2 — reconciled by RECEIPT NUMBER, or not");
{
  /* The match is receipt number → Trans. No, NOT reference → Reference.
     The receipt form hands back R.0000009403 and that same number is the
     reconciliation page's Trans. No. The reference is free text on rows this
     run did not create, so matching on it was checking the wrong thing against
     the wrong rows. Shape read off the reconcile screen, page 10. */
  const stmt = [
    { transNo: "R.0000009403", reference: "Deposit - Jill Shields", amount: "150.00" },
    { transNo: "R.0000009404", reference: "Trip File Tsfr 1105", amount: "200.00" },
    { transNo: "R.0000009405", reference: "VIX122334", amount: "145.54" },
  ];
  const row = (receiptNo, amt) => ({ receiptNo, amountCents: C.cents(amt), reference: "whatever" });

  const hit = C.matchAgainstStatement(row("R.0000009403", "150.00"), stmt);
  check("the receipt number and amount both match", hit.status, "Reconciled");
  check("and the transaction is named", hit.transNo, "R.0000009403");
  ok("and the reason names the receipt, not the reference",
    /receipt R\.0000009403/.test(hit.reason), hit.reason);

  // The reference is deliberately ignored now — these rows carry one that
  // matches nothing, and they still reconcile.
  check("a mismatched reference does not stop it",
    C.matchAgainstStatement({ receiptNo: "R.0000009404", amountCents: C.cents("200.00"), reference: "nothing like it" }, stmt).status,
    "Reconciled");

  // Machine-issued identifier, fixed shape: case and zero padding are noise.
  check("case is ignored", C.matchAgainstStatement(row("r.0000009405", "145.54"), stmt).status, "Reconciled");
  check("so is the zero padding", C.matchAgainstStatement(row("R9405", "145.54"), stmt).status, "Reconciled");
  check("receiptKey normalises", [C.receiptKey("R.0000009403"), C.receiptKey("r9403"), C.receiptKey("P.0000000155")],
    ["R9403", "R9403", "P155"]);
  // …but a payment and a receipt with the same digits are NOT the same thing.
  check("the letter still matters", C.receiptKey("P.0000009403") === C.receiptKey("R.0000009403"), false);

  const absent = C.matchAgainstStatement(row("R.0000000001", "1.00"), stmt);
  check("a receipt that isn't there is not reconciled", absent.status, "Not reconciled");
  // "It isn't there" and "it's there for a different amount" are different
  // problems with different fixes, so they never collapse into one message.
  ok("and says it is absent", /not among the transactions/.test(absent.reason), absent.reason);

  const wrongAmt = C.matchAgainstStatement(row("R.0000009405", "999.00"), stmt);
  check("right receipt, wrong amount is not reconciled", wrongAmt.status, "Not reconciled");
  ok("and reports what the statement actually says", /at \$145\.54/.test(wrongAmt.reason), wrongAmt.reason);

  // A row whose receipt failed has nothing to look for. Calling that "not
  // reconciled" without saying why blames the statement for a missing receipt.
  const noReceipt = C.matchAgainstStatement({ receiptNo: "", amountCents: 15000 }, stmt);
  check("a row with no receipt is not reconciled", noReceipt.status, "Not reconciled");
  ok("and says nothing was filed", /nothing to look for/.test(noReceipt.reason), noReceipt.reason);

  // Two transactions carrying one receipt number should not happen. It is how
  // a double posting hides, so it is counted and reported rather than ignored.
  const dupes = [...stmt, { transNo: "R.0000009405", reference: "elsewhere", amount: "145.54" }];
  const d = C.matchAgainstStatement(row("R.0000009405", "145.54"), dupes);
  check("a duplicate transaction number still reconciles", d.status, "Reconciled");
  check("and the duplication is surfaced", d.duplicates, 2);

  check("an empty statement reconciles nothing",
    C.matchAgainstStatement(row("R.0000009403", "150.00"), []).status, "Not reconciled");
}

console.log("\nthe shipped bookings.json actually exercises both paths");
{
  const fs = require("fs"), path = require("path");
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "bookings.json"), "utf8"));

  /* ONE SEGMENT, ONE COSTING — asserted, because a live run died of the
     alternative.

     The fixture used to give each booking a flight AND a hotel. A receipt
     raised for the costing's fare is allocated with "ALL", which clicks
     Tramada's Select All, which ticks EVERY row — the hotel included. On
     10-Aug-2026 all three TravelPay receipts came back

         Allocation cannot be greater than Amount Received

     (200.00 receipted, 200.00 + 60.00 allocated; 250.00 receipted, 250.00 +
     790.00 allocated). A flight carries no allocatable row of its own — its
     ticket costing is the row — so one flight plus one costing is exactly one
     row worth exactly the fare, and Select All cannot exceed the receipt by
     construction. This is here so that cannot drift back unnoticed. */
  check("three bookings", doc.bookings.length, 3);
  ok("every booking has exactly one segment",
    doc.bookings.every((b) => (b.segments || []).length === 1),
    JSON.stringify(doc.bookings.map((b) => (b.segments || []).length)));
  ok("and exactly one costing",
    doc.bookings.every((b) => (b.costings || []).length === 1),
    JSON.stringify(doc.bookings.map((b) => (b.costings || []).length)));
  ok("and no hotel to widen Select All past the fare",
    doc.bookings.every((b) => !(b.segments || []).some((s) => s.kind === "hotel")),
    JSON.stringify(doc.bookings.map((b) => (b.segments || []).map((s) => s.kind))));

  // What the receipt form will show: one row per costing, worth the fare.
  const books = doc.bookings.map((b, i) => {
    const out = [];
    const h = (b.segments || []).find((s) => s.kind === "hotel");
    if (h) out.push({ segId: `HTL${i}`, debtorDue: (h.rate * h.nights).toFixed(2) });
    for (const [n, c] of (b.costings || []).entries()) {
      out.push({ segId: `TKT${i}_${n}`, debtorDue: c.fare });
    }
    return out;
  });
  ok("so everything Select All can tick totals exactly the fare",
    books.every((rows, i) =>
      rows.reduce((a, r) => a + C.cents(r.debtorDue), 0) === C.cents(doc.bookings[i].costings[0].fare)),
    JSON.stringify(books));

  /* And the amounts are chosen, not arbitrary: with arbitrary fares every row
     comes back "Not allocated" and a run demonstrates nothing. The pairing
     below is a property of two files that can drift apart, so it is asserted
     rather than eyeballed. */
  // From statement-rows.json, not the CSV: the CSV's Booking No column is empty
  // until run-bookings.js has run, and parseReconCsv correctly refuses a row it
  // cannot act on — reading the CSV here would assert against zero rows.
  const scraped = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "statement-rows.json"), "utf8"));
  const amounts = scraped.map((r) => C.cents(r.amount));
  check("six statement rows", amounts.length, 6);

  // Walk the rows the way a run does: a settled segment goes to zero.
  const got = amounts.map((amt, i) => {
    const b = books[i % 3];
    const live = b.filter((s) => C.cents(s.debtorDue) > 0);
    const d = C.decideAllocation(amt, live);
    if (Array.isArray(d.allocation)) {
      for (const a of d.allocation) {
        const s = b.find((x) => x.segId === a.segId);
        if (s) s.debtorDue = "0.00";
      }
    } else if (d.allocation === "ALL") b.forEach((s) => { s.debtorDue = "0.00"; });
    return d.status;
  });

  check("the run comes back mixed, not uniform",
    got, ["Part allocated", "Allocated", "Not allocated", "Not allocated", "Not allocated", "Allocated"]);
  ok("all three outcomes appear", new Set(got).size === 3, JSON.stringify(got));
}

console.log("\nthe new statement page is always a new one");
// Read off the live search screen: Trust Account holds pages 1–9.
check("after 1–9 comes 10", C.nextPageNumber([9, 8, 7, 6, 5, 4, 3, 2, 1]), 10);
check("order doesn't matter", C.nextPageNumber([1, 9, 5]), 10);
check("the search screen's own row shape works", C.nextPageNumber([{ pageNo: "9" }, { pageNo: "8" }]), 10);
check("no statements yet means page 1", C.nextPageNumber([]), 1);
// A second run in the same day must land AFTER the page the first run made,
// which is why this is derived from the search screen every time rather than
// remembered.
check("a run after page 10 goes to 11", C.nextPageNumber([10, 9, 8]), 11);
check("junk page numbers are ignored", C.nextPageNumber(["", "n/a", 9]), 10);

console.log("\ndates go to Tramada the way Tramada writes them");
check("ISO becomes dd-mm-yyyy", C.toTramadaDate("2026-08-07"), "07-08-2026");
check("already dd-mm-yyyy is left alone", C.toTramadaDate("07-08-2026"), "07-08-2026");

console.log("\nthe run's summary");
{
  const results = [
    { allocation: "Allocated", reconciliation: "Reconciled" },
    { allocation: "Allocated", reconciliation: "Not reconciled" },
    { allocation: "Not allocated", reconciliation: "Reconciled" },
    { allocation: "Not allocated", reconciliation: "Not reconciled" },
    { allocation: "Not allocated", reconciliation: "Not reconciled", error: "boom" },
  ];
  const s = C.summarise(results);
  check("totals", [s.total, s.allocated, s.notAllocated], [5, 2, 3]);
  check("reconciled counts", [s.reconciled, s.notReconciled], [2, 3]);
  check("both is the fully-clean count", s.both, 1);
  check("failures are counted separately", s.failed, 1);
}


console.log("\nerrors are made fit to show a person");
{
  const CALL_LOG =
    "Could not connect to Chrome on 127.0.0.1:9222. Run \"npm run start:chrome\" and " +
    "sign into Tramada in that window first. [browserType.connectOverCDP: connect " +
    "ECONNREFUSED 127.0.0.1:9222\nCall log:\n" + ESC + "[2m  - <ws preparing> retrieving " +
    "websocket url from http://127.0.0.1:9222" + ESC + "[22m\n]";
  const tidy = C.tidyError(CALL_LOG);
  check("the call log is cut off", tidy.includes("Call log"), false);
  check("no colour codes survive", tidy.includes(ESC), false);
  check("the sentence a person needs is kept",
    tidy.startsWith("Could not connect to Chrome on 127.0.0.1:9222."), true);
  // A wrapper embeds the inner failure as [${err.message}], and the cut lands
  // inside it. The bracket gets closed rather than left hanging.
  check("the bracket is closed", tidy.endsWith("…]"), true);
  check("brackets balance",
    (tidy.match(/\[/g) || []).length, (tidy.match(/\]/g) || []).length);

  check("a plain message is untouched",
    C.tidyError("Timed out waiting for a Tramada login."), "Timed out waiting for a Tramada login.");
  check("nothing in, nothing out", [C.tidyError(""), C.tidyError(null), C.tidyError(undefined)], ["", "", ""]);

  // What intercepted the click is the one line of the log worth keeping —
  // an overlay in the way and a wrong selector look identical without it.
  check("the blocker is named",
    C.tidyError("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - <div class=\"x\"></div> intercepts pointer events"),
    "locator.click: Timeout 30000ms exceeded. (blocked by <div>)");

  // A table cell, not a terminal.
  check("very long messages are capped", C.tidyError("x".repeat(900)).length <= 400, true);
}


console.log("\ngrid columns are found by header name");
{
  // Captured off the live Bank Statements search grid, 07-08-2026. The leading
  // Action column of icon links is the whole point: counting from zero puts
  // pageNo on "TRUST".
  const HEAD = ["Action", "Bank Account", "Page No", "Statement Date",
    "Opening Balance", "Closing Balance", "Period Balance", "Balanced"];
  const ROWS = [
    ["", "TRUST", "9", "31-05-2020", "111753.97", "1300000.00", "1188246.03", "N"],
    ["", "TRUST", "8", "30-04-2020", "111753.97", "111753.97", "0.00", "N"],
    ["", "TRUST", "1", "29-02-2020", "0.00", "60493.55", "60493.55", "Y"],
  ];
  const got = C.rowsByHeader(HEAD, ROWS, C.STATEMENT_COLUMNS);
  check("the Action column does not shift everything", got[0],
    { account: "TRUST", pageNo: "9", statementDate: "31-05-2020",
      opening: "111753.97", closing: "1300000.00" });
  check("nine pages read means the next one is ten",
    C.nextPageNumber(got.filter((r) => /^\d+$/.test(r.pageNo))), 10);

  // The bug, kept as a test: read positionally and page 9 becomes the word TRUST,
  // every row is discarded as unreadable, and the run starts again at page 1.
  check("read by position, pageNo is the account name", ROWS[0][1], "TRUST");
  check("and nextPageNumber then answers 1",
    C.nextPageNumber(ROWS.map((r) => ({ pageNo: r[1] }))), 1);

  // Same grid without the Action column: names still find the right cells.
  const NARROW = ["Bank Account", "Page No", "Statement Date", "Opening Balance", "Closing Balance"];
  check("no Action column, same answer",
    C.rowsByHeader(NARROW, [["TRUST", "9", "31-05-2020", "1.00", "2.00"]], C.STATEMENT_COLUMNS)[0].pageNo, "9");

  // Sort arrows land inside the header cell text.
  check("sort arrows in the header do not break the match",
    C.mapColumns(["Action", "Bank Account ▲▼", "Page No ▲▼"], C.STATEMENT_COLUMNS).pageNo, 2);
  check("case and spacing are ignored",
    C.mapColumns(["  PAGE   NO  "], { pageNo: ["page no"] }).pageNo, 0);

  // A column that is not there comes back -1 and reads as empty, never as
  // whatever happens to sit at index 0.
  check("a missing column is -1", C.mapColumns(["Page No"], C.STATEMENT_COLUMNS).opening, -1);
  check("and its value is empty, not borrowed",
    C.rowsByHeader(["Page No"], [["9"]], C.STATEMENT_COLUMNS)[0].opening, "");

  // The transaction grid keeps measured positions as a fallback, for the case
  // where the header row cannot be read at all.
  const TX = ["Date", "Trans. No", "Rec/Pay Type", "Trans Type", "Reference",
    "Receipt For/Payment To", "Debit", "Credit"];
  const TXROW = ["07-08-2026", "4021", "Client Payment Receipt", "EFT", "NW", "GRAY/SPIDER", "", "150.00"];
  const tx = C.rowsByHeader(TX, [TXROW], C.TRANSACTION_COLUMNS, C.TRANSACTION_FALLBACK)[0];
  check("transactions map by name", [tx.reference, tx.credit, tx.transNo], ["NW", "150.00", "4021"]);
  const blind = C.rowsByHeader([], [TXROW], C.TRANSACTION_COLUMNS, C.TRANSACTION_FALLBACK)[0];
  check("and fall back to the measured positions when there are no headers",
    [blind.reference, blind.credit], ["NW", "150.00"]);
}


console.log("\nthe Mint daily settlement");
{
  // The sample's own header row, verbatim — including "To Company " with the
  // trailing space that only matches because mapColumns trims.
  const HEAD = ["From Company", "From Company Number", "To Company ", "To Company Number",
    "Transaction Reference", "Amount", "Currency", "Status", "Created Time", "Authorised Time",
    "Updated Time", "Due Time", "Recipient Reference", "Sender Reference", "Settlement Amt", "Statement Date"];
  const rowOf = (ref, amt, to) =>
    ["RAA", "M363355", to, "M735037", ref, amt, "AUD", "Pending at Bank",
      "46203", "46203", "46204", "46203", "x", "y", "", "46204"];

  const parsed = C.parseMintRows(HEAD, [
    rowOf("M00640038", "594", "Viva Holidays Pty Ltd"),
    rowOf("M00641007", "3684.84", "Australia New Zealand Central Reservations Office Pty Ltd"),
  ]);
  check("both rows read", parsed.rows.length, 2);
  check("only the three columns the run needs, plus what they derive",
    Object.keys(parsed.rows[0]).sort(),
    ["amount", "amountCents", "line", "rawAmount", "toCompany", "transNo"]);
  check("the trailing space in the header does not hide the column",
    parsed.rows[0].toCompany, "Viva Holidays Pty Ltd");
  check("amounts become cents", parsed.rows[1].amountCents, 368484);
  // A workbook stores the binary float, so 10383.96 arrives as the string
  // "10383.959999999999" and the inbox showed it verbatim. The comparison was
  // always fine; the column looked broken.
  const drift = C.parseMintRows(HEAD, [rowOf("M1", "10383.959999999999", "Top Deck Tours Pty Ltd")]).rows[0];
  check("float drift is tidied for display", drift.amount, "10383.96");
  check("and the raw value is kept", drift.rawAmount, "10383.959999999999");
  check("the cents were never affected", drift.amountCents, 1038396);
  check("a whole number gains its decimals",
    C.parseMintRows(HEAD, [rowOf("M2", "594", "X")]).rows[0].amount, "594.00");

  // A reordered export must not shift anything — same three values, different
  // column order. This is the by-name rule doing its job.
  const SHUFFLED = ["Amount", "Transaction Reference", "Status", "To Company"];
  check("a reordered sheet reads the same",
    C.parseMintRows(SHUFFLED, [["594", "M00640038", "Pending at Bank", "Viva Holidays Pty Ltd"]]).rows[0],
    { line: 2, transNo: "M00640038", amount: "594.00", toCompany: "Viva Holidays Pty Ltd",
      rawAmount: "594", amountCents: 59400 });

  // Nothing is silently dropped.
  const bad = C.parseMintRows(HEAD, [rowOf("", "594", "X"), rowOf("M1", "not money", "X")]);
  check("rows that cannot be checked are held back", bad.rows.length, 0);
  check("and reported", bad.problems.map((x) => x.line), [2, 3]);
  ok("with the reason", /no transaction reference/.test(bad.problems[0].why), bad.problems[0].why);
  // Mint exports a workbook; a CSV of the same columns is easier to hand-write
  // for a test, so the card takes either. Which parser runs is decided by the
  // file's container, never by its name.
  const asCsv = C.csvGrid(
    'From Company,To Company ,Transaction Reference,Amount\n' +
    'RAA,READY ROOMS,P.0000004123,400.00\n' +
    '"RAA, Inc.",TEMPO HOLIDAYS,P.0000004125,150.00\n');
  check("a CSV reads the same as a workbook",
    C.parseMintRows(asCsv.headers, asCsv.rows).rows.map((r) => [r.transNo, r.amount, r.toCompany]),
    [["P.0000004123", "400.00", "READY ROOMS"], ["P.0000004125", "150.00", "TEMPO HOLIDAYS"]]);
  check("quoted commas survive", asCsv.rows[1][0], "RAA, Inc.");
  check("an empty CSV is empty, not a crash", C.csvGrid(""), { headers: [], rows: [] });

  const noCol = C.parseMintRows(["Amount", "To Company"], [["1", "x"]]);
  ok("a sheet missing the reference column is refused outright",
    /no column for: transaction reference/.test(noCol.problems[0].why), noCol.problems[0].why);

  console.log("");
  // The rule: the transaction reference being on the page is what decides it.
  const stmt = [
    { transNo: "M00640038", payee: "Viva Holidays Pty Ltd", amount: "594.00" },
    { transNo: "M00641007", payee: "ANZCRO", amount: "1.00" },
  ];
  const row = (transNo, amount, toCompany) => ({ transNo, amount, toCompany, amountCents: C.cents(amount) });

  const hit = C.matchMintAgainstStatement(row("M00640038", "594", "Viva Holidays Pty Ltd"), stmt);
  check("the reference is on the page", hit.status, "Reconciled");
  check("nothing to note when it all agrees", hit.mismatch, undefined);

  // Zero padding and case are noise on a machine-issued reference, same as a
  // receipt number.
  check("padding and case are ignored",
    C.matchMintAgainstStatement(row("m640038", "594", "Viva Holidays Pty Ltd"), stmt).status, "Reconciled");

  const absent = C.matchMintAgainstStatement(row("M00999999", "10", "Anyone"), stmt);
  check("a reference that isn't there is not reconciled", absent.status, "Not reconciled");
  ok("and says so plainly", /not among the transactions/.test(absent.reason), absent.reason);

  // It ARRIVED — for a different figure. That is a thing to chase, not a thing
  // to report as missing, so it reconciles and the difference is named.
  const odd = C.matchMintAgainstStatement(row("M00641007", "3684.84", "ANZCRO"), stmt);
  check("a different amount still reconciles", odd.status, "Reconciled");
  ok("and the difference is reported", /page says \$1\.00, the file says \$3684\.84/.test(odd.mismatch), odd.mismatch);

  const company = C.matchMintAgainstStatement(row("M00641007", "1.00", "Someone Else Entirely"), stmt);
  check("a different company still reconciles", company.status, "Reconciled");
  ok("and that difference is reported too", /paid to "ANZCRO"/.test(company.mismatch), company.mismatch);

  // With two transactions under one reference, report the one that agrees on
  // the money rather than whichever came first.
  const twice = [...stmt, { transNo: "M00641007", payee: "ANZCRO", amount: "3684.84" }];
  const d = C.matchMintAgainstStatement(row("M00641007", "3684.84", "ANZCRO"), twice);
  check("the matching amount is the one reported", d.mismatch, undefined);
  check("and the duplication is surfaced", d.duplicates, 2);

  const sum = C.summariseMint([
    { reconciliation: "Reconciled" },
    { reconciliation: "Reconciled", mismatch: "x" },
    { reconciliation: "Not reconciled" },
  ]);
  check("the summary counts", [sum.total, sum.reconciled, sum.notReconciled, sum.mismatched], [3, 2, 1, 1]);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

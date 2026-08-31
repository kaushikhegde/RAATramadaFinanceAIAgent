/**
 * The IPSI merchant settlement, offline.
 *
 * Run against the client's REAL export (`ipsi.xlsx`, 49 rows) as well as
 * hand-built rows, because the real file is the only thing that carries all
 * three transaction shapes at once — and it was the real file that showed the
 * merchant reference is not one format.
 *
 * IPSI is not like the other three. It never touches a bank statement page: it
 * ticks receipts that already exist on Tramada's Finance Merchant Payment
 * Receipt screen and issues one receipt covering them.
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

const sheet = XL.readSheet(fs.readFileSync(path.join(__dirname, "..", "fixtures", "ipsi.xlsx")));
const real = C.parseIpsiRows(sheet.headers, sheet.rows);

console.log("\nthe client's own export");
check("34 columns", sheet.headers.length, 34);
check("49 transactions", sheet.rows.length, 49);
// The two refunds are now ACTIONABLE — they tick against Payments To
// Reconcile — so all 49 rows run and nothing is held back.
check("all 49 are actionable", real.rows.length, 49);
check("none held back", real.problems.length, 0);

console.log("\nrefunds ARE part of an IPSI run — they tick against Payments To Reconcile");
// Guide step 12: a refund is money going back OUT, and it ticks against the
// table beside Receipts To Reconcile, not the one purchases and captures use.
// Excluding it outright (the old behaviour) left a real settlement's refunds
// unreconciled with no path to ever being ticked.
const refunds = real.rows.filter((r) => r.isRefund);
check("both refunds are flagged", refunds.length, 2);
// Guide step 5 — flipped negative, whether the file arrived that way already
// (this fixture, already reconciled) or arrived positive (IPSI's raw export).
check("both carry a negative amount", refunds.map((r) => r.amount), ["-1050.93", "-455.37"]);
check("both are the same booking", [...new Set(refunds.map((r) => r.bookingNo))], ["115932"]);

console.log("\nthe settlement cross-check");
// The file states its own Settlement Amount on one row. Every row summed —
// refunds included, they carry their own sign — has to equal it, or something
// is wrong with a file that is about to produce a receipt for real money.
check("every row, summed", C.money(real.settlement.everyRowCents), "104433.41");
check("what the file says it settled", C.money(real.settlement.statedCents), "104433.41");
ok("they agree", real.settlement.agrees === true);
check("and it says which row carried the figure", real.settlement.statedBy, "1782810105QQtmc");
check("the Tramada payment number is picked up", real.settlement.paymentNo, "R276395");
// Purchases and captures alone come to 105,939.71 — the refunds are exactly
// why the bank settled 1,506.30 less.
const withoutRefunds = real.rows.filter((r) => !r.isRefund).reduce((a, r) => a + r.amountCents, 0);
check("purchases and captures alone do NOT equal the settlement", C.money(withoutRefunds), "105939.71");

/* The match key is TRANSACTION Reference now. It used to be Merchant
   Reference, and two of the four rows on the live screen had none — so those
   rows were held back before anything looked at them, for want of a column the
   run does not need. Merchant Reference is not read at all. */
const HEAD = ["Transaction Reference", "Transaction Amount", "Booking Number", "Transaction Status", "Custom 5", "Transaction Type"];
const one = (ref, amt, bkg, status = "APPROVED", kind = "Purchase (1)", code = "1") =>
  [ref, amt, bkg, status, kind, code];

console.log("\nrows that cannot be acted on");
const odd = C.parseIpsiRows(HEAD, [
  one("128388-171850", "942.35", "128388"),
  one("", "100.00", "128000"),
  one("128111-1", "n/a", "128111"),
  one("128222-2", "50.00", "128222", "DECLINED"),
  one("guid-here", "25.00", "115932", "APPROVED", "Refund (20)", "20"),
  one("preauth-here", "10.00", "128999", "APPROVED", "PreAuth (10)", "10"),
]);
/* A row with no reference but a booking number is now USABLE — it matches on
   the booking, which is the fallback that has always been there. Only a row
   with neither is held back. The refund is usable too, now — it just runs
   against a different table, and its amount arrives here already flipped
   negative (guide step 5). */
check("a row with no reference still runs on its booking",
  odd.rows.map((r) => r.bookingNo), ["128388", "128000", "115932"]);
check("the refund's amount is flipped negative", odd.rows[2].amount, "-25.00");
ok("and flagged as a refund", odd.rows[2].isRefund === true);
check("a row with neither is the one held back",
  C.parseIpsiRows(HEAD, [one("", "100.00", "")]).problems[0].why,
  "no transaction reference and no booking number — nothing to match it by");
// The unreadable amount, the decline and the PreAuth — the refund is no
// longer one of them.
check("three rows are held back", odd.problems.length, 3);
check("an unreadable amount", odd.problems[0].why, 'unreadable amount "n/a"');
check("and one that was not approved", odd.problems[1].why, 'the transaction is "DECLINED", not approved');
ok("and the PreAuth — a hold, not a settled transaction",
  /PreAuth \(10\) hold/.test(odd.problems[2].why), odd.problems[2].why);
check("a sheet with no transaction reference column is refused",
  C.parseIpsiRows(["Transaction Amount"], [["1.00"]]).problems[0].why,
  "the sheet has no column for: transaction reference");
check("an empty sheet is empty, not a crash", C.parseIpsiRows(HEAD, []).rows, []);

console.log("\na refund that arrives already flipped is not flipped again");
const preFlipped = C.parseIpsiRows(HEAD, [one("g2", "-25.00", "115932", "APPROVED", "Refund (20)", "20")]);
check("still -25.00, not +25.00", preFlipped.rows[0].amount, "-25.00");

console.log("\nguide step 4 — one settlement date, the rest set aside");
{
  const HEAD2 = [...HEAD, "Settlement Date"];
  const dated = (ref, amt, bkg, date) => [ref, amt, bkg, "APPROVED", "Purchase (1)", "1", date];
  const parsed = C.parseIpsiRows(HEAD2, [
    dated("a", "100.00", "1", "2026-08-13"),
    dated("b", "200.00", "2", "2026-08-12"),
    dated("c", "300.00", "3", "2026-08-14"),
    dated("d", "400.00", "4", ""),           // unreadable — kept, not guessed away
  ]);
  const scoped = C.filterIpsiSettlementDate(parsed.rows, "13-08-2026");
  check("only the 13th survives", scoped.rows.map((r) => r.bookingNo), ["1", "4"]);
  check("the day either side is set aside", scoped.excluded.map((r) => r.bookingNo), ["2", "3"]);
  ok("and says why", /settled 2026-08-12, not 2026-08-13/.test(scoped.excluded[0].why), scoped.excluded[0].why);
  check("no date entered keeps everything", C.filterIpsiSettlementDate(parsed.rows, "").rows.length, 4);
  check("nothing to filter is nothing to crash on", C.filterIpsiSettlementDate([], "13-08-2026"), { rows: [], excluded: [] });
}

console.log("\nmatching against Receipts To Reconcile");
const receipts = [
  { receiptNo: "R.0000009405", bookingNo: "128388", reference: "128388-171850", receiptAmount: "942.35" },
  { receiptNo: "R.0000009410", bookingNo: "128364", reference: "", receiptAmount: "132.46" },
  { receiptNo: "R.0000009411", bookingNo: "128380", reference: "128380-164004", receiptAmount: "1.00" },
  { receiptNo: "R.0000009412", bookingNo: "128999", reference: "", receiptAmount: "500.00" },
  { receiptNo: "R.0000009413", bookingNo: "128999", reference: "", receiptAmount: "750.00" },
];
const purchase = { reference: "128388-171850", bookingNo: "128388", amountCents: 94235 };
const hit = C.matchIpsiAgainstReceipts(purchase, receipts);
ok("a purchase matches on its transaction reference", hit.matched && hit.on === "reference", JSON.stringify(hit));
check("and reports which receipt", hit.receipt.receiptNo, "R.0000009405");

/* Ten of the forty-nine rows are Captures, whose reference is a
   different shape entirely (R82EQ6F8-JoanneMChapma-raa-2911). Matching on
   reference alone would leave a fifth of the settlement unticked with no
   explanation, so booking + amount is the fallback. */
const capture = { reference: "R82EQ6F8-JoanneMChapma-raa-2911", bookingNo: "128364", amountCents: 13246 };
const capHit = C.matchIpsiAgainstReceipts(capture, receipts);
ok("a capture falls back to its booking", capHit.matched && capHit.on === "booking", JSON.stringify(capHit));
ok("and says it had to", /no receipt carries reference/.test(capHit.reason), capHit.reason);

// The amount has to agree either way — four bookings appear twice in the real
// file, so a booking on its own does not identify a row.
const wrongMoney = C.matchIpsiAgainstReceipts(
  { reference: "128380-164004", bookingNo: "128380", amountCents: 165901 }, receipts);
ok("a reference at the wrong amount does not match", !wrongMoney.matched);
ok("and says what the list holds instead", /not \$1659\.01/.test(wrongMoney.reason), wrongMoney.reason);

const ambiguous = C.matchIpsiAgainstReceipts(
  { reference: "nope", bookingNo: "128999", amountCents: 75000 }, receipts);
ok("two receipts on one booking are separated by amount",
  ambiguous.matched && ambiguous.receipt.receiptNo === "R.0000009413", JSON.stringify(ambiguous));

const gone = C.matchIpsiAgainstReceipts({ reference: "x", bookingNo: "999", amountCents: 1 }, receipts);
ok("nothing matching is not a match", !gone.matched);
ok("and says so plainly", /nothing on the list carries/.test(gone.reason), gone.reason);
check("and BR06's exact words", gone.remark, C.IPSI_REMARKS.booking);

console.log("\nBR03 — three cents of variance is a match, four is not");
{
  const penny = C.matchIpsiAgainstReceipts(
    { reference: "128388-171850", bookingNo: "128388", amountCents: 94238 }, receipts);   // 3c over
  ok("three cents over still matches", penny.matched, JSON.stringify(penny));
  const tooFar = C.matchIpsiAgainstReceipts(
    { reference: "128388-171850", bookingNo: "128388", amountCents: 94239 }, receipts);   // 4c over
  ok("four cents over does not", !tooFar.matched, JSON.stringify(tooFar));
  check("and BR07's exact words", tooFar.remark, C.IPSI_REMARKS.amount);
}

console.log("\nBR10 — a booking-fallback match is still ticked, but flagged");
ok("the capture above ticks", capHit.matched);
check("with BR10's exact words, not blocked", capHit.remark, C.IPSI_REMARKS.reference);

console.log("\nmatching a refund against Payments To Reconcile");
{
  // Measured live 21-Aug-2026: Tramada's own Due Amount for a payment is
  // NEGATIVE ("-1302.15" on a real row) — a refund reduces what is due. The
  // refund's own amount is negative too (guide step 5), for the same reason;
  // both sides are compared on their absolute value rather than either one
  // trusted to keep a particular sign.
  const payments = [
    { paymentNo: "P.0000000091", bookingNo: "115932", reference: "2dfa06e7-6454-445a-aa4d-7f36963f6d36", dueAmount: "-1050.93" },
    { paymentNo: "P.0000000092", bookingNo: "115932", reference: "", dueAmount: "-455.37" },
  ];
  const refundHit = C.matchIpsiAgainstPayments(
    { reference: "2dfa06e7-6454-445a-aa4d-7f36963f6d36", bookingNo: "115932", amountCents: -105093 }, payments);
  ok("a refund matches on its reference", refundHit.matched && refundHit.on === "reference", JSON.stringify(refundHit));
  check("against the payment it names", refundHit.payment.paymentNo, "P.0000000091");

  const refundByBooking = C.matchIpsiAgainstPayments(
    { reference: "nope", bookingNo: "115932", amountCents: -45537 }, payments);
  ok("a second refund on the same booking falls back to amount",
    refundByBooking.matched && refundByBooking.payment.paymentNo === "P.0000000092", JSON.stringify(refundByBooking));

  const refundGone = C.matchIpsiAgainstPayments({ reference: "x", bookingNo: "1", amountCents: -100 }, payments);
  ok("nothing on the Payments list is not a match", !refundGone.matched);
  check("BR06's words apply here too", refundGone.remark, C.IPSI_REMARKS.booking);
}

console.log("\nBR08 — the allocated total against the entered Transaction Total, twenty cents either way");
{
  const dead_on = C.checkIpsiAllocatedTotal(1044341, "10443.41");
  ok("an exact match is fine", dead_on.checked && dead_on.ok, JSON.stringify(dead_on));
  const within = C.checkIpsiAllocatedTotal(1044341, "10443.61");   // 20c short
  ok("twenty cents short is still fine", within.checked && within.ok, JSON.stringify(within));
  const over = C.checkIpsiAllocatedTotal(1044341, "10443.62");     // 21c short
  ok("twenty-one cents is not", over.checked && !over.ok, JSON.stringify(over));
  check("BR08's exact words", over.remark, C.IPSI_REMARKS.total);
  const blank = C.checkIpsiAllocatedTotal(1044341, "");
  check("no Transaction Total entered is not a failure, just unchecked", blank.checked, false);
}

console.log("\nstep 9 / BR01 — a different check, a different sentence, on purpose");
{
  // Not the same wording as BR08's "Incorrect total amount" — MINT and
  // TravelPay already draw exactly this distinction between their
  // file-level total and their Tramada-level total, and the guide gives
  // IPSI's own file-level check its own exact words too.
  check("the file-level remark", C.IPSI_REMARKS.fileTotal, "Total transaction amounts does not match.");
  ok("and it differs from BR08's Tramada-level one",
    C.IPSI_REMARKS.fileTotal !== C.IPSI_REMARKS.total);

  // The rows here are what parseIpsiRows would have already kept — a refund's
  // amountCents carries its sign — so this is "what checkIpsiFileTotal does
  // with a real settlement", not a hand-picked total.
  const rows = [{ amountCents: 10000 }, { amountCents: 5050 }, { amountCents: -1000 }]; // net 140.50
  const dead_on = C.checkIpsiFileTotal(rows, "140.50");
  ok("the file's own total matching the NUVEI figure, to the cent, is fine",
    dead_on.checked && dead_on.ok, JSON.stringify(dead_on));

  // Unlike BR08, there is NO tolerance here — a single cent out fails it.
  const oneCentOut = C.checkIpsiFileTotal(rows, "140.51");
  ok("one cent out is not fine — BR01 has no tolerance",
    oneCentOut.checked && !oneCentOut.ok, JSON.stringify(oneCentOut));
  check("naming BR01's own remark", oneCentOut.remark, C.IPSI_REMARKS.fileTotal);
  check("and the file's own total, for the dashboard to say", oneCentOut.fileCents, 14050);

  const blank = C.checkIpsiFileTotal(rows, "");
  check("nothing entered is not a failure, just unchecked", blank.checked, false);
  check("with a null verdict, not a false one", blank.ok, null);

  const noRows = C.checkIpsiFileTotal([], "0.00");
  ok("an empty settlement totals zero, not a crash", noRows.checked && noRows.ok, JSON.stringify(noRows));
}

console.log("\nwhat the run made of it");
const s = C.summariseIpsi([
  { ticked: true, matchedOn: "reference", amountCents: 94235 },
  { ticked: true, matchedOn: "booking", amountCents: 13246 },
  { ticked: false, matchedOn: null, amountCents: 50000 },
]);
check("every row counted", s.total, 3);
check("ticked", s.ticked, 2);
check("unmatched", s.unmatched, 1);
check("how each was found", [s.onReference, s.onBooking], [1, 1]);
// The receipt is for what it ALLOCATES. A row that found nothing must not
// inflate the total, or the receipt will not balance against its own ticks.
check("the amount is the ticked rows only", C.money(s.allocatedCents), "1074.81");
check("nothing ticked is zero, not the file's headline figure", C.money(C.summariseIpsi([]).allocatedCents), "0.00");

console.log("\nleaving the popup behind");
{
  /* Go opens a real window, and it is slow — every step after it waits on that
     window painting. The one thing only the window has is its URL, which
     carries the `dataContainerId` the server made for this search. With that id
     the form loads in an ordinary tab; without it, going straight to the form
     is the navigation that ends at an Error Page.

     The decision is pure so it can be checked here. The navigation itself needs
     Tramada, and the popup is kept until the form is confirmed in the tab. */
  const { popupTarget } = require("../tramada-ipsi");
  const real = "https://asp.tramada.com.au/ttms/raatravelsandbox/finance/" +
    "finance-merchant-payment-receipt.htm?mode=add&dataContainerId=161&isPxIssue=false";

  const go = popupTarget(real);
  ok("the real popup URL is worth taking", go.relocate, JSON.stringify(go));
  check("with nothing to warn about", go.warn, null);
  check("and it is the URL that gets loaded", go.url, real);

  // Still tried — the fallback is right there — but said out loud, because a
  // missing container is the first thing to look at when it fails.
  const noContainer = popupTarget(
    "https://asp.tramada.com.au/ttms/x/finance/finance-merchant-payment-receipt.htm?mode=add");
  ok("no dataContainerId is still tried", noContainer.relocate);
  ok("but it says so first", /dataContainerId/.test(noContainer.warn || ""), noContainer.warn);

  // A window that has not navigated yet is not a failure — it is why the popup
  // is kept as a fallback rather than closed on faith.
  const blank = popupTarget("about:blank");
  ok("a blank window is left alone", !blank.relocate);
  ok("and does not read as an error", !/went to/.test(blank.warn || ""), blank.warn);
  check("nothing at all is left alone too", popupTarget("").relocate, false);
  check("and so is undefined", popupTarget(undefined).relocate, false);

  const elsewhere = popupTarget("https://asp.tramada.com.au/ttms/x/error.htm");
  ok("a window that landed somewhere else is left alone", !elsewhere.relocate);
  ok("and says where it went", /error\.htm/.test(elsewhere.warn || ""), elsewhere.warn);
  ok("without dragging the query string into the message",
    !/\?/.test(elsewhere.warn || ""), elsewhere.warn);
}

console.log("\nwhich window Go opened, and how long it is given to open it");
{
  /* The run stopped with
       page.waitForEvent: Timeout 30000ms exceeded while waiting for event "popup"
     and the window opened a moment afterwards, orphaned. The time is the
     SEARCH — Tramada posts the form, works, and only then calls window.open —
     so the answer is to wait properly, and to pick the right window when more
     than one has appeared. This runs against the human's own Chrome, so a tab
     they opened while waiting is a new window too. */
  const { chooseWindow, POPUP_TIMEOUT_MS } = require("../tramada-ipsi");
  const FORM = "https://asp.tramada.com.au/ttms/x/finance/finance-merchant-payment-receipt.htm?dataContainerId=161";

  check("nothing opened yet", chooseWindow([]), -1);
  check("one blank window is taken — it is about to navigate",
    chooseWindow([{ url: "about:blank" }]), 0);
  check("the one showing the form always wins",
    chooseWindow([{ url: "https://news.example.com" }, { url: FORM }]), 1);
  // Two anonymous windows and no way to tell them apart: driving the run
  // against whatever they were reading is worse than waiting longer.
  check("two unidentifiable windows are not guessed between",
    chooseWindow([{ url: "about:blank" }, { url: "https://news.example.com" }]), -1);
  check("a closed window does not count",
    chooseWindow([{ url: "about:blank", closed: true }, { url: FORM }]), 1);
  check("and a single closed one leaves nothing",
    chooseWindow([{ url: "about:blank", closed: true }]), -1);
  check("undefined is not a crash", chooseWindow(undefined), -1);

  // 30s was the old value and it is what failed.
  ok("Go is given minutes, not seconds", POPUP_TIMEOUT_MS >= 120000, String(POPUP_TIMEOUT_MS));
}

console.log("\nthe receipt search reaches two days back, not to the beginning of time");
{
  /* The From date was left EMPTY, which on that screen means "everything up to
     the To date" — every swipe receipt ever raised for the debtor, fetched and
     rendered before anything could be ticked, and most of why Go took long
     enough to time out the window it opens.

     Two days rather than one: a receipt raised late settles the next day, and a
     Monday run has a weekend behind it. */
  check("from the To date, as Tramada writes it", C.daysBefore("12-08-2026", 2), "2026-08-10");
  check("and as a form gives it", C.daysBefore("2026-08-12", 2), "2026-08-10");
  // Month and year ends fall out of the arithmetic rather than being special-cased.
  check("across a month end", C.daysBefore("2026-03-01", 2), "2026-02-27");
  check("across a year end", C.daysBefore("2026-01-01", 2), "2025-12-30");
  check("a leap day is a real day", C.daysBefore("2028-03-01", 1), "2028-02-29");
  check("zero days is the same day", C.daysBefore("2026-08-12", 0), "2026-08-12");

  /* A date it cannot read comes back EMPTY, never a guess. Empty means "no From
     date" — wide and slow, but honest. A wrong From is a search that quietly
     misses receipts, which on a settlement is much the worse failure. */
  check("an unreadable date is empty, not guessed", C.daysBefore("n/a", 2), "");
  check("nothing at all is empty too", C.daysBefore("", 2), "");
  check("and so is undefined", C.daysBefore(undefined, 2), "");
  check("a nonsense day count is empty as well", C.daysBefore("2026-08-12", "two"), "");
}

console.log("\nIPSI is not a statement-page report, and a combined run has to know");
{
  /* Loaded alongside the other three, IPSI was swept into the statement-page
     phase with them and reported as
       CCTEST02 is not among the transactions on this page
     — the wrong automation, then blaming the data. What separates it is
     `recPayType: null`: there is no filter for it because there is no page.
     The combined run splits on exactly that. */
/* IPSI IS EXEMPT FROM THE "BPAY FIRST" GATE, ON PURPOSE.

   RAA's POC feedback BPAY 02 reads: "If BPAY has not been run yet, and a new
   bank statement has not been created in Tramada for the day, then user cannot
   run Mint, TravelPay and/or IPSI." It names IPSI. RAA then confirmed on
   28-Aug: "IPSI can still run by itself because it doesn't reference the
   Tramada bank statement."

   So the feedback line and the intended behaviour differ, and the difference is
   deliberate. Anyone reading that line later will reasonably reach for a gate.
   This is what stops them adding one without noticing: `recPayType: null` is
   the single fact that routes IPSI away from the statement-page flow, and if it
   is ever given a value IPSI joins that flow and starts being refused on days
   BPay has not run. */
{
  ok("IPSI has no recPayType, which is what keeps it off the statement page",
    C.REPORTS.ipsi.recPayType == null,
    `REPORTS.ipsi.recPayType is ${JSON.stringify(C.REPORTS.ipsi.recPayType)} — ` +
    `give it a value and IPSI gets swept into the BPay-statement flow and refused ` +
    `with "BPAY needs to be reconciled first", which RAA has said it must not be`);
  ok("...unlike Mint and TravelPay, which do reconcile against that page",
    C.REPORTS.mint.recPayType != null && C.REPORTS.travelpay.recPayType != null);
}

/* STEP 19 — "Finalised and reconciled CSV file will be ordered in sequence of
   ascending booking numbers."

   This was not implemented: IPSI files nothing, so its export fell into the
   same branch as Mint and TravelPay and kept the upload order — which for IPSI
   is whatever order IPSI's own download happened to arrive in. Mint and
   TravelPay are right to keep it (they have no booking column to sort on);
   IPSI has one and the guide names it. */
{
  const rows = [
    { bookingNo: "100" }, { bookingNo: "99" }, { bookingNo: "" },
    { bookingNo: "13" }, { bookingNo: "B128297" }, { bookingNo: "7" },
  ];
  const out = C.sortIpsiForExport(rows).map((r) => r.bookingNo);
  check("ascending booking numbers, and 99 sorts BEFORE 100 (numeric, not text)",
    out, ["7", "13", "99", "100", "B128297", ""]);

  // A tie keeps the order it arrived in, so the sort never reshuffles equals.
  const tied = [{ bookingNo: "5", n: 1 }, { bookingNo: "5", n: 2 }, { bookingNo: "5", n: 3 }];
  check("equal booking numbers keep their original order",
    C.sortIpsiForExport(tied).map((r) => r.n), [1, 2, 3]);

  ok("rows with no booking number go last, not first",
    C.sortIpsiForExport([{ bookingNo: "" }, { bookingNo: "2" }])[0].bookingNo === "2");
}

/* The browser assembles the exported file, so it keeps its own copy of that
   sort. Two copies, one rule — run both over the same rows and compare, the
   way test-run-order.js keeps RUN_ORDER in step. */
{
  const wire = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
  const m = wire.match(/function sortIpsiForExport\(rows\) \{[\s\S]*?\n  \}/);
  ok("recon-wire.html has its own sortIpsiForExport", !!m,
    "the browser is exporting in upload order again — step 19 is silently undone");
  if (m) {
    // eslint-disable-next-line no-new-func
    const browserSort = new Function(`${m[0]}; return sortIpsiForExport;`)();
    const sample = [
      { bookingNo: "100" }, { bookingNo: "7" }, { bookingNo: "" },
      { bookingNo: "13" }, { bookingNo: "B1" }, { bookingNo: "99" },
    ];
    check("the browser's copy and core's agree, row for row",
      browserSort(sample).map((r) => r.bookingNo),
      C.sortIpsiForExport(sample).map((r) => r.bookingNo));
  }
}

/* STEP 11 — "Bank Account – Trust Account", checked by LABEL not position. */
{
  const src = fs.readFileSync(path.join(__dirname, "..", "tramada-ipsi.js"), "utf8");
  ok("the bank account chosen is verified to be the Trust Account",
    /\/trust\/i\.test\(chosen\.label\)/.test(src),
    "the run selects #agencyBankAccount by the positional value \"1\" with nothing " +
    "checking which account that is — reorder the dropdown and the merchant receipt " +
    "is issued against a different bank account with nothing looking wrong");
  ok("...and the refusal lists what the form actually offered",
    /The form offers:/.test(src));
}

  const onThePage = Object.keys(C.REPORTS).filter((k) => C.REPORTS[k].recPayType);
  const ownFlow = Object.keys(C.REPORTS).filter((k) => !C.REPORTS[k].recPayType);
  check("IPSI is the one with its own flow", ownFlow, ["ipsi"]);
  check("the other three share the page", onThePage, ["bpay", "mint", "travelpay"]);
  ok("and IPSI is the one that issues a receipt", C.REPORTS.ipsi.issuesReceipt === true);
  ok("while none of the page reports do",
    onThePage.every((k) => !C.REPORTS[k].issuesReceipt), JSON.stringify(onThePage));
  // It has no statement matcher either — asking for one must not hand back
  // Mint's and quietly match it against a page.
  ok("IPSI has no statement-page matcher of its own", !C.MATCHERS.ipsi);
}

console.log("\nrow numbers survive a combined run");
{
  /* On its own card these rows are 1..n. Inside a combined run they are
     numbered across every report, and renumbering them would send row 1 for
     the first IPSI row and overwrite the first BPay row in the inbox and in
     runs.json. */
  const keep = (rows) => rows.map((r, i) => ({ ...r, n: r.n || i + 1 }));
  check("a row that already has a number keeps it",
    keep([{ reference: "CCTEST02", n: 4 }]).map((r) => r.n), [4]);
  check("and one that does not is numbered from 1",
    keep([{ reference: "A" }, { reference: "B" }]).map((r) => r.n), [1, 2]);
  check("mixed, each keeps its own",
    keep([{ n: 7 }, {}, { n: 9 }]).map((r) => r.n), [7, 2, 9]);
}

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

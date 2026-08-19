/**
 * The TravelPay merchant settlement, offline.
 *
 * Run against the client's REAL export (`travelpay.xlsx`) as well as the CSV
 * derived from it, because that is how `test-xlsx-lite.js` caught a parser bug
 * a hand-written fixture would have agreed with. The two containers have to
 * come out the same, and one of them stores its dates as numbers.
 */
const fs = require("fs");
const path = require("path");
const C = require("./recon-core");
const XL = require("./xlsx-lite");

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

console.log("\nExcel's serial dates");
// The epoch is 1899-12-30, not 1900-01-01: Excel believes 1900 was a leap year
// and everyone else's code carries the two-day offset to stay compatible.
check("the sample's processing date", C.serialDate("46204"), "2026-07-01");
check("and its settlement date", C.serialDate("46206"), "2026-07-03");
check("a fraction is a time of day, so the day is what is kept", C.serialDate("46204.73"), "2026-07-01");
// A date this does not recognise is reported, never reformatted into a wrong one.
check("an ISO date is already a date", C.serialDate("2026-07-01"), "2026-07-01");
check("junk is left alone", C.serialDate("n/a"), "n/a");
check("nothing is nothing", C.serialDate(""), "");
check("zero is not 1899", C.serialDate("0"), "0");

console.log("\nthe booking buried in Additional Reference");
check("a plain number", C.bookingFromReference("Client Name -  128380"), "128380");
// The real file has a B on one and not the other, and trailing spaces.
check("a lettered one", C.bookingFromReference("Client Name - B128297  "), "B128297");
check("nothing to find is blank", C.bookingFromReference("Client Name"), "");
check("blank is blank", C.bookingFromReference(""), "");

console.log("\nthe client's own export");
const wb = XL.readSheet(fs.readFileSync(path.join(__dirname, "travelpay.xlsx")));
check("21 columns", wb.headers.length, 21);
check("both rows read", wb.rows.length, 2);
const fromXlsx = C.parseTravelPayRows(wb.headers, wb.rows);
check("both rows usable", fromXlsx.rows.length, 2);
check("nothing held back", fromXlsx.problems, []);

// PAYMENT REFERENCE is what reconciles a row. The file also carries a
// Processor Reference (PR.46nyrd) and a Customer Reference (2028592), and
// matching on either of those would look right and find nothing.
check("it reconciles on Payment Reference", fromXlsx.rows.map((r) => r.transNo), ["31282716", "31282311"]);
// Processed Amount, not Base Amount: the bank moved the processed figure, and
// the two only agree while the customer fee is zero.
check("the amount is the processed one", fromXlsx.rows.map((r) => r.amount), ["1480.88", "1735.84"]);
check("as cents", fromXlsx.rows.map((r) => r.amountCents), [148088, 173584]);
check("the merchant is read", fromXlsx.rows[0].toCompany, "Monarto Resort Pty Ltd");
check("the serial date is turned into a date", fromXlsx.rows[0].date, "2026-07-01");
check("and so is the settlement date", fromXlsx.rows[0].settlementDate, "2026-07-03");
check("the booking is pulled out for a person to see", fromXlsx.rows.map((r) => r.bookingNo), ["128380", "B128297"]);

console.log("\nthe same file as a CSV");
const csv = C.csvGrid(fs.readFileSync(path.join(__dirname, "travelpay-payments.csv"), "utf8"));
const fromCsv = C.parseTravelPayRows(csv.headers, csv.rows);
// Which parser runs is decided by the file's own container, never its name —
// so the two have to come out the same or the card lies about one of them.
check("a CSV reads the same as the workbook",
  fromCsv.rows.map((r) => [r.transNo, r.amount, r.bookingNo]),
  fromXlsx.rows.map((r) => [r.transNo, r.amount, r.bookingNo]));

console.log("\nrows that cannot be checked");
const head = ["Payment Reference", "Processed Amount", "MerchantCompanyName", "Transaction Status", "Failure Reason"];
const odd = C.parseTravelPayRows(head, [
  ["31282716", "100.00", "Monarto", "Successful", ""],
  ["", "200.00", "Monarto", "Successful", ""],
  ["31282999", "n/a", "Monarto", "Successful", ""],
  ["31282888", "300.00", "Monarto", "Failed", "Insufficient funds"],
  ["31282777", "400.00", "Monarto", "Pending", ""],
]);
check("only the good row runs", odd.rows.map((r) => r.transNo), ["31282716"]);
check("no reference is held back", odd.problems[0].why, "no payment reference");
check("an unreadable amount too", odd.problems[1].why, 'unreadable amount "n/a"');
/* A transaction that did not succeed never reached the bank, so it cannot be on
   the statement. Checking it would report it as missing, which reads exactly
   like a settlement that vanished — and this one never left. */
check("a failed transaction is held back, not called missing",
  odd.problems[2].why, 'the transaction was "Failed" — Insufficient funds, so it never reached the bank');
check("and one still pending", odd.problems[3].why,
  'the transaction was "Pending", so it never reached the bank');
check("every held-back row is accounted for", odd.problems.length, 4);

console.log("\nwhat the sheet must have");
check("no payment reference column is refused outright",
  C.parseTravelPayRows(["Processed Amount"], [["1.00"]]).problems[0].why,
  "the sheet has no column for: payment reference");
check("and no amount column", C.parseTravelPayRows(["Payment Reference"], [["1"]]).problems[0].why,
  "the sheet has no column for: processed amount");
// The status column is optional: an export without one is not a reason to
// refuse every row in it.
check("a sheet with no status column still runs",
  C.parseTravelPayRows(["Payment Reference", "Processed Amount"], [["31282716", "100.00"]]).rows.length, 1);
check("an empty sheet is empty, not a crash", C.parseTravelPayRows(head, []).rows, []);

console.log("\nmatching it against the statement");
const statement = [
  { transNo: "31282716", amount: "1480.88", payee: "Monarto Resort Pty Ltd" },
  { transNo: "31282311", amount: "1700.00", payee: "Monarto Resort" },
];
const hit = C.matchMintAgainstStatement(fromXlsx.rows[0], statement);
ok("a reference that is there reconciles", hit.reconciled);
check("and reports the transaction", hit.transNo, "31282716");
// It arrived — for a different figure. Calling that "not reconciled" would read
// exactly like one that never came.
const odd2 = C.matchMintAgainstStatement(fromXlsx.rows[1], statement);
ok("a different amount still reconciles", odd2.reconciled);
ok("and the difference is reported", /1735.84/.test(odd2.mismatch || ""), odd2.mismatch);
const gone = C.matchMintAgainstStatement({ transNo: "99999999", amountCents: 100 }, statement);
ok("a reference that is not there does not reconcile", !gone.reconciled);

console.log("\nPayment Reference is TRAVELPAY's number, so it is looked for in the Reference column");
{
  /* The client's own export puts `31282716` in Payment Reference — a merchant
     gateway id. Tramada's Trans. No is an `R.` receipt number and can never
     equal one, so matching Payment Reference against Trans. No could only ever
     match a file whose Payment Reference had been made to hold a Tramada
     receipt number. Our fixture was doing exactly that, and matching itself. */
  const page = [
    { transNo: "R.0000009413", reference: "TP-PG5DR-13223", amount: "250.00", payee: "RAA" },
    { transNo: "R.0000009414", reference: "TP-PG5DR-13226", amount: "145.54", payee: "RAA" },
  ];
  const row = { transNo: "TP-PG5DR-13223", amountCents: 25000 };

  const good = C.matchTravelPayAgainstStatement(row, page);
  ok("a merchant reference reconciles off the Reference column", good.reconciled, good.reason);
  check("and says which column found it", good.on, "reference");
  check("reporting the transaction it belongs to", good.transNo, "R.0000009413");

  // The bug, written down: the old matcher looked only at Trans. No.
  const old = C.matchMintAgainstStatement(row, page);
  ok("the Mint matcher cannot find it at all", !old.reconciled, old.reason);

  // Files written before today carry the receipt number, digits only. Those
  // still work — the fallback costs nothing, and a row found either way really
  // is on the page.
  const legacy = C.matchTravelPayAgainstStatement({ transNo: "9413", amountCents: 25000 }, page);
  ok("an older file carrying the receipt number still reconciles", legacy.reconciled, legacy.reason);
  check("and says it matched the other way", legacy.on, "transNo");

  const wrongMoney = C.matchTravelPayAgainstStatement({ transNo: "TP-PG5DR-13223", amountCents: 99900 }, page);
  ok("a different amount still reconciles", wrongMoney.reconciled);
  ok("and the difference is reported", /250\.00/.test(wrongMoney.mismatch || ""), wrongMoney.mismatch);

  /* MerchantCompanyName is RAA's own merchant account — "Monarto Resort Pty
     Ltd" on every row of the client's export — while the statement names the
     CLIENT the receipt came from. They disagree by design, so comparing them
     would put a difference on every row and teach you to ignore the one column
     that exists to catch a real one. */
  const clean = C.matchTravelPayAgainstStatement(
    { transNo: "TP-PG5DR-13223", amountCents: 25000, toCompany: "Monarto Resort Pty Ltd" },
    [{ transNo: "R.0000009413", reference: "TP-PG5DR-13223", amount: "250.00", payee: "GRAY/SPIDER MS" }]);
  ok("the merchant name is not compared against the client on the page", clean.reconciled, clean.reason);
  check("so a good row carries no mismatch at all", clean.mismatch, undefined);
  // Mint's To Company IS the creditor being paid, so there the check is real.
  const mintNote = C.matchMintAgainstStatement(
    { transNo: "P.0000004123", amountCents: 25000, toCompany: "READY ROOMS" },
    [{ transNo: "P.0000004123", amount: "250.00", payee: "SOMEONE ELSE" }]);
  ok("Mint still checks it, because there it means something",
    /SOMEONE ELSE/.test(mintNote.mismatch || ""), mintNote.mismatch);

  const gone = C.matchTravelPayAgainstStatement({ transNo: "TP-XXXXX-99999", amountCents: 100 }, page);
  ok("a reference on neither column does not reconcile", !gone.reconciled);
  ok("and says it looked in both",
    /Reference column/.test(gone.reason) && /transaction number/.test(gone.reason), gone.reason);

  const blank = C.matchTravelPayAgainstStatement({ transNo: "", amountCents: 100 }, page);
  ok("a row with no payment reference matches nothing", !blank.reconciled, blank.reason);

  // Two rows carrying one reference is how a double posting hides.
  const dupes = C.matchTravelPayAgainstStatement(row,
    page.concat([{ transNo: "R.0000009499", reference: "TP-PG5DR-13223", amount: "250.00" }]));
  check("a duplicated reference is counted", dupes.duplicates, 2);
}

console.log("\nevery report is matched by the RIGHT matcher, chosen in one place");
{
  /* This is the assertion that would have caught the live failure. The choice
     was made twice — `runMintReconciliation` by `o.source`, the combined run by
     `REPORTS[k].files` — and the second one put TravelPay on Mint's matcher,
     which reported "not among the transactions on this page" about a row
     sitting FIRST on the page with its reference in plain sight. One table
     now, and this reads it. */
  check("BPay matches on the receipt number", C.matcherFor("bpay"), C.matchAgainstStatement);
  check("Mint on its P. number", C.matcherFor("mint"), C.matchMintAgainstStatement);
  check("TravelPay on the Reference column", C.matcherFor("travelpay"), C.matchTravelPayAgainstStatement);
  ok("Mint and TravelPay do NOT share one", C.matcherFor("mint") !== C.matcherFor("travelpay"));
  // An unknown report falls back rather than crashing a live run.
  check("something unknown falls back to Mint's", C.matcherFor("nonsense"), C.matchMintAgainstStatement);
  check("and so does nothing at all", C.matcherFor(undefined), C.matchMintAgainstStatement);

  // Said out loud at the start of a run, so the wrong column is visible from
  // the log instead of only from a row that mysteriously will not reconcile.
  ok("a run says which column it will look in",
    /Reference column/.test(C.matchesOn("travelpay")), C.matchesOn("travelpay"));
  ok("and Mint says Trans. No", /Trans\. No/.test(C.matchesOn("mint")), C.matchesOn("mint"));

  // Every report that reconciles against a statement page needs an entry.
  const needsOne = Object.keys(C.REPORTS).filter((k) => C.REPORTS[k].recPayType);
  ok("every statement-page report has a matcher of its own",
    needsOne.every((k) => C.MATCHERS[k]), JSON.stringify(needsOne.filter((k) => !C.MATCHERS[k])));
}

console.log("\nwhat the report IS");
check("TravelPay files nothing", C.REPORTS.travelpay.files, false);
// Client Payment Receipt, confirmed 10-08-2026 — NOT the Finance Merchant
// Payment Receipt its name suggests. These receipts ALREADY EXIST on Tramada;
// nothing here files one, so the type is whatever Tramada gave them.
check("and is filtered to Client Payment Receipt", C.REPORTS.travelpay.recPayType, "Client Payment Receipt");
/* It used to share that filter with BPay. It no longer does: from 17-Aug-2026
   BPay files Debtor Payment Receipts, because the type on offer depends on the
   client's account and a BPay booking's client is a debtor account. Asserted as
   a DIFFERENCE rather than deleted, so a change that silently merged them again
   has something to fail against. */
check("BPay no longer shares that filter", C.REPORTS.bpay.recPayType, "Debtor Payment Receipt");
ok("so the two are filtered separately",
  C.REPORTS.bpay.recPayType !== C.REPORTS.travelpay.recPayType,
  `both read ${C.REPORTS.bpay.recPayType}`);
check("Mint has its own", C.REPORTS.mint.recPayType, "Creditor Payment");
check("only BPay writes", Object.keys(C.REPORTS).filter((k) => C.REPORTS[k].files), ["bpay"]);

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

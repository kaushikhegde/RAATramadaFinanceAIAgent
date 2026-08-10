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

const sheet = XL.readSheet(fs.readFileSync(path.join(__dirname, "ipsi.xlsx")));
const real = C.parseIpsiRows(sheet.headers, sheet.rows);

console.log("\nthe client's own export");
check("34 columns", sheet.headers.length, 34);
check("49 transactions", sheet.rows.length, 49);
check("47 of them are actionable", real.rows.length, 47);
check("2 are held back", real.problems.length, 2);

console.log("\nrefunds are not part of an IPSI run");
// They are money going back OUT to a cardholder, and each links to a purchase
// from an EARLIER settlement. The screen this drives ticks receipts — money
// coming in — so there is nothing there to tick against a refund.
const refunds = real.problems.map((p) => p.row);
check("both refunds are held back", refunds.map((r) => r.amount), ["-1050.93", "-455.37"]);
ok("and the reason says why", /refunds are money going back out/.test(real.problems[0].why), real.problems[0].why);
ok("naming the transaction being reversed", /1771283527nm3QB/.test(real.problems[0].why), real.problems[0].why);
check("both are the same booking", [...new Set(refunds.map((r) => r.bookingNo))], ["115932"]);
// Held back, never silently dropped — a quietly shortened file reads as
// "that was all there was".
ok("held rows are still returned for a person to see", real.problems.every((p) => p.row));

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
const withoutRefunds = real.rows.reduce((a, r) => a + r.amountCents, 0);
check("actionable rows alone do NOT equal the settlement", C.money(withoutRefunds), "105939.71");

const HEAD = ["Merchant Reference", "Transaction Amount", "Booking Number", "Transaction Status", "Custom 5", "Transaction Type"];
const one = (ref, amt, bkg, status = "APPROVED", kind = "Purchase (1)", code = "1") =>
  [ref, amt, bkg, status, kind, code];

console.log("\nrows that cannot be acted on");
const odd = C.parseIpsiRows(HEAD, [
  one("128388-171850", "942.35", "128388"),
  one("", "100.00", "128000"),
  one("128111-1", "n/a", "128111"),
  one("128222-2", "50.00", "128222", "DECLINED"),
  one("guid-here", "-25.00", "115932", "APPROVED", "Refund (20)", "20"),
]);
check("only the good row runs", odd.rows.map((r) => r.bookingNo), ["128388"]);
check("no merchant reference is held back", odd.problems[0].why, "no merchant reference");
check("an unreadable amount too", odd.problems[1].why, 'unreadable amount "n/a"');
check("and one that was not approved", odd.problems[2].why, 'the transaction is "DECLINED", not approved');
ok("and the refund", /refund/i.test(odd.problems[3].why), odd.problems[3].why);
check("a sheet with no merchant reference column is refused",
  C.parseIpsiRows(["Transaction Amount"], [["1.00"]]).problems[0].why,
  "the sheet has no column for: merchant reference");
check("an empty sheet is empty, not a crash", C.parseIpsiRows(HEAD, []).rows, []);

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
ok("a purchase matches on its merchant reference", hit.matched && hit.on === "reference", JSON.stringify(hit));
check("and reports which receipt", hit.receipt.receiptNo, "R.0000009405");

/* Ten of the forty-nine rows are Captures, whose merchant reference is a
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

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

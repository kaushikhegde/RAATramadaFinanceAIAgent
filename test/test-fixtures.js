/**
 * The fixture generator's own arithmetic, offline.
 *
 *   node test-fixtures.js
 *
 * Two things live here, and both cost a real run to learn.
 *
 * REFERENCES. They used to be worked out from the booking number —
 * `TRAVELPAY-13196`, `MINT-13196` — and IPSI's were worked out from nothing at
 * all: `FIXTURE0001`, identical on every run ever made. A receipt is found
 * again BY its reference (`readLatestReceipt`, `findIssuedPayment`), so a
 * reference that repeats lets a run read back somebody else's transaction and
 * report a number that belongs to an earlier attempt. Real references come
 * from a payment provider and are never reused.
 *
 * COSTED AMOUNTS. `costedCents` returned the costings OR the segments, never
 * both, and read a hotel's nightly rate as its due. That is what made booking
 * 13196 ask Tramada for 75.00 against a 150.00 row, and every TravelPay
 * receipt on 10-Aug-2026 was refused: "Allocation cannot be greater than
 * Amount Received".
 *
 * Requiring this file creates nothing — make-fixtures.js only runs when it is
 * the process's entry point.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Point the CSVs at a scratch folder BEFORE the module reads argv, so a test
// run can never overwrite the real csv_uploads/.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-fixtures-"));
process.argv = [process.argv[0], "test-fixtures", "bpay", "--out-dir", DIR];

const F = require("../tools/make-fixtures");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const check = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// A run tag from a separate process is a genuinely separate roll of the dice —
// asking this one for a second tag would only prove the module was loaded once.
const tagOf = (...extra) => execFileSync(process.execPath, [
  "-e", `process.argv=[];console.log(require(${JSON.stringify(path.join(__dirname, "..", "tools", "make-fixtures.js"))}).RUN)`,
  ...extra,
], { encoding: "utf8" }).trim();

console.log("\nevery run signs its own references");
{
  check("the tag is five characters", F.RUN.length, 5);
  ok("of nothing but digits and capitals", /^[0-9A-Z]{5}$/.test(F.RUN), F.RUN);

  const tags = new Set([F.RUN, tagOf(), tagOf(), tagOf(), tagOf()]);
  // Five separate processes sharing a tag means it is not random — a counter,
  // a constant, or a timestamp too coarse to tell two runs apart. That is
  // exactly the `FIXTURE0001` failure, and it would pass a test that only ever
  // asked one process.
  ok("and no two runs get the same one", tags.size === 5, [...tags].join(" "));
}

console.log("\nand every reference carries it");
{
  const r = F.ref("TP", "13196");
  check("shaped kind-tag-booking", r, `TP-${F.RUN}-13196`);
  ok("short enough that a maxlength cannot quietly bite", r.length <= 20, `${r} is ${r.length}`);
  // Not merely different per run: different per REPORT within a run, so a
  // TravelPay receipt and a Mint payment against the same booking cannot be
  // confused for one another.
  const kinds = ["BP", "TP", "MP", "IP"].map((k) => F.ref(k, "13196"));
  ok("each report has its own", new Set(kinds).size === 4, kinds.join(" "));
  ok("and each booking its own", F.ref("TP", "13196") !== F.ref("TP", "13199"));
  ok("nothing is called FIXTURE any more",
    !kinds.some((k) => /FIXTURE/.test(k)), kinds.join(" "));
}

console.log("\nwhat a booking owes is every row the receipt form will show");
{
  const ticket = (fare) => ({ costings: [{ fare }], segments: [{ kind: "flight" }] });
  const hotel = (rate, nights, rooms) => ({ segments: [{ kind: "hotel", rate, nights, rooms }] });

  check("a costed flight is worth its fare", F.costedCents(ticket("145.54")), 14554);
  // rate x NIGHTS, not rate. Booking 13196 asked for 75.00 against a 150.00
  // row and Tramada refused the receipt.
  check("a hotel is worth rate x nights", F.costedCents(hotel("75.00", 2)), 15000);
  check("and x rooms as well", F.costedCents(hotel("75.00", 2, 3)), 45000);
  check("a missing night count is one night, not zero", F.costedCents(hotel("75.00")), 7500);
  // The live failure, exactly: 200.00 was returned where Select All allocated
  // 260.00.
  check("a booking with both counts BOTH",
    F.costedCents({ costings: [{ fare: "200.00" }], segments: [{ kind: "flight" }, { kind: "hotel", rate: "20.00", nights: 3 }] }),
    26000);
  check("and the other one that failed",
    F.costedCents({ costings: [{ fare: "250.00" }], segments: [{ kind: "flight" }, { kind: "hotel", rate: "197.50", nights: 4 }] }),
    104000);
  check("a booking with nothing costed owes nothing", F.costedCents({ segments: [{ kind: "flight" }] }), 0);
  check("an empty booking does not throw", F.costedCents({}), 0);
}

console.log("\nthe BPay amounts still aim at three different outcomes");
{
  const due = 20000;
  const b = { costings: [{ fare: "200.00" }], segments: [{ kind: "flight" }] };
  check("the first row settles exactly", F.bpayCents(b, 0), due);
  ok("the second overpays", F.bpayCents(b, 1) > due, String(F.bpayCents(b, 1)));
  ok("the third is too small to settle anything", F.bpayCents(b, 2) < due, String(F.bpayCents(b, 2)));
  ok("and it never asks for nothing", F.bpayCents(b, 2) > 0, String(F.bpayCents(b, 2)));
  ok("a booking that owes nothing still gets a figure",
    F.bpayCents({ segments: [] }, 0) > 0, String(F.bpayCents({ segments: [] }, 0)));
}

console.log("\nthe report file exists from the first row, not the last");
{
  /* A Mint run created two REAL bookings in Tramada, failed at the payment
     form, and wrote no file at all — every row was built in memory behind
     `if (!rows.length) die("nothing to write")`. The bookings existed and
     nothing named them. So the file is on disk from the first row now, and
     a later step fills its own column in. */
  const read = (w) => fs.readFileSync(w.path, "utf8");
  const lines = (w) => read(w).trim().split("\n");

  const w = F.csvWriter("probe-a.csv", ["Booking No", "Reference", "Amount"], ["Reference"]);
  const r1 = w.add({ "Booking No": "13229", Reference: "", Amount: "145.54" });
  ok("the file exists as soon as one row does", fs.existsSync(w.path));
  check("header, then the row", lines(w), ["Booking No,Reference,Amount", "13229,,145.54"]);

  w.add({ "Booking No": "13232", Reference: "", Amount: "200.00" });
  check("a second row lands without waiting for the end", lines(w).length, 3);

  // The whole point: the payment number arrives later and finds its own row.
  r1.Reference = "P.0000004123";
  w.update();
  check("a later step fills its column in", lines(w)[1], "13229,P.0000004123,145.54");

  check("rows still waiting on a human are named", w.unfilled().map((u) => u.i), [1]);
  r1.Reference = "";
  w.update();
  check("and both, when both are blank", w.unfilled().map((u) => u.i), [0, 1]);

  // Extra keys are working notes, not columns — the file must not grow one.
  const w2 = F.csvWriter("probe-b.csv", ["A"], []);
  w2.add({ A: "1", _note: "not a column", "Booking No": "13229" });
  check("keys that are not columns stay out of the file", lines(w2), ["A", "1"]);

  const w3 = F.csvWriter("probe-c.csv", ["A", "B"], []);
  w3.add({ A: 'say "hi", loudly', B: "plain" });
  check("commas and quotes survive", lines(w3)[1], '"say ""hi"", loudly",plain');
  check("and read back as one field",
    require("../recon-core").csvGrid(read(w3)).rows[0][0], 'say "hi", loudly');

  const w4 = F.csvWriter("probe-d.csv", ["A"], []);
  ok("a writer with no rows leaves no half-written file", !fs.existsSync(w4.path));
}

console.log("\nthe fixtures seed the type the run goes looking for");
{
  /* THE INVARIANT THIS FILE EXISTS FOR NOW.
   *
   * A fixture that seeds one receipt type while its run filters to another
   * produces receipts that are really there, a filter that shows an empty grid,
   * and every row reported unreconciled. Nothing errors. Nothing looks wrong
   * until somebody opens Tramada and finds the receipts sitting in it.
   *
   * That is not hypothetical: setting every booking's client to GRAY/MEGAN on
   * 17-Aug-2026 made TravelPay's fixtures Debtor Payment Receipts, because the
   * receipts list defaults to whatever the booking is opened on and the fixture
   * never said which it wanted. Its run still filtered to Client Payment
   * Receipt. This assertion is what that mistake is worth.
   *
   * (This comment said "whatever the CLIENT's account type offers" until
   * 31-Aug-2026. It is the BOOKING's — see the block at the end of this file,
   * where the two are finally told apart.) */
  const core = require("../recon-core");
  const LABEL = {
    DEBTOR_PAYMENT_RECEIPT: "Debtor Payment Receipt",
    CLIENT_PAYMENT_RECEIPT: "Client Payment Receipt",
  };
  for (const [report, category] of Object.entries(F.CATEGORY_FOR)) {
    const seeds = LABEL[category];
    ok(`${report}: the category is one Tramada offers`, !!seeds, category);
    if (report === "mint" || report === "travelpay") {
      /* BOTH creditor reports work the same way: the receipt is only an
         ENABLER — without money in, nothing is payable out — and what lands on
         the statement page, and what the run filters to, is the creditor
         payment that follows it. TravelPay joined Mint here on 17-Aug-2026;
         before that its fixture stopped at the receipt and its run filtered to
         Client Payment Receipt, so the file matched a receipt this repo had
         created and proved nothing about a real TravelPay file. */
      check(`${report} filters on what the receipt enables, not the receipt`,
        core.REPORTS[report].recPayType, "Creditor Payment");
      check(`${report} seeds a receipt its client can actually raise`,
        category, "CLIENT_PAYMENT_RECEIPT");
      continue;
    }
    check(`${report}: seeds exactly what its run filters to`,
      seeds, core.REPORTS[report].recPayType);
  }

  /* And the client has to be able to offer that category at all.

     THE " DR" SUFFIX IS LOad-BEARING. `GRAY/MEGAN` and `GRAY/MEGAN DR` are two
     different clients: the first is a retail account, the second a debtor one,
     and `#receiptCategory` is decided by the account type. This assertion used
     to read `"GRAY/MEGAN"` — it pinned the wrong value and passed happily while
     every BPay fixture was built on a client that cannot take a Debtor Payment
     Receipt. Verified live 27-Aug-2026 on bookings 13703 (no Debtor variant)
     and 13115 (Debtor variants only).

     Asserted as the suffix rather than the whole string as well, so that
     renaming the client keeps the rule while dropping "DR" fails. */
  check("bpay builds under a debtor-account client", F.CLIENT_FOR.bpay, "GRAY/MEGAN DR");
  ok("and that client code is marked as a debtor account (the DR suffix)",
    / DR$/.test(F.CLIENT_FOR.bpay),
    `CLIENT_FOR.bpay is "${F.CLIENT_FOR.bpay}" — without the DR suffix this is the retail client, ` +
    `and every BPay fixture will refuse with "Debtor Payment Receipt not available"`);
  check("travelpay builds under a retail one", F.CLIENT_FOR.travelpay, "GRAY/SPIDER");
  // And the two creditor reports agree with each other, because they are the
  // same shape of job — a receipt in, a payment out, filtered to the payment.
  check("mint and travelpay filter to the same thing",
    core.REPORTS.mint.recPayType, core.REPORTS.travelpay.recPayType);
  ok("so the two are not the same client",
    F.CLIENT_FOR.bpay !== F.CLIENT_FOR.travelpay, F.CLIENT_FOR.bpay);
  check("and bpay's category is the one the run files under",
    F.CATEGORY_FOR.bpay, core.BPAY_RECEIPT.value);
}


console.log("\nand the BOOKING is opened on the account type that offers that category");
{
  const { mapBookingToTramada } = require("../tramada-booking");

  /* IT IS THE BOOKING'S ACCOUNT TYPE, NOT THE CLIENT'S.
   *
   * Everything above this block, and the comments in tramada-receipt.js that
   * went with it, said `#receiptCategory` follows the CLIENT's account type.
   * That was read off 13115 (GRAY/MEGAN DR → Debtor variants) against 13394
   * (GRAY/SPIDER MS → Client variants), which differ in BOTH the client and
   * the booking's account type, so it never separated the two.
   *
   * Separated live 31-Aug-2026, same client on both sides:
   *
   *   13115  GRAY/MEGAN DR (client id 415)  booking CORPORATE  → Debtor variants
   *   14120  GRAY/MEGAN DR (client id 415)  booking RETAIL     → Client variants
   *   13034  MOULDS/NICHOLAS MR (id 4103)   booking CORPORATE  → Debtor variants
   *
   * Client 415 and client 4103 are BOTH CORPORATE account types, so the client
   * cannot be what moves it. `#accountTypeCode` on booking-profile.htm can, and
   * does: RETAIL fills `#retailDebtor` and leaves `#debtor` empty, so there is
   * no debtor on the booking to receipt against and Tramada offers only the
   * Client variants.
   *
   * That is why picking the right client was never enough. `mapBookingToTramada`
   * hard-coded RETAIL, so every fixture booking — GRAY/MEGAN DR included — came
   * out retail and reported "Debtor Payment Receipt not available". */
  const NEEDS = { DEBTOR_PAYMENT_RECEIPT: "CORPORATE", CLIENT_PAYMENT_RECEIPT: "RETAIL" };
  for (const [report, category] of Object.entries(F.CATEGORY_FOR)) {
    const acct = F.ACCOUNT_FOR[report];
    ok(`${report}: the fixture states an account type at all`,
      !!(acct && acct.accountType),
      `ACCOUNT_FOR.${report} is ${JSON.stringify(acct)} — a booking that states none ` +
      `takes mapBookingToTramada's default and may not offer ${category}`);
    check(`${report}: opened on the account type that offers ${category}`,
      acct && acct.accountType, NEEDS[category]);
  }
  // ipsi creates bookings too — its receipts are raised by hand, but the
  // account type still decides what the human is offered when they get there.
  ok("ipsi states one as well, even though nothing raises its receipts",
    !!(F.ACCOUNT_FOR.ipsi && F.ACCOUNT_FOR.ipsi.accountType),
    JSON.stringify(F.ACCOUNT_FOR.ipsi));

  /* And the table has to actually REACH the form. ACCOUNT_FOR travels as the
     booking's `tramadaOverrides`, which is the only channel mapBookingToTramada
     honours — a table nothing reads is the same bug in a new place. */
  const trip = { departureDate: "2026-09-01", originCode: "ADL", destinationCode: "MEL" };
  const bpay = mapBookingToTramada({ ...trip, tramadaOverrides: F.ACCOUNT_FOR.bpay }, F.CLIENT_FOR.bpay);
  check("a bpay booking maps to CORPORATE, like 13115", bpay.accountType, "CORPORATE");
  /* A retail debtor left in place is not inert: setFields() picks its widget by
     which one Tramada rendered, and a CORPORATE booking carrying a retail
     debtor is one ajax re-render away from being a RETAIL booking again. */
  check("and carries no retail debtor to swap the widget back", bpay.retailDebtor, "");

  const travelpay = mapBookingToTramada({ ...trip, tramadaOverrides: F.ACCOUNT_FOR.travelpay }, F.CLIENT_FOR.travelpay);
  check("a travelpay booking stays RETAIL", travelpay.accountType, "RETAIL");
  check("and keeps the retail debtor that makes it saveable",
    travelpay.retailDebtor, "RAA of SA Limited (Retail)");

  /* GRAY/SPIDER is a CORPORATE client too (checked live 31-Aug-2026), so
     "use whatever the client says" would have flipped TravelPay to Debtor
     receipts — the exact 17-Aug-2026 breakage this file already tests for one
     line up. The account type is a decision each report makes, not a discovery. */
  ok("bpay and travelpay do not share an account type",
    F.ACCOUNT_FOR.bpay.accountType !== F.ACCOUNT_FOR.travelpay.accountType,
    F.ACCOUNT_FOR.bpay.accountType);
}

console.log("\nthe IPSI file states the reference its receipts will be raised under");
{
  const core = require("../recon-core");

  /* IPSI WROTE ITS MATCH KEY AS AN EMPTY STRING, on every row, every run.
   *
   * The other three fixtures raise their own receipts, so they know the
   * reference and write it: BP-/TP-/MP-. IPSI cannot raise its receipts — a
   * Credit Card Swipe wants a real card number, so a human does it — and the
   * column was therefore left blank "for you to paste in". `ref("IP", …)` was
   * built and tested for this and then never called by anything.
   *
   * A blank is not neutral. `Transaction Reference` is what the run matches on;
   * with nothing in it every row falls through to matching on Booking Number
   * and comes back carrying IPSI_REMARKS.reference — "Incorrect payment
   * reference" — so the fixture could never produce a clean IPSI run, and the
   * reference path it is supposed to exercise was never exercised at all.
   *
   * The order is what was wrong, not the honesty: state the reference FIRST and
   * have the human raise the receipt under it. That invents nothing — it is the
   * fixture's own reference, the same as the other three — and it turns a
   * round trip into an instruction. */
  const RUN_BKG = "14126";
  const row = F.ipsiRow({ bookingNo: RUN_BKG, dueCents: 14554, cardHolder: "Spider Gray", today: "2026-08-31" });

  check("Transaction Reference is the run's own IP reference",
    row["Transaction Reference"], F.ref("IP", RUN_BKG));
  ok("and it is not the empty string this used to write",
    !!String(row["Transaction Reference"] || "").trim(),
    JSON.stringify(row["Transaction Reference"]));

  // Through the parser the run actually uses, not a hand-made row object.
  const cols = Object.keys(row);
  const asFile = (over = {}) =>
    core.parseIpsiRows(cols, [cols.map((c) => (c in over ? over[c] : row[c]))]);

  const parsed = asFile();
  check("the row is usable, not held back", parsed.problems.map((p) => p.why), []);
  check("and the run reads the reference back off it",
    parsed.rows[0].reference, F.ref("IP", RUN_BKG));

  /* A swipe receipt raised under the reference the file names matches ON THE
     REFERENCE, which is the path IPSI exists to test. */
  const receipts = [{ reference: F.ref("IP", RUN_BKG), receiptAmount: "145.54", bookingNo: RUN_BKG }];
  const m = core.matchIpsiAgainstReceipts(parsed.rows[0], receipts);
  check("a receipt raised under it matches on the reference", [m.matched, m.on], [true, "reference"]);
  ok("and carries no remark", !m.remark, JSON.stringify(m.remark));

  /* THE BUG, as a row: the same file with the column blanked is what every IPSI
     fixture used to write. It still matches — on the booking — and that is why
     this went unnoticed: the run worked, it just flagged every single row. */
  const blank = asFile({ "Transaction Reference": "" });
  const fell = core.matchIpsiAgainstReceipts(blank.rows[0], receipts);
  check("blanked, it falls back to the booking and is remarked",
    [fell.matched, fell.on, fell.remark], [true, "booking", core.IPSI_REMARKS.reference]);

  // And nothing is left for a human to paste: the column is no longer a gap.
  ok("so the file has no blank match key left in it",
    F.IPSI_BLANK_COLUMNS.every((c) => c !== "Transaction Reference"),
    JSON.stringify(F.IPSI_BLANK_COLUMNS));
}
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

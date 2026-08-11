/**
 * What the two money-moving forms refuse to do, offline.
 *
 *   node test-receipt-guard.js
 *
 * The receipt form's over-allocation guard, and the payment form's reading of
 * what is actually payable — both of them checks that happen BEFORE Issue, so
 * a wrong answer costs nothing.
 *
 * WHY THIS FILE EXISTS
 *
 * On 10-Aug-2026 a real TravelPay fixture run raised three receipts and
 * Tramada refused all three:
 *
 *     Allocation cannot be greater than Amount Received
 *
 * The receipts were for the booking's ticket fare, but `allocation: "ALL"`
 * clicks Tramada's Select All, which ticks EVERY allocatable row — the hotel
 * too. 200.00 receipted, 200.00 + 60.00 allocated. The run learned about it
 * from a one-line banner on a page that no longer showed which row was to
 * blame, and three receipts' worth of work was lost.
 *
 * `allocateSegments` now adds the figures up before Issue and refuses with the
 * rows named. That refusal is the thing under test here.
 *
 * WHAT THIS DOES NOT TEST: reading the numbers out of the live DOM. That part
 * needs Tramada and is verified there. The stub below hands back rows the way
 * the page would, so what is pinned is the arithmetic, the boundary, and the
 * message — the parts that decide whether real money gets filed.
 */
const R = require("./tramada-receipt");
const P = require("./tramada-payment");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const check = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/** A page that behaves like the receipt form with `rows` in its allocation grid. */
function stubPage(rows) {
  return {
    clicked: 0,
    locator() {
      const self = this;
      return { count: async () => 1, nth: () => ({ click: async () => { self.clicked++; } }) };
    },
    // The Select All fix-up pass touches `document`; there is none here, and it
    // is best-effort anyway — the stub's rows already carry the filled values.
    async evaluate() { return undefined; },
    async $$eval() { return rows.map((r) => ({ ...r })); },
  };
}
const segs = (rows) => rows.map((r) => ({ segId: r.segId, debtorDue: r.value }));

const thrown = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.message; }
};

(async () => {
  console.log("\ncents are read without ever touching a float");
  check('"1,234.50"', R.centsOf("1,234.50"), 123450);
  check('"$60.00"', R.centsOf("$60.00"), 6000);
  check('"790"', R.centsOf("790"), 79000);
  check('"-4.46"', R.centsOf("-4.46"), -446);
  check("nothing at all", R.centsOf(""), null);
  check("a dash is not an amount", R.centsOf("—"), null);
  check("a number", R.centsOf(145.54), 14554);

  console.log("\nSelect All is stopped when it ticks more than the receipt");
  {
    // The exact shape of the live failure: booking 13199.
    const rows = [
      { segId: "1", value: "200.00", segType: "Ticket" },
      { segId: "2", value: "60.00", segType: "Hotel" },
    ];
    const page = stubPage(rows);
    const msg = await thrown(() => R.allocateSegments(page, "ALL", segs(rows), "200.00"));
    ok("it refuses", !!msg, "no error was thrown — the receipt would have been issued");
    ok("in Tramada's own words, so the two are recognisably the same fault",
      /Allocation cannot be greater than Amount Received/.test(msg || ""), msg);
    ok("saying what the receipt was for", /\$200\.00/.test(msg || ""), msg);
    ok("and what Select All actually ticked", /260\.00/.test(msg || ""), msg);
    ok("naming the rows, which the banner never does",
      /Ticket/.test(msg || "") && /Hotel/.test(msg || ""), msg);
    ok("and saying nothing was issued", /Nothing was issued/.test(msg || ""), msg);
  }

  console.log("\nand left alone whenever Tramada would have accepted it");
  {
    const rows = [{ segId: "1", value: "145.54", segType: "Ticket" }];
    ok("a receipt worth exactly its one row goes through",
      (await thrown(() => R.allocateSegments(stubPage(rows), "ALL", segs(rows), "145.54"))) === null);
    ok("a receipt worth more than its rows goes through",
      (await thrown(() => R.allocateSegments(stubPage(rows), "ALL", segs(rows), "150.00"))) === null);
    // One cent over is refused exactly as hard as a hundred dollars over,
    // because Tramada refuses it exactly as hard.
    const over = await thrown(() => R.allocateSegments(stubPage(rows), "ALL", segs(rows), "145.53"));
    ok("one cent over is still over", !!over, "a cent slipped through");
    ok("a caller that gave no amount is not second-guessed",
      (await thrown(() => R.allocateSegments(stubPage(rows), "ALL", segs(rows), undefined))) === null);
    const p = stubPage(rows);
    await R.allocateSegments(p, "ALL", segs(rows), "145.54");
    // Awaited, not handed to ok() as a promise — a promise is truthy and the
    // check would pass no matter what the guard did.
    check("Select All was still clicked on the way through", p.clicked, 1);
  }

  console.log("\nan explicit allocation is checked as arithmetic, before a key is pressed");
  {
    const rows = [
      { segId: "1", value: "200.00", segType: "Ticket" },
      { segId: "2", value: "60.00", segType: "Hotel" },
    ];
    // No page methods are reachable here: it must refuse before it types.
    const msg = await thrown(() => R.allocateSegments(
      null, [{ segId: "1", amount: "200.00" }, { segId: "2", amount: "60.00" }], segs(rows), "200.00"));
    ok("it refuses without touching the form", !!msg, "no error was thrown");
    ok("with both figures", /\$200\.00/.test(msg || "") && /\$260\.00/.test(msg || ""), msg);

    ok("allocating exactly the receipt is fine",
      !/greater than/.test(await thrown(() => R.allocateSegments(
        null, [{ segId: "1", amount: "200.00" }], segs(rows), "200.00")) || ""));
    // Allocating LESS than the receipt is the ordinary part-allocated case and
    // must never be blocked — the run relies on it.
    ok("allocating less than the receipt is fine",
      !/greater than/.test(await thrown(() => R.allocateSegments(
        null, [{ segId: "2", amount: "60.00" }], segs(rows), "200.00")) || ""));
    // Allocating nothing at all is a wanted outcome, not a mistake: the receipt
    // still has to exist, unallocated.
    ok("allocating nothing is left completely alone",
      (await thrown(() => R.allocateSegments(null, [], segs(rows), "200.00"))) === null);
  }

  console.log("\nthe payment form says WHICH thing is wrong with it");
  {
    /* An empty Segments To Allocate table used to come out as
         The payment form's segment table has no "Creditor Payable" column (headers: )
       because the header list was only ever built inside the loop over the
       rows. Nothing is payable to a creditor until the client's receipt has
       been taken and allocated, so an empty table is the NORMAL state of a
       booking that has only been costed — and that sentence sent a debugging
       session after a column that was never missing. The two cases have to
       stay tellable apart. */
    const HEADERS = ["D", "Seg. Type", "Reference", "Creditor ID",
      "Creditor Nett", "Creditor Paid", "Creditor Payable", "Allocate", "A"];
    const gridPage = (grid) => ({ evaluate: async () => grid });

    const empty = await thrown(() => P.readPayableSegments(gridPage({ headers: [], rows: [] }), "READY ROOMS"));
    ok("an empty table is reported as nothing payable", /nothing is payable/i.test(empty || ""), empty);
    ok("naming the creditor asked for", /READY ROOMS/.test(empty || ""), empty);
    ok("and saying what to do about it", /receipt/i.test(empty || ""), empty);
    ok("it does NOT blame a missing column",
      !/Creditor Payable" column/.test(empty || ""), empty);

    const rows = [{ segId: "1", cells: ["", "Ticket", "REF", "READY", "200.00", "0.00", "200.00", "", ""] }];
    const noHead = await thrown(() => P.readPayableSegments(gridPage({ headers: [], rows }), "READY ROOMS"));
    ok("rows it cannot read DO blame the column",
      /Creditor Payable" column/.test(noHead || ""), noHead);
    ok("and admit no header row was found at all",
      /no header row found/.test(noHead || ""), noHead);
    // Without this the next person is where I was: a complaint about a column,
    // and no way to see what the row actually held.
    ok("and show what a row looks like, so the next person can see it",
      /Ticket/.test(noHead || ""), noHead);

    const good = await P.readPayableSegments(gridPage({ headers: HEADERS, rows }), "READY ROOMS");
    check("a readable grid comes back parsed", good.length, 1);
    check("payable read by header name, not by position", good[0].payable, "200.00");
    check("and turned into cents", good[0].payableCents, 20000);
    check("with the segment type", good[0].segType, "Ticket");
  }

  console.log("\na receipt already on the booking is not filed again");
  {
    /* Upload the same CSV twice and, without this, the second run takes the
       money a second time against a booking that no longer owes it. Reference
       AND amount both have to match: a booking can legitimately take two
       receipts for the same amount on different references, and one reference
       can be followed by a correcting receipt for a different figure. */
    const core = require("./recon-core");
    const onBooking = [
      { receiptNo: "R.0000009429", reference: "BP-ONQ3Y-13262", amount: "394.00", allocated: "0.00" },
      { receiptNo: "R.0000009430", reference: "BP-ONQ3Y-13265", amount: "394.00", allocated: "394.00" },
    ];
    const find = (q) => core.findFiledReceipt(onBooking, q);

    const same = find({ reference: "BP-ONQ3Y-13262", amount: "394.00" });
    ok("the same reference and amount is the same receipt", !!same, JSON.stringify(same));
    check("and it names the one already there", same.receiptNo, "R.0000009429");
    ok("formatting does not hide it",
      !!find({ reference: " bp-onq3y-13262 ", amount: "$394" }), "394 vs 394.00, case and spaces");

    ok("the same amount on another reference is NOT it",
      !find({ reference: "BP-ONQ3Y-99999", amount: "394.00" }));
    ok("and the same reference at another amount is NOT it",
      !find({ reference: "BP-ONQ3Y-13262", amount: "395.00" }));
    // A blank cell must never read as a blank request.
    ok("a blank reference matches nothing", !find({ reference: "", amount: "394.00" }));
    ok("an unreadable amount matches nothing", !find({ reference: "BP-ONQ3Y-13262", amount: "n/a" }));
    ok("an empty booking matches nothing",
      !core.findFiledReceipt([], { reference: "BP-ONQ3Y-13262", amount: "394.00" }));
    ok("and no list at all does not throw",
      !core.findFiledReceipt(undefined, { reference: "A", amount: "1.00" }));

    // Two identical receipts already there is itself worth saying out loud.
    const twice = core.findFiledReceipt(
      onBooking.concat([{ receiptNo: "R.0000009499", reference: "BP-ONQ3Y-13262", amount: "394.00" }]),
      { reference: "BP-ONQ3Y-13262", amount: "394.00" });
    check("a reference already filed twice is counted", twice.duplicates, 2);
    check("and the first is the one reported", twice.receiptNo, "R.0000009429");
  }

  console.log("\nthe page is filtered for one report and read whole for several");
  {
    /* One report at a time there is exactly one Rec/Pay Type to show, and
       showing it is what the screen is for. Several at once meant swapping the
       filter per pass and re-reading the grid each time; unfiltered, one read
       serves them all. Matching is unaffected either way. */
    const { filterFor } = require("./recon-run");
    check("one report on its own is filtered", filterFor(false), true);
    check("several together are not", filterFor(true), false);
  }

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n  test harness failed:", e); process.exit(1); });

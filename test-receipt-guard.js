/**
 * The over-allocation guard, offline.
 *
 *   node test-receipt-guard.js
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

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n  test harness failed:", e); process.exit(1); });

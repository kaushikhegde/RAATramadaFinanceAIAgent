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
const F = require("./make-fixtures");
const { execFileSync } = require("child_process");
const path = require("path");

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
  "-e", `process.argv=[];console.log(require(${JSON.stringify(path.join(__dirname, "make-fixtures.js"))}).RUN)`,
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

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

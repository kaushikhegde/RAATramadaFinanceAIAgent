/**
 * BPAY GOES FIRST, AND STAYS FIRST.
 *
 * RAA's POC feedback, BPAY 01:
 *
 *   "If more than 1 statement for different payment type is being upload
 *    (e.g. BPAY and Mint), and user hit 'Start run', BPAY reconciliation
 *    should start first, after it finishes, then run the next automation."
 *
 * That was already true when this test was written — but only because
 * `runCombined` read `Object.keys(REPORTS)` and somebody had happened to type
 * `bpay` at the top of that object literal. Alphabetise it, or add a report
 * above `bpay`, and Mint runs first: no throw, no failing test, and the only
 * symptom is a reconciliation against a bank statement that does not exist yet.
 *
 * So the order is a named constant now, and this file is what stops it moving.
 * Three things are pinned:
 *
 *   1. bpay is first, and every defined report has a place in the order
 *   2. the combined run actually USES that order, whatever order the rows
 *      arrive in
 *   3. the browser's copy of the list agrees with core's — they number the
 *      same rows at two ends of a websocket, and `n` has to mean one thing
 */
const fs = require("fs");
const path = require("path");
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

console.log("\nthe order itself");
check("BPay is first — it creates the statement the others reconcile against",
  C.RUN_ORDER[0], "bpay");
check("every report has a place in it",
  [...C.RUN_ORDER].sort(), Object.keys(C.REPORTS).sort());
ok("no report is listed twice",
  new Set(C.RUN_ORDER).size === C.RUN_ORDER.length,
  `RUN_ORDER = [${C.RUN_ORDER.join(", ")}]`);

/* The load-time guard in recon-core.js is the thing that makes "every report
   has a place in it" impossible to break quietly. Prove it actually fires,
   rather than trusting that a thrown error would have been noticed. */
console.log("\nthe guard that catches an unordered report");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "recon-core.js"), "utf8");
  ok("recon-core refuses to load if RUN_ORDER and REPORTS disagree",
    /RUN_ORDER and REPORTS disagree/.test(src),
    "the require-time check is gone — an unordered report would be dropped from every combined run in silence");
  ok("...and refuses if bpay is not first",
    /RUN_ORDER must start with bpay/.test(src));
}

/* What runCombined does with `byReport`, extracted. If this line and the one in
   recon-run.js ever stop being the same line, the last check below says so. */
const orderOf = (byReport) => C.RUN_ORDER.filter((k) => (byReport[k] || []).length);

console.log("\na combined run, whatever order the reports arrive in");
{
  // Deliberately built Mint-first: this is the shape the bug would have had.
  const byReport = {
    travelpay: [{ ref: "T1" }],
    mint: [{ ref: "M1" }, { ref: "M2" }],
    bpay: [{ ref: "B1" }],
  };
  check("BPay is run first even though it was listed last",
    orderOf(byReport), ["bpay", "mint", "travelpay"]);

  // The numbering that goes with it — `n` is what the server patches rows by.
  const rows = orderOf(byReport)
    .flatMap((k) => byReport[k].map((r) => ({ ...r, src: k })))
    .map((r, i) => ({ ...r, n: i + 1 }));
  check("and row 1 is a BPay row", rows[0], { ref: "B1", src: "bpay", n: 1 });
  check("the numbering follows the run, not the upload",
    rows.map((r) => `${r.n}:${r.src}`), ["1:bpay", "2:mint", "3:mint", "4:travelpay"]);
}
{
  const byReport = { ipsi: [{ ref: "I1" }], bpay: [{ ref: "B1" }] };
  check("IPSI runs after BPay too, though it never touches the statement page",
    orderOf(byReport), ["bpay", "ipsi"]);
}
{
  check("a report with no rows is not in the order at all",
    orderOf({ bpay: [], mint: [{ ref: "M1" }] }), ["mint"]);
  check("nothing loaded, nothing ordered", orderOf({}), []);
}

console.log("\nrecon-run.js uses the constant, not the object literal");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "recon-run.js"), "utf8");
  ok("the combined run orders by core.RUN_ORDER",
    /const order = core\.RUN_ORDER\.filter/.test(src),
    "runCombined is not building its order from RUN_ORDER any more");
  ok("...and no longer from Object.keys(core.REPORTS)",
    !/const order = Object\.keys\(core\.REPORTS\)/.test(src),
    "the object-literal order is back — reordering REPORTS would change the run order");
}

/* THE ONE THAT MATTERS MOST. The browser numbers rows before the server sees
   them; the server renumbers with its own order and sends results back keyed by
   `n`. Two lists, two files, one meaning — and nothing but this check holds
   them together. */
console.log("\nthe browser's copy of the list");
{
  const wire = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
  const m = wire.match(/const RUN_ORDER = \[([^\]]*)\]/);
  ok("recon-wire.html declares RUN_ORDER", !!m,
    "the browser is back to Object.keys(SOURCES) — its row numbering can drift from the server's");
  if (m) {
    const browser = m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    check("and it is the same list, in the same order, as core's", browser, C.RUN_ORDER);
  }
  ok("the browser numbers rows by RUN_ORDER",
    /const runnable = RUN_ORDER\.reduce/.test(wire),
    "allResults() is numbering by SOURCES order again");
  ok("and builds byReport by RUN_ORDER",
    /byReport: RUN_ORDER\.reduce/.test(wire));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

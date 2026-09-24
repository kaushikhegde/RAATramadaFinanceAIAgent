"use strict";

/**
 * UPLOAD EVERYTHING, PRESS START RUN, AND THE AGENT WORKS OUT THE ORDER.
 *
 * RAA, 24-Sep-2026. Before this:
 *   - IPSI loaded beside any other report was REFUSED on the Sources screen
 *     ("IPSI runs alone — remove the other loaded report"), so the four
 *     reports had to be run as two runs by hand.
 *   - and IPSI ran in the MIDDLE — after BPay's receipts, before the statement
 *     page — which is not the order RAA asked for.
 *
 * The order asked for, and the one pinned here:
 *
 *     BPAY  →  Mint + TravelPay  →  IPSI
 *
 * Nothing is parallel and nothing can be: one browser drives Tramada, so a
 * combined run is a sequence. What DVC cannot do is join it at all — it opens
 * no browser — and that refusal stays.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const C = require("../recon-core");

const ROOT = path.join(__dirname, "..");
let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

/* Every subset of the four browser reports, in every upload order — the point
   is that arrival order never decides run order. */
function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) =>
    permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((rest) => [x, ...rest]));
}
const BROWSER_REPORTS = ["bpay", "mint", "ipsi", "travelpay"];
const subsets = (a) => a.reduce((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]).slice(1);

console.log("\nthe three phases");

check("BPay files its receipts first, and only BPay files anything", () => {
  const p = C.runPhases(BROWSER_REPORTS);
  assert.deepStrictEqual(p.receipts, ["bpay"]);
});

check("the statement page carries BPay, Mint and TravelPay — never IPSI", () => {
  const p = C.runPhases(BROWSER_REPORTS);
  assert.deepStrictEqual(p.statement, ["bpay", "mint", "travelpay"]);
  assert.ok(!p.statement.includes("ipsi"),
    "IPSI is on the statement page — it would be matched against a page its rows can never be on");
});

check("IPSI is the own-flow phase, which runs last", () => {
  const p = C.runPhases(BROWSER_REPORTS);
  assert.deepStrictEqual(p.ownFlow, ["ipsi"]);
});

check("nothing is left unplaced when all four are loaded", () => {
  assert.deepStrictEqual(C.runPhases(BROWSER_REPORTS).unplaced, []);
});

console.log("\nupload order never decides run order");

check("every permutation of all four gives the same three phases", () => {
  const want = JSON.stringify(C.runPhases(BROWSER_REPORTS));
  for (const perm of permutations(BROWSER_REPORTS)) {
    assert.strictEqual(JSON.stringify(C.runPhases(perm)), want,
      "uploading in the order " + perm.join(", ") + " changed the run");
  }
});

check("and every subset puts BPay before Mint, Mint before IPSI", () => {
  for (const set of subsets(BROWSER_REPORTS)) {
    for (const perm of permutations(set)) {
      const p = C.runPhases(perm);
      const seq = [...p.receipts.map((k) => "receipts:" + k),
                   ...p.statement.map((k) => "statement:" + k),
                   ...p.ownFlow.map((k) => "ownFlow:" + k)];
      const at = (s) => seq.findIndex((x) => x.endsWith(":" + s));
      if (at("bpay") >= 0 && at("mint") >= 0) {
        assert.ok(at("bpay") < at("mint"), "mint before bpay for " + perm.join(","));
      }
      if (at("ipsi") >= 0) {
        for (const other of ["bpay", "mint", "travelpay"]) {
          if (at(other) >= 0) {
            assert.ok(at(other) < at("ipsi"),
              "IPSI before " + other + " for " + perm.join(",") + " — " + seq.join(" | "));
          }
        }
      }
    }
  }
});

console.log("\nwhat still refuses");

check("DVC cannot join a run — it opens no browser", () => {
  const p = C.runPhases(["bpay", "dvc"]);
  assert.deepStrictEqual(p.unplaced, ["dvc"]);
});

check("nothing loaded, no phases", () => {
  const p = C.runPhases([]);
  assert.deepStrictEqual([p.order, p.receipts, p.statement, p.ownFlow, p.unplaced],
    [[], [], [], [], []]);
});

console.log("\nonly BPay may create the day's statement page");

check("a day that already has a page is reused, whoever is running", () => {
  for (const mayCreate of [true, false]) {
    assert.strictEqual(
      C.statementPageAction({ hasPageForDate: true, mayCreate }), "reuse",
      "a second statement page for the same day (POC feedback General 04)");
  }
});

check("a run carrying BPay creates one when there is none", () => {
  assert.strictEqual(C.statementPageAction({ hasPageForDate: false, mayCreate: true }), "create");
});

check("Mint or TravelPay WITHOUT BPay refuses instead of creating an empty page", () => {
  /* The hole this closes: it used to create one. Every Mint line then read as
     missing — correctly, nothing had been filed onto it — and the date was now
     occupied, so the real BPay run later was refused as a duplicate. */
  assert.strictEqual(C.statementPageAction({ hasPageForDate: false, mayCreate: false }), "refuse");
});

check("and the run asks that question with BPay's presence, not a guess", () => {
  const src = fs.readFileSync(path.join(ROOT, "recon-run.js"), "utf8");
  assert.ok(/mayCreate: order\.includes\("bpay"\)/.test(src),
    "the combined run is not deciding mayCreate from whether BPay is loaded");
  assert.ok(/const action = core\.statementPageAction\(/.test(src),
    "openOrCreateDayStatement has its own copy of the rule again");
  /* And that it passes the caller's answer through rather than hard-coding
     one. `mayCreate: true` here would let any combined run create a page
     while every unit test above still passed — the rule would be right and
     nothing would be asking it. */
  assert.ok(/mayCreate: o\.mayCreate !== false,/.test(src),
    "openOrCreateDayStatement is not passing the caller's mayCreate through");
  assert.ok(/has no BPay receipts to make one from/.test(src),
    "the refusal no longer says what to do about it");
});

console.log("\nthe run itself does it in that order");
{
  const src = fs.readFileSync(path.join(ROOT, "recon-run.js"), "utf8");

  check("the combined run takes its phases from runPhases", () => {
    assert.ok(/const phases = core\.runPhases\(order\)/.test(src),
      "runCombinedReconciliation is filtering its own buckets again — the order is no longer one tested fact");
  });

  check("IPSI is called AFTER the shared browser is closed, not before it is opened", () => {
    /* Both halves matter. RAA's order puts IPSI last; the CDP rule says it can
       never overlap the statement page, because `runIpsiReconciliation` closes
       its own connection and over CDP that takes the shared Chrome down. One
       call site, after the finally, satisfies both. */
    const openAt = src.indexOf("let pageOut = null;");
    const closeAt = src.indexOf("await browser.close().catch(() => {});", openAt);
    const callAt = src.indexOf("await runOwnFlowReports();", closeAt);
    assert.ok(openAt > 0 && closeAt > openAt, "the statement phase no longer looks like itself");
    assert.ok(callAt > closeAt,
      "runOwnFlowReports() is not called after the browser is closed — IPSI is back in the middle of the run");
    /* Exactly two call sites, and the only one before the statement phase is
       the branch for a run that HAS no statement phase. A third, or one sitting
       loose above `let pageOut`, is IPSI back in the middle of the run. */
    const sites = [...src.matchAll(/await runOwnFlowReports\(\);/g)].map((m) => m.index);
    assert.strictEqual(sites.length, 2, "expected two call sites, found " + sites.length);
    const noPageAt = src.indexOf("if (!onThePage.length) {");
    assert.ok(sites[0] > noPageAt && sites[0] < openAt,
      "the first call is not inside the no-statement-page branch");
  });

  check("a run with no statement-page report still runs IPSI", () => {
    const at = src.indexOf("if (!onThePage.length) {");
    assert.ok(at > 0, "the no-statement-page branch is gone");
    assert.ok(/await runOwnFlowReports\(\);/.test(src.slice(at, at + 200)),
      "an IPSI-only run would now do nothing at all");
  });

  check("the summary is built after IPSI, so its verdicts are counted", () => {
    const callAt = src.lastIndexOf("await runOwnFlowReports();");
    const sumAt = src.indexOf("summary: core.summariseCombined(results)", callAt);
    assert.ok(sumAt > callAt,
      "the combined summary is computed before IPSI has written its verdicts onto the rows");
  });
}

console.log("\nthe Sources screen no longer refuses the combination");
{
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  check("'IPSI runs alone' is gone from the built page", () => {
    assert.ok(!/IPSI runs alone/.test(html),
      "the page still tells people to remove a report before running IPSI");
  });

  check("Start run is no longer disabled for IPSI plus another report", () => {
    assert.ok(!/ipsiCombo\(\)/.test(html),
      "ipsiCombo is still gating the run button");
  });

  check("...but DVC still is", () => {
    /* The WHOLE statement, not a prefix of it: `dvcCombo() || <anything>` also
       matches a looser check, and the thing being pinned is that nothing else
       is ORed onto it. */
    assert.ok(/const invalidCombo = dvcCombo\(\);\n/.test(html),
      "invalidCombo is not dvcCombo alone any more — something else is blocking the run");
    assert.ok(/DVC runs alone/.test(html), "DVC's own refusal went with IPSI's");
  });
}

console.log("\n  " + n + " checks passed\n");

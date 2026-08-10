/**
 * run-store.js and the dashboard arithmetic behind it.
 *
 * The overview screen is the one screen whose being wrong is invisible: every
 * figure on it looks like a figure, and nobody re-adds a dashboard. So the
 * numbers are decided in recon-core.js, which is pure, and checked here against
 * runs built by hand.
 *
 * The store half writes to a throwaway directory (RECON_STORE_DIR), never the
 * repo — a test suite that leaves runs.json behind is one nobody runs twice.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-store-"));
process.env.RECON_STORE_DIR = DIR;

const C = require("./recon-core");
const S = require("./run-store");

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

console.log("\nthe upload's filename");
check("stamped, so two of the same report don't collide",
  C.uploadName("mint.xlsx", "20260810-143002"), "20260810-143002-mint.xlsx");
// The name comes from a file picker, so it is whatever the OS allowed.
check("a path is reduced to its basename",
  C.uploadName("/etc/passwd", "20260810-143002"), "20260810-143002-passwd");
check("traversal cannot survive it",
  C.uploadName("../../../etc/shadow", "20260810-143002"), "20260810-143002-shadow");
check("spaces and punctuation are tamed",
  C.uploadName("Mint Daily Settlement (2).xlsx", "20260810-143002"),
  "20260810-143002-Mint-Daily-Settlement-2-.xlsx");
check("a name that is nothing but junk still gets one",
  C.uploadName("///", "20260810-143002"), "20260810-143002-report");
check("the stamp comes off an ISO instant",
  C.stampOf("2026-08-10T14:30:02.123Z"), "20260810-143002");

console.log("\nwhat a run moved");
const rows = [
  { amountCents: 15000, reconciliation: "Reconciled" },
  { amountCents: 40000, reconciliation: "Reconciled" },
  { amountCents: 27550, reconciliation: "Not reconciled" },
  { amountCents: 10000, reconciliation: "Not reconciled", error: "receipt failed: timeout" },
];
const t = C.runTotals(rows);
check("every row is counted", t.rows, 4);
check("the total is the whole file", t.amountCents, 92550);
check("reconciled money", t.reconciledCents, 55000);
// A failed receipt never reached the statement, so it is not money sitting
// unreconciled on the page — it is money that was never filed. Three buckets.
check("unreconciled money excludes what failed", t.unreconciledCents, 27550);
check("and failed money is its own figure", t.failedCents, 10000);
ok("the three buckets add up to the total",
  t.reconciledCents + t.unreconciledCents + t.failedCents === t.amountCents);
check("raw text is read when there are no cents",
  C.runTotals([{ amount: "$1,056.93", reconciliation: "Reconciled" }]).amountCents, 105693);
check("an unreadable amount contributes nothing, never NaN",
  C.runTotals([{ amount: "n/a" }]).amountCents, 0);
check("no rows is zero, not a crash", C.runTotals(null).amountCents, 0);

console.log("\nwhat still needs a person");
const attention = C.needsReaction([{
  id: "run-1", source: "bpay",
  rows: [
    { n: 1, bookingNo: "13157", reference: "VIX122334", amountCents: 15000, reconciliation: "Reconciled" },
    { n: 2, bookingNo: "13158", reference: "NW", amountCents: 40000, reconciliation: "Not reconciled" },
    { n: 3, bookingNo: "13159", reference: "DEP", amountCents: 90000, error: "timeout", reconciliation: "Not reconciled" },
    { n: 4, bookingNo: "13160", reference: "TFR", amountCents: 22000, reconciliation: "Reconciled", mismatch: "the page says $210.00" },
  ],
}]);
check("a clean row is not on the list", attention.map((a) => a.item), ["13159", "13158", "13160"]);
// The design ranks this table by dollar impact, so the biggest problem comes
// first — not the first problem found.
check("ranked by money, worst first", attention.map((a) => a.amountCents), [90000, 40000, 22000]);
check("a failed receipt says so", attention[0].issue, "Receipt failed");
check("a missing one says something else", attention[1].issue, "Not on the statement page");
// Reconciled-but-different is a different colour of dot in the mockup: it
// arrived, it just did not agree.
check("a difference is a review, not a failure", attention[2].kind, "rev");
check("and carries the difference", attention[2].variance, "the page says $210.00");
// A row nobody looked at needs a person exactly as much as one that failed.
check("a row the run never reached is on the list",
  C.needsReaction([{ id: "r", source: "bpay", rows: [{ n: 1, amountCents: 100, reconciliation: "Not checked" }] }])[0].issue,
  "Never checked — the run stopped");
check("the limit is honoured", C.needsReaction([{ id: "r", source: "bpay",
  rows: Array.from({ length: 20 }, (_, i) => ({ n: i, amountCents: i * 100, reconciliation: "Not reconciled" })) }], 3).length, 3);
check("nothing to react to is an empty list", C.needsReaction([]), []);

console.log("\na run that carried both reports");
const mixed = [
  { n: 1, src: "bpay", amountCents: 15000, allocation: "Allocated", reconciliation: "Reconciled" },
  { n: 2, src: "bpay", amountCents: 40000, allocation: "Not allocated", reconciliation: "Not reconciled" },
  { n: 3, src: "mint", amountCents: 27550, reconciliation: "Reconciled" },
  { n: 4, src: "mint", amountCents: 10000, reconciliation: "Reconciled", mismatch: "the page says $95.00" },
];
const cs = C.summariseCombined(mixed);
check("every row counted once", cs.total, 4);
check("and split by report", [cs.bpay, cs.mint], [2, 2]);
// Mint files nothing, so it can never be "allocated" — counting its rows as
// not-allocated would put two failures on a screen where nothing failed.
check("allocation counts only the rows that CAN be allocated", cs.notAllocated, 1);
check("allocated is BPay only", cs.allocated, 1);
check("reconciliation covers both", cs.reconciled, 3);
check("as does a difference", cs.mismatched, 1);

const split = C.sourceBreakdown({ source: "both", rows: mixed });
check("the breakdown counts rows per report", [split.bpay.rows, split.mint.rows], [2, 2]);
check("and what reconciled in each", [split.bpay.reconciled, split.mint.reconciled], [1, 2]);
// Runs recorded before combined runs existed have no `src` on their rows.
check("an old single-source run still reads right",
  C.sourceBreakdown({ source: "mint", rows: [{}, {}] }).mint.rows, 2);
check("a combined run counts under every report it carried",
  C.overviewFrom([{ id: "x", startedAt: "2026-08-10T00:00:00Z", source: "both", status: "done", rows: mixed }]).bySource,
  { bpay: 1, mint: 1, travelpay: 0 });

console.log("\nthe overview");
const runs = [
  {
    id: "run-1", startedAt: "2026-08-09T01:00:00Z", source: "bpay", status: "done",
    totals: { rows: 2, amountCents: 55000, reconciledCents: 55000, unreconciledCents: 0 },
    summary: { reconciled: 2 }, committed: { done: true, ticked: 2 },
    rows: [{ receiptNo: "R.0000009403" }, { receiptNo: "R.0000009404" }],
  },
  {
    id: "run-2", startedAt: "2026-08-10T01:00:00Z", source: "mint", status: "done",
    totals: { rows: 3, amountCents: 115000, reconciledCents: 100000, unreconciledCents: 15000 },
    summary: { reconciled: 2 }, committed: { done: true, ticked: 2 },
    rows: [{}, {}, {}],                                  // Mint files nothing
  },
  {
    id: "run-3", startedAt: "2026-08-08T01:00:00Z", source: "bpay", status: "failed",
    error: "Could not connect to Chrome", totals: { rows: 1, amountCents: 10000 },
    rows: [{}],
  },
];
const o = C.overviewFrom(runs);
check("every run", o.runs, 3);
check("completed", o.completed, 2);
check("failed", o.failed, 1);
// Built from REPORTS, so a report nobody ran still appears, at zero — the
// dashboard says "no TravelPay today" rather than staying silent about it.
check("by source", o.bySource, { bpay: 2, mint: 1, travelpay: 0 });
check("rows across every run", o.rows, 6);
check("money across every run", o.amountCents, 180000);
check("reconciled across every run", o.reconciledCents, 155000);
// Only the BPay run files anything; counting Mint rows as receipts would
// double the number on the dashboard.
check("receipts filed counts receipt numbers, not rows", o.receiptsFiled, 2);
check("transactions committed", o.transactionsCommitted, 4);
check("the newest run is the last one", o.lastRun.id, "run-2");
check("recent is newest first", o.recent.map((r) => r.id), ["run-2", "run-1", "run-3"]);
check("a recent row carries its money as dollars", o.recent[0].amount, "1150.00");
check("nothing at all is an empty dashboard, not a crash", C.overviewFrom([]).runs, 0);
check("and its money is zero", C.overviewFrom(null).amountCents, 0);

console.log("\nthe store on disk");
// The first four bytes of a real .xlsx, so the fixture is the kind of thing
// the Mint card actually receives. Written as escapes, never as raw control
// bytes in the source — grep cannot find those and neither can a person.
const SAMPLE_XLSX = Buffer.from("PK\x03\x04fake", "binary");
const file = S.saveUpload("mint.xlsx", SAMPLE_XLSX, "2026-08-10T14:30:02.000Z");
check("the upload is stored under uploads/", file.stored, path.join("uploads", "20260810-143002-mint.xlsx"));
ok("and the bytes are really there", fs.existsSync(path.join(DIR, file.stored)));
check("its size is recorded", file.bytes, SAMPLE_XLSX.length);
check("and the size recorded is the size on disk",
  fs.statSync(path.join(DIR, file.stored)).size, file.bytes);
check("the original name is kept for the operator", file.name, "mint.xlsx");

const run = S.startRun({
  source: "bpay", file,
  statementDate: "2026-08-10", openingBalance: "111,753.97", closingBalance: "$120000",
  rows: [
    { reference: "VIX122334", amount: "150.00", amountCents: 15000, bookingNo: "13157" },
    { reference: "NW", amount: "400.00", amountCents: 40000, bookingNo: "13158" },
  ],
}, "2026-08-10T14:30:02.000Z");
check("the run has an id", run.id, "run-20260810-143002-1");
check("it starts as running", run.status, "running");
// The agent types "111,753.97" as readily as "111753.97". A money field is
// not the place to keep whichever one they chose.
check("the balances are normalised on the way in", run.openingBalance, "111753.97");
check("and so is a dollar sign", run.closingBalance, "120000.00");
check("rows are numbered from one", run.rows.map((r) => r.n), [1, 2]);
check("the opening total", run.totals.amountCents, 55000);

S.patchRow(run.id, 1, { receiptNo: "R.0000009403", allocation: "Allocated", reconciliation: "Reconciled" });
S.patchRow(run.id, 2, { allocation: "Not allocated", reconciliation: "Not reconciled" });
const mid = S.getRun(run.id);
check("a row's verdict is written the moment it is known", mid.rows[0].receiptNo, "R.0000009403");
check("and the totals follow it", mid.totals.reconciledCents, 15000);
ok("a run in progress is still on disk before it finishes", mid.status === "running");
check("patching a row that isn't there is null, not a throw", S.patchRow(run.id, 99, {}), null);
check("patching a run that isn't there is null too", S.patchRow("nope", 1, {}), null);

// Progress lines used to exist only as websocket frames — shown once, then
// gone, so a finished run could not be explained afterwards.
S.appendActivity(run.id, "Row 1: opening the receipt form…", true, "2026-08-10T14:31:00.000Z");
S.appendActivity(run.id, "Row 2: receipt failed: timeout", false, "2026-08-10T14:32:00.000Z");
const logged = S.getRun(run.id).activity;
check("the run keeps its log", logged.length, 2);
check("in the order it happened", logged.map((a) => a.message.slice(0, 5)), ["Row 1", "Row 2"]);
check("and whether the line was good news", logged.map((a) => a.ok), [true, false]);
check("logging against a run that isn't there is null", S.appendActivity("nope", "hi"), null);
for (let i = 0; i < 250; i++) S.appendActivity(run.id, `line ${i}`, true, "2026-08-10T14:33:00.000Z");
const capped = S.getRun(run.id);
// Unbounded, this file is rewritten on every row and the cost goes quadratic.
check("the log is capped", capped.activity.length, 200);
check("dropping the OLDEST, because the end is what anyone reads",
  capped.activity[capped.activity.length - 1].message, "line 249");
check("and it says it was truncated rather than losing them quietly",
  capped.activityTruncated, true);

S.finishRun(run.id, {
  pageNumber: 10,
  summary: { total: 2, allocated: 1, reconciled: 1 },
  selection: { ticked: ["R.0000009403"], missing: [], futureDated: [] },
  finished: { done: true },
});
const end = S.getRun(run.id);
check("it finishes done", end.status, "done");
check("with its page number", end.pageNumber, 10);
check("and what it committed", end.committed, { done: true, ticked: 1, missing: [], futureDated: [], reason: null });
ok("and a finish time", !!end.finishedAt);

const failed = S.startRun({ source: "mint", rows: [{ amountCents: 100 }] }, "2026-08-10T14:30:03.000Z");
check("two runs in the same second still get different ids", failed.id, "run-20260810-143003-2");
S.finishRun(failed.id, { error: "Could not connect to Chrome" });
check("a failed run says so", S.getRun(failed.id).status, "failed");
check("and keeps why", S.getRun(failed.id).error, "Could not connect to Chrome");

const dash = S.overview();
check("the dashboard sees both runs", dash.runs, 2);
check("one completed", dash.completed, 1);
check("one failed", dash.failed, 1);

console.log("\nwhen the file is not what it should be");
const orphan = S.startRun({ source: "bpay", rows: [] }, "2026-08-10T15:00:00.000Z");
check("an orphan starts running", S.getRun(orphan.id).status, "running");
check("startup closes it", S.reconcileOrphans(), 1);
check("as failed", S.getRun(orphan.id).status, "failed");
check("saying what happened", S.getRun(orphan.id).error, "the server stopped while this run was going");
check("and a second sweep finds nothing left to do", S.reconcileOrphans(), 0);

// A runs.json that will not parse is somebody's record of money that moved.
// Overwriting it would destroy the only copy at the moment it got interesting.
const before = S.listRuns().length;
fs.writeFileSync(path.join(DIR, "runs.json"), "{ this is not json");
const after = S.listRuns();
check("a corrupt store reads as empty rather than throwing", after.length, 0);
ok("and the unreadable one is kept aside, not overwritten",
  fs.readdirSync(DIR).some((f) => f.startsWith("runs.json.corrupt-")),
  `dir held: ${fs.readdirSync(DIR).join(", ")}`);
ok("there was something to lose", before > 0);
const fresh = S.startRun({ source: "bpay", rows: [] }, "2026-08-10T16:00:00.000Z");
check("and the store keeps working afterwards", S.getRun(fresh.id).status, "running");

fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

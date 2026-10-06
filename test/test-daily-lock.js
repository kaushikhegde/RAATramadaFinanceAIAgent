/**
 * ONCE A DAY, NOT ONCE EVER.
 *
 * RAA business rule, 05-Oct-2026: BPay, Mint, IPSI, TravelPay and DVC each run
 * once a day — a second live run for the same type is refused until the next
 * calendar day. Tokio is its own card and is never asked about here.
 *
 * "Live run that finished the work" is NOT the same question for every report,
 * which is why this is three checks wearing one name:
 *
 *   - bpay / mint / travelpay FINISH IN ONE SITTING (run-store.js's own words
 *     for why `listUnresolved` is IPSI-only) — any completed, non-dry run is
 *     the day's one shot, failures and all.
 *   - ipsi can finish without being DONE — a settlement can take several
 *     attempts across days (docs/ipsi reconciliation guide, "Other features").
 *     `run.resolved` is the exact flag `markResolved`/`markSettlementResolved`
 *     already set for "nothing left to do here", so the lock reuses it rather
 *     than re-deciding it.
 *   - dvc's reconciliation half can come back clean while the Tramada
 *     reimbursement never committed (RAA's drawing, 23-09-2026: spreadsheet
 *     errors go to a person by email and nothing is filed) — `sessionCommitted`
 *     already sets `committed.complete` only once that payment session went
 *     all the way through, so the lock reuses that too.
 *
 * A dry run is a preview, never a filing (CLAUDE.md §3) — it must never use up
 * the day, however many times someone runs one.
 */
const C = require("../recon-core");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const TODAY = "2026-10-05T01:00:00.000Z";
const now = () => new Date(TODAY);

console.log("\nbpay / mint / travelpay — any completed live run is the day's one shot");

ok("no runs at all — not locked",
  C.lockedReportToday("bpay", [], now()) === null);

ok("a dry run today — never locks, no matter how clean",
  C.lockedReportToday("bpay", [
    { source: "bpay", dryRun: true, status: "done", error: null, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) === null);

ok("a live, completed bpay run today — locked",
  C.lockedReportToday("bpay", [
    { id: "run-1", source: "bpay", dryRun: false, status: "done", error: null, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) !== null);

ok("a live bpay run that errored today — not locked (nothing was finished)",
  C.lockedReportToday("bpay", [
    { source: "bpay", dryRun: false, status: "failed", error: "Tramada timed out", finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) === null);

ok("a live, completed bpay run YESTERDAY — not locked today",
  C.lockedReportToday("bpay", [
    { source: "bpay", dryRun: false, status: "done", error: null, finishedAt: "2026-10-04T23:59:00.000Z" },
  ], now()) === null);

ok("a locked mint run never locks bpay — the lock is per report",
  C.lockedReportToday("bpay", [
    { source: "mint", dryRun: false, status: "done", error: null, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) === null);

console.log("\nipsi — only a resolved settlement locks");

ok("a live, completed IPSI run today that is NOT resolved — not locked",
  C.lockedReportToday("ipsi", [
    { source: "ipsi", dryRun: false, status: "done", error: null, resolved: false, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) === null);

ok("a live IPSI run today marked resolved — locked",
  C.lockedReportToday("ipsi", [
    { id: "run-2", source: "ipsi", dryRun: false, status: "done", error: null, resolved: true, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) !== null);

console.log("\ndvc — only a committed Tramada session locks");

ok("DVC reconciled clean today but nothing committed to Tramada — not locked",
  C.lockedReportToday("dvc", [
    { source: "dvc", dryRun: false, status: "done", error: null, committed: { session: true, complete: false }, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) === null);

ok("DVC with a completed Tramada session today — locked",
  C.lockedReportToday("dvc", [
    { id: "run-3", source: "dvc", dryRun: false, status: "done", error: null, committed: { session: true, complete: true }, finishedAt: "2026-10-05T00:30:00.000Z" },
  ], now()) !== null);

console.log("\na combined (\"both\") run locks every report type it actually finished");

ok("a combined run's bpay rows lock bpay",
  C.lockedReportToday("bpay", [
    {
      id: "run-4", source: "both", dryRun: false, status: "done", error: null,
      finishedAt: "2026-10-05T00:30:00.000Z",
      rows: [{ n: 1, src: "bpay" }, { n: 2, src: "mint" }],
    },
  ], now()) !== null);

ok("the same combined run also locks mint",
  C.lockedReportToday("mint", [
    {
      source: "both", dryRun: false, status: "done", error: null,
      finishedAt: "2026-10-05T00:30:00.000Z",
      rows: [{ n: 1, src: "bpay" }, { n: 2, src: "mint" }],
    },
  ], now()) !== null);

ok("a combined run that never carried travelpay rows does not lock travelpay",
  C.lockedReportToday("travelpay", [
    {
      source: "both", dryRun: false, status: "done", error: null,
      finishedAt: "2026-10-05T00:30:00.000Z",
      rows: [{ n: 1, src: "bpay" }, { n: 2, src: "mint" }],
    },
  ], now()) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

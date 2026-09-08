/**
 * test-store-pg.js — the ONE test that needs a real Postgres.
 *
 * Everything else about the store is proved offline in test-run-store.js against
 * the in-memory model. This file proves the half that model cannot: that a run
 * written by one process is read back, whole, by the next one — the "survives a
 * restart" promise the file store used to keep and Postgres keeps now.
 *
 * It is NOT in `npm test`, because that suite is offline by rule (CLAUDE.md §7).
 * Run it by hand against a throwaway database:
 *
 *   DATABASE_URL=postgres://localhost/recon_test node test/test-store-pg.js
 *
 * With no DATABASE_URL it prints that it was skipped and exits 0, so a CI step
 * that has no database is a pass, not a failure.
 *
 * It never touches your tables: everything happens inside a `recon_pgtest`
 * schema that is dropped at the end, so pointing it at a database with real runs
 * in it cannot harm them.
 */

const BASE = process.env.DATABASE_URL;
if (!BASE) {
  console.log("\ntest-store-pg: no DATABASE_URL — skipped (offline).\n");
  process.exit(0);
}

const os = require("os");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Only the uploaded bytes still hit disk; keep them out of the repo.
process.env.RECON_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-pg-"));

const SCHEMA = "recon_pgtest";
// Point the store at the same database but inside a throwaway schema, so its
// CREATE TABLEs and every row land somewhere a DROP SCHEMA can take back.
const sep = BASE.includes("?") ? "&" : "?";
process.env.DATABASE_URL = BASE + sep + "options=" + encodeURIComponent(`-c search_path=${SCHEMA}`);

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

async function main() {
  const admin = new Pool({ connectionString: BASE });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);

  // Required fresh so it reads the search-path'd DATABASE_URL set above.
  delete require.cache[require.resolve("../run-store")];
  const S = require("../run-store");

  try {
    await S.init();

    console.log("\na run written to Postgres");
    const run = S.startRun({
      source: "bpay",
      statementDate: "2026-08-10",
      openingBalance: "111,753.97",
      closingBalance: "$120000",
      rows: [
        { reference: "VIX122334", amount: "150.00", amountCents: 15000, bookingNo: "13157" },
        { reference: "NW", amount: "400.00", amountCents: 40000, bookingNo: "13158" },
      ],
    }, "2026-08-10T14:30:02.000Z");
    check("it has the id the cache made", run.id, "run-20260810-143002-1");

    S.patchRow(run.id, 1, { receiptNo: "R.0000009403", allocation: "Allocated", reconciliation: "Reconciled" });
    S.patchRow(run.id, 2, { allocation: "Not allocated", reconciliation: "Not reconciled" });
    S.appendActivity(run.id, "Row 1: opening the receipt form…", true, "2026-08-10T14:31:00.000Z");
    S.appendActivity(run.id, "Row 2: receipt failed: timeout", false, "2026-08-10T14:32:00.000Z");
    S.finishRun(run.id, {
      pageNumber: 10,
      summary: { total: 2, allocated: 1, reconciled: 1 },
      selection: { ticked: ["R.0000009403"], missing: [], futureDated: [] },
      finished: { done: true },
    });
    S.saveCheatSheet("suppliers", {
      name: "Supplier Cheat Sheet.xlsx",
      pairs: [{ from: "RCL CRUISES LTD", to: "Royal Caribbean", try: ["Royal Caribbean", "Celebrity Cruises"] }],
    });

    // The writes are enqueued behind the cache; wait for the database to catch up
    // before pretending to be a fresh process.
    await S.flush();

    console.log("\nread back by a fresh process");
    // Simulate a restart: drop the cache and every open handle, then load again
    // from Postgres alone.
    S._resetForTests();
    await S.init();

    const back = S.getRun(run.id);
    ok("the run comes back at all", !!back, "getRun returned null after reload");
    check("with its source", back.source, "bpay");
    check("its balances, normalised as they were stored", [back.openingBalance, back.closingBalance], ["111753.97", "120000.00"]);
    check("its status", back.status, "done");
    check("its page number", back.pageNumber, 10);
    check("both rows, in order", back.rows.map((r) => r.n), [1, 2]);
    check("a row's verdict written mid-run survived", back.rows[0].receiptNo, "R.0000009403");
    check("the totals were recomputed and stored", back.totals.reconciledCents, 15000);
    // Compared field by field, not as a whole object: jsonb does not preserve key
    // ORDER, so the reloaded object is the same data with the keys shuffled. The
    // app only ever reads these by name, so the order is nothing to defend.
    check("what it committed — done and ticked count",
      [back.committed.done, back.committed.ticked], [true, 1]);
    check("what it committed — nothing missing or future-dated",
      [back.committed.missing, back.committed.futureDated, back.committed.reason], [[], [], null]);
    check("the activity log, in the order it happened", (back.activity || []).map((a) => a.message.slice(0, 5)), ["Row 1", "Row 2"]);
    check("and whether each line was good news", (back.activity || []).map((a) => a.ok), [true, false]);

    const dash = S.overview();
    check("the dashboard is built from the reloaded run", dash.runs, 1);
    check("and counts it complete", dash.completed, 1);

    const sheet = S.getCheatSheet("suppliers");
    ok("the cheat sheet came back too", !!sheet);
    check("with its candidates, not just the cell", sheet.pairs[0].try, ["Royal Caribbean", "Celebrity Cruises"]);

    console.log("\nresolving a whole settlement persists");
    // The merge-sensitive path: markSettlementResolved was added upstream on the
    // file store and rewritten here to enqueue a single UPDATE ... WHERE id = ANY.
    // Prove it actually reaches Postgres and survives a reload.
    const a = S.startRun({ source: "ipsi", statementDate: "2026-09-02", rows: [] }, "2026-09-02T01:00:00.000Z");
    const b = S.startRun({ source: "ipsi", statementDate: "2026-09-02", rows: [] }, "2026-09-02T02:00:00.000Z");
    S.finishRun(a.id, {}); S.finishRun(b.id, {});
    const cleared = S.markSettlementResolved("ipsi", "2026-09-02");
    check("both attempts resolved together", cleared.length, 2);
    await S.flush();
    S._resetForTests();
    await S.init();
    check("and both are still resolved after a reload",
      [S.getRun(a.id).resolved, S.getRun(b.id).resolved], [true, true]);
    ok("each kept when it was resolved",
      !!S.getRun(a.id).resolvedAt && !!S.getRun(b.id).resolvedAt);

    console.log("\nthe orphan sweep against the database");
    const orphan = S.startRun({ source: "mint", rows: [] }, "2026-08-10T15:00:00.000Z");
    await S.flush();
    // A brand-new process would find it "running" and close it.
    S._resetForTests();
    await S.init();
    check("a run left running is reloaded as running", S.getRun(orphan.id).status, "running");
    check("the sweep closes exactly it", S.reconcileOrphans(), 1);
    await S.flush();
    S._resetForTests();
    await S.init();
    check("and the close is durable — still failed after another reload", S.getRun(orphan.id).status, "failed");
  } finally {
    await S.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
    fs.rmSync(process.env.RECON_STORE_DIR, { recursive: true, force: true });
  }

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ test-store-pg crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});

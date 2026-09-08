/**
 * run-store.js — where a run is written down.
 *
 *   uploads/20260810-143002-mint.xlsx     the report exactly as it arrived
 *   Postgres                              every run, its rows and its money
 *
 * The Run overview screen is fed from this store and nothing else. Before it
 * existed the screen showed the design mockup's invented figures — $7.2m of
 * them — behind a "sample data" banner, because there was nowhere for a
 * finished run to go: the results existed only as websocket frames to a page
 * that forgot them on reload.
 *
 * ── Postgres is the record; an in-process cache is the read model ────────────
 *
 * Runs used to live in a single `runs.json`. They now live in Postgres, reached
 * over `DATABASE_URL`. But the public shape of this file did NOT change: every
 * function still returns synchronously and the run objects have the exact same
 * fields, so `server.js` and the offline suite are untouched by the move.
 *
 * That works because reads are served from an in-memory cache, loaded ONCE from
 * Postgres by `init()` at boot and kept in step by every write. Within a process
 * the cache and the database say the same thing; on a restart the cache is
 * rebuilt from the database, which is why Postgres — not the cache — is the
 * source of truth. A single reconciliation server with one writer is exactly the
 * shape this pattern is safe for.
 *
 * ── Recording a run must never be able to STOP one (CLAUDE.md §6b) ───────────
 *
 * A write updates the cache synchronously and then ENQUEUES the database work on
 * a serial FIFO chain whose failures are swallowed. So a database that is down,
 * slow or read-only can lose the archive copy of a row — it can NEVER throw back
 * into the callback that is filing real receipts, and it can never reorder two
 * writes, because they are enqueued in call order. This is the same trade the
 * file store made when a full disk meant "lose the dashboard entry, not the
 * run"; it is stated the same way in the callbacks in server.js.
 *
 * ── A row is written as it happens, not at the end (CLAUDE.md §6b) ───────────
 *
 * `patchRow` is called from the same `onRow` callback that feeds the page, and
 * enqueues its UPDATE immediately. A run that dies on row 7 has still filed six
 * real receipts, and their numbers reach the database as they are learned rather
 * than in one write at the finish that a crash would take with it.
 *
 * ── No DATABASE_URL → in-memory only ────────────────────────────────────────
 *
 * With no `DATABASE_URL` the store runs on the cache alone: nothing is persisted
 * and nothing is loaded. That is what keeps the offline test suite offline
 * (CLAUDE.md §7 — no network, no database) and it is a usable, if amnesiac,
 * local dev mode. `init()` says so out loud so it is never a surprise in
 * production, where the URL is always set.
 *
 * Everything that DECIDES anything — totals, the overview's figures, the
 * upload's filename — still lives in recon-core.js and is tested offline. This
 * file only reads and writes.
 */

const fs = require("fs");
const path = require("path");
const core = require("./recon-core");

// The repo, unless a test or the container points it somewhere disposable. Only
// the uploaded report BYTES live here now (see saveUpload); the runs live in
// Postgres. A store whose location cannot be moved is a store whose tests write
// into the repo.
const ROOT = process.env.RECON_STORE_DIR || __dirname;
const UPLOADS = path.join(ROOT, "uploads");

// One line per row per phase makes a long run chatty. An unbounded activity log
// is a table that grows without limit, so it is capped the same way the file
// store capped its array — dropping the OLDEST lines, because the end of a run
// is the part anyone reads.
const ACTIVITY_CAP = 200;

/* ── the connection ──────────────────────────────────────────────────────── */

// Loaded lazily so a machine with no `pg` and no DATABASE_URL (a pure offline
// test run) never has to have the driver installed to require this file.
let Pool = null;
let pool = null;
let ready = null;                 // the init() promise, so init is idempotent

function haveDb() {
  return !!process.env.DATABASE_URL;
}

/* ── the in-memory read model ────────────────────────────────────────────── */

// Authoritative WITHIN this process; a materialised view of Postgres, rebuilt
// from it by init() on every boot. Never read a run off the wire per request —
// the overview has to be right on a page opened long after the run finished, and
// re-querying on each read buys nothing a one-writer server does not already
// have in memory.
let runs = [];
let cheats = {};

/* ── the serial write chain ──────────────────────────────────────────────── */

// Every database write is a link on this chain, so they run in the order they
// were enqueued and never interleave — the activity cap in particular is a
// read-modify-write that two concurrent appends would corrupt. Each link
// swallows its own failure: the cache (and the run) has already moved on, and a
// lost archive write must not become an unhandled rejection that takes the
// process down mid-run.
let chain = Promise.resolve();

function persist(label, fn) {
  if (!pool) return;              // in-memory mode: nothing to write to
  chain = chain.then(fn).catch((err) => {
    // Reported, not thrown. Losing the archive copy of a row is survivable;
    // crashing a run with receipts already filed is not (CLAUDE.md §6b).
    console.error(`  ⚠ could not persist ${label}: ${err.message}`);
  });
}

/** Await the outstanding database writes. For graceful shutdown and for tests. */
function flush() {
  return chain;
}

/* ── init: connect, ensure the schema, fill the cache ────────────────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  started_at         TEXT,
  finished_at        TEXT,
  dry_run            BOOLEAN,
  source             TEXT,
  file               JSONB,
  statement_date     TEXT,
  cols               JSONB,
  format             TEXT,
  opening_balance    TEXT,
  closing_balance    TEXT,
  transaction_total  TEXT,
  page_number        INTEGER,
  status             TEXT,
  error              TEXT,
  totals             JSONB,
  summary            JSONB,
  committed          JSONB,
  balances           JSONB,
  resolved           BOOLEAN DEFAULT FALSE,
  resolved_at        TEXT,
  activity_truncated BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS run_rows (
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  n       INTEGER NOT NULL,
  data    JSONB,
  PRIMARY KEY (run_id, n)
);
CREATE TABLE IF NOT EXISTS run_activity (
  seq     BIGSERIAL PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at      TEXT,
  message TEXT,
  ok      BOOLEAN
);
CREATE INDEX IF NOT EXISTS run_activity_run ON run_activity(run_id, seq);
CREATE TABLE IF NOT EXISTS cheat_sheets (
  source     TEXT PRIMARY KEY,
  data       JSONB
);
`;

/**
 * Connect (if DATABASE_URL is set), make sure the tables exist, and load every
 * run into the cache. Idempotent and safe to await more than once.
 *
 * Called once from server.js before it starts listening, so the very first
 * `/api/overview` is answered from a full cache rather than an empty one.
 */
async function init() {
  if (ready) return ready;
  ready = (async () => {
    if (!haveDb()) {
      console.warn("  ⚠ no DATABASE_URL — runs are kept in memory only and will not survive a restart.");
      return;
    }
    if (!Pool) ({ Pool } = require("pg"));
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(SCHEMA);
    await load();
    // Say it out loud, and WITHOUT credentials — host:port/db only, never the
    // user or password. `url.host`/`url.pathname` drop them; a URL that will not
    // parse just prints without the location rather than leaking the raw string.
    let where = "";
    try { const u = new URL(process.env.DATABASE_URL); where = ` (${u.host}${u.pathname})`; } catch { /* no location, no leak */ }
    console.log(`  ✓ Postgres connected${where} — ${runs.length} run(s) loaded.`);
  })();
  return ready;
}

/** Rebuild the cache from the database. Runs come back oldest-first, the order
 *  they were made, so `runs.length` still numbers a new run the same way. */
async function load() {
  const runRows = (await pool.query("SELECT * FROM runs ORDER BY started_at, id")).rows;
  const allRows = (await pool.query("SELECT run_id, data FROM run_rows ORDER BY run_id, n")).rows;
  const allAct = (await pool.query("SELECT run_id, at, message, ok FROM run_activity ORDER BY run_id, seq")).rows;
  const cheatRows = (await pool.query("SELECT source, data FROM cheat_sheets")).rows;

  const rowsByRun = new Map();
  for (const r of allRows) (rowsByRun.get(r.run_id) || rowsByRun.set(r.run_id, []).get(r.run_id)).push(r.data);
  const actByRun = new Map();
  for (const a of allAct) (actByRun.get(a.run_id) || actByRun.set(a.run_id, []).get(a.run_id)).push({ at: a.at, message: a.message, ok: a.ok });

  runs = runRows.map((db) => fromDb(db, rowsByRun.get(db.id) || [], actByRun.get(db.id)));
  cheats = {};
  for (const c of cheatRows) cheats[c.source] = c.data;
}

/* ── shaping a run row for and from the database ──────────────────────────── */

// jsonb parameters have to arrive as JSON text; a bare object is sent as
// "[object Object]". null stays null so a jsonb column can hold SQL NULL.
const j = (v) => (v == null ? null : JSON.stringify(v));

/** The DB representation of a cache run, as ordered INSERT/UPDATE params. The
 *  key order here is the column order used everywhere below. */
function toParams(r) {
  return [
    r.id, r.startedAt, r.finishedAt, r.dryRun, r.source, j(r.file),
    r.statementDate, j(r.columns), r.format, r.openingBalance, r.closingBalance,
    r.transactionTotal, r.pageNumber, r.status, r.error, j(r.totals),
    j(r.summary), j(r.committed), j(r.balances), r.resolved, r.resolvedAt,
    r.activityTruncated || false,
  ];
}

const RUN_COLS = [
  "id", "started_at", "finished_at", "dry_run", "source", "file",
  "statement_date", "cols", "format", "opening_balance", "closing_balance",
  "transaction_total", "page_number", "status", "error", "totals",
  "summary", "committed", "balances", "resolved", "resolved_at",
  "activity_truncated",
];

// The columns holding JSON, so INSERT can cast just those to jsonb.
const JSON_COLS = new Set(["file", "cols", "totals", "summary", "committed", "balances"]);

/** A cache run built back out of a database row and its children. Shaped exactly
 *  like what startRun() puts in the cache, so a reloaded run is indistinguishable
 *  from a live one. */
function fromDb(db, rowsData, activity) {
  const run = {
    id: db.id,
    startedAt: db.started_at,
    finishedAt: db.finished_at,
    dryRun: db.dry_run,
    source: db.source,
    file: db.file || null,
    statementDate: db.statement_date || "",
    columns: db.cols || [],
    format: db.format || "csv",
    openingBalance: db.opening_balance || "",
    closingBalance: db.closing_balance || "",
    transactionTotal: db.transaction_total || "",
    pageNumber: db.page_number == null ? null : db.page_number,
    status: db.status,
    error: db.error || null,
    totals: db.totals || core.runTotals(rowsData),
    summary: db.summary || null,
    committed: db.committed || null,
    resolved: !!db.resolved,
    resolvedAt: db.resolved_at || null,
    rows: rowsData,
  };
  if (db.balances) run.balances = db.balances;
  if (db.activity_truncated) run.activityTruncated = true;
  // Only carry an activity array when there is one, matching the file store —
  // appendActivity created it lazily, so a run with no log has no `activity` key.
  if (activity) run.activity = activity;
  return run;
}

/* ── uploads ─────────────────────────────────────────────────────────────── */

/**
 * The report exactly as it arrived, kept on disk.
 *
 * Not the parsed rows — the bytes. When a figure is disputed three weeks later
 * the question is always "what was actually in the file", and a re-parse of the
 * original is the only answer that settles it (CLAUDE.md §6b). The bytes stay on
 * the RECON_STORE_DIR volume rather than going into Postgres: they are already
 * durable there, and a database backup has no business carrying binary report
 * files. Only the run's `file` metadata is stored with the run.
 */
function saveUpload(originalName, buffer, at = new Date().toISOString()) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const name = core.uploadName(originalName, core.stampOf(at));
  const full = path.join(UPLOADS, name);
  fs.writeFileSync(full, buffer);
  return {
    name: String(originalName || name),
    stored: path.join("uploads", name),
    bytes: buffer.length,
    savedAt: at,
  };
}

/* ── runs ────────────────────────────────────────────────────────────────── */

function startRun({ source, file, statementDate, openingBalance, closingBalance, transactionTotal, rows, dryRun, columns, format }, at = new Date().toISOString()) {
  // The stamp alone collides when two runs start in the same second, which the
  // Mint and BPay cards make easy to do; the count makes it unique. Counting the
  // cache (all runs, loaded from the database at boot) keeps the suffix rising
  // across restarts exactly as counting the file's array did.
  const run = {
    id: `run-${core.stampOf(at)}-${runs.length + 1}`,
    startedAt: at,
    finishedAt: null,
    // A rehearsal is kept, because "we ran it and it looked fine" is worth
    // having — but it is marked, because a history that cannot tell a run that
    // filed money from one that only looked is worse than no history.
    dryRun: !!dryRun,
    source: source || "bpay",
    file: file || null,
    statementDate: statementDate || "",
    /* The uploaded file's own headings and container, kept with the run.
       Without them a run reopened from the picker can only be shown, and
       exported, as this code's five columns — and the whole point of the
       working file is that it is THEIR spreadsheet with three columns filled
       in. `format` is what decides whether the export comes back as .xlsx or
       .csv, so it has to outlive the tab that did the upload. */
    columns: Array.isArray(columns) ? columns.filter(Boolean) : [],
    format: format === "xlsx" ? "xlsx" : "csv",
    openingBalance: core.money(core.cents(openingBalance)),
    closingBalance: core.money(core.cents(closingBalance)),
    // BR01/step 3 — the NUVEI figure a human entered, not derived. `money()`
    // of an unreadable or blank entry is "", which is exactly "none entered",
    // not a guessed zero.
    transactionTotal: core.money(core.cents(transactionTotal)),
    pageNumber: null,
    status: "running",
    error: null,
    totals: core.runTotals(rows),
    summary: null,
    committed: null,
    /* IPSI only, in practice: an unresolved settlement can take days to fix,
       across several separate run attempts, and stays on the dashboard's
       pending list until a person says otherwise — see `markResolved`. Every
       run gets the field regardless of source; nothing but the IPSI list
       ever reads it. */
    resolved: false,
    resolvedAt: null,
    rows: (rows || []).map((r, i) => ({ n: i + 1, ...r })),
  };
  runs.push(run);

  const runParams = toParams(run);
  const rowParams = run.rows.map((row) => [run.id, row.n, JSON.stringify(row)]);
  persist(`run ${run.id}`, async () => {
    const cols = RUN_COLS.join(", ");
    const ph = RUN_COLS.map((c, i) => (JSON_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
    await pool.query(`INSERT INTO runs (${cols}) VALUES (${ph})`, runParams);
    for (const p of rowParams) {
      await pool.query("INSERT INTO run_rows (run_id, n, data) VALUES ($1, $2, $3::jsonb)", p);
    }
  });
  return run;
}

/**
 * A settlement is done with.
 *
 * Reconciliation Guide — IPSI's "Other features": errors can take days to
 * resolve, across several attempts, and for a settlement that STOPPED the
 * accounts team — not this code — is the one who knows when it is really
 * finished. That is what the button on the dashboard is for.
 *
 * A settlement that got all the way through is different, and `closeRun` calls
 * this itself for one: every row reconciled, the total agreed, Issue pressed,
 * and the receipts confirmed off Receipts To Reconcile. Nothing is left to
 * decide, and a pending list that keeps finished work stops being read.
 */
function markResolved(runId, at = new Date().toISOString()) {
  const run = runs.find((r) => r.id === runId);
  if (!run) return null;
  run.resolved = true;
  run.resolvedAt = at;
  persist(`resolve ${runId}`, () =>
    pool.query("UPDATE runs SET resolved = TRUE, resolved_at = $2 WHERE id = $1", [runId, at]));
  return run;
}

/**
 * Every unresolved attempt at ONE settlement, resolved together.
 *
 * A settlement is not a run. `listUnresolved` deliberately returns every run
 * rather than one per settlement date — two attempts are two pieces of
 * evidence and collapsing them would hide that a second was ever made — but
 * that cuts the other way when one finally succeeds: the successful run
 * clearing only itself leaves every earlier attempt at the same settlement
 * sitting on the pending list, and the list never empties. Measured 08-09-2026
 * on the client's own store: twenty-two unresolved runs, all of them
 * 2026-09-02, one settlement.
 *
 * They are attempts at the same thing. When the thing is done they are all
 * done, and nothing is lost — the runs keep their own status, rows and
 * activity in the store, they just stop being asked about.
 *
 * A run with no settlement date resolves alone: without one there is nothing
 * to say which other attempts belong to it, and guessing would clear runs that
 * are still outstanding.
 */
function markSettlementResolved(source, statementDate, at = new Date().toISOString()) {
  if (!statementDate) return [];
  const hit = runs.filter(
    (r) => r.source === source && r.statementDate === statementDate && !r.resolved
  );
  if (!hit.length) return [];
  const ids = hit.map((r) => r.id);
  for (const r of hit) {
    r.resolved = true;
    r.resolvedAt = at;
  }
  // Exactly the runs that were unresolved when we were called, by id — not a
  // `WHERE resolved = FALSE`, so a run resolved between now and when this write
  // drains off the queue is left to its own persist rather than swept up here.
  persist(`resolve settlement ${source}/${statementDate}`, () =>
    pool.query("UPDATE runs SET resolved = TRUE, resolved_at = $2 WHERE id = ANY($1)", [ids, at]));
  return ids;
}

/**
 * Every run for a report that is still sitting unresolved, most recent first.
 *
 * IPSI is the only report this is for — BPay/Mint/TravelPay finish in one
 * sitting and have no "still waiting on Tramada to be fixed" state at all.
 * Deliberately every RUN, not deduplicated to one per settlement date: two
 * attempts against the same date are two different pieces of evidence (what
 * changed between them), and collapsing them would hide that a second attempt
 * was ever made.
 *
 * A run still RUNNING is not listed. This list means "settlements needing
 * someone's attention", and a run that started ninety seconds ago has not
 * asked for anything yet — it may be about to come back clean and resolve
 * itself. Listing it made a settlement that turned out to be entirely
 * reconciled appear as pending work for as long as the run took.
 *
 * Nothing hides behind this. A run that dies mid-flight is swept to `failed`
 * by `reconcileOrphans` on the next start-up, and appears then.
 */
function listUnresolved(source) {
  return listRuns()
    .filter((r) => r.source === source && !r.resolved && r.status !== "running")
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

/** One row's verdict, written the moment it is known. */
function patchRow(runId, n, patch) {
  const run = runs.find((r) => r.id === runId);
  if (!run) return null;
  const row = (run.rows || []).find((r) => r.n === n);
  if (!row) return null;
  Object.assign(row, patch);
  run.totals = core.runTotals(run.rows);
  // The full merged row and the recomputed totals, so the database says the same
  // thing the cache does rather than a jsonb-merge that could drift from it.
  const rowJson = JSON.stringify(row);
  const totalsJson = j(run.totals);
  persist(`row ${runId}#${n}`, async () => {
    await pool.query("UPDATE run_rows SET data = $3::jsonb WHERE run_id = $1 AND n = $2", [runId, n, rowJson]);
    await pool.query("UPDATE runs SET totals = $2::jsonb WHERE id = $1", [runId, totalsJson]);
  });
  return row;
}

/**
 * One line of what the run said it was doing.
 *
 * These used to exist only as websocket frames — the page showed them and then
 * forgot them, so the overview's activity timeline had nothing real to draw and
 * a finished run could not be explained after the fact.
 *
 * Capped: a long run is chatty (a line per row per phase). The cap drops the
 * OLDEST lines both in the cache and in the table, so a reload sees the same
 * tail the screen does.
 */
function appendActivity(runId, message, ok, at = new Date().toISOString()) {
  const run = runs.find((r) => r.id === runId);
  if (!run) return null;
  run.activity = run.activity || [];
  const entry = { at, message: String(message == null ? "" : message).slice(0, 300), ok: ok !== false };
  run.activity.push(entry);
  let truncated = false;
  if (run.activity.length > ACTIVITY_CAP) {
    run.activity.splice(0, run.activity.length - ACTIVITY_CAP);
    run.activityTruncated = true;    // said out loud rather than silently lost
    truncated = true;
  }
  persist(`activity ${runId}`, async () => {
    await pool.query("INSERT INTO run_activity (run_id, at, message, ok) VALUES ($1, $2, $3, $4)",
      [runId, entry.at, entry.message, entry.ok]);
    if (truncated) {
      // Keep only the newest ACTIVITY_CAP lines, the same tail the cache kept.
      await pool.query(
        `DELETE FROM run_activity WHERE run_id = $1 AND seq NOT IN
           (SELECT seq FROM run_activity WHERE run_id = $1 ORDER BY seq DESC LIMIT $2)`,
        [runId, ACTIVITY_CAP]);
      await pool.query("UPDATE runs SET activity_truncated = TRUE WHERE id = $1", [runId]);
    }
  });
  return entry;
}

function finishRun(runId, { pageNumber, summary, selection, finished, balances, error } = {}) {
  const run = runs.find((r) => r.id === runId);
  if (!run) return null;
  run.finishedAt = new Date().toISOString();
  run.status = error ? "failed" : "done";
  run.error = error || null;
  if (pageNumber != null) run.pageNumber = pageNumber;
  if (summary) run.summary = summary;
  if (balances) run.balances = balances;
  run.committed = {
    done: !!(finished && finished.done),
    ticked: (selection && selection.ticked && selection.ticked.length) || 0,
    missing: (selection && selection.missing) || [],
    futureDated: (selection && selection.futureDated) || [],
    reason: (finished && finished.reason) || null,
  };
  run.totals = core.runTotals(run.rows);
  const snap = {
    finishedAt: run.finishedAt, status: run.status, error: run.error,
    pageNumber: run.pageNumber, summary: j(run.summary), committed: j(run.committed),
    balances: j(run.balances || null), totals: j(run.totals),
  };
  persist(`finish ${runId}`, () =>
    pool.query(
      `UPDATE runs SET finished_at = $2, status = $3, error = $4, page_number = $5,
         summary = $6::jsonb, committed = $7::jsonb, balances = $8::jsonb, totals = $9::jsonb
       WHERE id = $1`,
      [runId, snap.finishedAt, snap.status, snap.error, snap.pageNumber,
       snap.summary, snap.committed, snap.balances, snap.totals]));
  return run;
}

/**
 * A run that was still "running" when the process stopped is not running now.
 *
 * Called once at startup, after the cache is loaded. Without it a crashed run
 * sits on the dashboard as in-progress forever, and "1 running" is the kind of
 * figure people wait on.
 */
function reconcileOrphans() {
  const at = new Date().toISOString();
  let n = 0;
  for (const r of runs) {
    if (r.status === "running") {
      r.status = "failed";
      r.error = r.error || "the server stopped while this run was going";
      r.finishedAt = r.finishedAt || at;
      n++;
    }
  }
  if (n) {
    persist("reconcile orphans", () =>
      pool.query(
        `UPDATE runs SET status = 'failed',
           error = COALESCE(error, 'the server stopped while this run was going'),
           finished_at = COALESCE(finished_at, $1)
         WHERE status = 'running'`, [at]));
  }
  return n;
}

const listRuns = () => runs;
const getRun = (id) => runs.find((r) => r.id === id) || null;
const overview = () => core.overviewFrom(runs);

/* ── the supplier name cheat sheet ───────────────────────────────────────── */

/**
 * One mapping per report, replacing whatever was there.
 *
 * Both guides: "User to be able to upload supplier name cheat sheet. If there
 * is an existing one, it will get replaced. Date and time of upload will be
 * displayed." So: no history, one row per source, and the timestamp is part of
 * the record rather than a property of the filesystem — a restored database
 * should still say when Finance actually uploaded it.
 */
function readCheatSheets() {
  return cheats;
}

function saveCheatSheet(source, { name, pairs, problems }, at = new Date().toISOString()) {
  const entry = {
    source,
    name: String(name || "supplier-cheat-sheet"),
    uploadedAt: at,
    pairs: (pairs || []).map((p) => ({
      from: String(p.from),
      to: String(p.to),
      /* The candidates, not only the cell they came from. "Royal Caribbean /
         Celebrity Cruises" is TWO creditors, and writing just the cell here
         would quietly un-match one of them the moment the sheet came back off
         disk — a bug that only appears after a restart. */
      try: (p.try && p.try.length ? p.try : [p.to]).map(String),
    })),
    // Kept so the screen can say "3 of 19 lines were half a mapping" rather
    // than quietly using the 16 that worked.
    skipped: (problems || []).filter((p) => !p.heading).length,
  };
  cheats[source] = entry;
  const dataJson = JSON.stringify(entry);
  persist(`cheat sheet ${source}`, () =>
    pool.query(
      `INSERT INTO cheat_sheets (source, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (source) DO UPDATE SET data = EXCLUDED.data`, [source, dataJson]));
  return entry;
}

function getCheatSheet(source) {
  return cheats[source] || null;
}

/** For tests and graceful shutdown: drain writes and drop the pool. */
async function close() {
  await flush();
  if (pool) { await pool.end(); pool = null; }
  ready = null;
}

// Test-only: throw away the cache and any pool without touching Postgres, so a
// suite can start from empty. Never called by the server.
function _resetForTests() {
  runs = [];
  cheats = {};
  chain = Promise.resolve();
  pool = null;
  ready = null;
}

module.exports = {
  UPLOADS,
  init, flush, close,
  saveUpload, startRun, patchRow, appendActivity, finishRun,
  listRuns, getRun, overview, reconcileOrphans,
  markResolved, markSettlementResolved, listUnresolved,
  saveCheatSheet, getCheatSheet, readCheatSheets,
  _resetForTests,
};

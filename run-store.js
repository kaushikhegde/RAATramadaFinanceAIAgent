/**
 * run-store.js — where a run is written down.
 *
 *   uploads/20260810-143002-mint.xlsx     the report exactly as it arrived
 *   runs.json                             every run, its rows and its money
 *
 * The Run overview screen is fed from this file and nothing else. Before it
 * existed the screen showed the design mockup's invented figures — $7.2m of
 * them — behind a "sample data" banner, because there was nowhere for a
 * finished run to go: the results existed only as websocket frames to a page
 * that forgot them on reload.
 *
 * ── One file, and why it is allowed to be one file ──────────────────────────
 *
 * Everything lives in a single `runs.json`. That is the wrong shape for a
 * hundred thousand runs and the right shape for this: a daily reconciliation
 * makes a few hundred a year, the whole history is worth reading at once, and
 * one file is one thing to back up and one thing to open when a figure on the
 * dashboard is disputed.
 *
 * ── Writes are atomic, because a run is expensive to lose ───────────────────
 *
 * Every write goes to a temp file and is renamed over the real one. A process
 * killed mid-write leaves the previous good file rather than a truncated one,
 * and truncated JSON is a dashboard that will not load at all.
 *
 * ── A row is written as it happens, not at the end ──────────────────────────
 *
 * `patchRow` is called from the same `onRow` callback that feeds the page. A
 * run that dies on row 7 has still filed six real receipts, and their numbers
 * have to survive the process that filed them (this is the same rule
 * run-bookings.js follows for `created-bookings.json`, and for the same
 * reason).
 *
 * Everything that DECIDES anything — totals, the overview's figures, the
 * upload's filename — lives in recon-core.js and is tested offline. This file
 * only reads and writes.
 */

const fs = require("fs");
const path = require("path");
const core = require("./recon-core");

// The repo, unless a test points it somewhere disposable. A store whose
// location cannot be moved is a store whose tests write into the repo.
const ROOT = process.env.RECON_STORE_DIR || __dirname;
const UPLOADS = path.join(ROOT, "uploads");
const RUNS = path.join(ROOT, "runs.json");
const VERSION = 1;

/* ── the file ────────────────────────────────────────────────────────────── */

function readAll() {
  try {
    const doc = JSON.parse(fs.readFileSync(RUNS, "utf8"));
    if (Array.isArray(doc)) return { version: VERSION, runs: doc };
    if (doc && Array.isArray(doc.runs)) return { version: doc.version || VERSION, runs: doc.runs };
  } catch { /* no file yet, or it is unreadable — see below */ }
  return { version: VERSION, runs: [] };
}

/**
 * A corrupt runs.json is MOVED ASIDE, never overwritten in place.
 *
 * If the file will not parse, the runs in it are still somebody's record of
 * money that moved. Renaming it keeps that, and starting a fresh one keeps the
 * dashboard working — quietly writing over it would destroy the only copy at
 * the exact moment it became interesting.
 */
function readAllOrQuarantine() {
  if (!fs.existsSync(RUNS)) return { version: VERSION, runs: [] };
  try {
    JSON.parse(fs.readFileSync(RUNS, "utf8"));
    return readAll();
  } catch (err) {
    const aside = `${RUNS}.corrupt-${Date.now()}`;
    try { fs.renameSync(RUNS, aside); } catch { /* best effort */ }
    console.error(`  ⚠ runs.json would not parse (${err.message}). Moved to ${path.basename(aside)}.`);
    return { version: VERSION, runs: [] };
  }
}

function writeAll(doc) {
  const tmp = `${RUNS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, RUNS);
  return doc;
}

/* ── uploads ─────────────────────────────────────────────────────────────── */

/**
 * The report exactly as it arrived, kept.
 *
 * Not the parsed rows — the bytes. When a figure is disputed three weeks later
 * the question is always "what was actually in the file", and a re-parse of the
 * original is the only answer that settles it.
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

function startRun({ source, file, statementDate, openingBalance, closingBalance, rows, dryRun, columns, format }, at = new Date().toISOString()) {
  const doc = readAllOrQuarantine();
  // The stamp alone collides when two runs start in the same second, which the
  // Mint and BPay cards make easy to do; the count makes it unique.
  const run = {
    id: `run-${core.stampOf(at)}-${doc.runs.length + 1}`,
    startedAt: at,
    finishedAt: null,
    // A rehearsal is kept, because "we ran it and it looked fine" is worth
    // having — but it is marked, because a history that cannot tell a run
    // that filed money from one that only looked is worse than no history.
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
    pageNumber: null,
    status: "running",
    error: null,
    totals: core.runTotals(rows),
    summary: null,
    committed: null,
    rows: (rows || []).map((r, i) => ({ n: i + 1, ...r })),
  };
  doc.runs.push(run);
  writeAll(doc);
  return run;
}

/** One row's verdict, written the moment it is known. */
function patchRow(runId, n, patch) {
  const doc = readAll();
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return null;
  const row = (run.rows || []).find((r) => r.n === n);
  if (!row) return null;
  Object.assign(row, patch);
  run.totals = core.runTotals(run.rows);
  writeAll(doc);
  return row;
}

/**
 * One line of what the run said it was doing.
 *
 * These used to exist only as websocket frames — the page showed them and then
 * forgot them, so the overview's activity timeline had nothing real to draw and
 * a finished run could not be explained after the fact.
 *
 * Capped, because a long run is chatty (a line per row per phase) and an
 * unbounded log inside a file that is rewritten on every row turns a linear
 * cost into a quadratic one. The cap drops the OLDEST lines: the end of a run
 * is the part anyone reads.
 */
const ACTIVITY_CAP = 200;

function appendActivity(runId, message, ok, at = new Date().toISOString()) {
  const doc = readAll();
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return null;
  run.activity = run.activity || [];
  run.activity.push({ at, message: String(message == null ? "" : message).slice(0, 300), ok: ok !== false });
  if (run.activity.length > ACTIVITY_CAP) {
    run.activity.splice(0, run.activity.length - ACTIVITY_CAP);
    run.activityTruncated = true;    // said out loud rather than silently lost
  }
  writeAll(doc);
  return run.activity[run.activity.length - 1];
}

function finishRun(runId, { pageNumber, summary, selection, finished, balances, error } = {}) {
  const doc = readAll();
  const run = doc.runs.find((r) => r.id === runId);
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
  writeAll(doc);
  return run;
}

/**
 * A run that was still "running" when the process stopped is not running now.
 *
 * Called once at startup. Without it a crashed run sits on the dashboard as
 * in-progress forever, and "1 running" is the kind of figure people wait on.
 */
function reconcileOrphans() {
  const doc = readAllOrQuarantine();
  let n = 0;
  for (const r of doc.runs) {
    if (r.status === "running") {
      r.status = "failed";
      r.error = r.error || "the server stopped while this run was going";
      r.finishedAt = r.finishedAt || new Date().toISOString();
      n++;
    }
  }
  if (n) writeAll(doc);
  return n;
}

const listRuns = () => readAllOrQuarantine().runs;
const getRun = (id) => listRuns().find((r) => r.id === id) || null;
const overview = () => core.overviewFrom(listRuns());



/* ── the supplier name cheat sheet ───────────────────────────────────────── */

/**
 * One mapping file per report, replacing whatever was there.
 *
 * Both guides: "User to be able to upload supplier name cheat sheet. If there
 * is an existing one, it will get replaced. Date and time of upload will be
 * displayed." So: no history, one file, and the timestamp is part of the
 * record rather than a property of the filesystem — a copied or restored
 * directory should still say when Finance actually uploaded it.
 *
 * Kept in its own file rather than inside runs.json, because runs.json is
 * rewritten on every row of every run and a mapping table has no business
 * being rewritten a hundred times an hour.
 */
function cheatSheetPath() {
  return path.join(DIR, "cheat-sheets.json");
}

function readCheatSheets() {
  try { return JSON.parse(fs.readFileSync(cheatSheetPath(), "utf8")); }
  catch { return {}; }
}

function saveCheatSheet(source, { name, pairs, problems }, at = new Date().toISOString()) {
  const all = readCheatSheets();
  all[source] = {
    source,
    name: String(name || "cheat-sheet.csv"),
    uploadedAt: at,
    pairs: (pairs || []).map((p) => ({ from: String(p.from), to: String(p.to) })),
    // Kept so the screen can say "3 of 19 lines were half a mapping" rather
    // than quietly using the 16 that worked.
    skipped: (problems || []).filter((p) => !p.heading).length,
  };
  const tmp = `${cheatSheetPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, cheatSheetPath());
  return all[source];
}

function getCheatSheet(source) {
  return readCheatSheets()[source] || null;
}

module.exports = {
  UPLOADS, RUNS,
  saveUpload, startRun, patchRow, appendActivity, finishRun,
  listRuns, getRun, overview, reconcileOrphans,
  saveCheatSheet, getCheatSheet, readCheatSheets,
};

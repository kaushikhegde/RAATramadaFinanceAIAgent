/**
 * server.js — the bank reconciliation agent.
 *
 *   npm start        → http://localhost:3000
 *
 * One page and one socket. The page is the client's mockup with live wiring
 * (see build-recon.js); the socket carries a run's progress back while it
 * happens. Everything it decides lives in recon-core.js, which is pure and
 * tested; everything it clicks lives in recon-run.js.
 *
 * This was lifted out of the RAA back-office assistant, which also did chat,
 * Room-Res quotes, travel insurance and PDF itineraries. None of that is here —
 * the reconciliation flow never used it.
 *
 * ── The frames ───────────────────────────────────────────────────────────────
 *
 *   page  ──recon_parse{name, base64}────────────▶  a workbook or CSV to read
 *   page  ◀──recon_parsed{rows, problems}
 *   page  ──recon_run{source, rows, statementDate, openingBalance, closingBalance}
 *   page  ◀──recon_progress{message, ok}            every step, as it happens
 *   page  ◀──recon_login{message}                   a human has to sign in
 *   page  ◀──recon_row{n, row}                      one row's verdict
 *   page  ◀──recon_done{pageNumber | error}
 */
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const reconCore = require("./recon-core");
const xlsxLite = require("./xlsx-lite");
const store = require("./run-store");
const { runReconciliation, runMintReconciliation, runCombinedReconciliation } = require("./recon-run");
const { runIpsiReconciliation } = require("./tramada-ipsi");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC = path.join(__dirname, "public");

const app = express();
app.use(express.static(PUBLIC));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

/* ── the run history, for the overview screen ────────────────────────────── */

// Read over HTTP rather than pushed down the socket: the overview has to be
// right on a page that was opened long after the run finished, and a frame only
// reaches a page that was listening at the time.
app.get("/api/overview", (req, res) => res.json(store.overview()));
app.get("/api/runs", (req, res) => res.json(store.listRuns()));
app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "no such run" });
  res.json(run);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/* ── one session per open page ───────────────────────────────────────────── */

wss.on("connection", (ws) => {
  const session = { ws, active: true, reconRunning: false };
  console.log("🔌 page connected");

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try {
      if (msg.type === "recon_parse") handleReconParse(session, msg);
      else if (msg.type === "recon_upload") handleReconUpload(session, msg);
      else if (msg.type === "recon_run") await handleReconRun(session, msg);
    } catch (err) {
      // A throw here would take the socket down mid-run and the page would show
      // nothing at all. Report it as a finished run that failed.
      send(session, { type: "recon_done", error: reconCore.tidyError(err.message) });
    }
  });

  ws.on("close", () => { session.active = false; console.log("🔌 page disconnected"); });
});

function send(session, m) {
  if (session.active && session.ws.readyState === 1) session.ws.send(JSON.stringify(m));
}

/* ── reading an uploaded report ──────────────────────────────────────────── */

/**
 * A Mint file arrives as base64 and is read HERE.
 *
 * `xlsx-lite` is node, and a second parser in the browser is a second thing to
 * keep in agreement with the one the run actually uses. What comes back is what
 * the run will use.
 */
function handleReconParse(session, msg) {
  const name = String(msg.name || "the file");
  // Mint and TravelPay are both read here, by the parser the run itself uses.
  const source = reconCore.REPORTS[msg.source] && msg.source !== "bpay" ? msg.source : "mint";
  const reply = (extra) => send(session, { type: "recon_parsed", source, name, ...extra });

  // ~8 MB of base64 is ~6 MB of file. A daily settlement is tens of kilobytes.
  if (!msg.base64 || String(msg.base64).length > 8 * 1024 * 1024) {
    reply({ error: "that file is empty or far too large to be a daily settlement" });
    return;
  }

  try {
    const buf = Buffer.from(String(msg.base64), "base64");
    // Kept before it is parsed. The bytes are the only thing that settles a
    // disputed figure three weeks later, and they are already here — asking the
    // page to send them a second time would be sending the same file twice.
    keep(session, source, name, buf);
    // A zip starts "PK". That is the file's own container saying what it is —
    // not a guess from its name or its contents.
    const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
    const sheet = isZip ? xlsxLite.readSheet(buf) : reconCore.csvGrid(buf.toString("utf8"));
    const parse = {
      travelpay: reconCore.parseTravelPayRows,
      ipsi: reconCore.parseIpsiRows,
    }[source] || reconCore.parseMintRows;
    const { rows, problems, settlement } = parse(sheet.headers, sheet.rows);
    reply({ rows, problems, settlement, headers: sheet.headers, sheetRows: sheet.rows.length });
  } catch (err) {
    reply({ error: reconCore.tidyError(err.message) });
  }
}

/**
 * Keep the report exactly as it arrived.
 *
 * Storing must never take a run down: a full disk is a reason to lose the
 * archive copy, not a reason to refuse to reconcile. So this reports and
 * carries on rather than throwing into the run.
 */
function keep(session, source, name, buf) {
  try {
    const file = store.saveUpload(name, buf);
    session.files = session.files || {};
    session.files[source] = file;
    console.log(`📁 stored ${file.stored} (${file.bytes} bytes)`);
    return file;
  } catch (err) {
    console.error(`  ⚠ could not store ${name}: ${err.message}`);
    return null;
  }
}

/**
 * The BPay CSV, kept.
 *
 * Its own message because that file is parsed in the PAGE and never reached the
 * server at all — the run was filing real receipts from a file that existed
 * nowhere but a browser tab, and when someone asked what had been in it there
 * was nothing to show them. Mint has no such message: its workbook already
 * arrives whole for parsing and is kept there.
 */
function handleReconUpload(session, msg) {
  const source = reconCore.REPORTS[msg.source] ? msg.source : "bpay";
  const name = String(msg.name || "report");
  if (!msg.base64 || String(msg.base64).length > 8 * 1024 * 1024) {
    send(session, { type: "recon_uploaded", source, name, error: "that file is empty or too large to store" });
    return;
  }
  const file = keep(session, source, name, Buffer.from(String(msg.base64), "base64"));
  send(session, file
    ? { type: "recon_uploaded", source, name, file }
    : { type: "recon_uploaded", source, name, error: "the file could not be stored — the run can still go ahead" });
}

/* ── the runs ────────────────────────────────────────────────────────────── */

/**
 * The page's BPay rows, back into a CSV so recon-core can re-parse them.
 *
 * Re-parsed server-side rather than trusted: the browser parses only to SHOW
 * you what will be filed, and what actually gets filed is read here by the
 * parser the node tests cover, so there is one authority on what a row means.
 */
function csvOf(rows) {
  return [
    "Date,Reference,Rec/Pay Type,Amount,Booking No",
    ...(rows || []).map((r) => [r.date, r.reference, r.recPayType, r.amount, r.bookingNo]
      .map((v) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")),
  ].join("\n");
}

const callbacks = (session, run) => ({
  // To the page AND to disk. A progress line that lives only in a websocket
  // frame is gone the moment the tab is closed, which is why the overview's
  // activity timeline had nothing real to draw.
  onProgress: (message, ok) => {
    send(session, { type: "recon_progress", message, ok });
    if (run) { try { store.appendActivity(run.id, message, ok); } catch { /* the run matters more */ } }
  },
  // The same verdict goes to the page and to disk, from one call. A run that
  // dies on row 7 has still filed six real receipts and their numbers have to
  // outlive the process that filed them.
  onRow: (n, row) => {
    send(session, { type: "recon_row", n, row });
    if (run) { try { store.patchRow(run.id, n, row); } catch { /* the run matters more */ } }
  },
  // Its own frame, not a progress line. This is the one message during a run
  // that needs someone to go and DO something, and a run waits five minutes for
  // it — long enough that a line in a scrolling list is missed and the run looks
  // hung. The page shows it as a banner.
  onNeedLogin: () => send(session, {
    type: "recon_login",
    message: "Sign into Tramada in the Chrome on port 9222 — I'll wait, and I never type credentials.",
  }),
});

async function handleReconRun(session, msg) {
  if (msg.source === "both") return handleCombinedRun(session, msg);

  /* A report that ISSUES a receipt has its own flow and must never fall
     through to the BPay path — that path files a real receipt per row
     against a real booking, which for an IPSI file would be dozens of
     receipts nobody asked for. Until `tramada-ipsi.js` exists this refuses
     rather than doing the most dangerous available thing. */
  const report = reconCore.REPORTS[msg.source];
  if (report && report.issuesReceipt) return handleIpsiRun(session, msg);
  if (report && !report.files) return handleMintRun(session, msg);

  const { rows, problems } = reconCore.parseReconCsv(csvOf(msg.rows));

  for (const p of problems) {
    send(session, { type: "recon_progress", message: `Line ${p.line}: ${p.why}`, ok: false });
  }
  if (!rows.length) {
    send(session, { type: "recon_done", error: "nothing in that CSV could be run" });
    return;
  }
  if (session.reconRunning) {
    send(session, { type: "recon_progress", message: "A run is already going — waiting for it to finish.", ok: false });
    return;
  }
  session.reconRunning = true;

  const run = openRun(session, "bpay", msg, rows);
  try {
    const out = await runReconciliation({
      rows,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    send(session, {
      type: "recon_progress",
      message: `${s.allocated} of ${s.total} allocated, ${s.reconciled} reconciled, ${s.both} fully clean` +
        (s.failed ? `, ${s.failed} failed` : ""),
    });
    send(session, { type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id });
  } catch (err) {
    // The receipts already filed are real. Say how far it got rather than
    // implying the whole run rolled back — nothing here rolls back.
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    session.reconRunning = false;
  }
}

/**
 * Both reports, one run, one statement page.
 *
 * The BPay half is re-parsed here exactly as the single-report path does it —
 * the page parses only to SHOW you what will be filed, and what actually gets
 * filed is read by recon-core so there is one authority on what a row means.
 * The Mint half already came from this server's own parser.
 */
async function handleCombinedRun(session, msg) {
  const given = msg.byReport || {};
  const { rows: bpayRows, problems } = reconCore.parseReconCsv(csvOf(given.bpay));
  const byReport = { bpay: bpayRows };
  // Everything that is not BPay was parsed by this server already, on its way
  // in — it round-tripped through the page only so a person could look at it.
  for (const k of Object.keys(reconCore.REPORTS)) {
    if (k !== "bpay") byReport[k] = Array.isArray(given[k]) ? given[k] : [];
  }

  for (const p of problems) {
    send(session, { type: "recon_progress", message: `Line ${p.line}: ${p.why}`, ok: false });
  }
  if (!Object.values(byReport).some((rs) => rs.length)) {
    send(session, { type: "recon_done", error: "none of those reports had anything that could be run" });
    return;
  }
  if (session.reconRunning) {
    send(session, { type: "recon_progress", message: "A run is already going — this one was not started.", ok: false });
    return;
  }
  session.reconRunning = true;

  // One record, every report. Rows carry their own `src` so the overview can
  // still tell them apart on a screen whose stream cards are per report.
  const run = openRun(session, "both", msg,
    Object.keys(byReport).flatMap((k) => byReport[k].map((r) => ({ ...r, src: k }))));
  try {
    const out = await runCombinedReconciliation({
      byReport,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    send(session, {
      type: "recon_progress",
      message: `${s.reconciled} of ${s.total} reconciled on page ${out.pageNumber} ` +
        ` (${s.perReport})` +
        (s.allocated ? `, ${s.allocated} allocated` : "") +
        (s.failed ? `, ${s.failed} failed` : ""),
    });
    send(session, { type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    session.reconRunning = false;
  }
}

/**
 * IPSI: tick receipts that already exist, then issue ONE receipt for them.
 *
 * No statement page, no page number, no Done — this report drives the Finance
 * Receipts screens instead, so it shares nothing with the other three beyond
 * the card it is uploaded on.
 */
async function handleIpsiRun(session, msg) {
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  if (!rows.length) {
    send(session, { type: "recon_done", error: "nothing in that IPSI file could be checked" });
    return;
  }
  if (session.reconRunning) {
    send(session, { type: "recon_progress", message: "A run is already going — this one was not started.", ok: false });
    return;
  }
  session.reconRunning = true;

  const run = openRun(session, "ipsi", msg, rows.map((r) => ({ ...r, src: "ipsi" })));
  try {
    const out = await runIpsiReconciliation({
      rows,
      payerName: msg.payerName || "RAA",
      toDate: msg.statementDate,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    send(session, {
      type: "recon_progress",
      message: `${s.ticked} of ${s.total} matched and ticked` +
        (s.onBooking ? ` (${s.onReference} on reference, ${s.onBooking} on booking)` : "") +
        (out.issued && out.issued.issued ? `, receipt issued for $${out.issued.amount}` : ", nothing issued"),
    });
    send(session, { type: "recon_done", summary: s, runId: run && run.id });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    session.reconRunning = false;
  }
}

/* ── opening and closing the record of a run ─────────────────────────────── */

/**
 * Recording a run must never be able to stop one.
 *
 * Both of these swallow their own failures on purpose. A read-only disk is a
 * reason to lose the dashboard entry; it is not a reason to refuse to file
 * receipts that somebody is waiting on, and it is certainly not a reason to
 * abandon a run half way through with real receipts already filed.
 */
function openRun(session, source, msg, rows) {
  try {
    return store.startRun({
      source,
      file: (session.files && session.files[source]) || null,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      rows,
    });
  } catch (err) {
    console.error(`  ⚠ could not open the run record: ${err.message}`);
    return null;
  }
}

function closeRun(run, out, error) {
  if (!run) return;
  try {
    store.finishRun(run.id, {
      pageNumber: out && out.pageNumber,
      summary: out && out.summary,
      selection: out && out.selection,
      finished: out && out.finished,
      balances: out && out.balances,
      error: error || null,
    });
  } catch (err) {
    console.error(`  ⚠ could not close the run record: ${err.message}`);
  }
}

/** Mint: create the page, then look each transaction reference up on it. */
/**
 * Mint and TravelPay: create the page, then look each reference up on it.
 *
 * One handler for both because they are the same job — nothing is filed, a
 * reference either reached the page or it did not. All that differs is which
 * Rec/Pay Type the page is filtered to, and that comes from `REPORTS`.
 */
async function handleMintRun(session, msg) {
  const source = reconCore.REPORTS[msg.source] && msg.source !== "bpay" ? msg.source : "mint";
  const report = reconCore.REPORTS[source];
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  if (!rows.length) {
    send(session, { type: "recon_done", error: `nothing in that ${report.title} file could be checked` });
    return;
  }
  if (session.reconRunning) {
    send(session, { type: "recon_progress", message: "A run is already going — waiting for it to finish.", ok: false });
    return;
  }
  session.reconRunning = true;

  const run = openRun(session, source, msg, rows.map((r) => ({ ...r, src: source })));
  try {
    const out = await runMintReconciliation({
      rows,
      recPayType: report.recPayType,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    send(session, {
      type: "recon_progress",
      message: `${s.reconciled} of ${s.total} found on page ${out.pageNumber}` +
        (s.mismatched ? `, ${s.mismatched} with a difference to check` : "") +
        (s.notReconciled ? `, ${s.notReconciled} missing` : ""),
    });
    send(session, { type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    session.reconRunning = false;
  }
}

/* ── up ──────────────────────────────────────────────────────────────────── */

// A run still marked "running" is one the last process died holding. Said out
// loud, because "1 running" on the dashboard is a figure people wait on.
const orphans = store.reconcileOrphans();
if (orphans) console.log(`  ⚠ ${orphans} run(s) were still open from a previous server — marked failed.`);

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║   🏦  Bank reconciliation agent                ║
║   🌐  http://localhost:${String(PORT).padEnd(24)}║
╚════════════════════════════════════════════════╝

  A run drives Chrome over CDP on port ${process.env.CDP_PORT || 9222}.
  Start it with "npm run start:chrome" and sign into Tramada in that window —
  credentials are never typed here.
`);
});

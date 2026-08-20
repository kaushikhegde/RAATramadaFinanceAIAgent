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
const xlsxWrite = require("./xlsx-write");
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

/* ── the working file ────────────────────────────────────────────────────── */

/**
 * The updated spreadsheet, built HERE rather than in the browser.
 *
 * It used to be assembled client-side out of an in-memory array, which meant
 * three things: an .xlsx was impossible (there is no workbook writer in the
 * page), the file existed only for as long as the tab did, and the columns came
 * from whichever cards happened to be loaded rather than from the run being
 * looked at. All three go away by doing it on the server, where the same
 * `buildExportGrid` serves both formats.
 *
 * The FORMAT FOLLOWS THE UPLOAD. Finance sent a workbook, Finance gets a
 * workbook back; they sent a CSV, they get a CSV. Nobody should have to convert
 * a file to send it on.
 */
app.post("/api/export", express.json({ limit: "12mb" }), (req, res) => {
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "there are no rows to export" });

    const columns = Array.isArray(body.columns) ? body.columns.filter(Boolean) : [];
    const grid = reconCore.buildExportGrid(rows, columns, {
      inputColumns: reconCore.inputColumnsOf(columns),
    });

    // Their own file name, with what happened to it on the end — so a folder of
    // these still says which day each one was.
    const stem = String(body.name || "bpay-reconciliation")
      .replace(/\.(csv|xlsx?|txt)$/i, "").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "bpay";
    const wantXlsx = String(body.format || "").toLowerCase() === "xlsx";

    if (wantXlsx) {
      const buf = xlsxWrite.writeSheet(grid, "Reconciliation", {
        moneyColumns: reconCore.moneyColumnsOf(grid.headings),
      });
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${stem}-reconciled.xlsx"`);
      return res.send(buf);
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${stem}-reconciled.csv"`);
    // A BOM, so Excel on Windows opens a UTF-8 CSV without mangling a name like
    // "Ní Bhriain" into mojibake.
    res.send("﻿" + reconCore.gridToCsv(grid));
  } catch (err) {
    res.status(500).json({ error: reconCore.tidyError(err.message) });
  }
});

/* ── the supplier name cheat sheet ───────────────────────────────────────── */

/**
 * One cheat sheet per report, kept where the runs are kept.
 *
 * Both guides ask for the same thing: upload a CSV, it replaces the previous
 * one, and the dashboard shows when it was last uploaded. It exists because
 * MINT names companies by their LEGAL ENTITY — "Viva Holidays II Limited T/A
 * Ready Rooms" — and Tramada names creditors by their TRADING NAME —
 * "READY ROOMS". BR05's third gate compares those two strings, so without a
 * mapping the row fails on a naming difference rather than on the money.
 *
 * On disk rather than in the session: it is maintained once and used every day
 * by whoever happens to be at the screen.
 */
function handleCheatSheet(session, msg) {
  const source = reconCore.REPORTS[msg.source] ? msg.source : "mint";
  const reply = (extra) => send(session, { type: "cheat_sheet", source, ...extra });
  try {
    const text = Buffer.from(String(msg.base64 || ""), "base64").toString("utf8");
    const parsed = reconCore.parseCheatSheet(text);
    if (!parsed.pairs.length) {
      reply({ error: (parsed.problems[0] && parsed.problems[0].why) || "nothing in it could be read" });
      return;
    }
    reply({
      ...store.saveCheatSheet(source, {
        name: String(msg.name || "cheat-sheet.csv"),
        pairs: parsed.pairs,
        problems: parsed.problems,
      }),
      problems: parsed.problems,
    });
  } catch (err) {
    reply({ error: reconCore.tidyError(err.message) });
  }
}

/** Whatever is on file for this report, or an empty mapping. */
function cheatSheetFor(source) {
  try { return store.getCheatSheet(source) || { pairs: [] }; }
  catch { return { pairs: [] }; }
}

app.get("/api/cheat-sheet/:source", (req, res) => {
  const source = reconCore.REPORTS[req.params.source] ? req.params.source : "mint";
  res.json(store.getCheatSheet(source) || { source, pairs: [] });
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
      else if (msg.type === "recon_edit") handleReconEdit(session, msg);
      else if (msg.type === "cheat_sheet") handleCheatSheet(session, msg);
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

/**
 * A cell somebody corrected by hand.
 *
 * Consultant and Shop are filled in from the booking, and the booking is not
 * always right — a consultant leaves, a booking was made under the wrong shop.
 * Remarks is the agent's reading of a business rule, and the person sending the
 * file to Finance is the one who knows whether it holds. So all three are
 * editable, and the correction is written where the run's own verdicts are
 * written, which is what makes it survive the tab being closed.
 *
 * ONLY those three fields. A patch is arriving from a browser and there is no
 * reason for it to be able to rewrite a receipt number, an allocation verdict
 * or an amount — those are the run's record of what it did to a finance system,
 * and nothing typed into a table cell should be able to disagree with them.
 */
const EDITABLE = ["consultant", "shop", "remark"];

function handleReconEdit(session, msg) {
  const runId = String(msg.runId || "");
  const n = Number(msg.n);
  if (!runId || !Number.isFinite(n)) return;

  const patch = {};
  for (const k of EDITABLE) {
    if (msg.patch && Object.prototype.hasOwnProperty.call(msg.patch, k)) {
      patch[k] = String(msg.patch[k] == null ? "" : msg.patch[k]).slice(0, 200);
    }
  }
  if (!Object.keys(patch).length) return;

  try {
    const row = store.patchRow(runId, n, patch);
    // Told, rather than assumed. A silent failure here looks exactly like a
    // successful edit until the page is reloaded and the correction is gone.
    if (!row) send(session, { type: "recon_progress", ok: false,
      message: `Could not save the edit to row ${n} — no such row in ${runId}.` });
  } catch (err) {
    send(session, { type: "recon_progress", ok: false,
      message: `Could not save the edit to row ${n}: ${reconCore.tidyError(err.message)}` });
  }
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
  /* Every report is read here, by the parser the run itself uses — BPay
     included since 17-Aug-2026. It used to be excluded, so a BPay workbook was
     read as text in the browser and refused with "the header is missing", while
     the identical container from Mint went straight through. That is a
     distinction nobody outside this file could have predicted, on a file the
     guide only ever calls "a spreadsheet". */
  const source = reconCore.REPORTS[msg.source] ? msg.source : "mint";
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
      bpay: reconCore.parseReconRows,
      travelpay: reconCore.parseTravelPayRows,
      ipsi: reconCore.parseIpsiRows,
    }[source] || reconCore.parseMintRows;
    const { rows, problems, settlement, columns } = parse(sheet.headers, sheet.rows);
    /* `columns` is the file's own headings, in its own order. It goes back to
       the page so the inbox can show the spreadsheet as Finance wrote it, and
       so the export can hand back that same spreadsheet with the run's columns
       filled in rather than a new file of this code's own devising. */
    reply({
      rows, problems, settlement, columns: columns || sheet.headers,
      format: isZip ? "xlsx" : "csv",
      headers: sheet.headers, sheetRows: sheet.rows.length,
    });
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
      // Checks only: the run does everything except press Issue and Done.
      dryRun: !!msg.dryRun,
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
      // Checks only: the run does everything except press Issue and Done.
      dryRun: !!msg.dryRun,
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
      // Checks only: the run does everything except press Issue and Done.
      dryRun: !!msg.dryRun,
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
    const run = store.startRun({
      source,
      file: (session.files && session.files[source]) || null,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      dryRun: !!msg.dryRun,
      /* The uploaded file's own headings, kept with the run. This is what lets
         the inbox show the spreadsheet as it was, and the export hand back
         THEIR file rather than a new one — including for a run reopened from
         the picker a week later, when the upload itself is long gone from the
         page. */
      columns: Array.isArray(msg.columns) ? msg.columns.filter(Boolean) : [],
      format: msg.format === "xlsx" ? "xlsx" : "csv",
      rows,
    });
    // The page needs the id before the run ends: an edited Consultant cell has
    // to be able to say which run it belongs to while the run is still going.
    if (run) send(session, { type: "recon_started", runId: run.id });
    return run;
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
      // The NORMALISED source, not `msg.source`: line 1 above already falls
      // back to "mint" for anything it does not recognise, and passing the raw
      // value would let the two disagree about which report this is — which is
      // exactly the class of bug that put TravelPay on Mint's matcher.
      source,
      recPayType: report.recPayType,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      /* MINT BR02 / TravelPay BR02 — the figure a human worked out from the
         bank statement. Checked against the file's own total once, at the end,
         and reported on the RUN rather than down every row. */
      transactionTotal: msg.transactionTotal,
      /* BR05's supplier gate. MINT names companies by legal entity and Tramada
         names creditors by trading name, so without this a perfectly good row
         reads "Supplier does not match". Kept per report, because the two
         reports pay different sets of people. */
      cheatSheet: cheatSheetFor(source),
      // Checks only: the run does everything except press Issue and Done.
      dryRun: !!msg.dryRun,
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

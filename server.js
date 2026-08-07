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
const { runReconciliation, runMintReconciliation } = require("./recon-run");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC = path.join(__dirname, "public");

const app = express();
app.use(express.static(PUBLIC));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

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
  const reply = (extra) => send(session, { type: "recon_parsed", source: "mint", name, ...extra });

  // ~8 MB of base64 is ~6 MB of file. A daily settlement is tens of kilobytes.
  if (!msg.base64 || String(msg.base64).length > 8 * 1024 * 1024) {
    reply({ error: "that file is empty or far too large to be a daily settlement" });
    return;
  }

  try {
    const buf = Buffer.from(String(msg.base64), "base64");
    // A zip starts "PK". That is the file's own container saying what it is —
    // not a guess from its name or its contents.
    const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
    const sheet = isZip ? xlsxLite.readSheet(buf) : reconCore.csvGrid(buf.toString("utf8"));
    const { rows, problems } = reconCore.parseMintRows(sheet.headers, sheet.rows);
    reply({ rows, problems, headers: sheet.headers, sheetRows: sheet.rows.length });
  } catch (err) {
    reply({ error: reconCore.tidyError(err.message) });
  }
}

/* ── the runs ────────────────────────────────────────────────────────────── */

const callbacks = (session) => ({
  onProgress: (message, ok) => send(session, { type: "recon_progress", message, ok }),
  onRow: (n, row) => send(session, { type: "recon_row", n, row }),
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
  if (msg.source === "mint") return handleMintRun(session, msg);

  /* Re-parse server-side rather than trusting the page's rows. The browser
     parses only to SHOW you what will be filed; what actually gets filed is read
     here, by the parser node tests, so there is one authority on what a row
     means. */
  const csv = [
    "Date,Reference,Rec/Pay Type,Amount,Booking No",
    ...(msg.rows || []).map((r) => [r.date, r.reference, r.recPayType, r.amount, r.bookingNo]
      .map((v) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")),
  ].join("\n");
  const { rows, problems } = reconCore.parseReconCsv(csv);

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

  try {
    const out = await runReconciliation({
      rows,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      callbacks: callbacks(session),
    });
    const s = out.summary;
    send(session, {
      type: "recon_progress",
      message: `${s.allocated} of ${s.total} allocated, ${s.reconciled} reconciled, ${s.both} fully clean` +
        (s.failed ? `, ${s.failed} failed` : ""),
    });
    send(session, { type: "recon_done", pageNumber: out.pageNumber, summary: s });
  } catch (err) {
    // The receipts already filed are real. Say how far it got rather than
    // implying the whole run rolled back — nothing here rolls back.
    send(session, { type: "recon_done", error: reconCore.tidyError(err.message) });
  } finally {
    session.reconRunning = false;
  }
}

/** Mint: create the page, then look each transaction reference up on it. */
async function handleMintRun(session, msg) {
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  if (!rows.length) {
    send(session, { type: "recon_done", error: "nothing in that workbook could be checked" });
    return;
  }
  if (session.reconRunning) {
    send(session, { type: "recon_progress", message: "A run is already going — waiting for it to finish.", ok: false });
    return;
  }
  session.reconRunning = true;

  try {
    const out = await runMintReconciliation({
      rows,
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      callbacks: callbacks(session),
    });
    const s = out.summary;
    send(session, {
      type: "recon_progress",
      message: `${s.reconciled} of ${s.total} found on page ${out.pageNumber}` +
        (s.mismatched ? `, ${s.mismatched} with a difference to check` : "") +
        (s.notReconciled ? `, ${s.notReconciled} missing` : ""),
    });
    send(session, { type: "recon_done", pageNumber: out.pageNumber, summary: s });
  } catch (err) {
    send(session, { type: "recon_done", error: reconCore.tidyError(err.message) });
  } finally {
    session.reconRunning = false;
  }
}

/* ── up ──────────────────────────────────────────────────────────────────── */

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

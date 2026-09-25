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
 *   page  ◀──recon_hello{novncPort}                 what this deployment has
 *   page  ◀──recon_login{message}                   a human has to sign in
 *   page  ◀──recon_login_ok{message}                ...and has now done it
 *   page  ◀──recon_row{n, row}                      one row's verdict
 *   page  ◀──recon_done{pageNumber | error}
 *   page  ──recon_login_test                    sign in, and nothing else
 *   page  ◀──recon_login_test_done{signedInAs | error}
 */
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const reconCore = require("./recon-core");
const xlsxLite = require("./xlsx-lite");
const xlsxWrite = require("./xlsx-write");
const store = require("./run-store");
const { runReconciliation, runMintReconciliation, runCombinedReconciliation, runTramadaLogin } = require("./recon-run");
const { runIpsiReconciliation } = require("./tramada-ipsi");
// docs/dvc.md steps 12-16. Separate from the reconciliation above it: the
// matching is offline and the session drives the shared browser, and only the
// second of those needs the run lock.
const { runDvcPayment } = require("./tramada-dvc");
// Step 18 — the email to Travel Accounts.
const mailer = require("./mailer");
/* BR12's Issue Payment card as Tramada's own dropdown spells it (four dots,
   hyphens — measured 22-09-2026). A masked LABEL: the BIN and last four that
   Tramada already shows everyone, never a card number (§4). */
const DVC_CARD_DEFAULT = "555003....0457 CA - A - Westpac DVC VCC";
const paymentsChat = require("./payments-chat");
const tokioCore = require("./tokio-core");
const tramadaTokio = require("./tramada-tokio");
const tokioEmail = require("./tokio-email");
const paymentsCore = require("./payments-core");
const azureAuth = require("./azure-auth");
const creds = require("./tramada-creds");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC = path.join(__dirname, "public");

/* The container runs a Chromium on a virtual screen and serves that screen as a
   web page, so a human can sign in without a Chrome on the host — see
   docker-entrypoint.sh. NOVNC_PORT is set by the image and by nothing else,
   which is the whole test: no port means no login screen exists, and the page
   must not offer to frame one. Discovered, not assumed (CLAUDE.md §6).

   Only the PORT travels to the page, never a host. The page builds the URL from
   its own location.hostname, so it still works through the
   `ssh -L 6080:localhost:6080` tunnel the README recommends — where a
   server-side 127.0.0.1 would name the wrong machine entirely. */
const NOVNC_PORT = parseInt(process.env.NOVNC_PORT || "", 10) || null;

const app = express();
/* Sign-in goes on BEFORE the static handler, and that order is the whole
   protection: express.static serves index.html to anyone who asks for it by
   name, so mounting it first would leave the entire app reachable without a
   session while the routes below looked guarded. */
azureAuth.install(app);

// The two things an unauthenticated browser is allowed: the login page itself,
// and the question "am I signed in?" that the page asks to render itself.
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC, "login.html")));
app.get("/api/me", (req, res) => {
  const user = azureAuth.userFromSession(req.session);
  res.json({ entra: azureAuth.enabled(), signedIn: !!user, user, vault: creds.configured() });
});

app.use(azureAuth.requireAuth);
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

/* IPSI settlements that can take days to fix, across several run attempts —
   Reconciliation Guide — IPSI's "Other features". A person, not a clean run,
   decides one is finished (see `run-store.markResolved`), so this list can
   keep showing a settlement whose most recent attempt looked fine. */
app.get("/api/ipsi/unresolved", (req, res) => res.json(store.listUnresolved("ipsi")));
app.post("/api/runs/:id/resolve", (req, res) => {
  const run = store.markResolved(req.params.id);
  if (!run) return res.status(404).json({ error: "no such run" });
  res.json(run);
});

/* ── IPSI customer payments, as a conversation ───────────────────────────── */

/*
 * "Payments Guide - IPSI.docx" is a different job from reconciliation: a
 * consultant has just taken a card payment over the phone and needs the
 * matching Credit Card Swipe receipt raised in Tramada. The guide asks for it
 * to run as a conversation — stop when something is missing, confirm with a
 * human before writing anything, and keep a log of the steps.
 *
 * All of that lives in payments-chat.js, which is pure. This holds only the
 * sessions, in memory: a conversation that is lost on restart costs one
 * re-paste, whereas persisting a half-finished receipt invites a stale one
 * being confirmed days later against a booking that has moved on.
 */
const paymentSessions = new Map();
const PAYMENT_SESSION_TTL_MS = 60 * 60 * 1000;

function reapPaymentSessions(now = Date.now()) {
  for (const [id, entry] of paymentSessions) {
    if (now - entry.touched > PAYMENT_SESSION_TTL_MS) paymentSessions.delete(id);
  }
}

function paymentReply(id, result) {
  reapPaymentSessions();
  paymentSessions.set(id, { session: result.session, touched: Date.now() });
  return {
    id,
    step: result.step,
    awaiting: result.awaiting || null,
    choices: result.choices || null,
    suggestion: result.suggestion || null,
    ready: result.ready === true,
    message: result.message,
    decision: result.ready ? result.decision : undefined,
    log: result.session.log,
  };
}

app.post("/api/ipsi-payment/start", express.json({ limit: "256kb" }), (req, res) => {
  try {
    const text = String((req.body && req.body.text) || "");
    const id = "pay_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    res.json(paymentReply(id, paymentsChat.startIpsiPayment(text)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ipsi-payment/:id/reply", express.json({ limit: "256kb" }), (req, res) => {
  const entry = paymentSessions.get(req.params.id);
  if (!entry) {
    return res.status(404).json({
      error: "That conversation has expired. Paste the IPSI approval again to start a new one.",
    });
  }
  try {
    const text = String((req.body && req.body.text) || "");
    res.json(paymentReply(req.params.id, paymentsChat.replyIpsiPayment(entry.session, text)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── IPSI customer payments, raised from the settlement file ─────────────── */

/*
 * "Payments Guide - IPSI.docx" steps 2-9, for a whole settlement file.
 *
 * The same file the IPSI card already holds for reconciliation carries
 * everything step 1 asks a consultant to read off the Approved screen: booking
 * number, transaction reference, amount, cardholder. The guide's own note —
 * "issue receipt at end of day" — is that file.
 *
 * ONE thing is not in it: whether the customer paid by credit or debit. BR02
 * says that is confirmed with the customer, so the caller states it for the
 * run and a row whose brand disagrees is refused rather than coerced.
 *
 * BR07 still holds: nothing here touches IPSI. The charge was taken by a human
 * in real time; this only raises the matching receipt in Tramada.
 */

app.post("/api/ipsi-payment/plan", express.json({ limit: "12mb" }), (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    const cardType = String((req.body && req.body.cardType) || "");
    if (!rows.length) return res.status(400).json({ error: "No settlement rows to receipt." });

    const choice = paymentsCore.normaliseCardChoice(cardType);
    if (!paymentsCore.BR08_CARDS[choice]) {
      return res.status(400).json({
        error:
          'The settlement file records the brand ("VISA"), never credit or debit, and ' +
          "BR02 says that is confirmed with the customer. Choose one.",
        choices: Object.keys(paymentsCore.BR08_CARDS),
      });
    }

    const plan = rows.map((row) => {
      const brand = paymentsCore.normaliseCardType(row.brand || row.cardType || "");
      if (brand && !choice.startsWith(brand)) {
        return { row, skip: `The file says ${brand}, this run is ${choice}.` };
      }
      const d = paymentsCore.decideSwipeReceipt(
        { ...row, cardType: choice },
        row.cardholderName || row.payerName,
        {}
      );
      return d.ok ? { row, decision: d } : { row, skip: d.reason };
    });

    res.json({
      cardType: choice,
      ready: plan.filter((p) => p.decision).length,
      skipped: plan.filter((p) => p.skip).length,
      plan: plan.map((p) => ({
        bookingNo: p.row.bookingNo,
        txnRef: p.row.txnRef,
        amount: p.row.amount,
        payerName: p.decision ? p.decision.receipt.payerName : p.row.cardholderName || "",
        card: p.decision ? p.decision.receipt.card.choice : null,
        reference: p.decision ? p.decision.receipt.reference : null,
        skip: p.skip || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Tokio Marine, the monthly reconciliation ────────────────────────────── */

/*
 * Four spreadsheets, uploaded together, for one reporting month (BR01). Unlike
 * the daily cards there is no Transaction Total to enter — the guide is
 * explicit that the figure to balance to is not known until Retail is excluded
 * and exceptions are resolved.
 *
 * The month is not asked for either. The files carry no month anywhere, so it
 * is derived from the B2B report's own transaction dates and handed back for a
 * human to confirm or correct.
 *
 * Everything decided here lives in tokio-core.js, which is pure and tested.
 * This endpoint only turns bytes into rows.
 */

/** A zip starts "PK" — the container saying what it is, not its file name. */
function sheetFromBase64(base64) {
  const buf = Buffer.from(String(base64 || ""), "base64");
  if (!buf.length) return { headers: [], rows: [] };
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
  return isZip ? xlsxLite.readSheet(buf) : reconCore.csvGrid(buf.toString("utf8"));
}

/** headers + row arrays -> row objects, keyed by the file's own headings. */
function asObjects(sheet) {
  const headers = (sheet.headers || []).map((h) => String(h == null ? "" : h).trim());
  return (sheet.rows || []).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      if (h) o[h] = Array.isArray(r) ? r[i] : r[h];
    });
    return o;
  });
}

const TOKIO_FILES = ["b2b", "payment", "costing", "rcc"];
const TOKIO_TITLES = {
  b2b: "Tokio Marine B2B report",
  payment: "Tramada Payment Report",
  costing: "Tramada Costing Report",
  rcc: "RCC report (Finance One)",
};

app.post("/api/tokio/parse", express.json({ limit: "48mb" }), (req, res) => {
  try {
    const body = req.body || {};
    const files = body.files || {};

    const missing = TOKIO_FILES.filter((k) => !files[k] || !files[k].base64);
    if (missing.length) {
      return res.status(400).json({
        error:
          "All four files are needed for the same reporting month (BR01): missing " +
          missing.map((k) => TOKIO_TITLES[k]).join(", ") + ".",
        missing,
      });
    }

    const sheets = {};
    for (const k of TOKIO_FILES) {
      try {
        sheets[k] = asObjects(sheetFromBase64(files[k].base64));
      } catch (err) {
        return res.status(400).json({
          error: `Could not read ${TOKIO_TITLES[k]} (${(files[k].name || "")}): ${err.message}`,
        });
      }
      if (!sheets[k].length) {
        return res.status(400).json({
          error: `${TOKIO_TITLES[k]} (${files[k].name || ""}) has no rows.`,
        });
      }
    }

    /* The month. Derived, never assumed — and the caller may override it,
       which is why it comes back with its own warnings attached rather than
       being applied silently. */
    const month = body.month
      ? { ok: true, key: body.month, label: null, warnings: [], overridden: true }
      : tokioCore.deriveReportingMonth(sheets.b2b);
    if (!month.ok) return res.status(400).json({ error: month.reason });
    if (month.overridden) {
      try {
        const d = tokioCore.monthKeyToDate(month.key);
        month.label = `${tokioCore.MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    const sources = {
      payment: tokioCore.indexByPolicy(sheets.payment, (r) => r["Reference"]),
      costing: tokioCore.indexByPolicy(sheets.costing, (r) => r["Segment Reference"]),
      rcc: tokioCore.indexByPolicy(sheets.rcc, (r) => r["Ticket/Booking No."]),
    };

    const consolidated = tokioCore.buildConsolidated(sheets.b2b, sources);
    const monthDate = tokioCore.monthKeyToDate(month.key);

    res.json({
      month: {
        key: month.key,
        label: month.label,
        counted: month.counted,
        outside: month.outside,
        unreadable: month.unreadable,
        warnings: month.warnings || [],
        overridden: !!month.overridden,
      },
      labels: {
        paymentReference: tokioCore.paymentReference(monthDate), // step 11
        sessionLabel: tokioCore.sessionLabel(monthDate),         // step 14
      },
      files: TOKIO_FILES.map((k) => ({
        kind: k,
        title: TOKIO_TITLES[k],
        name: files[k].name || "",
        rows: sheets[k].length,
        unreadableKeys: k === "b2b" ? undefined : (sources[k] ? sources[k].unreadable.length : undefined),
      })),
      counts: {
        total: consolidated.rows.length,
        travel: consolidated.travel.length,
        retail: consolidated.retail.length,
        exceptions: consolidated.exceptions.length,
        undocumented: consolidated.rows.filter((r) => r.undocumented).length,
      },
      /* The whole sheet goes back: the dashboard shows it, and the export hands
         back the B2B report's own columns with ours appended (BR02). */
      appendedColumns: tokioCore.APPENDED_COLUMNS,
      rows: consolidated.rows.map((r) => ({
        line: r.line,
        policy: r.policy,
        outcome: r.outcome,
        undocumented: r.undocumented,
        source: r.row,
        appended: r.appended,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Steps 9-14 against the live Tramada, driven from the dashboard.
 *
 * The page already holds the consolidated rows it is showing, so it posts
 * those back rather than a file path — the run then reconciles exactly what
 * the consultant was looking at, which a path on disk cannot promise.
 *
 * Two gates, both deliberate:
 *
 *   dryRun is the DEFAULT. Without `confirm` it ticks the matching lines and
 *   stops, leaving the filled page open in Tramada for a human to check.
 *
 *   BR16 — Issue is never clicked, here or anywhere. Saving the session takes
 *   the exact literal, and even then the payment total is left for Travel
 *   Accounts (BR18).
 *
 * This is a long call: a browser, a search, and up to fifty pages of matching.
 * It answers once, when it is done, and the steps come back with it — so the
 * card can show what happened rather than only whether it worked.
 */
app.post("/api/tokio/reconcile", express.json({ limit: "24mb" }), async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) {
    return res.status(400).json({ error: "No consolidated rows to reconcile — upload the four files first." });
  }

  // Only what steps 7-8 classified as Travel is reconciled. The whole sheet is
  // sent and filtered HERE, so the page cannot widen it by accident.
  const travel = rows.filter((r) => r.outcome === tokioCore.OUTCOME.TRAVEL);
  if (!travel.length) {
    return res.status(400).json({
      error:
        "No Travel transactions in this sheet. Steps 7-8 excluded every row as Retail or flagged it as an " +
        "exception, so there is nothing to tick.",
    });
  }

  const steps = [];
  try {
    const out = await tramadaTokio.runTokioReconciliation({
      consolidated: { rows, travel },
      month: body.month || null,
      dryRun: body.confirm !== tramadaTokio.SAVE_LITERAL,
      confirm: body.confirm || null,
      callbacks: {
        onProgress: (percent, status) => steps.push({ step: percent + "%", detail: status }),
        onStep: (s) => steps.push(s),
      },
    });
    res.json({
      reference: out.reference,
      label: out.label,
      savedSession: out.savedSession,
      ticked: out.ticked,
      mismatched: out.mismatched,
      steps: out.steps,
      confirmLiteral: tramadaTokio.SAVE_LITERAL,
    });
  } catch (err) {
    // The steps matter most when it failed — they say how far it got.
    res.status(500).json({ error: err.message, steps: err.steps || steps });
  }
});


/**
 * Step 15 / BR17 — the consolidated sheet goes to Travel Accounts.
 *
 * The page sends the sheet it is showing, the same bytes the Export button
 * would hand the user, so the mail and the download can never disagree.
 *
 * It DRAFTS by default. tokio-email.js says at length why: the message
 * asserts "session saved, ready for review", and a person pressing Send in
 * their own mail client is the person who owns that claim. Transmitting
 * takes `transport: "smtp"` plus the exact literal, and credentials that are
 * not in this repo.
 */
app.post("/api/tokio/email", express.json({ limit: "48mb" }), async (req, res) => {
  const body = req.body || {};
  try {
    const attachment = body.attachment || {};
    if (!attachment.filename || !attachment.contentBase64) {
      return res.status(400).json({
        error: "Nothing to attach. BR17 is the consolidated spreadsheet reaching Travel Accounts.",
      });
    }
    const out = await tokioEmail.sendReconciliationEmail({
      to: body.to || tokioEmail.TRAVEL_ACCOUNTS,
      from: body.from || process.env.MAIL_FROM || null,
      subject: body.subject || tokioEmail.SUBJECT,
      label: body.label,
      month: body.month,
      reference: body.reference,
      savedSession: body.savedSession === true,
      counts: body.counts || {},
      attachments: [{
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, "base64"),
      }],
      transport: body.transport === "smtp" ? "smtp" : "draft",
      confirm: body.confirm || null,
      dir: path.join(__dirname, "csv_uploads"),
    });
    res.json({ ...out, sendLiteral: tokioEmail.SEND_LITERAL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
 * ONE cheat sheet, used by MINT and TravelPay alike.
 *
 * The two guides each name their own — "MINT Supplier Name Cheat Sheet",
 * "TravelPay Supplier Name Cheat Sheet" — as though there were two. RAA's actual
 * sheet is headed "SUPPLIER NAME IN MINT / TRAVELPAY" and is one file covering
 * both, and that is how it is kept here: upload it once, both reports use it.
 *
 * It exists because the spreadsheets name companies by their LEGAL ENTITY —
 * "Viva Holidays II Limited T/A Ready Rooms" — and Tramada names creditors by
 * their TRADING NAME — "READY ROOMS". BR05's third gate compares those two
 * strings, so without a mapping the row fails on a naming difference rather than
 * on the money.
 *
 * On disk rather than in the session: it is maintained once and used every day
 * by whoever happens to be at the screen.
 */
const CHEAT_SHEET_KEY = "suppliers";
const SHIPPED_CHEAT_SHEET = path.join(__dirname, "cheat-sheets", "supplier-names.xlsx");

/** Excel or CSV, both guides' "Other features", and the sheet arrives as .xlsx. */
function parseUploadedCheatSheet(name, base64) {
  const buf = Buffer.from(String(base64 || ""), "base64");
  // The extension if there is one, the ZIP magic if there isn't — a workbook
  // read as UTF-8 turns into one nonsense line and a baffling error message.
  const isXlsx = /\.xlsx$/i.test(String(name || "")) ||
    (buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b);
  return isXlsx
    ? reconCore.parseCheatSheet(xlsxLite.readSheet(buf))
    : reconCore.parseCheatSheet(buf.toString("utf8"));
}

function handleCheatSheet(session, msg) {
  const reply = (extra) => send(session, { type: "cheat_sheet", source: CHEAT_SHEET_KEY, via: "upload", ...extra });
  try {
    const parsed = parseUploadedCheatSheet(msg.name, msg.base64);
    if (!parsed.pairs.length) {
      reply({ error: (parsed.problems[0] && parsed.problems[0].why) || "nothing in it could be read" });
      return;
    }
    reply({
      ...store.saveCheatSheet(CHEAT_SHEET_KEY, {
        name: String(msg.name || "supplier-cheat-sheet"),
        pairs: parsed.pairs,
        problems: parsed.problems,
      }),
      problems: parsed.problems,
    });
  } catch (err) {
    reply({ error: reconCore.tidyError(err.message) });
  }
}

/**
 * A row typed or edited by hand on the Reconciliation inbox's cheat-sheet tab,
 * as opposed to a file dropped on it (`handleCheatSheet` above). Kept as its
 * own message rather than folded into that one because the two have nothing in
 * common to validate: a upload is bytes that might not even be a spreadsheet,
 * an edit is already `{from, to}` strings the page's own inputs produced.
 *
 * Whole-sheet replace, same as an upload — "no history, one file" (see
 * `run-store.saveCheatSheet`) applies here too, so Save writes the page's
 * current table, not a diff of one row.
 */
function handleCheatSheetSave(session, msg) {
  const reply = (extra) => send(session, { type: "cheat_sheet", source: CHEAT_SHEET_KEY, via: "edit", ...extra });
  try {
    const problems = [];
    const pairs = [];
    (Array.isArray(msg.pairs) ? msg.pairs : []).forEach((p, i) => {
      const from = String((p && p.from) || "").trim();
      const to = String((p && p.to) || "").trim();
      if (!from && !to) return;                 // a blank row added and left empty
      if (!from || !to) {
        problems.push({ line: i + 1, why: `half a mapping — "${from}" → "${to}"` });
        return;
      }
      pairs.push({ from, to, try: reconCore.cheatSheetCandidates(to) });
    });
    if (!pairs.length) {
      reply({ error: "nothing to save — every row is missing one side of the mapping" });
      return;
    }
    // Keep whatever the sheet was already called; a hand-typed table has no
    // filename of its own. The shipped default has never been "named" by
    // anyone, so an edit to it is called what it is rather than borrowing the
    // shipped file's name.
    const existing = cheatSheetFor();
    const name = existing && existing.name && !existing.shipped ? existing.name : "Edited by hand";
    reply({
      ...store.saveCheatSheet(CHEAT_SHEET_KEY, { name, pairs, problems }),
      problems,
    });
  } catch (err) {
    reply({ error: reconCore.tidyError(err.message) });
  }
}

/* The sheet RAA supplied, shipped with the app so a fresh install reconciles
   correctly before anybody has uploaded anything. An upload replaces it. */
let shippedSheet = null;
function shippedCheatSheet() {
  if (shippedSheet) return shippedSheet;
  try {
    const parsed = reconCore.parseCheatSheet(xlsxLite.readSheet(fs.readFileSync(SHIPPED_CHEAT_SHEET)));
    shippedSheet = {
      name: path.basename(SHIPPED_CHEAT_SHEET),
      pairs: parsed.pairs,
      problems: parsed.problems,
      shipped: true,
    };
  } catch { shippedSheet = { pairs: [], shipped: true }; }
  return shippedSheet;
}

/** Whatever is on file, or the sheet that shipped with the app. */
function cheatSheetFor() {
  try {
    const saved = store.getCheatSheet(CHEAT_SHEET_KEY);
    if (saved && saved.pairs && saved.pairs.length) return saved;
  } catch { /* fall through to the shipped one */ }
  return shippedCheatSheet();
}

// `:source` is ignored — there is one sheet. The parameter stays so an older
// page asking for /api/cheat-sheet/mint still gets the right answer.
app.get("/api/cheat-sheet/:source", (req, res) => {
  res.json({ source: CHEAT_SHEET_KEY, ...cheatSheetFor() });
});

/* The cheat sheet back out as a CSV, with whatever has been uploaded or
   hand-edited since — so a Finance person can take the updated names back
   into their own copy without retyping them. Headings match
   `CHEAT_SHEET_COLUMNS` so the file this hands back is also one this app can
   read back in, unchanged. */
app.get("/api/cheat-sheet/:source/export", (req, res) => {
  const sheet = cheatSheetFor();
  const grid = {
    headings: ["Spreadsheet Name", "Tramada Creditor"],
    rows: (sheet.pairs || []).map((p) => [p.from, p.to]),
  };
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="supplier-cheat-sheet.csv"');
  res.send("﻿" + reconCore.gridToCsv(grid));
});

const server = http.createServer(app);

/* `noServer` rather than handing the WebSocketServer the http server, because
   the upgrade has to be REFUSED before a socket exists. Gating the HTTP routes
   alone would have protected nothing that matters: `recon_run` arrives down
   this socket, and that is the frame that files real receipts. */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch { pathname = ""; }
  if (pathname !== "/ws") return socket.destroy();

  let user = null;
  // Never let a failure here fall through as "allowed". A session store that
  // throws is a reason to refuse the socket, not to open it to nobody.
  try { user = await azureAuth.userForUpgrade(req); } catch { user = null; }
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, user));
});

/* ── one session per open page ───────────────────────────────────────────── */

/* ── one run at a time, across the whole server ──────────────────────────── */

/* This used to be `session.reconRunning`, a flag on ONE open page — which meant
   it stopped a person double-clicking Run and nothing else. Two people were
   free to start two runs, and there is only ever one browser: `runTramadaReceipt`
   closes the shared CDP connection in its finally (recon-run.js §fileReceipts),
   so the second run would pull the page out from under the first with real
   receipts already filed. Per-user credentials make it worse still — the second
   run signs the shared browser in as somebody else mid-flight.
   So the lock belongs to the server, and it remembers WHO holds it, because
   "a run is already going" is a much better message with a name on it. */
const runLock = {
  _by: null,
  heldBy() { return this._by; },
  take(session) { this._by = (session.user && session.user.name) || "someone"; },
  release() { this._by = null; },
};

wss.on("connection", (ws, req, user) => {
  const session = { ws, active: true, user };
  console.log(`🔌 page connected${user && user.email ? ` — ${user.email}` : ""}`);

  /* What this deployment can do, told to the page rather than guessed at by it.
     Only the Docker image has a login screen; a local `npm start` has none, and
     a page that assumed one would frame a port with nothing behind it.
     `recon_` prefix because the page's socket handler drops every frame that
     does not start with one. */
  send(session, { type: "recon_hello", novncPort: NOVNC_PORT });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try {
      if (msg.type === "recon_parse") handleReconParse(session, msg);
      else if (msg.type === "recon_upload") handleReconUpload(session, msg);
      else if (msg.type === "recon_edit") handleReconEdit(session, msg);
      else if (msg.type === "cheat_sheet") handleCheatSheet(session, msg);
      else if (msg.type === "cheat_sheet_save") handleCheatSheetSave(session, msg);
      else if (msg.type === "recon_run") await handleReconRun(session, msg);
      else if (msg.type === "recon_login_test") await handleLoginTest(session);
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
  /* WHICH HALF OF A TWO-FILE REPORT THIS IS. DVC uploads the Westpac DVC report
     and Tramada's Agency CC Reimbursement export onto one card, and they have
     different columns entirely — reading one with the other's parser gives
     "the sheet has no column for: transaction amount (aud)" about a file that
     is perfectly well formed. The page says which slot it dropped the file in;
     nothing here guesses from the headings, because the two files are one
     revision away from sharing one. */
  const pairs = reconCore.REPORTS[source].pairs;
  const part = pairs && pairs[msg.part] ? msg.part : (pairs ? Object.keys(pairs)[0] : "");
  const reply = (extra) => send(session, { type: "recon_parsed", source, part, name, ...extra });

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
    /* Kept under the SLOT, not just the report. A DVC run has two files and the
       archive has to be able to say which of them was which weeks later — one
       key for both would have the Tramada export quietly overwrite the Westpac
       report on the run record (§6b: keep the bytes). */
    keep(session, part ? `${source}:${part}` : source, name, buf);
    // A zip starts "PK". That is the file's own container saying what it is —
    // not a guess from its name or its contents.
    const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
    const sheet = isZip ? xlsxLite.readSheet(buf) : reconCore.csvGrid(buf.toString("utf8"));
    const parse = {
      bpay: reconCore.parseReconRows,
      travelpay: reconCore.parseTravelPayRows,
      ipsi: reconCore.parseIpsiRows,
      "dvc:westpac": reconCore.parseDvcRows,
      "dvc:tramada": reconCore.parseTramadaCcRows,
    }[part ? `${source}:${part}` : source] || reconCore.parseMintRows;
    const { rows, problems, settlement, columns, missingColumns } = parse(sheet.headers, sheet.rows);

    /* `columns` is the file's own headings, in its own order. It goes back to
       the page so the inbox can show the spreadsheet as Finance wrote it, and
       so the export can hand back that same spreadsheet with the run's columns
       filled in rather than a new file of this code's own devising. */
    /* Consultant and Shop are left blank here, for both .xlsx and .csv BPay
       uploads alike — they are filled by the run itself, off the live receipt
       form probe, the same way a CSV upload has always worked. An eager lookup
       used to run right after upload for .xlsx only (querying Tramada a second
       time before Start run was even pressed), which made the two formats
       behave differently and made the reviewer wait on a spinner for no
       reason the run itself doesn't already handle. */
    reply({
      rows, problems, settlement, columns: columns || sheet.headers,
      /* BR01's roll call. Reported rather than enforced: a DVC report with no
         Segment Type column still reconciles on booking number and amount, it
         just runs without step 5's sense check — and the card has to be able to
         say so rather than the run quietly being less sure than it looks. */
      missingColumns: missingColumns || [],
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

/**
 * This person's Tramada credentials, out of the vault.
 *
 * THE EMAIL COMES FROM THE SESSION and from nowhere else — it was put there by
 * azure-auth.js out of an ID token Entra signed. Taking it from `msg` would let
 * anyone with the socket open name a colleague and be handed their password.
 *
 * null means "no vault configured", which is not a failure: the run then waits
 * for a human on the noVNC screen exactly as it did before any of this existed.
 * A vault that IS configured and cannot answer throws instead, because silently
 * falling back would hide a broken vault behind a login prompt for weeks.
 */
async function tramadaAuthFor(session) {
  if (!creds.configured()) return null;
  const email = session.user && session.user.email;
  if (!email) return null;
  return creds.credentialsFor(email);
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
  /* `reason` is "otp" when the app already filled the credentials from the
     vault and Tramada wanted something more, and "signin" when nobody had
     credentials stored and the whole login is the human's to do. The words
     matter: telling somebody to "sign into Tramada" when the form is already
     sitting on a verification-code prompt sends them looking for a password
     box that is not there.

     "otp" is deliberately NOT claimed to be a verification code — nobody has
     captured that screen, so it is equally an expired password or a locked
     account, and this says what is true for all three (CLAUDE.md §6). */
  onNeedLogin: (reason) => send(session, {
    type: "recon_login",
    /* Naming port 9222 inside the container sent people looking for a browser
       that was not on their machine: compose deliberately never publishes it,
       and the only Chrome is the one on the virtual screen. Say where the
       browser actually IS for this deployment. */
    message: reason === "otp"
      ? (NOVNC_PORT
        ? "Tramada wants more than a password — finish signing in on the screen below and I'll carry on."
        : `Tramada wants more than a password — finish signing in in the Chrome on port ${process.env.CDP_PORT || 9222}.`)
      : (NOVNC_PORT
        ? "Sign into Tramada on the login screen below — I'll wait."
        : `Sign into Tramada in the Chrome on port ${process.env.CDP_PORT || 9222} — I'll wait.`),
  }),
  // The other half. To the page so it can take the login screen down, and to
  // disk because "a human signed in at 09:14, mid-run" is exactly the kind of
  // thing that settles a question about a run weeks later (§6b).
  onLoginOk: () => {
    const message = "Signed into Tramada — carrying on.";
    send(session, { type: "recon_login_ok", message });
    if (run) { try { store.appendActivity(run.id, message, true); } catch { /* the run matters more */ } }
  },
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
  /* OFFLINE FIRST, and before the `!report.files` line below. DVC files nothing
     either, so it would otherwise fall into `handleMintRun` — which opens a
     browser, creates or finds a bank statement page and matches every row
     against it. A DVC card line can never be on that page: the money moved on a
     virtual card and the reconciliation is against Tramada's own export, not
     against a statement. It would have reported an entire correct file as
     unreconciled, having taken the browser for several minutes to do it. */
  if (report && report.offline) return handleDvcRun(session, msg);
  if (report && !report.files) return handleMintRun(session, msg);

  const { rows, problems } = reconCore.parseReconCsv(csvOf(msg.rows));

  for (const p of problems) {
    send(session, { type: "recon_progress", message: `Line ${p.line}: ${p.why}`, ok: false });
  }
  if (!rows.length) {
    send(session, { type: "recon_done", error: "nothing in that CSV could be run" });
    return;
  }
  if (runLock.heldBy()) {
    send(session, { type: "recon_progress", message: `${runLock.heldBy()} is running a reconciliation — waiting for it to finish.`, ok: false });
    return;
  }
  runLock.take(session);

  const run = openRun(session, "bpay", msg, rows);
  try {
    const out = await runReconciliation({
      auth: await tramadaAuthFor(session),
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
    /* THE TALLY, AND ONLY WHEN IT MEANS SOMETHING.
       On a day that was already done it would read "0 of 7 allocated, 0
       reconciled" — true, and indistinguishable from a broken run. The run
       itself has already said what happened, with the date, so this line is
       skipped rather than restated: three sentences arrived for one event and
       two of them were near-copies of the third. */
    /* NO "fully clean". POC feedback BPAY 05: "What does 'fully clean' means?
       Doesn't sound like a term RAA uses, can remove if not needed." It was
       a third count for rows that were both allocated AND reconciled — which
       the first two numbers already let you work out, under a name Finance
       does not use. `s.both` is still computed and still on the run record;
       it just no longer gets a made-up label in the sentence a person reads. */
    const headline = out.alreadyFiled
      ? `All ${s.total} BPay row${s.total === 1 ? "" : "s"} for ${msg.statementDate} were already filed by ` +
        `an earlier run — reconciliation page ${out.pageNumber} was not touched by this one.`
      : `${s.allocated} of ${s.total} BPay row${s.total === 1 ? "" : "s"} for ${msg.statementDate} allocated, ` +
        `${s.reconciled} reconciled` + (s.failed ? `, ${s.failed} failed` : "") + ".";
    if (!out.alreadyFiled) send(session, { type: "recon_progress", message: headline });

    const email = await sendReconEmail(msg, {
      source: "bpay", title: reconCore.REPORTS.bpay.title, headline, rows: out.results, run,
    });
    send(session, {
      type: "recon_progress",
      message: email.sent
        ? `Emailed the reconciliation to ${email.to.join(", ")}.`
        : `The reconciliation email was not sent — ${email.why}.`,
      ok: !!email.sent,
    });

    send(session, {
      type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id,
      // So the page knows not to add its own "page N created" — nothing was
      // created, and the run has already said so.
      alreadyFiled: !!out.alreadyFiled,
      email: { sent: !!email.sent, to: email.to || [], why: email.why || "" },
    });
  } catch (err) {
    // The receipts already filed are real. Say how far it got rather than
    // implying the whole run rolled back — nothing here rolls back.
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    runLock.release();
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
/**
 * The Browser nav's "Login into Tramada" — a sign-in and nothing else.
 *
 * It drives the SAME shared Chromium a run drives, and `ensureLoggedIn` will
 * sign that browser out if the session is not provably this person's. So it
 * takes the run lock: without it, pressing this mid-run tears down the session
 * a reconciliation is filing receipts through (CLAUDE.md §6, "two reports = one
 * run"). The same reason a run refuses while this is in flight.
 *
 * It reuses the run's own recon_login / recon_login_ok frames, so the page puts
 * the noVNC screen up for a verification code exactly as it does mid-run — the
 * point is to exercise that path, not a second one that resembles it.
 */
async function handleLoginTest(session) {
  if (runLock.heldBy()) {
    send(session, { type: "recon_login_test_done", error: `${runLock.heldBy()} is running a reconciliation — the browser is busy.` });
    return;
  }
  runLock.take(session);
  try {
    // Same source as a run's: the email off the verified Entra session, never
    // anything the page sent. See tramadaAuthFor.
    const auth = await tramadaAuthFor(session);
    // `run` is null — this files nothing, so there is no run record to write
    // activity against, and inventing one would put a reconciliation that never
    // happened on the overview screen (§6b).
    const out = await runTramadaLogin({ auth, callbacks: callbacks(session, null) });
    send(session, {
      type: "recon_login_test_done",
      signedInAs: out.signedInAs,
      title: out.title,
    });
  } catch (err) {
    send(session, { type: "recon_login_test_done", error: reconCore.tidyError(err.message) });
  } finally {
    runLock.release();
  }
}

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
  /* AN OFFLINE REPORT HAS NO PLACE IN A COMBINED RUN, and this is said before
     the run record is opened rather than after. `runCombinedReconciliation`
     refuses it too — before it files anything — but a run recorded, started and
     then abandoned reads on the overview as a reconciliation that failed, when
     nothing was ever attempted. DVC also needs its second file, which this
     frame has no room for. */
  const offline = Object.keys(byReport).filter((k) =>
    byReport[k].length && reconCore.REPORTS[k] && reconCore.REPORTS[k].offline);
  if (offline.length) {
    send(session, { type: "recon_done",
      error: `${offline.map((k) => reconCore.REPORTS[k].title).join(", ")} cannot run alongside ` +
        "another report — it reconciles two spreadsheets and has no statement page to share. Run it on its own." });
    return;
  }
  if (runLock.heldBy()) {
    send(session, { type: "recon_progress", message: `${runLock.heldBy()} is running a reconciliation — this one was not started.`, ok: false });
    return;
  }
  runLock.take(session);

  // One record, every report. Rows carry their own `src` so the overview can
  // still tell them apart on a screen whose stream cards are per report.
  const run = openRun(session, "both", msg,
    Object.keys(byReport).flatMap((k) => byReport[k].map((r) => ({ ...r, src: k }))));
  try {
    const out = await runCombinedReconciliation({
      auth: await tramadaAuthFor(session),
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
    const title = reconCore.RUN_ORDER
      .filter((k) => (byReport[k] || []).length)
      .map((k) => reconCore.REPORTS[k].title)
      .join(" + ");
    const headline = `${title}, ${msg.statementDate}: ${s.reconciled} of ${s.total} reconciled on page ` +
      `${out.pageNumber} (${s.perReport})` +
      (s.allocated ? `, ${s.allocated} allocated` : "") +
      (s.failed ? `, ${s.failed} failed` : "") + ".";
    send(session, { type: "recon_progress", message: headline });

    const email = await sendReconEmail(msg, { source: "combined", title, headline, rows: out.results, run });
    send(session, {
      type: "recon_progress",
      message: email.sent
        ? `Emailed the reconciliation to ${email.to.join(", ")}.`
        : `The reconciliation email was not sent — ${email.why}.`,
      ok: !!email.sent,
    });

    send(session, {
      type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id,
      email: { sent: !!email.sent, to: email.to || [], why: email.why || "" },
    });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    runLock.release();
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
  const uploaded = Array.isArray(msg.rows) ? msg.rows : [];
  if (!uploaded.length) {
    send(session, { type: "recon_done", error: "nothing in that IPSI file could be checked" });
    return;
  }
  if (runLock.heldBy()) {
    send(session, { type: "recon_progress", message: `${runLock.heldBy()} is running a reconciliation — this one was not started.`, ok: false });
    return;
  }
  runLock.take(session);

  /* Guide step 4 — kept to ONE settlement date only now that the human has
     typed it in. IPSI's own export pads a day either side of it, and every row
     that padding brought along is reported, never silently dropped. */
  const { rows, excluded } = reconCore.filterIpsiSettlementDate(uploaded, msg.statementDate);
  if (excluded.length) {
    console.log(`  IPSI: ${excluded.length} row(s) outside ${msg.statementDate} left out of this run.`);
  }
  if (!rows.length) {
    send(session, { type: "recon_done", error: `none of the uploaded rows are dated ${msg.statementDate}` });
    runLock.release();
    return;
  }

  /* Step 9 / BR01 — the dashboard disables Start on this same check, but that
     is JS in a page, not a gate. Checked again here, server-side, because this
     is the one place a run cannot be talked past it. */
  const fileTotal = reconCore.checkIpsiFileTotal(rows, msg.transactionTotal);
  if (fileTotal.checked && !fileTotal.ok) {
    send(session, { type: "recon_done", error: fileTotal.reason });
    runLock.release();
    return;
  }

  const run = openRun(session, "ipsi", msg, rows.map((r) => ({ ...r, src: "ipsi" })));
  try {
    const out = await runIpsiReconciliation({
      auth: await tramadaAuthFor(session),
      rows,
      payerName: msg.payerName || "IPSI",
      toDate: msg.statementDate,
      dateReceived: msg.statementDate,
      // BR08's gate — the NUVEI figure a human typed for this settlement.
      transactionTotal: msg.transactionTotal,
      // Checks only: the run does everything except press Issue and Done.
      // BR04/BR09 can force the same outcome even when this is false — see
      // `runIpsiReconciliation`'s all-or-nothing gate.
      dryRun: !!msg.dryRun,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    // "0 of 4 matched and ticked, nothing issued" is a true and terrible way
    // to describe a settlement that was already fully reconciled, so that
    // case gets its own sentence rather than the tally.
    const headline = out.alreadyReconciled
      ? `All ${s.total} IPSI rows for ${msg.statementDate} were already reconciled — nothing left to tick or issue.`
      : `IPSI ${msg.statementDate}: ${s.ticked} of ${s.total} matched and ticked` +
        (s.alreadyReconciled ? `, ${s.alreadyReconciled} already reconciled earlier` : "") +
        (s.onBooking ? ` (${s.onReference} on reference, ${s.onBooking} on booking)` : "") +
        (out.issued && out.issued.issued ? `, receipt issued for $${out.issued.amount}` : ", nothing issued") + ".";
    send(session, { type: "recon_progress", message: headline });

    const email = await sendReconEmail(msg, {
      source: "ipsi", title: reconCore.REPORTS.ipsi.title, headline, rows: out.results, run,
    });
    send(session, {
      type: "recon_progress",
      message: email.sent
        ? `Emailed the reconciliation to ${email.to.join(", ")}.`
        : `The reconciliation email was not sent — ${email.why}.`,
      ok: !!email.sent,
    });

    send(session, {
      type: "recon_done", summary: s, runId: run && run.id,
      email: { sent: !!email.sent, to: email.to || [], why: email.why || "" },
    });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    runLock.release();
  }
}

/**
 * DVC: two spreadsheets against each other, then the Payment Session.
 *
 * The Westpac DVC report and Tramada's own Agency CC Reimbursement export are
 * both uploaded, `reconcileDvc` matches them, and the answer is arithmetic. So:
 *
 *   - THE MATCHING TAKES NO RUN LOCK. The lock exists because there is one
 *     shared Chrome and a second flow closes the first one's page mid-run with
 *     real receipts already filed (CLAUDE.md §6). Matching two spreadsheets
 *     touches no browser; only the Tramada half after it takes the lock
 *     (`dvcPaymentPhase`).
 *   - WHEN THE SPREADSHEETS RECONCILE WITH NO ERRORS it goes straight on to
 *     steps 12-16 and saves the session; otherwise it only emails the errors.
 *     Either way it emails (step 18). It never presses Issue.
 *
 * What it does do is record the run like every other one (§6b) — the verdicts
 * are what Travel Accounts works from, and "what the agent decided on the 4th"
 * is exactly the thing somebody asks about three weeks later.
 */
async function handleDvcRun(session, msg) {
  const uploaded = Array.isArray(msg.rows) ? msg.rows : [];
  const costings = Array.isArray(msg.tramadaRows) ? msg.tramadaRows : [];
  const say = (message, ok) => send(session, { type: "recon_progress", message, ok });

  if (!uploaded.length) {
    send(session, { type: "recon_done", error: "nothing in that Westpac DVC report could be checked" });
    return;
  }
  /* BOTH FILES, OR NOTHING. With only the Westpac side every line comes back
     "Booking number not found" — a full screen of red about a report that is
     perfectly correct, describing a file nobody uploaded. The card refuses
     first; this is the gate a run cannot be talked past. */
  if (!costings.length) {
    send(session, { type: "recon_done",
      error: "the Tramada Agency CC Reimbursement export is missing — a DVC run needs both files, " +
        "or every line reads as a booking that is not in Tramada" });
    return;
  }

  /* Step 1 / BR02 — one business day. The client's own spreadsheet stacks a
     month of daily reports in one tab, because that is what dropping each day's
     CSV into it produces; reconciling all of it would match August's cards
     against a Tramada export pulled for one day. Excluded rows are named, never
     silently dropped. */
  const { rows, excluded } = reconCore.filterDvcSettlementDate(uploaded, msg.statementDate);
  if (excluded.length) {
    say(`${excluded.length} line${excluded.length === 1 ? "" : "s"} in the report settled on another ` +
      `day and ${excluded.length === 1 ? "was" : "were"} left out of this run.`, true);
  }
  if (!rows.length) {
    send(session, { type: "recon_done", error: `none of the report's lines settled on ${msg.statementDate}` });
    return;
  }

  const run = openRun(session, "dvc", msg, rows.map((r) => ({ ...r, src: "dvc" })));
  const cb = callbacks(session, run);
  /* WHAT CHANGED SINCE LAST TIME. The same settlement date arrives more than
     once by design — reconcile, flag, somebody fixes something, re-upload — and
     until now nothing said what was different. Said first, before the verdicts,
     because it is the context everything below it should be read in. */
  const diff = dvcUploadDiff(msg.statementDate, rows, run && run.id);
  if (diff) {
    cb.onProgress(diff.same
      ? `This file is identical to ${diff.label}.`
      : `${diff.summary} compared with ${diff.label}` +
        (diff.changed.length
          ? `: ${diff.changed.slice(0, 5).map((c) => `${c.what} (${c.fields.map((f) => f.label).join(", ")})`).join("; ")}` +
            (diff.changed.length > 5 ? `, and ${diff.changed.length - 5} more` : "")
          : "") + ".",
      diff.same);
  }
  try {
    cb.onProgress(`${rows.length} DVC line${rows.length === 1 ? "" : "s"} against ` +
      `${costings.length} Tramada costing${costings.length === 1 ? "" : "s"}, matched on booking number ` +
      `and amount within ${reconCore.DVC_TOLERANCE_CENTS} cents (BR03, BR04).`);

    const out = reconCore.reconcileDvc(rows, costings);

    /* Each verdict to the page AND to disk as it is known, not in one lump at
       the end (§6b). It is fast enough here that the distinction looks academic
       — but the store write is the thing Travel Accounts reads tomorrow, and a
       process that dies between the match and the save should still leave
       behind what it had decided. */
    for (const row of out.rows) {
      cb.onRow(row.n, {
        matched: row.matched,
        matchedOn: row.matchedOn,
        // The column Finance reads: the vocabulary term, then BR05's breakdown.
        remark: reconCore.dvcRemarksCell(row),
        why: row.why,
        tramadaLines: row.tramadaLines,
        tramadaAmounts: row.tramadaAmounts,
        /* "Reconciled" is the DOCUMENT'S OWN WORD for this, and it is the right
           one: step 18 asks the report to "distinguish reconciled lines from
           lines requiring verification", and steps 4-11 are the reconciliation.
           The Tramada half (steps 12-16) is a separate thing and is reported
           on its own line, and the card's finished message says "matched"
           rather than "reconciled in Tramada".

           A matched line carrying a remark is still Reconciled here: what puts
           it in front of a person is the remark itself (`NEEDS_ACTION`), not a
           third verdict that every chip and filter on the screen would then
           have to learn. There is no Allocation — this run allocates nothing,
           and "Pending" forever is a promise nothing is coming good on. */
        reconciliation: row.matched ? "Reconciled" : "Not reconciled",
      });
    }

    // Step 15 / BR04 — what the report adds up to against what a person read
    // off it. Checked and reported; it does not stop the session (step 16 saves
    // it with errors), and the email names it.
    const total = reconCore.checkDvcTotal(rows, msg.transactionTotal);
    if (total.checked) cb.onProgress(`BR04: ${total.reason}`, total.ok);

    const s = out.summary;
    /* THE COSTINGS NOTHING PAID, BY BOOKING. Not an error on its own — the
       Tramada range is two days wider than the report (BR13) — but step 19
       sends a person looking for exactly these, and a bare count sends them
       back to the spreadsheet to work out which. Named while the list is short
       enough to read; past that the count is the honest summary. */
    /* NOT THE COSTINGS A FLAGGED LINE WAS CHECKED AGAINST. A hotel charged
       $150.00 against its $420.00 costing leaves that costing unclaimed too,
       and naming it here as a harmless leftover read as "nothing to see" about
       the one costing a person has to look at (screenshot, 23-09-2026). */
    const flagged = new Set(out.rows.filter((r) => !r.matched || r.remark)
      .map((r) => r.bookingKey || r.bookingNo).filter(Boolean));
    const left = out.unmatchedTramada.filter((t) => !flagged.has(t.bookingKey || t.bookingNo));
    const bookings = [...new Set(left.map((t) => t.bookingNo).filter(Boolean))];
    cb.onProgress(
      `${s.matched} of ${s.total} matched cleanly` +
      (s.matchedForReview ? `, ${s.matchedForReview} matched but flagged for a person` : "") +
      (s.unmatched ? `, ${s.unmatched} not matched` : "") +
      (left.length
        ? `. ${left.length} Tramada costing${left.length === 1 ? "" : "s"} nothing on the report paid` +
          (bookings.length && bookings.length <= 8 ? ` (booking${bookings.length === 1 ? "" : "s"} ${bookings.join(", ")}).` : ".")
        : "."),
      s.unmatched === 0);
    /* RAA's DRAWING (23-09-2026). Spreadsheet errors → email, nothing in
       Tramada; the person fixes the Westpac report and re-uploads. No errors →
       straight on into Tramada with no click in between: tick, save the
       session even if Tramada raises something, and email the accounts team
       the state of the session. The agent never presses Issue.

       The verdicts above are already on the page and in the store, so nothing
       that happens in the browser can take the reconciliation away. */
    const payment = await dvcPaymentPhase(session, run, msg, { out, total, cb });

    // Step 18 — whatever happened in Tramada, Travel Accounts hears about it.
    const email = await dvcSendEmail(msg, { out, total, payment, run });
    cb.onProgress(email.sent
      ? `Emailed the reconciliation to ${email.to.join(", ")} (step 18).`
      : `The reconciliation email was not sent — ${email.why}.`,
      !!email.sent);

    closeRun(run, { summary: s, committed: sessionCommitted(payment, msg) });
    send(session, {
      type: "recon_done",
      summary: s,
      runId: run && run.id,
      unmatchedTramada: out.unmatchedTramada,
      total,
      sessionLabel: reconCore.dvcSessionLabel(msg.statementDate),
      payment: paymentForPage(payment, msg),
      email: { sent: !!email.sent, to: email.to || [], why: email.why || "" },
      uploadDiff: diff,
    });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  }
}

/**
 * docs/dvc.md steps 12 to 16 — the Tramada half, straight after the matching.
 *
 * SEPARATE FROM THE RECONCILIATION ABOVE IT, AND DELIBERATELY SO.
 *
 *   - IT TAKES THE RUN LOCK; the reconciliation does not. `runDvcPayment`
 *     closes the shared CDP browser in its `finally`, and a second flow running
 *     alongside would close the first one's page mid-run (§6).
 *   - IT NEVER SINKS THE RUN. The reconciliation's verdicts are already on the
 *     page and already in the store, written as each was known (§6b). A
 *     Tramada screen that has changed shape is a reason to lose the session,
 *     not a reason to throw away a correct reconciliation of sixty lines.
 *   - IT REPORTS WHAT IT DID, NOT WHAT IT MEANT TO. Whatever comes back says
 *     whether the session was saved, and a failure says how far it got — the
 *     page is left open on purpose so it can be looked at.
 */
async function dvcPaymentPhase(session, run, msg, { out, total, cb }) {
  /* SPREADSHEETS FIRST (RAA's drawing, 23-09-2026). Errors between the two
     files go to a person by email, and the Tramada reimbursement starts on the
     run that comes back clean — so a day with errors never opens a browser. */
  const gate = reconCore.dvcTramadaGate(out.summary, total);
  if (!gate.open) {
    cb.onProgress(`Steps 12-16 were not run: ${gate.why}. Nothing has been entered into Tramada.`, false);
    return { skipped: true, why: gate.why, blockers: gate.blockers || [] };
  }
  /* A DAY THAT ALREADY HAS A SESSION IS NOT REFUSED HERE ANY MORE (RAA,
     23-09-2026). `runDvcPayment` finds it on Tramada's own Payment Sessions
     list, reopens it, re-checks it and saves it again. This used to ask the
     run store instead, which said "DVC 24/09/2026" was saved after it had been
     cancelled in Tramada — and refused a re-run that had real work to do. */
  /* BR12's card, as the label Tramada shows in its own dropdown. SERVER
     CONFIGURATION, not a dashboard field (RAA, 23-09-2026): it is the same card
     every day and nobody at the screen should have to see or type it. Never a
     card number — `core.assertCardLabel` refuses one before the browser opens,
     because this server's socket has no redaction on it (§4). The fallback is
     the label measured live on raatravelsandbox 22-09-2026. */
  const creditCard = String(process.env.DVC_CARD || DVC_CARD_DEFAULT).trim();
  if (runLock.heldBy()) {
    const why = `${runLock.heldBy()} is running a reconciliation, so the browser is busy`;
    cb.onProgress(`The Issue Payment steps were skipped — ${why}. The matching above is finished and ` +
      "saved; upload the same two files again when it is free.", false);
    return { skipped: true, why };
  }
  runLock.take(session);
  try {
    cb.onProgress(`Entering the Agency CC Reimbursement for ${msg.statementDate}: ${gate.why}` +
      (msg.dryRun ? " (dry run — the session will not be saved)." : "."), true);
    return await runDvcPayment({
      auth: await tramadaAuthFor(session),
      statementDate: msg.statementDate,
      creditCard,
      dvcRows: out.rows,
      dvcSummary: out.summary,
      unmatchedTramada: out.unmatchedTramada,
      totalCheck: total,
      /* DRY RUN MEANS HERE WHAT IT MEANS EVERYWHERE ELSE: everything happens
         except the click that makes it permanent — here, Session. It is the
         toolbar's own dry run, read when Start was pressed. */
      dryRun: !!msg.dryRun,
      callbacks: cb,
    });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    cb.onProgress(`The Issue Payment step stopped: ${why} The reconciliation above is finished and ` +
      "saved, and the Tramada page has been left open so it can be looked at.", false);
    return { error: why };
  } finally {
    runLock.release();
  }
}

/**
 * What the page is told about the Tramada half — small, and nothing the page
 * has to work out for itself. The grid and plan stay on the server; the card
 * only needs to say whether the session is saved, what is in it, and what is
 * still for a person.
 */
function paymentForPage(payment, msg) {
  const p = payment || {};
  const c = p.commit || null;
  return {
    statementDate: msg.statementDate,
    sessionLabel: reconCore.dvcSessionLabel(msg.statementDate),
    saved: !!p.saved,
    confirmed: !!(p.session && p.session.confirmed),
    skipped: !!p.skipped,
    reopened: !!p.reopened,
    error: p.error || "",
    why: p.why || (c && c.why) || "",
    held: (c && c.held) || "",
    complete: !!(c && c.complete),
    ticked: (c && c.ticked) || 0,
    amount: c ? reconCore.money(c.paidCents || 0) : "",
    errors: (c && c.errors) || [],
    blockers: p.blockers || [],
    roundRemaining: !!(c && c.roundRemaining),
  };
}

/**
 * Step 18. Built by `reconCore.dvcEmail` (tested offline), delivered by
 * mailer.js, and it never throws — a mail server that is down is a reason to
 * lose the email, not a reason to fail a run that may have saved a session.
 */
async function dvcSendEmail(msg, { out, total, payment, run }) {
  try {
    const message = reconCore.dvcEmail({
      statementDate: msg.statementDate,
      summary: out.summary,
      rows: out.rows,
      unmatchedTramada: out.unmatchedTramada,
      totalCheck: total,
      payment,
      columns: Array.isArray(msg.columns) ? msg.columns : [],
      runId: run && run.id,
      dryRun: !!msg.dryRun,
    });
    return await mailer.send(message);
  } catch (err) {
    return { sent: false, why: reconCore.tidyError(err.message) };
  }
}

/**
 * The same step for BPay, Mint, TravelPay and IPSI — built by
 * `reconCore.reconEmail` (tested offline), delivered by mailer.js, never
 * throws. `headline` is the one sentence each handler already worked out for
 * its own `recon_progress` line — passed in rather than recomputed, so the
 * email and the screen never disagree about what happened.
 */
async function sendReconEmail(msg, { source, title, headline, rows, run }) {
  try {
    const message = reconCore.reconEmail({
      source, title,
      statementDate: msg.statementDate,
      headline,
      rows: rows || [],
      columns: Array.isArray(msg.columns) ? msg.columns.filter(Boolean) : [],
      runId: run && run.id,
      dryRun: !!msg.dryRun,
    });
    return await mailer.send(message);
  } catch (err) {
    return { sent: false, why: reconCore.tidyError(err.message) };
  }
}

/**
 * What the store keeps about a saved session — the record of what each run
 * did. It no longer decides anything: whether a session exists is read off
 * Tramada (see `tramada-dvc.findSavedSessions`).
 *
 * NOT UNDER `ticked`. The overview's "transactions committed" adds up
 * `committed.ticked` across runs, and it means ticks on a COMMITTED bank
 * statement page — a session nobody has Issued yet is not that, and counting it
 * would put a figure on the dashboard saying something that did not happen.
 */
function sessionCommitted(payment, msg) {
  if (!payment || !payment.saved || !payment.commit) return null;
  const c = payment.commit;
  return {
    session: true,
    label: c.sessionLabel || reconCore.dvcSessionLabel(msg.statementDate),
    sessionTicked: c.ticked || 0,
    paidCents: c.paidCents || 0,
    complete: !!c.complete,
    confirmed: !!(payment.session && payment.session.confirmed),
    reopened: !!payment.reopened,
  };
}

/**
 * What changed since the last upload of this same day.
 *
 * The DVC process is reconcile, flag, a person fixes something, re-upload,
 * re-run — so the same settlement date arrives more than once by design, and
 * until now nothing said what was DIFFERENT the second time. An edit to the
 * bank's own report was invisible.
 *
 * Reported, never enforced. A changed line is not wrong: it is usually exactly
 * the fix somebody was asked to make. What matters is that it is on the record
 * and on the screen rather than only in somebody's memory of what they typed.
 */
function dvcUploadDiff(statementDate, rows, exceptRunId) {
  if (!statementDate || !rows || !rows.length) return null;
  try {
    const earlier = store.listRuns()
      .filter((r) => r.source === "dvc" && r.statementDate === statementDate && r.id !== exceptRunId)
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0];
    if (!earlier) return null;
    const full = store.getRun(earlier.id);
    const before = (full && full.rows) || [];
    if (!before.length) return null;
    const diff = reconCore.diffDvcUploads(before, rows);
    /* The time, as a person reading it would say it — "the 09:14 upload". The
       date only when it was not today, because "3 lines differ from the 09:14
       upload" is the sentence RAA asked for and a date in the middle of it is
       noise on the day that matters most. */
    const when = new Date(earlier.startedAt || Date.now());
    const sameDay = when.toDateString() === new Date().toDateString();
    const label = Number.isNaN(when.getTime())
      ? "the earlier upload"
      : `the ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")} ` +
        (sameDay ? "upload" : `upload on ${when.toISOString().slice(0, 10)}`);
    return { ...diff, against: earlier.id, label };
  } catch (err) {
    console.error(`  ⚠ could not compare this upload with an earlier one: ${err.message}`);
    return null;
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
/**
 * The uploaded file this run is ABOUT, and — for a two-file report — the other
 * one hanging off it.
 *
 * A DVC run keeps its two files under `dvc:westpac` and `dvc:tramada`, because
 * one key for both would have the Tramada export overwrite the Westpac report
 * in `session.files`. The run record still names ONE file, the report the run is
 * about, and carries the other as `pair` — `file` is a JSONB column, so this
 * costs no schema and every reader that wants `.name` still gets it.
 *
 * Both sets of bytes are already on the `RECON_STORE_DIR` volume either way:
 * `keep()` stored them as they arrived, which is the thing that settles a
 * disputed figure weeks later (§6b). This is only about what the run POINTS at.
 */
function fileFor(session, source) {
  const files = session.files || {};
  const pairs = (reconCore.REPORTS[source] || {}).pairs;
  if (!pairs) return files[source] || null;
  const keys = Object.keys(pairs);
  const main = files[`${source}:${keys[0]}`] || null;
  const rest = keys.slice(1)
    .map((k) => (files[`${source}:${k}`] ? { part: k, label: pairs[k], ...files[`${source}:${k}`] } : null))
    .filter(Boolean);
  if (!main) return rest[0] || null;
  return rest.length ? { ...main, part: keys[0], label: pairs[keys[0]], pair: rest } : main;
}

function openRun(session, source, msg, rows) {
  try {
    const run = store.startRun({
      source,
      file: fileFor(session, source),
      statementDate: msg.statementDate,
      openingBalance: msg.openingBalance,
      closingBalance: msg.closingBalance,
      // BR01/step 3 — the NUVEI figure a human read off the bank statement.
      // Kept with the run so IPSI's pending-settlements list can show it and
      // a reloaded attempt can offer it back, rather than making a person
      // remember or re-derive it on every retry.
      transactionTotal: msg.transactionTotal,
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

/**
 * A settlement that is finished — say so without being asked.
 *
 * `markResolved` was built for a person to press, because an IPSI settlement
 * can take days and several attempts to fix and only the accounts team knows
 * when it is really done. That is still true of a settlement that STOPPED.
 * It is not true of one that got all the way through, and there are two ways
 * to be all the way through:
 *
 *   ISSUED   every row reconciled, the total agreed, Issue pressed, and the
 *            receipts confirmed off Receipts To Reconcile.
 *   ALREADY  every row was reconciled by an EARLIER run, so this one had
 *            nothing to tick and nothing to issue. A rerun of finished work
 *            is finished work; it used to report four "not found" errors and
 *            sit on the pending list forever.
 *
 * Deliberately narrow either way. A preview never qualifies — the dry-run
 * branch returns `issued: false` and only a confirmed live issue sets `true`.
 * A run that stopped at the gate never reaches Issue. And `allClean` is
 * required alongside, so a settlement that somehow issued while a row was
 * still flagged stays on the list for a human.
 */
function settlementComplete(run, out) {
  if (!run || run.source !== "ipsi" || !out) return false;
  /* TWO SHAPES, because there are two ways in. A combined upload runs IPSI
     alongside the statement-page reports and collects its result under
     `out.ipsi`; an IPSI-only upload has its own handler and hands back what
     `runIpsiReconciliation` returned, directly. This only understood the
     combined shape at first, so the path RAA actually uses — an IPSI file on
     its own — never resolved anything. */
  const runs = Array.isArray(out.ipsi) ? out.ipsi : [out];
  if (!runs.length) return false;
  return runs.every((r) =>
    r && r.allClean && ((r.issued && r.issued.issued === true) || r.alreadyReconciled === true));
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
      // A DVC run saves a Payment Session, not a statement page, so it hands in
      // its own record rather than being read off `finished`.
      committed: out && out.committed,
      error: error || null,
    });
    if (!error && settlementComplete(run, out)) {
      /* The whole settlement, not just this attempt. Twenty-two runs against
         2026-09-02 were sitting unresolved when this was written; clearing
         only the one that finally worked would have left twenty-one behind
         and the list would never empty. */
      const cleared = run.statementDate
        ? store.markSettlementResolved(run.source, run.statementDate)
        : (store.markResolved(run.id) ? [run.id] : []);
      console.log(
        `  ✓ settlement complete — cleared ${cleared.length} unresolved ` +
        `${cleared.length === 1 ? "entry" : "entries"} for ${run.statementDate || run.id}`
      );
    }
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
  if (runLock.heldBy()) {
    send(session, { type: "recon_progress", message: `${runLock.heldBy()} is running a reconciliation — waiting for it to finish.`, ok: false });
    return;
  }
  runLock.take(session);

  const run = openRun(session, source, msg, rows.map((r) => ({ ...r, src: source })));

  /* SAY WHICH SHEET, AND WHERE IT CAME FROM.
     `cheatSheetFor()` prefers a sheet somebody uploaded through the page over
     the one shipped in cheat-sheets/, and the two can disagree with nothing on
     screen saying so: a row's remark quotes the candidates it tried but never
     names their source. Editing the shipped file, re-running, and reading the
     same "cheat sheet disagrees" is then indistinguishable from the edit not
     having worked.

     Measured 25-08-2026. A sheet uploaded at 12:17 was the one in use; the file
     on disk had been corrected at 12:12 and was never consulted, and the run at
     12:19 reported the old candidates — correctly, about a sheet nobody
     realised was in play. One line naming it is the whole fix. */
  const sheet = cheatSheetFor();
  const sheetCount = (sheet.pairs || []).length;
  const sheetFrom = sheet.shipped
    ? "shipped with the app"
    : `uploaded ${(sheet.uploadedAt || "").slice(0, 10) || "earlier"} — upload again to change it`;
  send(session, {
    type: "recon_progress",
    ok: sheetCount > 0,
    message: sheetCount
      ? `Supplier cheat sheet: ${sheet.name || "(unnamed)"} — ${sheetCount} supplier${sheetCount === 1 ? "" : "s"}, ${sheetFrom}.`
      : "No supplier cheat sheet — every row will be matched on the supplier name exactly as the file spells it.",
  });

  try {
    const out = await runMintReconciliation({
      auth: await tramadaAuthFor(session),
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
         reads "Supplier does not match". ONE sheet for both reports — RAA's is
         headed "SUPPLIER NAME IN MINT / TRAVELPAY". */
      cheatSheet: sheet,
      // Checks only: the run does everything except press Issue and Done.
      dryRun: !!msg.dryRun,
      callbacks: callbacks(session, run),
    });
    const s = out.summary;
    closeRun(run, out);
    const headline = `${report.title}, ${msg.statementDate}: ${s.reconciled} of ${s.total} found on page ` +
      `${out.pageNumber}` + (s.mismatched ? `, ${s.mismatched} with a difference to check` : "") +
      (s.notReconciled ? `, ${s.notReconciled} missing` : "") + ".";
    send(session, { type: "recon_progress", message: headline });

    const email = await sendReconEmail(msg, { source, title: report.title, headline, rows: out.results, run });
    send(session, {
      type: "recon_progress",
      message: email.sent
        ? `Emailed the reconciliation to ${email.to.join(", ")}.`
        : `The reconciliation email was not sent — ${email.why}.`,
      ok: !!email.sent,
    });

    send(session, {
      type: "recon_done", pageNumber: out.pageNumber, summary: s, runId: run && run.id,
      email: { sent: !!email.sent, to: email.to || [], why: email.why || "" },
    });
  } catch (err) {
    const why = reconCore.tidyError(err.message);
    closeRun(run, null, why);
    send(session, { type: "recon_done", error: why, runId: run && run.id });
  } finally {
    runLock.release();
  }
}

/* ── up ──────────────────────────────────────────────────────────────────── */

// The overview and every write go through an in-memory cache that `init()` fills
// from Postgres, so it has to be loaded BEFORE the first request is answered and
// before orphans are swept — otherwise a fresh process would report an empty
// dashboard and re-open no crashed runs. A connection that will not come up is
// fatal here, on purpose: the run history is where receipts are recorded, and a
// server that cannot reach it should say so at boot, not silently keep runs in a
// cache that vanishes on restart.
(async () => {
  try {
    await store.init();
  } catch (err) {
    console.error(`  ✗ could not open the run store: ${err.message}`);
    process.exit(1);
  }

  // A run still marked "running" is one the last process died holding. Said out
  // loud, because "1 running" on the dashboard is a figure people wait on.
  const orphans = store.reconcileOrphans();
  if (orphans) console.log(`  ⚠ ${orphans} run(s) were still open from a previous server — marked failed.`);

  /* Said out loud on every boot, because BOTH of these are silent otherwise and
     both look identical from the outside — an app that opens straight onto the
     reconciliation screen. One of them is a deliberate local run; the other is a
     shared server whose front door never got installed. */
  const authProblem = azureAuth.configProblem();
  if (authProblem) console.log(`  ⚠ ${authProblem}`);
  else if (!azureAuth.enabled()) console.log("  ⚠ No Entra sign-in configured — anyone who can reach this port can use the app.");
  if (azureAuth.enabled() && !creds.configured()) {
    console.log("  ⚠ Signed-in users have no Tramada credentials in a vault — each run still waits for a human to sign into Tramada.");
  }

  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║   🏦  Bank reconciliation agent                ║
║   🌐  http://localhost:${String(PORT).padEnd(24)}║
╚════════════════════════════════════════════════╝

${NOVNC_PORT ? `  Sign into Tramada on the login screen:
  http://localhost:${NOVNC_PORT}/vnc.html
  The app opens it for you when a run needs it — credentials are never typed here.` : `  A run drives Chrome over CDP on port ${process.env.CDP_PORT || 9222}.
  Start it with "npm run start:chrome" and sign into Tramada in that window —
  credentials are never typed here.`}
`);
  });
})();

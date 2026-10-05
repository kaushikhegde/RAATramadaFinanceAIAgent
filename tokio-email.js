"use strict";

/**
 * Step 15 / BR17 — the consolidated sheet goes to RAA Travel Accounts.
 *
 * The guide: "AI Agent emails the consolidated spreadsheet to Travel Accounts,
 * advising that the Tokio Marine session is saved and ready for review."
 *
 * WHY A DRAFT IS THE DEFAULT AND NOT A SEND
 *
 * docs/bpay-guide-conformance.md has said all along why nothing here sends
 * mail: putting SMTP credentials into a service with no redaction on its
 * socket is worth doing deliberately. That has not changed. What HAS changed
 * is that step 15 is now wanted, so this module does the whole job up to the
 * last inch: it builds a real RFC-5322 message with the workbook attached and
 * writes it as a .eml. Opening that file puts the addressed, subject-lined,
 * attachment-bearing mail in front of a person in their own mail client, and
 * they press Send.
 *
 * That is not a workaround. The mail asserts "session saved, ready for
 * review" — a claim about work a human is about to be asked to check — and
 * BR16/BR18 already say a human, not this run, resolves what is left. A
 * person pressing Send is the same person who owns that claim.
 *
 * Transmitting over SMTP is possible (`transport: "smtp"`), requires the
 * exact confirmation literal, and requires credentials in the environment
 * that are never read into a log line.
 */

const fs = require("fs");
const path = require("path");

/** Nothing is sent without this, letter for letter. */
const SEND_LITERAL = "SEND EMAIL";

/** BR17 names the mailbox. Kept here so it is greppable and testable. */
const TRAVEL_ACCOUNTS = "TAccounts@raa.com.au";

/**
 * The subject the guide dictates, verbatim, including the hyphen.
 *
 * Measured from "Reconciliation Guide - Tokio Marine (2).docx":
 *   AI Agent Tokio Marine reconciliation - Session saved, ready for review
 *
 * It is a constant rather than a template because the guide gives no slot in
 * it — no month, no session label. Callers that need a different subject pass
 * one and take responsibility for it.
 */
const SUBJECT = "AI Agent Tokio Marine reconciliation - Session saved, ready for review";

/**
 * Step 1 removes the two passenger-name columns before the file leaves
 * Finance. This is the moment it leaves — so it is the moment to check.
 *
 * A reconciliation that quietly mails 1900 travellers' names to a mailbox is
 * a different kind of mistake from a wrong total, and it is not one the
 * recipient can undo.
 */
const PASSENGER_NAME_COLUMNS = Object.freeze(["xCustomer", "xInsuredName"]);

/** Quoted-printable is overkill; the guide's text is ASCII. Fold long lines. */
function foldHeader(name, value) {
  const line = `${name}: ${String(value).replace(/[\r\n]+/g, " ").trim()}`;
  if (line.length <= 78) return line;
  // RFC 5322 folding: continuation lines begin with whitespace.
  const out = [];
  let rest = line;
  while (rest.length > 78) {
    let cut = rest.lastIndexOf(" ", 78);
    if (cut <= name.length + 1) cut = 78;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut + 1);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** An RFC 2047 encoded-word, only when the subject is not plain ASCII. */
function encodeSubject(subject) {
  const s = String(subject);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function base64Lines(buf) {
  const b64 = Buffer.from(buf).toString("base64");
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join("\r\n");
}

const CONTENT_TYPES = Object.freeze({
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
});
const contentTypeFor = (name) =>
  CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || "application/octet-stream";

/**
 * The body. Deliberately short, and deliberately says what was NOT done.
 *
 * Travel Accounts read this to decide whether to open Tramada, so it has to
 * carry the three numbers that decide that and the one sentence that stops
 * anyone assuming the payment went out.
 */
function composeBody({ label, month, ticked, mismatched, exceptions, retail, reference }) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const lines = [
    "Hello Travel Accounts,",
    "",
    `The Tokio Marine reconciliation for ${month} has run and the payment session is saved in Tramada as ${label}.`,
    "",
    "It is ready for your review. Issue has NOT been clicked — nothing has been paid.",
    "",
    "What the run did:",
    `  • ${n(ticked)} segment(s) matched on reference and amount, and ticked`,
    `  • ${n(mismatched)} line(s) not ticked — listed in the attached sheet, with a reason in Remarks`,
    `  • ${n(exceptions)} exception(s) flagged for a person to resolve`,
    `  • ${n(retail)} Retail line(s) excluded, having been receipted through Retail`,
    "",
    "What still needs a person:",
    "  • resolve the exceptions and any unticked lines",
    "  • apply rounding across the reconciliation",
    "  • enter the transaction total, and click Issue",
    "",
    `Payment reference: ${reference}`,
    "",
    "The consolidated spreadsheet is attached.",
    "",
    "— RAA Travel AI Agent",
  ];
  return lines.join("\r\n");
}

/**
 * Compose the step-15 message. Pure: no disk, no network, no clock beyond the
 * Date header, which is injectable so a test can pin it.
 *
 * Throws rather than sending something untrue. Each guard below exists
 * because the message ASSERTS something:
 *   - "session saved"     → savedSession must actually be true
 *   - "spreadsheet attached" → there must actually be an attachment
 *   - the sheet left Finance → its passenger-name columns must be gone
 */
function composeReconciliationEmail({
  to = TRAVEL_ACCOUNTS,
  from,
  subject = SUBJECT,
  label,
  month,
  reference,
  savedSession,
  counts = {},
  attachments = [],
  date = new Date(),
  messageId,
} = {}) {
  if (savedSession !== true) {
    throw new Error(
      `Refusing to send: the subject says "Session saved, ready for review" and no session was saved. ` +
        "Step 15 follows step 14 — save the session first, or the mail tells Travel Accounts something untrue."
    );
  }
  if (!label) throw new Error("Refusing to send: no session label, so the mail cannot say which session to review.");
  if (!Array.isArray(attachments) || !attachments.length) {
    throw new Error(
      "Refusing to send: BR17 is the consolidated spreadsheet reaching Travel Accounts. " +
        "A mail with no attachment is not step 15."
    );
  }
  for (const a of attachments) {
    if (!a || !a.filename) throw new Error("Every attachment needs a filename.");
    if (a.content == null || !Buffer.byteLength(a.content)) {
      throw new Error(`Attachment ${a.filename} is empty — nothing to review.`);
    }
    // Step 1's de-identification, checked where it matters: on the way out.
    const head = Buffer.from(a.content).slice(0, 8192).toString("utf8");
    const leaked = PASSENGER_NAME_COLUMNS.filter((c) => head.includes(c));
    if (leaked.length) {
      throw new Error(
        `Refusing to send ${a.filename}: it still carries the passenger-name column(s) ` +
          `${leaked.join(", ")}. Step 1 removes those before the file leaves Finance.`
      );
    }
  }
  if (!to) throw new Error("Refusing to send: no recipient.");

  return {
    to: String(to),
    from: from ? String(from) : null,
    subject: String(subject),
    text: composeBody({
      label,
      month: month || "this month",
      reference: reference || label,
      ticked: counts.ticked,
      mismatched: counts.mismatched,
      exceptions: counts.exceptions,
      retail: counts.retail,
    }),
    attachments: attachments.map((a) => ({
      filename: String(a.filename),
      contentType: a.contentType || contentTypeFor(a.filename),
      content: Buffer.from(a.content),
    })),
    date,
    messageId: messageId || null,
  };
}

/**
 * Render a composed message as the bytes of a .eml file.
 *
 * multipart/mixed, base64 attachments, CRLF throughout — what every mail
 * client expects. Writing this by hand rather than pulling a dependency is
 * the same call xlsx-lite.js made, for the same reason: the format is small
 * and stable, and a mail library wants credentials in its constructor.
 */
function buildMime(msg, { boundary } = {}) {
  const b = boundary || "raa-tokio-" + Buffer.from(String(msg.date.getTime())).toString("hex").slice(0, 16);
  const head = [
    msg.from ? foldHeader("From", msg.from) : null,
    foldHeader("To", msg.to),
    foldHeader("Subject", encodeSubject(msg.subject)),
    foldHeader("Date", msg.date.toUTCString().replace("GMT", "+0000")),
    msg.messageId ? foldHeader("Message-ID", msg.messageId) : null,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
  ].filter(Boolean);

  const parts = [
    `--${b}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    msg.text,
  ];
  for (const a of msg.attachments) {
    parts.push(
      `--${b}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      base64Lines(a.content)
    );
  }
  parts.push(`--${b}--`, "");

  return Buffer.from(head.join("\r\n") + "\r\n\r\n" + parts.join("\r\n"), "utf8");
}

/**
 * Write the message where a person can open it and press Send.
 * Returns the path, never the bytes — a .eml in a log is the whole mail.
 */
function writeDraft(msg, { dir = path.join(__dirname, "csv_uploads"), filename, label } = {}) {
  // Named after the session it is about, not after its own subject line —
  // a folder of drafts should say which month each one reviews.
  const slug = String(label || msg.attachments[0].filename || "tokio")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const name = filename || `tokio-step15-${slug}.eml`;
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  fs.writeFileSync(out, buildMime(msg));
  return out;
}

/**
 * Hand the message to SMTP. Opt-in, confirmed, and credential-free in this
 * file: everything secret comes from the environment and is never returned,
 * logged or put in an error message.
 */
async function sendViaSmtp(msg, { env = process.env } = {}) {
  const host = env.SMTP_HOST;
  if (!host) {
    throw new Error(
      "transport \"smtp\" needs SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in the environment. " +
        "Without them the run writes a .eml draft instead, which is the default."
    );
  }
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    throw new Error(
      "transport \"smtp\" needs nodemailer, which this repo does not depend on. " +
        "Either `npm i nodemailer` deliberately, or leave the default draft transport alone."
    );
  }
  const transport = nodemailer.createTransport({
    host,
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || "") === "true",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const info = await transport.sendMail({
    from: msg.from || env.MAIL_FROM || env.SMTP_USER,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  // Deliberately narrow: an accepted-recipient list and an id, nothing else.
  return { messageId: info.messageId || null, accepted: info.accepted || [] };
}

/**
 * Step 15, end to end.
 *
 * `transport` is "draft" unless told otherwise. "smtp" additionally requires
 * `confirm === SEND_LITERAL`, because that is the one path where a machine,
 * not a person, puts the claim in RAA's mailbox.
 */
async function sendReconciliationEmail(options = {}) {
  const { transport = "draft", confirm, dir, filename, env = process.env } = options;
  const msg = composeReconciliationEmail(options);

  if (transport === "draft") {
    return {
      transport: "draft",
      to: msg.to,
      subject: msg.subject,
      sent: false,
      path: writeDraft(msg, { dir, filename, label: options.label }),
    };
  }
  if (transport !== "smtp") throw new Error(`Unknown transport "${transport}" — use "draft" or "smtp".`);
  if (confirm !== SEND_LITERAL) {
    throw new Error(`Sending over SMTP requires the exact confirmation "${SEND_LITERAL}" — refusing to proceed.`);
  }
  const res = await sendViaSmtp(msg, { env });
  return { transport: "smtp", to: msg.to, subject: msg.subject, sent: true, ...res };
}

/* ── the run notification, sent the way every other report's is ────────── */

/** CSV, quoted the way a spreadsheet expects — the page's Export uses the same rules. */
function csvCell(v) {
  const t = v == null ? "" : String(v);
  return /[",\n]/.test(t) || /^[\s+=@-]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/**
 * The consolidated sheet as CSV: Outcome, then Tokio's own columns in their
 * own order, then ours (step 4) — the same layout as the page's Export button.
 *
 * Passenger-name columns are LEFT OFF rather than refused. Step 1 has Finance
 * delete them before upload; if one got through anyway, this is a message a
 * machine sends with nobody reviewing it first, and dropping the column is the
 * only answer that neither mails the names nor loses the notification.
 */
function tokioSheetCsv(rows = []) {
  const first = rows[0] || {};
  const drop = new Set(PASSENGER_NAME_COLUMNS);
  const src = Object.keys(first.source || {}).filter((c) => !drop.has(c));
  const app = Object.keys(first.appended || {});
  const lines = [["Outcome"].concat(src, app).map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([r.outcome]
      .concat(src.map((c) => (r.source || {})[c]))
      .concat(app.map((c) => (r.appended || {})[c]))
      .map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * The email every Tokio run sends when it finishes, the same way BPay, Mint,
 * TravelPay, IPSI and DVC already do (recon-core `reconEmail` / `dvcEmail`,
 * delivered by mailer.js). Before this a Tokio run finished silently: the only
 * mail was step 15's draft, and that is offered only once a session is saved.
 *
 * This is NOT step 15's message and does not use its subject. That subject
 * says "Session saved, ready for review", and a run that ticked and stopped,
 * or found nothing outstanding, has saved nothing — so the subject here names
 * what actually happened, and step 15's draft stays the deliberate hand-off.
 *
 * `sheet` is tokio-core `sheetAfterRun`'s output: the whole consolidated sheet
 * with the Tramada run's verdict and remarks written into it.
 */
function tokioRunEmail({ sheet = [], run = {}, month = "", reference = "", dryRun = false } = {}) {
  const ticked = (run.ticked || []).length;
  const notTicked = (run.mismatched || []).length;
  const count = (o) => sheet.filter((r) => r.outcome === o).length;
  const retail = count("Retail");
  const exceptions = count("Exception");
  const label = run.label || "";
  const when = month || label.replace(/^TOKIO_/, "") || "this month";

  let status;
  let headline;
  if (run.savedSession) {
    status = "session saved, ready for review";
    headline = `The Tokio Marine reconciliation for ${when} has run. Payment session ${label} is saved in ` +
      `Tramada with ${ticked} line(s) ticked, and is ready for review. Issue has NOT been clicked — nothing ` +
      "has been paid.";
  } else if (run.empty) {
    status = "nothing outstanding in Tramada";
    headline = `The Tokio Marine reconciliation for ${when} ran, but Tramada has no outstanding Tokio Marine ` +
      "segments for the period. Nothing was ticked and no session was saved.";
  } else {
    status = "ticked, not saved";
    headline = `The Tokio Marine reconciliation for ${when} ticked ${ticked} line(s) in Tramada and stopped ` +
      `before saving. No payment session was saved${dryRun ? " (dry run)" : ""}.`;
  }

  const lines = [
    headline,
    "",
    `Reporting month: ${when}`,
    `Payment reference: ${reference || run.reference || "(none)"}`,
    `Ticked in Tramada: ${ticked}`,
    `Travel lines not ticked: ${notTicked}`,
    `Exceptions for a person: ${exceptions}`,
    `Retail lines excluded: ${retail}`,
  ];
  if (notTicked || exceptions) {
    lines.push("", "The attached sheet carries every line, with the reason for each one not ticked in " +
      "its Remarks column and what Tramada did with it in the Tramada column.");
  }
  lines.push("", "The agent does not press Issue. Resolving exceptions, rounding, the transaction total " +
    "and Issue stay with Travel Accounts (BR16/BR18).");

  const text = lines.join("\n") + "\n";
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = "<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:14px\">" +
    `<p><b>${esc(headline)}</b></p>` +
    `<pre style="font-family:Consolas,monospace;font-size:13px">${esc(lines.slice(2).join("\n"))}</pre>` +
    "</div>";

  const stamp = String(when).replace(/\s+/g, "-");
  return {
    subject: `AI Agent Tokio Marine reconciliation — ${when}` + (dryRun ? " [DRY RUN]" : "") + ` — ${status}`,
    text,
    html,
    status,
    attachment: {
      filename: `tokio-consolidated-${stamp}.csv`,
      contentType: "text/csv; charset=utf-8",
      // A BOM, as every other report's attachment: Excel on Windows otherwise
      // opens a UTF-8 CSV as mojibake.
      content: "\uFEFF" + tokioSheetCsv(sheet),
    },
  };
}

module.exports = {
  SEND_LITERAL,
  TRAVEL_ACCOUNTS,
  SUBJECT,
  PASSENGER_NAME_COLUMNS,
  composeReconciliationEmail,
  composeBody,
  buildMime,
  writeDraft,
  sendViaSmtp,
  sendReconciliationEmail,
  contentTypeFor,
  tokioSheetCsv,
  tokioRunEmail,
};

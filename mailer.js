"use strict";

/**
 * mailer.js — step 18 of docs/dvc.md: the emails to the accounts team.
 *
 * THREE WAYS, chosen by MAIL_TRANSPORT or by what is configured:
 *
 *   outbox            MAIL_TRANSPORT=outbox, or nothing else configured →
 *                     captured on this machine and shown at /outbox, not sent.
 *   Microsoft Graph   GRAPH_CLIENT_ID set → `POST /me/sendMail` over HTTPS,
 *                     from the Outlook / Microsoft 365 account that signed in
 *                     once with `npm run email:signin`.
 *   SMTP              SMTP_HOST set and no GRAPH_CLIENT_ID → nodemailer.
 *
 * ── Why Graph, and not SMTP ──────────────────────────────────────────────────
 *
 * Measured 23-09-2026: this machine's network blocks outbound SMTP on 587 —
 * `smtp.office365.com` never answered, while 443 went out fine. Graph is plain
 * HTTPS on 443, the same road Tramada itself is reached by. It is also what a
 * Microsoft 365 tenant like RAA's expects: Microsoft has been switching off
 * password SMTP sign-in, and Graph never needs a password stored at all.
 *
 * ── The sign-in, and what is kept ────────────────────────────────────────────
 *
 * Device-code flow, delegated `Mail.Send`: `npm run email:signin` prints a code,
 * a person enters it at microsoft.com/devicelogin and signs in, and MSAL keeps
 * the resulting refresh token in GRAPH_TOKEN_CACHE (default
 * `.graph-token-cache.json`, gitignored, written 0600). From then on every send
 * refreshes silently. NO PASSWORD IS STORED ANYWHERE — the cache holds tokens
 * Microsoft issued and can revoke, and deleting the file signs the agent out.
 *
 * ── The outbox: every email, kept where it can be seen ───────────────────────
 *
 * Every email this file is asked to send is also written to the OUTBOX — a
 * real `.eml` (opens in Outlook) and a `.json` beside it saying what happened
 * to it — and the server shows them at `/outbox`. With MAIL_TRANSPORT=outbox,
 * or nothing else configured, that is ALL that happens: captured, not sent.
 *
 * Why (23-09-2026): the company proxy blocks both SMTP (587) and the Microsoft
 * sign-in Graph needs, so from this machine no email can leave at all — and
 * "did the run try to email the accounts team, and what did it say?" still has
 * to be answerable. It also means a mail server that was down on the day does
 * not lose the email: the copy that failed is in the outbox, marked failed.
 *
 * ── Not configured is a reason, not an error ─────────────────────────────────
 *
 * Nothing configured, nobody signed in, a network that will not answer: `send`
 * never throws. It returns `{ sent: false, why }`, because the run has already
 * reconciled and may already have saved a session in Tramada, and a lost email
 * is not a reason to fail work that is done (the same rule the run store keeps,
 * §6b).
 *
 * ── THERE IS NO DEFAULT RECIPIENT, ON PURPOSE ────────────────────────────────
 *
 * Step 18 names TAccounts@raa.com.au. It is not a fallback here: this app runs
 * against the Tramada SANDBOX today, and a default that mailed a real RAA inbox
 * the first time somebody forgot a variable would send the accounts team a
 * sandbox day as though it were theirs. DVC_EMAIL_TO is set deliberately.
 *
 * WHAT the email says is `recon-core.dvcEmail`, tested offline (§2, §7). This
 * file only delivers it.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const GRAPH_SCOPES = ["Mail.Send", "offline_access"];
const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

/** Which settings are present — and, when they are not, which are missing. */
function config(env = process.env) {
  const to = String(env.DVC_EMAIL_TO || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const port = parseInt(env.SMTP_PORT || "587", 10);
  const graphClientId = String(env.GRAPH_CLIENT_ID || "").trim();
  const forced = String(env.MAIL_TRANSPORT || "").trim().toLowerCase();
  const c = {
    /* MAIL_TRANSPORT wins when set; otherwise Graph, then SMTP, and with
       neither, the outbox — so an unconfigured machine still shows what it
       would have sent rather than saying nothing. */
    transport: ["outbox", "graph", "smtp"].includes(forced) ? forced
      : graphClientId ? "graph" : env.SMTP_HOST ? "smtp" : "outbox",
    to,
    outboxDir: path.resolve(env.MAIL_OUTBOX_DIR ||
      path.join(env.RECON_STORE_DIR || __dirname, "outbox")),
    // Graph
    graphClientId,
    /* "consumers" is personal Outlook.com / Hotmail accounts. A Microsoft 365
       tenant — RAA's, later — is its tenant id or domain here, and nothing
       else in this file changes. */
    graphTenant: String(env.GRAPH_TENANT || "consumers").trim(),
    graphCache: path.resolve(env.GRAPH_TOKEN_CACHE || path.join(__dirname, ".graph-token-cache.json")),
    // SMTP
    host: String(env.SMTP_HOST || "").trim(),
    port: Number.isFinite(port) ? port : 587,
    user: String(env.SMTP_USER || "").trim(),
    pass: String(env.SMTP_PASS || ""),
    from: String(env.MAIL_FROM || env.SMTP_USER || "").trim(),
  };
  const missing = [];
  // The outbox sends nothing, so it needs nothing — not even a recipient.
  if (c.transport !== "outbox" && !c.to.length) missing.push("DVC_EMAIL_TO");
  if (c.transport === "graph" && !c.graphClientId) missing.push("GRAPH_CLIENT_ID");
  if (c.transport === "smtp" && !c.host) missing.push("SMTP_HOST");
  if (c.transport === "smtp") {
    if (!c.from) missing.push("MAIL_FROM (or SMTP_USER)");
    /* A user with no password is almost always a half-filled .env, and the
       failure it produces — an auth error from the relay minutes into a run —
       reads as the mail server being broken. Named up front instead. */
    if (c.user && !c.pass) missing.push("SMTP_PASS");
  }
  return { ...c, ready: !missing.length, missing };
}

/* ── Microsoft Graph ─────────────────────────────────────────────────────── */

/**
 * MSAL's token cache, on disk. Read before every access, written only when MSAL
 * says it changed, and never world-readable: it holds a refresh token, which is
 * as good as a sign-in until Microsoft revokes it.
 */
function cachePlugin(file) {
  return {
    async beforeCacheAccess(ctx) {
      try { ctx.tokenCache.deserialize(fs.readFileSync(file, "utf8")); } catch { /* not signed in yet */ }
    },
    async afterCacheAccess(ctx) {
      if (!ctx.cacheHasChanged) return;
      fs.writeFileSync(file, ctx.tokenCache.serialize(), { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
    },
  };
}

function graphApp(c) {
  const { PublicClientApplication } = require("@azure/msal-node");
  return new PublicClientApplication({
    auth: { clientId: c.graphClientId, authority: `https://login.microsoftonline.com/${c.graphTenant}` },
    cache: { cachePlugin: cachePlugin(c.graphCache) },
  });
}

/**
 * The one-time sign-in. `onCode(message)` is handed Microsoft's own sentence —
 * "To sign in, use a web browser to open … and enter the code …" — to show a
 * person. Resolves with the account that signed in.
 */
async function graphSignIn({ env = process.env, onCode = console.log } = {}) {
  const c = config(env);
  if (!c.graphClientId) throw new Error("GRAPH_CLIENT_ID is not set — see docs/email.md for the app registration.");
  const app = graphApp(c);
  const res = await app.acquireTokenByDeviceCode({
    scopes: GRAPH_SCOPES,
    deviceCodeCallback: (r) => onCode(r.message),
  });
  if (!res || !res.account) throw new Error("Microsoft returned no account for that sign-in.");
  return { username: res.account.username, name: res.account.name || "" };
}

/** Who is signed in, if anybody. Never throws. */
async function graphAccount(env = process.env) {
  const c = config(env);
  if (!c.graphClientId) return null;
  try {
    const accounts = await graphApp(c).getTokenCache().getAllAccounts();
    return accounts[0] || null;
  } catch {
    return null;
  }
}

/**
 * The Graph `sendMail` body for one built email. Pure, so the shape — which
 * Graph rejects with a bare 400 if any of it is wrong — is tested offline.
 */
function graphMessage(message, to) {
  const a = message.attachment;
  return {
    message: {
      subject: message.subject,
      body: { contentType: "HTML", content: message.html || `<pre>${message.text || ""}</pre>` },
      toRecipients: (to || []).map((address) => ({ emailAddress: { address } })),
      attachments: a ? [{
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        // Graph wants the MIME type without parameters.
        contentType: String(a.contentType || "application/octet-stream").split(";")[0].trim(),
        contentBytes: Buffer.from(String(a.content || ""), "utf8").toString("base64"),
      }] : [],
    },
    saveToSentItems: true,
  };
}

async function sendGraph(message, c) {
  const app = graphApp(c);
  const accounts = await app.getTokenCache().getAllAccounts();
  if (!accounts.length) {
    return { sent: false, to: c.to, why: "the mailbox is not signed in — run `npm run email:signin` once" };
  }
  let token;
  try {
    token = (await app.acquireTokenSilent({ account: accounts[0], scopes: GRAPH_SCOPES })).accessToken;
  } catch (err) {
    return { sent: false, to: c.to,
      why: `the saved Microsoft sign-in has expired or been revoked — run \`npm run email:signin\` again (${err.errorCode || err.message})` };
  }
  const controller = new AbortController();
  // Fail fast, as the SMTP path does: the email is the last thing a run does.
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(GRAPH_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(graphMessage(message, c.to)),
      signal: controller.signal,
    });
    // 202 Accepted is Graph's success for sendMail, with an empty body.
    if (res.status === 202) return { sent: true, to: c.to, from: accounts[0].username, via: "graph" };
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || ""; } catch { /* no body */ }
    return { sent: false, to: c.to, why: `Microsoft Graph refused the email (HTTP ${res.status}${detail ? `: ${detail}` : ""})` };
  } catch (err) {
    return { sent: false, to: c.to,
      why: err.name === "AbortError" ? "Microsoft Graph did not answer within 20 seconds"
        : `could not reach Microsoft Graph — ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/* ── SMTP ─────────────────────────────────────────────────────────────────── */

async function sendSmtp(message, c, transport) {
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (err) {
    return { sent: false, why: `nodemailer is not installed (npm install) — ${err.message}` };
  }
  try {
    const t = transport || nodemailer.createTransport({
      host: c.host,
      port: c.port,
      // 465 is implicit TLS; everything else upgrades with STARTTLS, which
      // Office 365 requires on 587 and refuses to skip.
      secure: c.port === 465,
      requireTLS: c.port !== 465 && c.port !== 25,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      /* FAIL FAST. Measured 23-09-2026 on this machine: outbound port 587 is
         blocked, and nodemailer's defaults waited minutes on a connection
         that was never going to open — at the very end of a run that had
         already saved its session. A relay that answers at all answers in
         seconds. */
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    const a = message.attachment;
    const info = await t.sendMail({
      from: c.from || "recon@localhost",
      to: c.to.length ? c.to.join(", ") : "test@localhost",
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: a ? [{ filename: a.filename, content: a.content, contentType: a.contentType }] : [],
    });
    return { sent: true, to: c.to, messageId: info.messageId || "", via: "smtp", info };
  } catch (err) {
    /* A timeout is almost always the network, not the password — say so, or
       somebody resets a perfectly good password chasing a firewall. The
       relay's own words otherwise; nodemailer never quotes the secret. */
    const blocked = /timeout|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(`${err.code} ${err.message}`);
    return { sent: false, to: c.to,
      why: blocked
        ? `could not reach ${c.host}:${c.port} (${err.code || err.message}) — the network is blocking outbound ` +
          "SMTP on that port; the login was never tried"
        : `the email could not be sent — ${err.message}` };
  }
}

/* ── The outbox ──────────────────────────────────────────────────────────── */

const OUTBOX_ID = /^[0-9]{8}-[0-9]{6}-[0-9]{3}-[a-z0-9-]{1,60}$/;

/** "20260923-154812-042-dvc-24-09-2026" — sortable, and safe as a file name. */
function outboxId(subject, when = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-` +
    `${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}-${p(when.getMilliseconds(), 3)}`;
  const slug = String(subject || "email").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `${stamp}-${slug || "email"}`;
}

/**
 * Write one email to the outbox: `<id>.eml` (the whole message, attachment and
 * all, as an email client reads it) and `<id>.json` (what happened to it).
 * Never throws — keeping a copy must not be able to stop a send, any more than
 * recording a run may stop a run (§6b).
 */
async function keep(message, c, outcome) {
  try {
    fs.mkdirSync(c.outboxDir, { recursive: true });
    const id = outboxId(message.subject);
    const a = message.attachment;
    const nodemailer = require("nodemailer");
    const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" })
      .sendMail({
        from: outcome.from || c.from || "dvc-agent@localhost",
        to: c.to.length ? c.to.join(", ") : "accounts-team@localhost",
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: a ? [{ filename: a.filename, content: a.content, contentType: a.contentType }] : [],
      });
    fs.writeFileSync(path.join(c.outboxDir, `${id}.eml`), raw.message);
    // The attachment on its own too, so /outbox can hand it back as a file
    // without parsing MIME back out of the .eml.
    if (a) fs.writeFileSync(path.join(c.outboxDir, `${id}.attachment`), String(a.content || ""));
    fs.writeFileSync(path.join(c.outboxDir, `${id}.json`), JSON.stringify({
      id,
      at: new Date().toISOString(),
      subject: message.subject,
      status: message.status || "",
      to: c.to,
      via: outcome.via || c.transport,
      sent: !!outcome.sent,
      why: outcome.why || "",
      text: message.text,
      html: message.html,
      attachment: a ? { filename: a.filename, contentType: a.contentType } : null,
    }, null, 2));
    return id;
  } catch (err) {
    console.error(`  ⚠ could not keep a copy of the email in the outbox: ${err.message}`);
    return "";
  }
}

/** Every email in the outbox, newest first — the `/outbox` page's list. */
function listOutbox(env = process.env) {
  const dir = config(env).outboxDir;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".json")).sort().reverse().map((n) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

/**
 * One outbox file by id. The id is checked against its own shape before it goes
 * anywhere near a path — `../../.env` is not an email.
 */
function outboxFile(id, ext, env = process.env) {
  if (!OUTBOX_ID.test(String(id || "")) || !["eml", "json", "attachment"].includes(ext)) return null;
  const file = path.join(config(env).outboxDir, `${id}.${ext}`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Send one built email. Never throws: the answer is `{ sent, why, ... }`.
 *
 * `message` is `recon-core.dvcEmail`'s output — subject, text, html and one
 * attachment. `transport` is a nodemailer transport for tests and tools that
 * want `jsonTransport` instead of a real relay.
 */
async function send(message, { env = process.env, transport = null } = {}) {
  const c = config(env);
  if (transport) return sendSmtp(message, c, transport);
  let out;
  if (c.transport === "outbox") {
    out = { sent: false, captured: true, via: "outbox", to: c.to,
      why: "captured in the outbox, not sent (MAIL_TRANSPORT=outbox, or no mail server configured)" };
  } else if (!c.ready) {
    out = { sent: false, skipped: true, to: c.to, why: `email is not configured — set ${c.missing.join(", ")}` };
  } else {
    try {
      out = c.transport === "graph" ? await sendGraph(message, c) : await sendSmtp(message, c, null);
    } catch (err) {
      out = { sent: false, to: c.to, why: `the email could not be sent — ${err.message}` };
    }
  }
  // Every email, sent, failed or only captured, leaves a copy that can be seen.
  out.outboxId = await keep(message, c, out);
  return out;
}

module.exports = { config, send, graphSignIn, graphAccount, graphMessage, GRAPH_SCOPES,
  listOutbox, outboxFile, outboxId };

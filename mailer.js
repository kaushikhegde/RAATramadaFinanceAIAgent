"use strict";

/**
 * mailer.js — step 18 of docs/dvc.md: the emails to the accounts team.
 *
 * TWO WAYS, chosen by MAIL_TRANSPORT or by what is configured:
 *
 *   Microsoft Graph   GRAPH_CLIENT_ID set → `POST /me/sendMail` over HTTPS,
 *                     from the Outlook / Microsoft 365 account that signed in
 *                     once with `npm run email:signin`.
 *   Resend            RESEND_API_KEY set, or nothing else configured →
 *                     `POST /emails` over HTTPS, no sign-in, no credentials
 *                     stored beyond the one API key.
 *
 * ── Why Graph or Resend, and not SMTP ────────────────────────────────────────
 *
 * Measured 23-09-2026: this machine's network blocks outbound SMTP on 587 —
 * `smtp.office365.com` never answered, while 443 went out fine. Graph and
 * Resend are both plain HTTPS on 443, the same road Tramada itself is reached
 * by. Graph is also what a Microsoft 365 tenant like RAA's expects: Microsoft
 * has been switching off password SMTP sign-in, and Graph never needs a
 * password stored at all. Resend needs even less — no sign-in, no mailbox, one
 * API key — which is why it is the fallback here when nobody has run
 * `npm run email:signin`: sibling project RAATramadaPaymentAIAgent's
 * email-notifier.js hit the same blocked-SMTP network and reached for it for
 * exactly that reason.
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
const RESEND_SEND_URL = "https://api.resend.com/emails";

/** Which settings are present — and, when they are not, which are missing. */
function config(env = process.env) {
  const to = String(env.DVC_EMAIL_TO || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const graphClientId = String(env.GRAPH_CLIENT_ID || "").trim();
  const resendApiKey = String(env.RESEND_API_KEY || "").trim();
  const forced = String(env.MAIL_TRANSPORT || "").trim().toLowerCase();
  const c = {
    // MAIL_TRANSPORT wins when set; otherwise Graph, then Resend.
    transport: ["graph", "resend"].includes(forced) ? forced : graphClientId ? "graph" : "resend",
    to,
    // Graph
    graphClientId,
    /* "consumers" is personal Outlook.com / Hotmail accounts. A Microsoft 365
       tenant — RAA's, later — is its tenant id or domain here, and nothing
       else in this file changes. */
    graphTenant: String(env.GRAPH_TENANT || "consumers").trim(),
    graphCache: path.resolve(env.GRAPH_TOKEN_CACHE || path.join(__dirname, ".graph-token-cache.json")),
    // Resend
    resendApiKey,
    /* Resend's own shared sandbox address — it sends, but only ever delivers
       to the account that owns the API key, until a real domain is verified
       in Resend. That makes it a safe default rather than a fallback that
       quietly fails: MAIL_FROM overrides it once a domain exists. */
    from: String(env.MAIL_FROM || "onboarding@resend.dev").trim(),
  };
  const missing = [];
  if (!c.to.length) missing.push("DVC_EMAIL_TO");
  if (c.transport === "graph" && !c.graphClientId) missing.push("GRAPH_CLIENT_ID");
  if (c.transport === "resend" && !c.resendApiKey) missing.push("RESEND_API_KEY");
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
  // Fail fast, as the Resend path does: the email is the last thing a run does.
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

/* ── Resend ───────────────────────────────────────────────────────────────── */

/**
 * The Resend `POST /emails` body for one built email — the HTTPS peer of
 * `graphMessage`. `content` is base64, the same encoding `graphMessage` uses,
 * because Resend's JSON API has no way to carry raw bytes either.
 */
function resendMessage(message, to, from) {
  const a = message.attachment;
  return {
    from,
    to: to || [],
    subject: message.subject,
    html: message.html || `<pre>${message.text || ""}</pre>`,
    text: message.text,
    attachments: a ? [{
      filename: a.filename,
      content: Buffer.from(String(a.content || ""), "utf8").toString("base64"),
    }] : [],
  };
}

async function sendResend(message, c) {
  const controller = new AbortController();
  // Fail fast, as the Graph path does: the email is the last thing a run does.
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(resendMessage(message, c.to, c.from)),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (res.ok) return { sent: true, to: c.to, from: c.from, messageId: (body && body.id) || "", via: "resend" };
    const detail = (body && (body.message || body.name)) || "";
    return { sent: false, to: c.to, why: `Resend refused the email (HTTP ${res.status}${detail ? `: ${detail}` : ""})` };
  } catch (err) {
    return { sent: false, to: c.to,
      why: err.name === "AbortError" ? "Resend did not answer within 20 seconds"
        : `could not reach Resend — ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one built email. Never throws: the answer is `{ sent, why, ... }`.
 *
 * `message` is `recon-core.dvcEmail`'s output — subject, text, html and one
 * attachment.
 */
async function send(message, { env = process.env } = {}) {
  const c = config(env);
  if (!c.ready) return { sent: false, skipped: true, to: c.to, why: `email is not configured — set ${c.missing.join(", ")}` };
  try {
    return c.transport === "graph" ? await sendGraph(message, c) : await sendResend(message, c);
  } catch (err) {
    return { sent: false, to: c.to, why: `the email could not be sent — ${err.message}` };
  }
}

module.exports = { config, send, graphSignIn, graphAccount, graphMessage, resendMessage, GRAPH_SCOPES };

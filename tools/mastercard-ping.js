#!/usr/bin/env node
"use strict";

/**
 * tools/mastercard-ping.js — does the Mastercard sandbox answer us?
 *
 * Standalone on purpose. It requires nothing from recon-core and nothing from
 * recon-core requires it. It is a connectivity + credential check for the
 * "Westpac RAA" project on developer.mastercard.com, nothing more.
 *
 * The project has two APIs, both Sandbox-Ready, Production not requested:
 *   In Control for Commercial Payments (ICCP)  — SOAP/XML
 *   Commercial Event Notifications (CEN)       — REST/JSON
 * Both sit behind the Mastercard gateway and both want OAuth 1.0a RSA-SHA256.
 *
 * The two calls this makes were picked because they take no arguments and
 * return no card data:
 *   ICCP getDataSourcesRequest -> the id/name of your data schema
 *   CEN  GET /fieldmappings    -> the fields you may filter subscriptions on
 *
 * See CLAUDE.md §4. This script must never grow a call that returns a PAN, a
 * virtual card number, a CVC or an expiry. If the integration needs those,
 * that is a conversation to have before any code is written, not after.
 *
 * Credentials come from the environment. Nothing is read from a config file
 * and nothing is written to disk.
 *
 *   MC_CONSUMER_KEY   the consumer key from Project -> Sandbox -> OAuth keys
 *                     (the long one ending in a run of zeroes)
 *   MC_KEY_PATH       the .p12 you downloaded when the project was created,
 *                     or a .pem private key
 *   MC_KEY_PASSWORD   the keystore password (.p12 only; usually "keystorepassword")
 *   MC_KEY_ALIAS      unused for now, kept so the name is not reused later
 *
 * MC_CONSUMER_KEY and MC_KEY_PATH must come from the SAME project. A signing
 * key from one project against another project's consumer key is a 401 every
 * time, and the gateway will not tell you that is why.
 *
 * The .p12 is downloadable exactly once, at project creation. If nobody has
 * it, the fix is to add a new key on the Sandbox page — not to hunt for the
 * old file.
 *
 * Usage:
 *   node tools/mastercard-ping.js              both calls, sandbox
 *   node tools/mastercard-ping.js --iccp       ICCP only
 *   node tools/mastercard-ping.js --cen        CEN only
 *   node tools/mastercard-ping.js --reach      no credentials needed; just
 *                                              proves the gateway is up
 *   node tools/mastercard-ping.js --prod       production hosts (will fail
 *                                              until production is granted)
 *   node tools/mastercard-ping.js --url URL    sign a GET to any endpoint; use
 *                                              this to prove the SIGNING works
 *                                              even where the project has no
 *                                              entitlement (401 = bad key,
 *                                              403/404 = key fine, no access)
 */

const crypto = require("crypto");
const https = require("https");
const { spawnSync } = require("child_process");
const { URL } = require("url");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const PROD = has("--prod");
const HOST = PROD ? "https://api.mastercard.com" : "https://sandbox.api.mastercard.com";

const ICCP_FINANCIAL = HOST + "/iccp/financial";
const ICCP_REPORTING = HOST + "/iccp/reporting";
const CEN_FIELDMAPPINGS = HOST + "/commercial-event-notifications/fieldmappings";

const GET_DATA_SOURCES =
  '<soapenv:Envelope xmlns:ser="http://mastercard.com/sd/pc/service" ' +
  'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  "<soapenv:Header></soapenv:Header>" +
  "<soapenv:Body><ser:getDataSourcesRequest></ser:getDataSourcesRequest></soapenv:Body>" +
  "</soapenv:Envelope>";

/* ---------------------------------------------------------------- plumbing */

// RFC 3986. encodeURIComponent leaves ! * ' ( ) alone and OAuth does not.
const pct = (s) =>
  encodeURIComponent(String(s)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );

function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: headers || {},
        timeout: 30000,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timed out after 30s")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------ §4 guard */

// CLAUDE.md §4: this project never touches card data. --url makes it trivial to
// point this script at an endpoint that returns PANs — Automatic Billing
// Updater exists to hand back refreshed card numbers, and Account Catalog can
// carry them too. A signing check never needs those: 401-vs-403 tells you
// whether the signature was accepted, and an unentitled path answers that just
// as well as an entitled one. So refuse them by name rather than trusting
// whoever types the flag at 6pm.
const CARD_DATA_PATHS = [
  ["/billing-updater", "Automatic Billing Updater returns refreshed card numbers"],
  ["/abu", "Automatic Billing Updater returns refreshed card numbers"],
  ["/account-catalog", "Account Catalog Services can return account identifiers"],
  ["/purchaserequest", "ICCP purchase requests create and return virtual card numbers"],
  ["/submitpurchaserequest", "ICCP purchase requests create and return virtual card numbers"],
];

function refuseCardData(url) {
  const lower = String(url).toLowerCase();
  for (const [needle, why] of CARD_DATA_PATHS) {
    if (lower.includes(needle)) {
      console.error("Refusing " + url);
      console.error("");
      console.error("  " + why + ".");
      console.error("  CLAUDE.md §4 — this project never touches card data.");
      console.error("");
      console.error("  A signing check does not need an entitled endpoint. Point --url at");
      console.error("  something harmless and read the status instead:");
      console.error("    401       signature rejected");
      console.error("    403/404   signature ACCEPTED, no entitlement — a pass");
      process.exit(3);
    }
  }
}

/* --------------------------------------------------------------- prompting */

// Credentials asked for at the prompt rather than exported. An exported
// MC_KEY_PASSWORD lands in shell history, in `ps`, and in every child process;
// a typed one does not. Env vars still win when set, so CI is unaffected.

function promptLine(question, hidden) {
  const fs = require("fs");
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null; // no terminal — caller falls back to the env-var error
  }
  fs.writeSync(fd, question);

  let echoOff = false;
  if (hidden) {
    echoOff = spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;
  }

  let out = "";
  const buf = Buffer.alloc(1);
  try {
    while (fs.readSync(fd, buf, 0, 1, null) === 1) {
      const c = buf.toString("utf8");
      if (c === "\n" || c === "\r") break;
      if (c === "\u0003") { // ctrl-c
        if (echoOff) spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
        fs.writeSync(fd, "\n");
        process.exit(130);
      }
      if (c === "\u007f" || c === "\b") { // backspace
        out = out.slice(0, -1);
        continue;
      }
      out += c;
    }
  } finally {
    if (echoOff) {
      spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
      fs.writeSync(fd, "\n");
    }
    fs.closeSync(fd);
  }
  return out.trim();
}

// With one .p12 sitting in the repo root there is nothing to choose. With two,
// guessing is worse than asking.
function findKeyInRepo() {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const found = fs
    .readdirSync(root)
    .filter((f) => /\.(p12|pfx)$/i.test(f))
    .map((f) => path.join(root, f));
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(
      "more than one key in the repo root — set MC_KEY_PATH to the one you mean:\n  " +
        found.join("\n  ")
    );
  }
  return null;
}

/* ------------------------------------------------------------ private key */

// Node cannot open a PKCS#12 directly, so shell out. The password goes via the
// environment, not argv — argv is readable by every process on the box.
function privateKeyPem() {
  const keyPath = process.env.MC_KEY_PATH || findKeyInRepo();
  if (!keyPath) {
    throw new Error("no .p12 in the repo root and MC_KEY_PATH is not set");
  }
  console.log("key:      " + keyPath);

  if (/\.pem$/i.test(keyPath)) {
    return require("fs").readFileSync(keyPath, "utf8");
  }

  if (!process.env.MC_KEY_PASSWORD) {
    const typed = promptLine("keystore password for that file: ", true);
    if (typed === null) throw new Error("MC_KEY_PASSWORD is not set and there is no terminal to ask at");
    process.env.MC_KEY_PASSWORD = typed;
  }

  const attempt = (extra) =>
    spawnSync(
      "openssl",
      ["pkcs12", "-in", keyPath, "-nodes", "-nocerts", "-passin", "env:MC_KEY_PASSWORD"].concat(
        extra || []
      ),
      { encoding: "utf8", env: process.env }
    );

  const first = attempt();
  // OpenSSL 3 refuses the RC2 that older .p12 files use unless asked nicely.
  // LibreSSL — which is what macOS ships as /usr/bin/openssl — has no -legacy
  // and will fail on the flag itself, so the retry's complaint is worthless.
  // Report the FIRST attempt's reason, which is the real one (usually a wrong
  // MC_KEY_PASSWORD).
  const r = first.status === 0 ? first : attempt(["-legacy"]);

  if (r.status !== 0) {
    const why = (first.stderr || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(
      "openssl could not open " + keyPath + " — " + (why || "no reason given") +
      "\n  If that mentions a MAC or verification failure, MC_KEY_PASSWORD is wrong."
    );
  }
  const pem = r.stdout.slice(r.stdout.indexOf("-----BEGIN"));
  if (!pem.startsWith("-----BEGIN")) throw new Error("openssl returned no private key");
  return pem;
}

/* ---------------------------------------------------------- OAuth 1.0a */

function signatureBaseString(method, url, oauth) {
  const u = new URL(url);
  const params = [];
  for (const [k, v] of u.searchParams) params.push([pct(k), pct(v)]);
  for (const k of Object.keys(oauth)) {
    if (k === "oauth_signature") continue;
    params.push([pct(k), pct(oauth[k])]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  return [
    method.toUpperCase(),
    pct(u.origin + u.pathname),
    pct(params.map(([k, v]) => k + "=" + v).join("&")),
  ].join("&");
}

function authHeader(method, url, body, pem, consumerKey) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  // Mastercard's extension: the body is hashed and the hash is signed with the
  // rest. Bodyless requests omit it entirely.
  if (body) {
    oauth.oauth_body_hash = crypto.createHash("sha256").update(body, "utf8").digest("base64");
  }

  oauth.oauth_signature = crypto
    .createSign("RSA-SHA256")
    .update(signatureBaseString(method, url, oauth), "utf8")
    .sign(pem, "base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => pct(k) + '="' + pct(oauth[k]) + '"')
      .join(",")
  );
}

/* ------------------------------------------------------------- reporting */

const tick = (ok) => (ok ? "  ok  " : " FAIL ");

function show(label, res, expectText) {
  const oneLine = res.body.replace(/\s+/g, " ").trim();
  const ok = res.status >= 200 && res.status < 300;
  console.log("[" + tick(ok) + "] " + label + "  HTTP " + res.status);
  console.log("          " + oneLine.slice(0, 300) + (oneLine.length > 300 ? " …" : ""));
  if (!ok) console.log("          " + explain(res, expectText));
  console.log("");
  return ok;
}

function explain(res) {
  const b = res.body || "";
  if (/INVALID_AUTH_HEADER/.test(b))
    return "no Authorization header reached the gateway — the signing step did not run";
  if (/oauth|signature/i.test(b) && res.status === 401)
    return "the gateway saw the header and rejected the signature — wrong key, wrong consumer key, or clock skew";
  if (res.status === 401) return "unauthorized — check MC_CONSUMER_KEY matches the key in MC_KEY_PATH";
  if (res.status === 403)
    return "authenticated but not entitled — this project is not onboarded for this call yet";
  if (res.status === 404) return "endpoint path is wrong, or the API is not enabled on this project";
  if (res.status >= 500) return "Mastercard-side error — check developer.mastercard.com/api-status";
  return "see the body above";
}

/* ------------------------------------------------------------------ main */

async function reachOnly() {
  console.log("Reachability only — no credentials used.\n");
  console.log("Every one of these SHOULD come back 400 INVALID_AUTH_HEADER.");
  console.log("That is the gateway answering, which is the whole point.\n");
  let allAnswered = true;
  for (const [label, url] of [
    ["ICCP financial ", ICCP_FINANCIAL],
    ["ICCP reporting ", ICCP_REPORTING],
    ["CEN            ", CEN_FIELDMAPPINGS],
  ]) {
    try {
      const res = await request("GET", url, null, {});
      const answered = /INVALID_AUTH_HEADER/.test(res.body) || res.status > 0;
      console.log("[" + tick(answered) + "] " + label + " HTTP " + res.status + "  " + res.body.replace(/\s+/g, " ").slice(0, 160));
      if (!answered) allAnswered = false;
    } catch (err) {
      console.log("[" + tick(false) + "] " + label + " " + err.message);
      allAnswered = false;
    }
  }
  console.log("");
  return allAnswered;
}

async function main() {
  console.log("");
  console.log("Mastercard " + (PROD ? "PRODUCTION" : "sandbox") + " — " + HOST);
  console.log("");

  // Check the target BEFORE asking for a password. Refusing after someone has
  // typed their keystore password is a worse experience and a worse habit.
  const urlFlag = argv.indexOf("--url");
  if (urlFlag !== -1 && argv[urlFlag + 1] && !argv[urlFlag + 1].startsWith("--")) {
    refuseCardData(argv[urlFlag + 1]);
  }

  if (has("--reach")) {
    process.exit((await reachOnly()) ? 0 : 1);
  }

  let consumerKey = process.env.MC_CONSUMER_KEY;
  if (!consumerKey) {
    consumerKey = promptLine("consumer key (Project -> Sandbox -> OAuth keys): ", false);
  }
  if (!consumerKey) {
    console.error("No consumer key.");
    console.error("It is on the project's Sandbox page, under OAuth keys.");
    console.error("It must belong to the SAME project as the .p12 — see the note at the");
    console.error("top of this file.");
    console.error("");
    console.error("To check the gateway is up without credentials:");
    console.error("  node tools/mastercard-ping.js --reach");
    process.exit(2);
  }

  let pem;
  try {
    pem = privateKeyPem();
  } catch (err) {
    console.error(err.message);
    console.error("");
    console.error("The .p12 is issued once, when the project is created. If it is lost,");
    console.error("add a new key on the project's Sandbox page rather than looking for it.");
    process.exit(2);
  }

  // --url signs an arbitrary GET. Its real use is not the response body: it is
  // telling a rejected SIGNATURE (401) apart from a signature the gateway
  // accepted on a resource this project is not entitled to (403/404). Both mean
  // "no data", only one means "the signing code is wrong".
  const urlAt = argv.indexOf("--url");
  if (urlAt !== -1) {
    const url = argv[urlAt + 1];
    if (!url || url.startsWith("--")) {
      console.error("--url needs a URL after it");
      process.exit(2);
    }
    refuseCardData(url); // already checked above; cheap and keeps the flag honest
    const headers = {
      Accept: "application/json",
      "X-B3-TraceId": crypto.randomUUID(),
      Authorization: authHeader("GET", url, null, pem, consumerKey),
    };
    let res;
    try {
      res = await request("GET", url, null, headers);
    } catch (err) {
      console.log("[" + tick(false) + "] GET " + url + "  " + err.message + "\n");
      process.exit(1);
    }
    const signedOk = res.status !== 400 && res.status !== 401;
    show("GET " + url, res);
    console.log(
      signedOk
        ? "The gateway ACCEPTED the signature. Anything above 2xx is entitlement, not auth."
        : "The gateway REJECTED the request before it got to the resource — auth problem."
    );
    process.exit(res.status >= 200 && res.status < 300 ? 0 : signedOk ? 0 : 1);
  }

  const wantIccp = !has("--cen");
  const wantCen = !has("--iccp");
  let ok = true;

  if (wantIccp) {
    const url = ICCP_FINANCIAL;
    const headers = {
      "Content-Type": "text/xml",
      Accept: "text/xml",
      "X-B3-TraceId": crypto.randomUUID(),
      Authorization: authHeader("POST", url, GET_DATA_SOURCES, pem, consumerKey),
      "Content-Length": Buffer.byteLength(GET_DATA_SOURCES),
    };
    try {
      ok = show("ICCP  getDataSources", await request("POST", url, GET_DATA_SOURCES, headers)) && ok;
    } catch (err) {
      console.log("[" + tick(false) + "] ICCP  getDataSources  " + err.message + "\n");
      ok = false;
    }
  }

  if (wantCen) {
    const url = CEN_FIELDMAPPINGS;
    const headers = {
      Accept: "application/json",
      "X-B3-TraceId": crypto.randomUUID(),
      Authorization: authHeader("GET", url, null, pem, consumerKey),
    };
    try {
      ok = show("CEN   fieldmappings ", await request("GET", url, null, headers)) && ok;
    } catch (err) {
      console.log("[" + tick(false) + "] CEN   fieldmappings  " + err.message + "\n");
      ok = false;
    }
  }

  const ran = (wantIccp ? 1 : 0) + (wantCen ? 1 : 0);
  console.log(
    ok
      ? ran === 1
        ? "That call answered."
        : "Both calls answered."
      : "Something did not answer — see above."
  );
  process.exit(ok ? 0 : 1);
}

module.exports = { pct, signatureBaseString, authHeader };

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

"use strict";

/**
 * The Mastercard gateway will not tell us why a signature is wrong — it says
 * 401 and stops. So the base string, which is the only part we can get wrong
 * silently, is checked here against RFC 5849 §3.4.1.1, the worked example the
 * whole OAuth 1.0a world is built on.
 *
 * The RFC example includes two form-body parameters (c2 and a3=2 q). We do not
 * sign form bodies — Mastercard hashes the body into oauth_body_hash instead —
 * so those two are dropped from the expected string and nothing else is.
 */

const assert = require("assert");
const crypto = require("crypto");
const { pct, signatureBaseString, authHeader } = require("../tools/mastercard-ping");

let n = 0;
const check = (what, fn) => {
  fn();
  n++;
  console.log("  ok  " + what);
};

/* -------------------------------------------------------------- pct() */

check("pct leaves the unreserved set alone", () => {
  assert.strictEqual(pct("aZ09-._~"), "aZ09-._~");
});

check("pct escapes what encodeURIComponent forgets", () => {
  // encodeURIComponent passes these through; OAuth requires them escaped.
  assert.strictEqual(pct("!*'()"), "%21%2A%27%28%29");
});

check("pct escapes a space as %20, never as +", () => {
  assert.strictEqual(pct("r b"), "r%20b");
});

/* ------------------------------------------------- RFC 5849 base string */

const RFC_URL = "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b";
const RFC_OAUTH = {
  oauth_consumer_key: "9djdj82h48djs9d2",
  oauth_token: "kkk9d7dh3k39sjv7",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "137131201",
  oauth_nonce: "7d8f3e4a",
};

const RFC_EXPECTED =
  "POST&http%3A%2F%2Fexample.com%2Frequest&" +
  "a2%3Dr%2520b%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26" +
  "oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26" +
  "oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26" +
  "oauth_token%3Dkkk9d7dh3k39sjv7";

check("base string matches RFC 5849 §3.4.1.1", () => {
  assert.strictEqual(signatureBaseString("POST", RFC_URL, RFC_OAUTH), RFC_EXPECTED);
});

check("the query string is sorted, not left in URL order", () => {
  const base = signatureBaseString("POST", RFC_URL, RFC_OAUTH);
  const params = decodeURIComponent(base.split("&").slice(2).join("&"));
  const keys = params.split("&").map((p) => p.split("=")[0]);
  assert.deepStrictEqual(keys, [...keys].sort(), "params came out unsorted: " + keys.join(","));
});

check("method is upper-cased", () => {
  assert.ok(signatureBaseString("post", RFC_URL, RFC_OAUTH).startsWith("POST&"));
});

check("oauth_signature is excluded from its own base string", () => {
  const withSig = { ...RFC_OAUTH, oauth_signature: "SHOULD-NOT-APPEAR" };
  const base = signatureBaseString("POST", RFC_URL, withSig);
  assert.ok(!/SHOULD-NOT-APPEAR/.test(base), "the signature signed itself");
  assert.strictEqual(base, RFC_EXPECTED);
});

check("the query string is not carried into the URL half", () => {
  const base = signatureBaseString("POST", RFC_URL, RFC_OAUTH);
  assert.strictEqual(base.split("&")[1], "http%3A%2F%2Fexample.com%2Frequest");
});

/* ------------------------------------------------------ a real signature */

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });

const parseHeader = (h) => {
  assert.ok(h.startsWith("OAuth "), "header does not start with OAuth: " + h.slice(0, 20));
  const out = {};
  for (const part of h.slice(6).split(",")) {
    const eq = part.indexOf("=");
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
      part.slice(eq + 1).replace(/^"|"$/g, "")
    );
  }
  return out;
};

const URL_ICCP = "https://sandbox.api.mastercard.com/iccp/financial";
const BODY = "<soapenv:Envelope><soapenv:Body/></soapenv:Envelope>";

check("the header carries every parameter the gateway looks for", () => {
  const p = parseHeader(authHeader("POST", URL_ICCP, BODY, PEM, "consumer-key"));
  for (const k of [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature",
    "oauth_signature_method",
    "oauth_timestamp",
    "oauth_version",
    "oauth_body_hash",
  ]) {
    assert.ok(p[k], "missing " + k);
  }
  assert.strictEqual(p.oauth_signature_method, "RSA-SHA256");
  assert.strictEqual(p.oauth_version, "1.0");
  assert.strictEqual(p.oauth_consumer_key, "consumer-key");
});

check("oauth_body_hash is sha256 of the body, base64", () => {
  const p = parseHeader(authHeader("POST", URL_ICCP, BODY, PEM, "ck"));
  assert.strictEqual(
    p.oauth_body_hash,
    crypto.createHash("sha256").update(BODY, "utf8").digest("base64")
  );
});

check("a bodyless GET carries no oauth_body_hash", () => {
  const p = parseHeader(authHeader("GET", URL_ICCP, null, PEM, "ck"));
  assert.strictEqual(p.oauth_body_hash, undefined);
});

check("the signature verifies against the base string it claims to sign", () => {
  const header = authHeader("POST", URL_ICCP, BODY, PEM, "ck");
  const p = parseHeader(header);
  const rebuilt = { ...p };
  delete rebuilt.oauth_signature;
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(signatureBaseString("POST", URL_ICCP, rebuilt), "utf8")
    .verify(publicKey, p.oauth_signature, "base64");
  assert.ok(ok, "the signature does not verify — the gateway would answer 401");
});

check("two calls do not reuse a nonce", () => {
  const a = parseHeader(authHeader("GET", URL_ICCP, null, PEM, "ck")).oauth_nonce;
  const b = parseHeader(authHeader("GET", URL_ICCP, null, PEM, "ck")).oauth_nonce;
  assert.notStrictEqual(a, b);
});

check("oauth_timestamp is seconds, not milliseconds", () => {
  const t = Number(parseHeader(authHeader("GET", URL_ICCP, null, PEM, "ck")).oauth_timestamp);
  assert.ok(Math.abs(t - Date.now() / 1000) < 5, "timestamp is " + t + " — wrong unit?");
});

/* ---------------------------------------------------- the CLAUDE.md §4 guard */

// The guard lives in a process that calls process.exit, so drive the real CLI.
const { spawnSync } = require("child_process");
const path = require("path");
const CLI = path.join(__dirname, "..", "tools", "mastercard-ping.js");

const runCli = (args) =>
  spawnSync(process.execPath, [CLI].concat(args), {
    encoding: "utf8",
    input: "",
    env: { ...process.env, MC_CONSUMER_KEY: "x", MC_KEY_PASSWORD: "y" },
  });

for (const [label, url] of [
  ["Automatic Billing Updater", "https://sandbox.api.mastercard.com/billing-updater/v1/accounts"],
  ["the /abu short path", "https://sandbox.api.mastercard.com/abu/v1/x"],
  ["Account Catalog", "https://sandbox.api.mastercard.com/account-catalog/v1/x"],
  ["an ICCP purchase request", "https://sandbox.api.mastercard.com/iccp/purchaserequest"],
]) {
  check("--url refuses " + label, () => {
    const r = runCli(["--url", url]);
    assert.strictEqual(r.status, 3, "expected exit 3, got " + r.status + "\n" + r.stdout + r.stderr);
    assert.ok(/CLAUDE.md §4/.test(r.stderr), "the refusal did not cite the rule");
  });
}

check("the refusal happens before any password is asked for", () => {
  // No MC_KEY_PASSWORD, no terminal: if the guard ran late this would die on
  // the key instead, with a different exit code and a different message.
  const r = spawnSync(
    process.execPath,
    [CLI, "--url", "https://sandbox.api.mastercard.com/abu/v1/x"],
    { encoding: "utf8", input: "", env: { ...process.env, MC_KEY_PASSWORD: "", MC_CONSUMER_KEY: "" } }
  );
  assert.strictEqual(r.status, 3, "guard did not run first — exit was " + r.status);
  assert.ok(!/openssl/.test(r.stderr), "it reached the keystore before refusing");
});

check("the summary line counts what actually ran", () => {
  // --iccp runs one call. Saying "Both calls answered" after one is the kind of
  // small lie that makes a passing run untrustworthy.
  const src = require("fs").readFileSync(CLI, "utf8");
  assert.ok(
    /ran === 1[\s\S]{0,80}That call answered/.test(src),
    "the single-call path does not have its own summary line"
  );
});

check("a harmless URL is not refused", () => {
  const r = runCli(["--url", "https://sandbox.api.mastercard.com/iccp/financial"]);
  assert.notStrictEqual(r.status, 3, "refused an endpoint that returns no card data");
});

console.log("\n" + n + " assertions passed.");

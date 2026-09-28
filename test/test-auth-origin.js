/* Two things that both look like "sign-in is broken" and are not:

   1. localhost:3000 and 127.0.0.1:3000 are the same machine and different
      cookie origins. Sign in on one while the redirect URI names the other and
      the session is dropped on the way back, silently, with no error anywhere.

   The reconciliation agent has the same shape, and the same trap. */

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n        " + e.message); }
}

const auth = require("../azure-auth.js");
const go = (host, url) => auth.canonicalRedirect({ headers: { host }, originalUrl: url });

console.log("\nOne origin for sign-in\n");

/* ── the origins ────────────────────────────────────────────────────────── */

check("127.0.0.1 is sent to the origin the redirect URI names", () => {
  const to = go("127.0.0.1:3000", "/auth/login");
  if (!to) throw new Error("stayed put — the cookie will be set on the wrong origin");
  if (!/^http:\/\/localhost:3000\/auth\/login$/.test(to)) throw new Error("went to " + to);
});

check("the canonical origin is left alone — no redirect loop", () => {
  if (go("localhost:3000", "/auth/login")) throw new Error("bounced a request that was already right");
});

check("case in the host header is not a reason to bounce", () => {
  if (go("LOCALHOST:3000", "/auth/login")) throw new Error("bounced on capitalisation alone");
});

check("A HOST HEADER CANNOT REWRITE WHERE PEOPLE ARE SENT", () => {
  // The risk in honouring Host at all: an attacker-set header turning this into
  // an open redirect. The destination is built from REDIRECT_URI and never from
  // the header, so this holds by construction — the check is here so a later
  // edit that interpolates the header cannot land quietly.
  for (const evil of ["evil.example.com", "localhost.evil.com", "127.0.0.1.evil.com:3000"]) {
    const to = go(evil, "/auth/login");
    if (to && !/^http:\/\/localhost:3000\//.test(to)) throw new Error(evil + " reached " + to);
  }
});

check("A REAL HOSTNAME IS NEVER BOUNCED TO LOOPBACK", () => {
  /* What the loopback-only guard actually protects. Deployed behind a proxy the
     Host is a real name; if REDIRECT_URI still said localhost, bouncing people
     there sends every user to a machine that is not the server. Rewriting only
     between spellings of loopback means a misconfigured REDIRECT_URI is a
     sign-in failure with a message, not a browser pointed at nothing. */
  for (const real of ["assistant.raa.com.au", "assistant.raa.com.au:3000", "10.0.0.4:3000"]) {
    const to = go(real, "/auth/login");
    if (to) throw new Error(real + " was bounced to " + to);
  }
});

check("a different port is a different service, not our business", () => {
  if (go("127.0.0.1:9999", "/auth/login")) throw new Error("bounced traffic for another port");
});

check("the path being asked for survives the bounce", () => {
  const to = go("127.0.0.1:3000", "/auth/login?rd=%2Faudit");
  if (!/\/auth\/login\?rd=%2Faudit$/.test(to)) throw new Error("lost the query: " + to);
});

check("a missing or junk host header does not throw", () => {
  auth.canonicalRedirect({ headers: {} });
  auth.canonicalRedirect({});
});

/* ── the route actually calls it ────────────────────────────────────────── */

/* Everything above tests canonicalRedirect() as a function. Delete the two
   lines that call it from /auth/login and all of it still passes while the bug
   is entirely back. So: boot the app and knock on the door. */
const http = require("http");

function loginFrom(host) {
  for (const k of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
                   "AZURE_REDIRECT_URI", "SESSION_SECRET"]) delete process.env[k];
  Object.assign(process.env, {
    AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s",
    AZURE_REDIRECT_URI: "http://localhost:3000/auth/callback",
    SESSION_SECRET: "x".repeat(32),
  });
  for (const k of Object.keys(require.cache)) {
    if (/azure-auth|express-session/.test(k)) delete require.cache[k];
  }
  const app = require("express")();
  require("../azure-auth.js").install(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const req = http.get({ port: srv.address().port, path: "/auth/login", headers: { host } },
        (res) => { srv.close(); resolve({ status: res.statusCode, location: res.headers.location || "" }); });
      req.on("error", (e) => { srv.close(); reject(e); });
      req.setTimeout(4000, () => req.destroy(new Error("timed out")));
    });
  });
}

(async () => {
  try {
    const r = await loginFrom("127.0.0.1:3000");
    if (r.status !== 302) throw new Error("expected a redirect, got " + r.status);
    if (!/^http:\/\/localhost:3000\/auth\/login/.test(r.location)) {
      throw new Error("went to " + r.location + " — the route never calls canonicalRedirect");
    }
    console.log("  ok  /AUTH/LOGIN ITSELF BOUNCES 127.0.0.1 — not just the helper");
  } catch (e) {
    failures++;
    console.log("  FAIL /auth/login itself bounces 127.0.0.1\n        " + e.message);
  }

  try {
    const r = await loginFrom("localhost:3000");
    // Already right: it must go on to Microsoft, not loop back to itself.
    if (/^http:\/\/localhost:3000\/auth\/login/.test(r.location)) {
      throw new Error("redirected to itself — an infinite loop");
    }
    console.log("  ok  ...and does not bounce the origin that is already correct");
  } catch (e) {
    failures++;
    console.log("  FAIL /auth/login does not loop on the correct origin\n        " + e.message);
  }

  console.log("\n  " + (failures ? failures + " FAILED" : "10 checks passed") + "\n");
  process.exit(failures ? 1 : 0);
})();

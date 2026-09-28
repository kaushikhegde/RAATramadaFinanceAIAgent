/**
 * azure-auth.js — who is using this app, according to Entra.
 *
 * The app had no login at all: anything that reached port 3000 could upload a
 * report and file real receipts, and the only thing between the internet and
 * that was the loopback bind in docker-compose.yml. This adds the front door.
 *
 * OpenID Connect authorization-code flow with PKCE, via msal-node. No implicit
 * grant, no tokens in the browser: the ID token is exchanged server-side and
 * only ever lives in the session.
 *
 * ── Not configured is not an error ───────────────────────────────────────────
 *
 * With no AZURE_CLIENT_ID, `enabled()` is false, `requireAuth` waves everything
 * through and the app behaves exactly as it did before — which is what keeps a
 * local `npm start`, the offline tests and `npm run shots` working without an
 * Azure tenant. It also means MISCONFIGURING Azure silently disables the login,
 * so the banner in server.js says out loud which of the two it is.
 *
 * ── The WebSocket is a door too ──────────────────────────────────────────────
 *
 * Gating the HTTP routes and not /ws would have achieved nothing: the socket is
 * where `recon_run` arrives, and that is the frame that files receipts. Uploads,
 * runs and the whole run history hang off it. So the upgrade is authenticated
 * with the same session cookie, before the socket exists — see `userForUpgrade`.
 */

const path = require("path");

const TENANT_ID = process.env.AZURE_TENANT_ID || "";
const CLIENT_ID = process.env.AZURE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.AZURE_REDIRECT_URI || "http://localhost:3000/auth/callback";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

/* All four, not any: a half-filled .env is the state this is most likely to be
   in, and starting up "logged in as nobody" with three of the four present is
   the failure that looks like success. */
const enabled = () => !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET);

/* Reported by server.js on startup so a broken config cannot look like a
   deliberate one. */
function configProblem() {
  if (enabled()) return null;
  const present = [
    TENANT_ID && "AZURE_TENANT_ID", CLIENT_ID && "AZURE_CLIENT_ID", CLIENT_SECRET && "AZURE_CLIENT_SECRET",
  ].filter(Boolean);
  if (!present.length) return null;                 // deliberately off
  return `${present.join(", ")} set but not the rest — sign-in is OFF. See docs/azure-setup.md §9.`;
}

let _msal = null;
function msal() {
  if (_msal) return _msal;
  const { ConfidentialClientApplication } = require("@azure/msal-node");
  _msal = new ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
      clientSecret: CLIENT_SECRET,
    },
  });
  return _msal;
}

/* openid/profile/email only. This app reads a name and an address off the ID
   token and calls no Microsoft API, so asking for Graph scopes would put a
   consent prompt in front of every user for access nothing uses. */
const SCOPES = ["openid", "profile", "email"];

/**
 * The signed-in person, or null.
 *
 * THE ONE CALLER THAT MATTERS is the Key Vault lookup: the email returned here
 * came out of an ID token Entra signed and msal verified, and is the only email
 * allowed to choose which secret gets fetched. Anything read off a request body
 * is a user naming a colleague's password.
 */
function userFromSession(session) {
  return (session && session.user) || null;
}

let _sessionMiddleware = null;

/**
 * Session + auth routes onto the express app. Call before the static handler,
 * or the login page is served to people who are already signed in.
 */
/* RAA Logging and Monitoring Standard v1.1 §3.1.3 — "Log on, log off." and
   "Failed logon attempts." are the first two rows of the Account Usage
   Information table, and this file is the only place either can be observed.

   `req.audit` is installed by server.js and carries the request's address, URL
   and method (§3.1.1). The fallback matters: this module is required by the
   offline suite and by tools, where no middleware has run, and a sign-in event
   lost because a helper was missing is the event you most wanted. */
function say(req, name, fields) {
  try {
    if (req && typeof req.audit === "function") return req.audit(name, fields);
    return require("./audit").record(name, fields);
  } catch (_) { /* never let logging break a sign-in */ }
}

/* localhost and 127.0.0.1 are the same machine and DIFFERENT COOKIE ORIGINS.
   A session cookie set while being sent back to localhost:3001 is invisible to
   a tab sitting on 127.0.0.1:3001, so sign-in "works", lands, and drops you
   back at the login page with nothing to show for it. There is no error
   anywhere: each half did its job.

   Rather than make people memorise which spelling is the blessed one, send
   them to it. Returns the URL to bounce to, or null when we are already on the
   right origin. Only the HOST is compared -- the port is part of the host
   header, and the scheme is not ours to change behind a proxy. */
function canonicalRedirect(req) {
  let want;
  try { want = new URL(REDIRECT_URI); } catch (_) { return null; }
  const have = String((req.headers && req.headers.host) || "");
  if (!have || have.toLowerCase() === want.host.toLowerCase()) return null;
  /* Only between spellings of this machine. Honouring the Host header in
     general would let any host header rewrite where people are sent, which is
     an open redirect with extra steps. */
  const local = (h) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(h);
  if (!local(have) || !local(want.host)) return null;
  /* Same port, or this is a different service and not our business. */
  const port = (h) => (h.split(":")[1] || "");
  if (port(have) !== port(want.host)) return null;
  return `${want.protocol}//${want.host}${req.originalUrl || req.url}`;
}

function install(app) {
  const session = require("express-session");

  if (enabled() && !SESSION_SECRET) {
    // Not a warning. An unset secret means express-session signs cookies with a
    // predictable value, and a forgeable session cookie on this app is a forged
    // identity on a finance system.
    throw new Error("SESSION_SECRET must be set when Entra sign-in is enabled (see docs/azure-setup.md §9).");
  }

  _sessionMiddleware = session({
    name: "recon.sid",
    secret: SESSION_SECRET || "dev-only-not-a-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,                                   // no script can read it
      sameSite: "lax",                                  // survives the Entra redirect back
      // Only over HTTPS in production. Left off for localhost, where the whole
      // point of the http:// redirect exception is that there is no TLS.
      secure: /^https:/i.test(REDIRECT_URI),
      maxAge: 8 * 60 * 60 * 1000,                       // a working day
    },
  });
  app.use(_sessionMiddleware);

  if (!enabled()) {
    /* Sign-in is off in THIS process. Answering /auth/* with nothing makes that
       state indistinguishable from a stale image, a second app on the port, or
       a typo in the route — the same bare 404 for all four. So say which it is.

       It matters most for the callback: by then Microsoft has already issued a
       code, so the registration and the secret are provably fine and the only
       thing wrong is the process that got the redirect. A 404 there sends you
       back to re-check Azure, which is the one place that is working. */
    const missing = [
      !TENANT_ID && "AZURE_TENANT_ID", !CLIENT_ID && "AZURE_CLIENT_ID",
      !CLIENT_SECRET && "AZURE_CLIENT_SECRET",
    ].filter(Boolean);
    const why =
      `<h3>Entra sign-in is not configured in this process</h3>` +
      `<p>Missing: <code>${missing.map(escapeHtml).join("</code>, <code>")}</code></p>` +
      `<p>The app is running, so these never reached it. Most often the process ` +
      `is older than the config, or is not the one you think it is:</p>` +
      `<ul><li>Docker reuses a built image — <code>docker compose up --build</code>, ` +
      `then <code>docker compose exec recon env | grep AZURE_</code> to see what it got.</li>` +
      `<li><code>.dockerignore</code> keeps <code>.env</code> out of the image on purpose; ` +
      `compose forwards it instead, so it must sit beside docker-compose.yml.</li>` +
      `<li>Something else may hold this port. A 404 shaped like JSON is not this app.</li></ul>` +
      `<p>See docs/azure-setup.md.</p>`;

    // 503, not 404: the route exists and the app is the right one. It cannot
    // serve this yet. A 404 says "no such thing here" and sends you looking in
    // Azure; this says "wrong process" and sends you to the process.
    for (const route of ["/auth/login", "/auth/callback"]) {
      app.get(route, (req, res) => {
        say(req, "signin.failure", { outcome: "failure", detail: `sign-in not configured: missing ${missing.join(", ")}` });
        res.status(503).type("html").send(why);
      });
    }
    return;
  }

  app.get("/auth/login", async (req, res) => {
    /* Before anything is signed or staged: if this tab is on the other
       spelling of localhost, move it. Doing it here rather than after the
       callback matters -- the pkce verifier and the CSRF state below are
       written into the session, and a session started on the wrong origin is
       thrown away by the browser on the way back. */
    const elsewhere = canonicalRedirect(req);
    if (elsewhere) return res.redirect(elsewhere);
    try {
      const { CryptoProvider } = require("@azure/msal-node");
      const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
      req.session.pkce = verifier;
      /* CSRF on the callback. Without it, a link can drive somebody's browser
         through a login they did not start and land them in a session that is
         not theirs. Checked, then thrown away, in the callback. */
      req.session.state = require("crypto").randomBytes(16).toString("hex");
      const url = await msal().getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        state: req.session.state,
      });
      res.redirect(url);
    } catch (err) {
      say(req, "signin.failure", { outcome: "failure", target: "Microsoft Entra ID",
        stage: "authorization request", reason: err.message });
      res.status(500).send(`Could not start sign-in: ${err.message}`);
    }
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      if (!req.query.code) throw new Error(String(req.query.error_description || "no authorization code came back"));
      if (!req.session.state || req.query.state !== req.session.state) {
        throw new Error("this sign-in did not start here — try again from the login page");
      }
      const result = await msal().acquireTokenByCode({
        code: String(req.query.code),
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        codeVerifier: req.session.pkce,
      });
      const claims = result.idTokenClaims || {};
      /* `preferred_username` is the address people recognise as theirs and the
         one the vault is keyed on. `email` and `upn` are fallbacks — which of
         the three is populated varies by how the tenant was set up, and an
         account with none of them cannot be matched to credentials at all. */
      const email = String(claims.preferred_username || claims.email || claims.upn || "").trim().toLowerCase();
      if (!email) throw new Error("that account has no email address on it, so its Tramada credentials cannot be found");

      // New session id on privilege change — otherwise a session id handed to
      // somebody before they signed in still works afterwards.
      const pkceDone = () => { delete req.session.pkce; delete req.session.state; };
      req.session.regenerate((err) => {
        if (err) return res.status(500).send(`Could not start your session: ${err.message}`);
        req.session.user = { email, name: claims.name || email };
        pkceDone();
        /* AFTER regenerate, so the id in the log is the id the person will
           carry. Logged before the redirect rather than after, because the
           redirect is the last thing this handler controls. */
        say(req, "signin.success", { user: email, target: "Microsoft Entra ID",
          sessionId: req.sessionID });
        req.session.save(() => res.redirect("/"));
      });
    } catch (err) {
      /* The reason is kept. "Failed logon attempts" as a count answers nothing:
         a bad state parameter is somebody being walked through a sign-in they
         did not start, and an account with no email is a tenant misconfigured.
         Those are two different pages of the incident report. */
      say(req, "signin.failure", { outcome: "failure", target: "Microsoft Entra ID",
        stage: "authorization callback", reason: err.message });
      res.status(401).send(
        `<h3>Sign-in failed</h3><p>${escapeHtml(err.message)}</p><p><a href="/auth/login">Try again</a></p>`
      );
    }
  });

  app.post("/auth/logout", (req, res) => {
    // BEFORE destroy — afterwards there is no session to read the account off,
    // and a logout event that cannot name who logged out is not one.
    say(req, "signout", { target: "Microsoft Entra ID", sessionId: req.sessionID });
    req.session.destroy(() => {
      /* Ends the session HERE and at Entra. Dropping only ours would leave the
         next click on "sign in" going straight back through without a prompt,
         which on a shared machine is not a logout at all. */
      const back = encodeURIComponent(new URL("/", REDIRECT_URI).toString());
      res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${back}`);
    });
  });
}

/** Everything except the login page and the auth routes needs a session. */
function requireAuth(req, res, next) {
  if (!enabled()) return next();
  if (userFromSession(req.session)) return next();
  /* §3.1.3's "Failed logon attempts" row, read the way a reviewer reads it:
     who is reaching this app without a session, and for what. A bounce to the
     login page is normal traffic; an unauthenticated POST to a run endpoint is
     not, and only the log can tell them apart afterwards. */
  say(req, "access.denied", { outcome: "failure", target: req.path });
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not signed in" });
  /* To OUR page, not straight to Microsoft. A bounce to login.microsoftonline.com
     from a bare URL gives no clue what asked for the sign-in, which is exactly
     the shape of a phishing redirect — and it strands anyone whose tenant is
     misconfigured on a Microsoft error page with no way back here. */
  res.redirect("/login");
}

/**
 * The signed-in person behind a WebSocket upgrade, or null.
 *
 * The upgrade is a plain HTTP request that never reaches the express stack, so
 * the session middleware is run against it by hand. It only needs the cookie
 * header and somewhere to write, which is why the throwaway response object is
 * enough.
 */
function userForUpgrade(req) {
  if (!enabled()) return { email: "", name: "local" };   // no Entra — same as before
  if (!_sessionMiddleware) return null;
  return new Promise((resolve) => {
    _sessionMiddleware(req, {}, () => resolve(userFromSession(req.session)));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

module.exports = { enabled, configProblem, install, requireAuth, userFromSession, userForUpgrade, canonicalRedirect, REDIRECT_URI };

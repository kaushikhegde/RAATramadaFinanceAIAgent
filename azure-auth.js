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

  if (!enabled()) return;

  app.get("/auth/login", async (req, res) => {
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
        req.session.save(() => res.redirect("/"));
      });
    } catch (err) {
      res.status(401).send(
        `<h3>Sign-in failed</h3><p>${escapeHtml(err.message)}</p><p><a href="/auth/login">Try again</a></p>`
      );
    }
  });

  app.post("/auth/logout", (req, res) => {
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

module.exports = { enabled, configProblem, install, requireAuth, userFromSession, userForUpgrade, REDIRECT_URI };

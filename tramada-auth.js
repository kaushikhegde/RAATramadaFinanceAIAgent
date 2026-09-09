/**
 * tramada-auth.js — getting the shared browser signed into Tramada, once.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * There were FIVE copies of `ensureLoggedIn` — recon-run.js, tramada-ipsi.js,
 * tramada-receipt.js, tramada-segments.js, tramada-payment.js — and they drifted.
 * When recon-run.js gained the paired onLoginOk callback the others did not, so
 * an IPSI run put a login screen on the page and never took it down;
 * `test/test-login-frames.js` was written to catch that class of bug by scanning
 * five files for a matching pair.
 *
 * Per-user credentials made five copies untenable rather than merely untidy. The
 * identity rule below decides which human a receipt gets filed as, and a copy of
 * it that drifts is a copy that files money under the wrong name. So the three
 * reachable copies are now this one function. (segments and payment keep theirs;
 * nothing requires them, so they can never reach a page — left alone deliberately
 * rather than by oversight, same as the old test said.)
 *
 * ── The identity rule ────────────────────────────────────────────────────────
 *
 * One container, one Chromium, ONE Chrome profile — so one Tramada session,
 * shared by everyone who uses this app. With per-user credentials that is a
 * money bug waiting to happen: Tim runs a reconciliation, finishes, and an hour
 * later Sarah signs in. `tramadaIsAuthed` says "somebody is signed in", the run
 * carries on, and SARAH'S receipts are filed into Tramada AS TIM. Nothing looks
 * wrong at any point — her credentials are simply never used.
 *
 * So the question asked here is not "is anyone signed in" but "is THIS person
 * signed in". If the answer is no, or unknown, the session is torn down and
 * rebuilt. Costing a login is the cheap side of that trade.
 *
 * ── What is NOT known ────────────────────────────────────────────────────────
 *
 * Nobody has captured the screen where Tramada shows who is signed in, so the
 * answer above is remembered HERE, in this process, rather than read from the
 * page. That is why a fresh process treats a warm profile as unknown and signs
 * out: it is the conservative reading, and the only safe one.
 *
 * It also leaves one gap that memory cannot close — if the app fills Tim's
 * username, Tramada asks for a code, and the person at the noVNC screen signs in
 * as somebody else entirely, this believes it is Tim. Closing that needs the
 * signed-in-user element off a real Tramada page; capture it and check it here
 * (CLAUDE.md §6 — discover, don't hard-code).
 */

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Who this browser's Tramada session belongs to, as an email, or null for
   "nobody, or we do not know". Deliberately module state and not per-run: the
   thing it describes is the shared Chrome profile, which outlives every run and
   every socket. null is the safe value — it forces a sign-out. */
let _signedInAs = null;

/** Test seam, and for a caller that knows the session is gone. */
function forgetSession() { _signedInAs = null; }
function signedInAs() { return _signedInAs; }

async function tramadaIsAuthed(page) {
  await page.goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" }).catch(() => {});
  // The URL alone is not the answer. Measured 25-08-2026: signed OUT, this
  // instance serves the LOGIN FORM at the protected .../home/home.htm URL — no
  // redirect to login.htm, the address bar stays put. A url-only check reads
  // that as signed in, ensureLoggedIn returns, and every row of the run then
  // fails while nobody is ever asked to sign in. Seen twice, on two different
  // pages: 17-Aug-2026 an expired session served the login form at
  // `booking-search.htm` with the address bar unchanged, and every row failed
  // with "could not be opened" while nothing ever asked the human to sign in.
  // So the presence of a password field is the answer.
  if (page.url().includes("login.htm")) return false;
  const showingLogin = await page
    .evaluate(() => !!document.querySelector("input[type=password], #loginForm_login"))
    .catch(() => false);
  return !showingLogin;
}

/* The same question as tramadaIsAuthed, asked WITHOUT touching the page.
   tramadaIsAuthed NAVIGATES, and the wait loop below asks every three seconds —
   on the very tab the human is typing their password into. Every ask reloaded
   the login form and wiped both fields, so on the noVNC screen the login page
   appeared to reload forever and there was no way to sign in at all. It went
   unnoticed while the workflow was "sign in first, then start a run"; it became
   the only path the moment the app started showing the login screen itself.

   This shares the browser's cookie jar, so it sees the same session no matter
   which tab the login happened in, and it never navigates anything. */
async function tramadaIsAuthedQuietly(page) {
  try {
    const res = await page.request.get(`${TRAMADA_BASE_URL}/home/home.htm`, { timeout: 15000 });
    // The URL is not the answer here either — signed out, this GET comes back
    // 200 with the address unchanged and the login form in the body. Read the
    // BODY the way tramadaIsAuthed reads the DOM.
    if (res.url().includes("login.htm")) return false;
    const body = await res.text();
    const showingLogin =
      /type=["']?password|name=["']?password|loginForm_login|action=["'][^"']*login\.htm/i.test(body);
    return !showingLogin;
  } catch {
    // A probe that could not run has not proved anything — least of all that
    // somebody is signed in (CLAUDE.md §6).
    return false;
  }
}

/**
 * End whoever's session this is, and PROVE it ended.
 *
 * Two ways, because only the first is polite and neither is guaranteed. The
 * logout route is a guess — it has never been captured off a real page — so it
 * is tried, verified, and abandoned quietly if it did nothing. Clearing the
 * cookie jar is the one that cannot fail to work, and costs the "remember this
 * device" cookie with everything else, which means Tramada asks for a code
 * again. That is a worse morning for one person, not a wrong name on a receipt.
 *
 * If BOTH fail we refuse to carry on. A run that cannot establish whose session
 * it is holding must not file anything: §3 says stop and ask rather than guess,
 * and the thing being guessed at here is whose name goes on the money.
 */
async function signOut(page, say) {
  say("Signing the shared browser out of Tramada first...");
  await page.goto(`${TRAMADA_BASE_URL}/logout.htm`, { waitUntil: "domcontentloaded" }).catch(() => {});
  if (!(await tramadaIsAuthed(page))) { _signedInAs = null; return; }

  await page.context().clearCookies().catch(() => {});
  if (!(await tramadaIsAuthed(page))) { _signedInAs = null; return; }

  throw new Error(
    "Could not sign the shared browser out of Tramada, so it cannot be established " +
    "whose session it is. Refusing to file anything under a name that may not be " +
    "the right one — sign out by hand on the login screen and start the run again."
  );
}

/**
 * Make sure this page is signed into Tramada as the right person.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {{username, password, forEmail}} [opts.auth]  From the vault, via
 *        `tramada-creds.credentialsFor`. Absent means nobody has credentials
 *        stored and a human signs in — how this app worked before Entra.
 * @param {(reason: "signin"|"otp") => void} [opts.onNeedLogin]  Put the noVNC
 *        screen up. "otp" means credentials were accepted as far as we can tell
 *        and Tramada wants something more.
 * @param {() => void} [opts.onLoginOk]  Take it down again. Paired — never
 *        fired unless onNeedLogin was.
 * @param {(msg: string) => void} [opts.onProgress]
 */
async function ensureLoggedIn(page, opts = {}) {
  const { auth = null, onNeedLogin, onLoginOk } = opts;
  const say = opts.onProgress || (() => {});
  const wantUser = auth && auth.forEmail ? String(auth.forEmail).toLowerCase() : null;

  if (await tramadaIsAuthed(page)) {
    // Nobody has per-user credentials — any signed-in session will do, which is
    // the pre-Entra behaviour and still how a local `npm start` runs.
    if (!wantUser) return;
    if (_signedInAs === wantUser) return;
    /* Either somebody else's session, or this process has just started and
       inherited a warm profile it knows nothing about. Both are "not provably
       theirs", and both are handled the same way on purpose — see the identity
       rule at the top. */
    say(_signedInAs
      ? `The browser is signed into Tramada as ${_signedInAs}, not ${wantUser}.`
      : "The browser has a Tramada session from before this run, and whose it is cannot be read back.");
    await signOut(page, say);
  }

  /* ── sign in with what the vault gave us ──────────────────────────────── */
  if (auth && auth.username && auth.password) {
    say(`Signing into Tramada as ${wantUser}...`);
    await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
    await page.fill("#username", auth.username);
    await page.fill("#loginForm_password", auth.password);
    await page.click("#loginForm_login");
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 }).catch(() => {});

    /* Assert, don't assume (§3). Leaving login.htm is not proof: this instance
       serves the login form from protected URLs too, so the address bar can
       move while the session did not. Ask the DOM. */
    if (await tramadaIsAuthed(page)) {
      _signedInAs = wantUser;
      say("Signed into Tramada.");
      return;                     // nobody was asked anything — no callbacks
    }

    /* Still not in. This is the OTP case, and also the expired-password case,
       the locked-account case and the Tramada-changed-its-login case — and we
       deliberately do not try to tell them apart. Nobody has ever captured
       Tramada's verification-code screen, so any selector for it would be a
       guess, and a guess here shows the wrong thing to somebody waiting.
       Handing all four to the human on the noVNC screen is correct for all
       four, and degrades to exactly what this app did before. */
    say("Tramada wants something more than a password — over to you.");
    return waitForHuman(page, { reason: "otp", wantUser, onNeedLogin, onLoginOk });
  }

  /* ── no credentials — a human signs in, as it always did ──────────────── */
  return waitForHuman(page, { reason: "signin", wantUser: null, onNeedLogin, onLoginOk });
}

/**
 * Put the login screen up and wait, up to five minutes.
 *
 * `wantUser` is what we record as the session's owner if this succeeds — set
 * when we already filled that person's username and Tramada only wanted a code,
 * and NULL when the human signed in from a blank form. Null is not laziness: if
 * nobody typed a username on our behalf we genuinely do not know who arrived,
 * and recording a guess would defeat the identity check on the next run.
 */
async function waitForHuman(page, { reason, wantUser, onNeedLogin, onLoginOk }) {
  if (typeof onNeedLogin === "function") onNeedLogin(reason);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await tramadaIsAuthedQuietly(page))) continue;
    /* Signed in. The run's own tab is still sitting on the login form, so put
       it on a real page before carrying on — and confirm THERE, because the
       probe proves the session is good, not that this tab is usable. This is
       the only navigation in the whole wait, and it happens after the human has
       finished, so it cannot eat anything they were typing. */
    await page.goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (page.url().includes("login.htm")) continue;
    _signedInAs = wantUser || null;
    /* Paired with onNeedLogin, never fired alone. An already-authed session
       returns long before this without a word, because the page never put a
       login screen up and has nothing to take down — and an unpaired "logged
       in" would close a screen somebody had pinned open to watch a run. */
    if (typeof onLoginOk === "function") onLoginOk();
    return;
  }
  throw new Error(reason === "otp"
    ? "Timed out waiting for the Tramada verification code."
    : "Timed out waiting for a Tramada login.");
}

module.exports = {
  TRAMADA_BASE_URL,
  ensureLoggedIn,
  tramadaIsAuthed,
  tramadaIsAuthedQuietly,
  forgetSession,
  signedInAs,
};

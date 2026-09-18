/**
 * Every flow that can ASK for a login can also say the login happened.
 *
 * The page puts a login screen on screen when `recon_login` arrives and takes it
 * down when `recon_login_ok` does. Those two frames are a pair: a run that fires
 * the first without ever firing the second leaves a live view of a browser
 * signed into a finance system open on the page for the rest of the run.
 *
 * This test used to scan FIVE files, because `ensureLoggedIn` had five copies
 * and they drifted — `tramada-ipsi.js` gained the ask without the tell, so an
 * IPSI run opened the login screen and never closed it.
 *
 * The copies are now one function in `tramada-auth.js`, which is a better fix
 * than the test was. So the test changed shape with it: it still checks the
 * pairing, and it now also checks THAT THERE IS STILL ONLY ONE COPY — because
 * re-adding a local ensureLoggedIn is exactly how this regressed the first time,
 * and a second copy would carry a second, drifting answer to "whose Tramada
 * session is this?" (tramada-auth.js, the identity rule).
 *
 * The probe and wait-loop checks below were written when those lived in each of
 * the five copies and were asserted against all of them. They are NOT dropped
 * now the code moved — the properties they defend (the wait must not navigate,
 * the probe must read the body) are the two bugs that cost the most live runs,
 * and they are asserted against tramada-auth.js, the one copy left.
 *
 * Still a source check, deliberately: CLAUDE.md §7 forbids mocking Playwright,
 * and the property worth asserting is about the shape of the code, not a run.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

/* The modules a run can actually reach from server.js — directly, or forwarded
   through recon-run.js. tramada-segments.js and tramada-payment.js also keep a
   copy of ensureLoggedIn but nothing requires them, so their onNeedLogin can
   never reach a page; they are left out on purpose rather than by oversight. */
const REACHABLE = ["recon-run.js", "tramada-ipsi.js", "tramada-receipt.js"];

console.log("\nthe login lives in exactly one place");
const auth = read("tramada-auth.js");
{
  const asks = (auth.match(/^\s*if \(typeof onNeedLogin === "function"\) onNeedLogin\(/gm) || []).length;
  const tells = (auth.match(/^\s*if \(typeof onLoginOk === "function"\) onLoginOk\(\);/gm) || []).length;
  ok(`tramada-auth.js: ${asks} ask(s) for a login, ${tells} report(s) one`, asks > 0 && asks === tells,
    `onNeedLogin() is called ${asks} time(s) but onLoginOk() ${tells} — a login screen would be opened and never closed`);
}

for (const f of REACHABLE) {
  const src = read(f);
  ok(`${f}: does not define its own ensureLoggedIn`, !/^async function ensureLoggedIn/m.test(src),
    "a second copy is how the ask/tell pair drifted apart before, and it would now also carry a second answer to whose session this is");
  ok(`${f}: gets it from tramada-auth`, /require\("\.\/tramada-auth"\)/.test(src));
}

console.log("\nand every call site hands the pair through");
for (const f of REACHABLE) {
  const src = read(f);
  // `cb.onNeedLogin` / `callbacks.onNeedLogin` passed anywhere must be
  // accompanied on the same line — or, now that the call spans lines, within
  // the same call — by its partner.
  const orphans = (src.match(/ensureLoggedIn\(page, \{[\s\S]{0,400}?\}\)/g) || [])
    .filter((c) => /onNeedLogin/.test(c) && !/onLoginOk/.test(c));
  ok(`${f}: no call site passes onNeedLogin without onLoginOk`, orphans.length === 0, orphans.join("\n      "));
}

/* THE WAIT MUST NOT NAVIGATE.
 *
 * tramadaIsAuthed() calls page.goto(). The wait loop runs every three seconds,
 * on the same tab the human is typing their password into — so every tick
 * reloaded the login form and wiped both fields. On the noVNC screen the page
 * appeared to reload forever and there was no way to sign in at all. It was
 * invisible while the workflow was "sign in first, then start a run", and became
 * the only path the moment the app started showing the login screen itself.
 *
 * The loop must poll the request-based probe, which shares the cookie jar but
 * never navigates. Asserted against tramada-auth.js now the five copies are one.
 */
console.log("\nthe wait for a login does not reload the page under the human");
{
  ok("tramada-auth.js: has a probe that does not navigate", /async function tramadaIsAuthedQuietly\(/.test(auth),
    "the 3-second wait needs a check that does not call page.goto()");
  // The body of the wait loop, from `while (Date.now() < deadline)` to the
  // throw that ends it.
  const m = auth.match(/while \(Date\.now\(\) < deadline\) \{[\s\S]*?\n  \}/);
  ok("tramada-auth.js: the wait loop was found", !!m);
  if (m) {
    const body = m[0];
    ok("tramada-auth.js: the loop polls the quiet probe", /tramadaIsAuthedQuietly\(page\)/.test(body));
    /* One goto is allowed and required: the one AFTER the probe says they are in,
       which puts the run's own tab back on a real page. More than one means
       something in the wait is navigating again. */
    const gotos = (body.match(/page\s*\n?\s*\.goto\(|page\.goto\(/g) || []).length;
    ok(`tramada-auth.js: the loop navigates at most once, after the sign-in (${gotos})`, gotos <= 1,
      "a goto inside the wait reloads the login form and wipes what the human typed");
  }
}

/* THE RELOAD CAME BACK ON 25-08-2026, and this is why. The quiet probe decided
   whether you were signed in from the URL alone: `!res.url().includes("login.htm")`.
   But this Tramada serves the LOGIN FORM at the protected .../home/home.htm URL
   when signed out — a 200, address bar unchanged, no redirect. So url-only read
   a logged-out page as signed in, ensureLoggedIn fell into its confirm-navigation
   on every poll, and the login form reloaded every three seconds under whoever
   was trying to type a password. The fix reads the response BODY. These check the
   one remaining copy never drifts back to trusting the URL, and — against the
   captured bytes — that the body check actually fires on the page that fooled it. */
console.log("\nthe quiet auth probe reads the body, not just the URL");
{
  const m = auth.match(/async function tramadaIsAuthedQuietly\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  ok("tramada-auth.js: has tramadaIsAuthedQuietly", !!m);
  if (m) {
    const q = m[0];
    ok("tramada-auth.js: quiet probe reads the response body", /\.text\(\)/.test(q),
      "decides on res.url() alone — a login form served at the protected URL then reads as signed in and reloads every poll");
    ok("tramada-auth.js: quiet probe looks for the login form", /password|loginForm_login|login\.htm/i.test(q));
  }
}

/* Behaviour, against the exact bytes that caused it — a 200 whose URL never says
   login.htm, so the fix has to catch it by CONTENT. The regex tested is the one
   the code runs, lifted out of tramada-auth.js (it was recon-run.js before the
   five copies became one), so loosening it there breaks here. */
console.log("\nthe fix classifies the real logged-out page as a login screen");
const loggedOut = read("fixtures/tramada-home-loggedout.html");
const reSrc = auth.match(/const showingLogin\s*=\s*\n?\s*(\/[\s\S]*?\/[a-z]*)\.test\(body\)/);
ok("the login-detection regex was found in tramada-auth.js", !!reSrc);
if (reSrc) {
  const re = eval(reSrc[1]); // the literal from the source, evaluated as itself
  ok("it matches the captured logged-out home.htm (so: NOT signed in)", re.test(loggedOut),
    "the quiet probe would call a page that is plainly the login form 'signed in'");
  // And it must NOT fire on a page with no login form — otherwise every authed
  // poll reads as logged out and the run waits five minutes for a login already
  // done. "logout.htm" deliberately included: it must not be mistaken for login.
  const dashboard = '<html><body><a href="/ttms/raatravelsandbox/logout.htm">Log out</a><div id="home-dashboard">Bookings</div></body></html>';
  ok("it does NOT match a dashboard with no login form (so: signed in)", !re.test(dashboard),
    "a logged-in home page is being read as the login screen");
}

/* ── the identity rule ───────────────────────────────────────────────────────
   Not a style point. Without these, a run reuses whoever's Tramada session
   happens to be warm in the shared browser, and files one person's receipts
   under another person's name with nothing on screen looking wrong. */
console.log("\nthe shared session is checked against WHO should be in it");
ok("ensureLoggedIn compares the session owner to the run's user",
  /_signedInAs === wantUser/.test(auth),
  "without this it only asks whether ANYONE is signed in — which is how Sarah's receipts get filed as Tim");
ok("a session that is not provably theirs is signed out",
  /await signOut\(page, say\)/.test(auth),
  "reusing an unknown session is the bug this whole file guards");
ok("an unverified manual login is recorded as owner-unknown, not assumed",
  /_signedInAs = wantUser \|\| null;/.test(auth),
  "if nobody typed a username on our behalf we do not know who arrived");
ok("signOut refuses rather than guessing when it cannot prove it worked",
  /Refusing to file anything under a name/.test(auth),
  "CLAUDE.md §3 — stop and ask rather than guess, and here the guess is whose name goes on the money");

console.log("\nthe server sends both, and the page listens for both");
const server = read("server.js");
ok("server.js builds a recon_login frame", /type: "recon_login"/.test(server));
ok("server.js builds a recon_login_ok frame", /type: "recon_login_ok"/.test(server));
ok("server.js tells the page what it has (recon_hello)", /type: "recon_hello"/.test(server));
/* The page's socket handler drops every frame whose type does not start with
   "recon_", so a frame named `hello` would have been silently discarded and the
   login screen would simply never have appeared. */
ok("every frame the server sends is named recon_*",
  (server.match(/type: "([a-z_]+)"/g) || [])
    .map((m) => m.slice(7, -1))
    .filter((t) => t !== "cheat_sheet")
    .every((t) => t.startsWith("recon_")),
  "the page ignores any frame not starting with recon_");

const page = read("public/index.html");
for (const t of ["recon_hello", "recon_login", "recon_login_ok"]) {
  ok(`the built page handles ${t}`, page.includes(`'${t}'`) || page.includes(`"${t}"`),
    "public/index.html is generated — run `npm run build` after editing design/recon-wire.html");
}

/* The panel is only offered where a login screen actually exists, and the image
   is the only thing that says so. If these two disagree the feature is dead in
   the container and nothing else reports it. */
console.log("\nthe container advertises the screen it runs");
const compose = read("docker-compose.yml");
const dockerfile = read("Dockerfile");
const entry = read("docker-entrypoint.sh");
ok("docker-compose.yml sets NOVNC_PORT", /NOVNC_PORT:\s*"?6080"?/.test(compose));
ok("the Dockerfile sets it too, so a plain `docker run` works", /NOVNC_PORT=6080/.test(dockerfile));
ok("and it matches the port websockify is actually told to serve",
  /websockify --web=\/usr\/share\/novnc 6080/.test(entry),
  "NOVNC_PORT and the websockify port must be the same number");

/* ── The statement balance Edit button is scoped to ITS OWN field ─────────
   Measured live 08-09-2026 on Reconcile Bank Statement Page 23: eleven
   `dl.edit` blocks, ONE Edit button, and it belonged to the closing balance:

       data-fn-click="EditToggleTextField.toggleTextField('closingBalance');"

   The old selector scoped to `dl.edit` and took `.first()` — DOM order, not
   relevance — so it clicked that one, unlocked the closing balance correctly,
   and then the caller asserted on `#openingBalance` and stopped a seven-row
   run. The opening balance has no Edit on a continuation page at all: Tramada
   carries it forward from the previous page's closing figure.

   Source-level, like the rest of this file: what matters is that neither
   selector can address a field other than the one it names. */
console.log("\nthe balance Edit button cannot reach another field");
{
  const R = require("../recon-run");

  for (const field of ["openingBalance", "closingBalance"]) {
    const byHandler = R.balanceEditByHandler(field);
    const sameBlock = R.balanceEditInSameBlock(field);
    ok(`${field}: the handler selector names the field it unlocks`,
      byHandler.includes(`toggleTextField('${field}')`), byHandler);
    ok(`${field}: and the fallback is scoped to that field's own dl.edit`,
      sameBlock.split(",").every((sel) => sel.includes(`dl.edit:has(#${field})`)), sameBlock);
  }

  const other = "closingBalance";
  ok("a selector for one field never matches the other's handler",
    !R.balanceEditByHandler("openingBalance").includes(other),
    R.balanceEditByHandler("openingBalance"));
  ok("...and its fallback is not merely `dl.edit`, which matched eleven blocks",
    !/dl\.edit\s+dt/.test(R.balanceEditInSameBlock("openingBalance")),
    R.balanceEditInSameBlock("openingBalance"));
}

/* THE TWO-FACTOR URL.
 *
 * 09-09-2026, a live Mint run: the password was accepted and Tramada served its
 * verification-code form at `two-fa-login.htm`. Every check here asked whether
 * the URL `.includes("login.htm")` — which that one does — so the wait after
 * submitting sat out its full 30 seconds on a page that had already moved on,
 * and the DOM check that followed navigated to home.htm and threw the code form
 * away. The human opened the login screen to a blank username/password box, no
 * code prompt, and no way to finish; the run then failed five minutes later
 * with "Timed out waiting for the Tramada verification code."
 *
 * The URLs below are the real ones, off that run. */
console.log("\nthe two-factor page is not the login page");
{
  const A = require("../tramada-auth");
  const BASE = "https://asp.tramada.com.au/ttms/raatravelsandbox";

  ok("the login form is the login form",
    A.isLoginUrl(`${BASE}/login.htm`), `${BASE}/login.htm`);
  ok("...and the two-factor prompt is NOT — it used to read as one",
    !A.isLoginUrl(`${BASE}/two-fa-login.htm`), `${BASE}/two-fa-login.htm`);
  ok("a protected page is not the login page either",
    !A.isLoginUrl(`${BASE}/home/home.htm`), `${BASE}/home/home.htm`);
  // Belt and braces on the anchor: the segment has to START at the slash, so
  // anything hyphenated onto the front of it stays a different page.
  ok("nor is anything else ending in -login.htm",
    !A.isLoginUrl(`${BASE}/sso-login.htm`), `${BASE}/sso-login.htm`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

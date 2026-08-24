/**
 * Every flow that can ASK for a login can also say the login happened.
 *
 * The page puts a login screen on screen when `recon_login` arrives and takes it
 * down when `recon_login_ok` does. Those two frames are a pair: a run that fires
 * the first without ever firing the second leaves a live view of a browser
 * signed into a finance system open on the page for the rest of the run, and
 * nothing about that failure is visible in the code you are reading at the time
 * — it is visible three files away, in whichever module happened to have its own
 * copy of ensureLoggedIn.
 *
 * That is not hypothetical. `tramada-ipsi.js` and `tramada-receipt.js` each keep
 * their OWN ensureLoggedIn, and when recon-run.js gained the paired callback
 * those two did not. An IPSI run opened the login screen and never closed it.
 *
 * So this is a source check, not a behaviour one — deliberately. The pairing is
 * a property of five separate copies of one function, and the thing worth
 * asserting is that no copy drifts out of step with the others again.
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

console.log("\nevery module that can ask for a login can also report one");
for (const f of REACHABLE) {
  const src = read(f);
  // Only the invocations, never the parameter list or a comment mentioning it.
  const asks = (src.match(/^\s*if \(typeof onNeedLogin === "function"\) onNeedLogin\(\);/gm) || []).length;
  const tells = (src.match(/^\s*if \(typeof onLoginOk === "function"\) onLoginOk\(\);/gm) || []).length;
  ok(`${f}: ${asks} ask(s) for a login, ${tells} report(s) one`, asks > 0 && asks === tells,
    `onNeedLogin() is called ${asks} time(s) but onLoginOk() ${tells} — a login screen would be opened and never closed`);
}

console.log("\nand every call site hands the pair through");
for (const f of REACHABLE) {
  const src = read(f);
  // `cb.onNeedLogin` / `callbacks.onNeedLogin` passed anywhere must be
  // accompanied on the same line by its partner.
  const lines = src.split("\n");
  const orphans = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /\b(cb|callbacks)\.onNeedLogin\b/.test(l))
    .filter(({ l }) => !/\b(cb|callbacks)\.onLoginOk\b/.test(l));
  ok(`${f}: no call site passes onNeedLogin without onLoginOk`, orphans.length === 0,
    orphans.map((o) => `${f}:${o.n}  ${o.l.trim()}`).join("\n      "));
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
 * never navigates.
 */
console.log("\nthe wait for a login does not reload the page under the human");
for (const f of REACHABLE) {
  const src = read(f);
  ok(`${f}: has a probe that does not navigate`, /async function tramadaIsAuthedQuietly\(/.test(src),
    "the 3-second wait needs a check that does not call page.goto()");
  // The body of the wait loop, from `while (Date.now() < deadline)` to the
  // throw that ends it.
  const m = src.match(/while \(Date\.now\(\) < deadline\) \{[\s\S]*?\n  \}/);
  ok(`${f}: the wait loop was found`, !!m);
  if (!m) continue;
  const body = m[0];
  ok(`${f}: the loop polls the quiet probe`, /tramadaIsAuthedQuietly\(page\)/.test(body));
  /* One goto is allowed and required: the one AFTER the probe says they are in,
     which puts the run's own tab back on a real page. More than one means
     something in the wait is navigating again. */
  const gotos = (body.match(/page\s*\n?\s*\.goto\(|page\.goto\(/g) || []).length;
  ok(`${f}: the loop navigates at most once, after the sign-in (${gotos})`, gotos <= 1,
    "a goto inside the wait reloads the login form and wipes what the human typed");
}

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

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

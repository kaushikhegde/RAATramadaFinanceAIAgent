/**
 * Entra sign-in and the Key Vault lookup.
 *
 * Two kinds of check, and both are here for the same reason: everything this
 * feature added is either a pure string rule or a piece of wiring, and both can
 * be wrong in a way that looks completely fine on screen.
 *
 *   1. The email → secret-name rule, exercised properly. A mismatch here does
 *      not surface as a naming error — it surfaces as "no credentials found for
 *      tim@raa.com", which sends people to the vault to look at a secret that
 *      is sitting there correctly named. docs/azure-setup.md §7 prints the same
 *      table for whoever fills the vault; these cases are that table.
 *
 *   2. Source checks on server.js, for the three wiring mistakes that are
 *      invisible at runtime: an unguarded WebSocket, a static handler mounted
 *      before the guard, and a run lock that is per-page instead of
 *      per-server. Each of those leaves an app that works perfectly for one
 *      signed-in person and is wide open, or corrupting, for two.
 *
 * No mocking of MSAL or Key Vault (CLAUDE.md §7 — offline, no mocks).
 */
const fs = require("fs");
const path = require("path");
const creds = require("../tramada-creds");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
function throws(name, fn, re) {
  try { fn(); ok(name, false, "did not throw"); }
  catch (err) { ok(name, re.test(err.message), `threw "${err.message}", wanted /${re.source}/`); }
}

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

console.log("\nan email becomes a Key Vault secret name");
// Key Vault allows letters, digits and dashes and NOTHING else, so the obvious
// name — the email itself — is rejected by the portal. This is that mapping.
eq("the documented example", creds.secretNameFor("tim@raa.com", "password"), "tramada-tim-raa-com-password");
eq("...and its username half", creds.secretNameFor("tim@raa.com", "username"), "tramada-tim-raa-com-username");
eq("case is not significant", creds.secretNameFor("Tim@RAA.Com", "password"), "tramada-tim-raa-com-password");
eq("surrounding whitespace is not either", creds.secretNameFor("  tim@raa.com  ", "password"), "tramada-tim-raa-com-password");

/* A RUN of punctuation collapses to ONE dash. Each character mapping to its own
   would give `tim--smith-raa-com`, and nobody hand-typing that name into the
   portal from an email address would produce two dashes in a row — so the app
   would look for a secret no human would ever have created. */
eq("a run of punctuation is one dash", creds.slugFor("tim..smith@raa.com"), "tim-smith-raa-com");
eq("dots in the domain too", creds.slugFor("tim@raa.com.au"), "tim-raa-com-au");
eq("plus-addressing survives", creds.slugFor("tim+recon@raa.com"), "tim-recon-raa-com");
// Key Vault rejects a name that starts or ends with a dash, so a stray leading
// character would make an unstorable name rather than a merely wrong one.
eq("leading and trailing junk is trimmed", creds.slugFor(".tim@raa.com."), "tim-raa-com");

console.log("\nand refuses to invent one");
/* An empty email would build `tramada--password`, which is a legal Key Vault
   name — so this would FETCH something rather than fail, and whatever came back
   would be typed into a finance system's login form. */
throws("no email is an error, not an empty slug", () => creds.secretNameFor("", "password"), /no email/i);
throws("nor is a nameless one", () => creds.secretNameFor("@@@", "username"), /no email/i);
throws("only username or password", () => creds.secretNameFor("tim@raa.com", "otp"), /username.*password/i);

console.log("\nno vault configured is not a failure");
// A local `npm start` has no Azure at all and must still run — the login screen
// then does what it always did and waits for a human.
ok("configured() is false without AZURE_KEYVAULT_URL", creds.configured() === false);

console.log("\nthe front door is actually in front");
const server = read("server.js");
{
  /* express.static serves index.html to anyone who names it, so mounting it
     before the guard leaves the whole app reachable unauthenticated while every
     route below it still looks protected. Order is the protection. */
  const guard = server.indexOf("app.use(azureAuth.requireAuth)");
  const stat = server.indexOf("app.use(express.static(PUBLIC))");
  ok("requireAuth is mounted before express.static", guard > -1 && stat > -1 && guard < stat,
    `requireAuth at ${guard}, static at ${stat}`);
  ok("the login page itself is reachable without a session",
    server.indexOf('app.get("/login"') > -1 && server.indexOf('app.get("/login"') < guard);
}
{
  /* The socket is the door that matters: `recon_run` arrives down it and that
     frame files real receipts. Gating only the HTTP routes protects nothing. */
  ok("the WebSocket upgrade is authenticated", /userForUpgrade\(req\)/.test(server));
  ok("an unauthenticated upgrade is refused, not accepted as nobody",
    /401 Unauthorized[\s\S]{0,120}socket\.destroy\(\)/.test(server));
  ok("the socket is not handed straight to the http server",
    /new WebSocketServer\(\{ noServer: true \}\)/.test(server),
    "with `{ server }` the ws library completes the upgrade itself and the check above never runs");
}

console.log("\none run at a time, for the whole server");
{
  /* There is one browser. Two runs mean the second one's browser.close() pulls
     the page out from under the first with real receipts already filed — and
     with per-user credentials it also signs that browser in as somebody else
     mid-flight. A flag on one page never stopped either. */
  ok("the lock is module-level, not per-socket", /^const runLock = \{/m.test(server));
  ok("no per-session run flag survives", !/session\.reconRunning\s*=/.test(server),
    "session.reconRunning only ever stopped one page double-clicking Run");
  const takes = (server.match(/runLock\.take\(session\)/g) || []).length;
  const rels = (server.match(/runLock\.release\(\)/g) || []).length;
  ok(`every take is released (${takes} take, ${rels} release)`, takes > 0 && rels >= takes,
    "a lock taken and not released wedges the server for everybody until it restarts");
}

console.log("\ncredentials are chosen by the token, never by the caller");
{
  /* The whole access control. If the email came off the socket frame, Tim could
     name Sarah and be handed her Tramada password. */
  ok("the vault is keyed off the session user", /session\.user && session\.user\.email/.test(server));
  ok("and never off the incoming message", !/credentialsFor\(\s*msg\./.test(server));
  const authjs = read("azure-auth.js");
  ok("the session email comes from the verified ID token claims",
    /result\.idTokenClaims/.test(authjs) && /preferred_username/.test(authjs));
  ok("the OAuth callback checks state", /req\.query\.state !== req\.session\.state/.test(authjs),
    "without it a link can walk somebody's browser into a session they did not start");
  ok("the session id is regenerated on sign-in", /req\.session\.regenerate\(/.test(authjs),
    "otherwise a session id issued before sign-in still works after it");
  ok("a signing secret is required once sign-in is on", /SESSION_SECRET must be set/.test(authjs),
    "a predictable cookie secret on this app is a forgeable identity on a finance system");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

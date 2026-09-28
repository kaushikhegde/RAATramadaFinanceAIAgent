/* The app's port and the port Microsoft sends people back to are two separate
   settings with nothing connecting them.

   This exists because of a real one: PORT was moved to 3009 in .env, and under
   Docker compose overrode PORT back to 3000 while forwarding
   AZURE_REDIRECT_URI unchanged. So HALF the pair followed .env. Sign-in
   succeeded at Microsoft, came back to :3009, and Chrome said the site could
   not be reached -- with the app healthy on :3000 the entire time, every log
   clean, nothing to find. */
const fs = require("fs");
const path = require("path");

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n        " + e.message); }
};

function problemFor(redirect, listening) {
  for (const k of ["AZURE_TENANT_ID","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET","AZURE_REDIRECT_URI"])
    delete process.env[k];
  Object.assign(process.env, {
    AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s",
    AZURE_REDIRECT_URI: redirect,
  });
  for (const k of Object.keys(require.cache)) if (/azure-auth/.test(k)) delete require.cache[k];
  return require("../azure-auth.js").configProblem(listening);
}

console.log("\nThe two ports must agree\n");

check("A MISMATCH IS REPORTED — the exact bug", () => {
  const p = problemFor("http://localhost:3009/auth/callback", 3000);
  if (!p) throw new Error("said nothing; sign-in dies on a port nothing serves");
  if (!/3009/.test(p) || !/3000/.test(p)) throw new Error("does not name both ports: " + p);
});

check("agreement is silent", () => {
  if (problemFor("http://localhost:3000/auth/callback", 3000)) throw new Error("complained about a correct config");
});

check("a string port and a number port are the same port", () => {
  // PORT arrives as a string from the environment and as a number in tests.
  if (problemFor("http://localhost:3000/auth/callback", "3000")) throw new Error("string/number mismatch");
});

check("https with no port means 443, not 'no opinion'", () => {
  if (!problemFor("https://agent.raa.com.au/auth/callback", 3000)) {
    throw new Error("a bare https URI behind no proxy silently passed");
  }
  if (problemFor("https://agent.raa.com.au/auth/callback", 443)) {
    throw new Error("443 should agree with a bare https URI");
  }
});

check("http with no port means 80", () => {
  if (problemFor("http://localhost/auth/callback", 80)) throw new Error("80 should agree with a bare http URI");
});

check("it says how to fix it, not just that it is broken", () => {
  const p = problemFor("http://localhost:3009/auth/callback", 3000);
  if (!/APP_PORT/.test(p)) throw new Error("does not name the setting that moves both");
});

check("a junk redirect URI does not throw", () => {
  problemFor("not-a-url", 3000);
});

check("nothing is claimed when the port is unknown", () => {
  if (problemFor("http://localhost:3009/auth/callback", null)) throw new Error("guessed without a port");
});

/* ── and the thing that caused it ───────────────────────────────────────── */

const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");

check("COMPOSE DOES NOT HARDCODE THE PORT WHILE FORWARDING THE REDIRECT URI", () => {
  if (/^\s+PORT:\s*"\d+"/m.test(compose)) {
    throw new Error("PORT is a literal — editing .env moves the redirect URI and not the app");
  }
  if (!/PORT:\s*"\$\{APP_PORT:-\d+\}"/.test(compose)) throw new Error("PORT does not follow APP_PORT");
});

check("the published port follows the same variable", () => {
  if (!/"127\.0\.0\.1:\$\{APP_PORT:-\d+\}:\$\{APP_PORT:-\d+\}"/.test(compose)) {
    throw new Error("the publish is still a literal — the app moves, the door does not");
  }
});

check("the server passes its real port to the check", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  if (!/configProblem\(PORT\)/.test(server)) throw new Error("configProblem() is called with nothing to compare");
});

console.log("\n  " + (failures ? failures + " FAILED" : "11 checks passed") + "\n");
process.exit(failures ? 1 : 0);

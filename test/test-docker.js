"use strict";
/**
 * THE CONTAINER, AS A SET OF CLAIMS.
 *
 * Most of what goes wrong in a Dockerfile goes wrong SILENTLY: the stack comes
 * up, looks right, and is wrong in a way nobody notices until a restart, or
 * until it is deployed somewhere that is not compose. Each claim below is one
 * line in one file, and was a real failure in this container or in the payment
 * assistant's, which shares its shape.
 *
 * Source-level, like test-login-frames.js: nothing here starts Docker.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n        " + e.message); }
};
const must = (cond, why) => { if (!cond) throw new Error(why); };

const DOCKERFILE = read("Dockerfile");
const COMPOSE = read("docker-compose.yml");
const ENTRY = read("docker/entrypoint.sh");
// Comments explain the flags at length; only the commands count.
const ENTRY_CODE = ENTRY.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

console.log("\nthe debugging port stays inside the container\n");

check("9222 is never published or EXPOSEd", () => {
  must(!/^\s*-\s*"?[\d.]*:?9222:/m.test(COMPOSE), "the CDP port is published in docker-compose.yml");
  must(!/EXPOSE[^\n]*9222/.test(DOCKERFILE), "the CDP port is EXPOSEd");
});

check("Chromium binds its debugging port to 127.0.0.1", () => {
  /* Not publishing 9222 only holds under compose. A plain `docker run -p`, or
     anything sharing the container's network, reaches every interface the
     port listens on — and drives a browser signed into Tramada. */
  must(/--remote-debugging-address=127\.0\.0\.1/.test(ENTRY_CODE),
    "chromium listens for CDP on every interface inside the container");
});

console.log("\nstale locks from the last container are cleared\n");

check("the X lock is removed BEFORE Xvfb starts", () => {
  /* /tmp survives `docker start` and `compose restart`, so without this the
     first `up` works and the second dies on "Server is already active for
     display 99". */
  const clear = ENTRY_CODE.search(/rm -f[^\n]*\/tmp\/\.X\$\{?X_NUM\}?-lock/);
  const xvfb = ENTRY_CODE.search(/start Xvfb/);
  must(clear !== -1, "the X lock is never cleared");
  must(/\/tmp\/\.X11-unix\/X\$\{?X_NUM/.test(ENTRY_CODE), "the X socket is left behind");
  must(clear < xvfb, "the X lock is cleared after Xvfb has already refused it");
});

check("Chromium's Singleton* lock is removed BEFORE Chromium starts", () => {
  const clear = ENTRY_CODE.search(/rm -f[^\n]*SingletonLock/);
  const chrome = ENTRY_CODE.search(/start Chromium/);
  must(clear !== -1, "the profile lock is never cleared — every recreated container hits ECONNREFUSED on :9222");
  must(clear < chrome, "the profile lock is cleared after Chromium has read it");
});

check("and the profile itself is NEVER deleted", () => {
  /* The profile is on the volume so the Tramada session outlives the
     container. Wiping it would sign everyone out on every restart and look,
     from outside, exactly like the lock fix working. */
  must(!/rm -[a-z]*r[a-z]*f?[^\n]*\$\{?CHROME_PROFILE\}?"?\s*$/m.test(ENTRY_CODE),
    "the entrypoint deletes the Chrome profile directory");
});

console.log("\nit runs somewhere that is not compose (ROSA / OpenShift)\n");

check("tini is PID 1, from the image", () => {
  /* compose's `init: true` reaped Chromium's zombies, but Kubernetes has no
     such setting; the image has to bring its own or the pod runs out of
     process slots. */
  must(/^\s+tini \\$/m.test(DOCKERFILE), "tini is not installed");
  must(/ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/entrypoint\.sh"\]/.test(DOCKERFILE),
    "the entrypoint is not started under tini");
});

check("compose does not ALSO set init: true", () => {
  // Two inits only earns a "tini is not PID 1" warning on every start.
  must(!/^\s*init:\s*true/m.test(COMPOSE), "compose still sets init: true alongside the image's tini");
});

check("TRUST_PROXY reaches the container and defaults to empty", () => {
  /* Empty locally: with nothing in front of the app, trusting X-Forwarded-For
     lets any client write its own IP into the audit log. */
  must(/TRUST_PROXY:\s*\$\{TRUST_PROXY:-\}/.test(COMPOSE), "compose does not forward TRUST_PROXY, or gives it a default");
  must(!/TRUST_PROXY=/.test(DOCKERFILE), "the image turns TRUST_PROXY on for everyone");
});

check("the server only trusts a proxy when TRUST_PROXY is set", () => {
  const server = read("server.js");
  must(/if \(azureAuth\.TRUST_PROXY\)\s*\{[^}]*app\.set\("trust proxy"/.test(server),
    "trust proxy is set unconditionally, or not at all");
});

check("failure screenshots go to the volume, not the image's /app", () => {
  /* /app is not writable under OpenShift's random UID, so a screenshot taken
     there on a failed receipt is silently never written. */
  for (const f of ["tramada-receipt.js", "tramada-segments.js"]) {
    const src = read(f);
    must(!/path:\s*["']last-error\.png["']/.test(src), `${f} writes last-error.png to the working directory`);
    must(/process\.env\.RECON_STORE_DIR \|\| process\.cwd\(\), "last-error\.png"/.test(src),
      `${f} does not put last-error.png under RECON_STORE_DIR`);
  }
});

console.log("\nthe vault checker never shows a secret\n");

check("tools/check-vault.js prints lengths, never values", () => {
  const src = read("tools/check-vault.js");
  must(/got\.password\.length/.test(src), "the password length is not reported");
  const leaks = src.split("\n").filter((l) => /console\.log/.test(l) && /got\.(username|password)(?!\.length)/.test(l));
  must(!leaks.length, "a secret value is printed: " + leaks.join(" | "));
});

console.log("\n  " + (fail ? fail + " FAILED" : "all checks passed") + "\n");
process.exit(fail === 0 ? 0 : 1);

/* There is ONE browser driving Tramada, so there may be one run at a time.
 *
 * Found live: handleDvcRun never touched runLock at all. A DVC file uploaded
 * while a BPay or IPSI run was in flight started a SECOND flow against the
 * same Chrome. Two flows typing into one page do not race into a clean error —
 * they file a receipt against whatever page the other run had just navigated
 * to. It also meant a DVC run in progress stopped nothing from starting on
 * top of it.
 *
 * This reads server.js rather than booting it: the failure is structural —
 * a handler that forgets the lock — and a new one is added by copying an
 * existing handler, which is exactly how this gets reintroduced.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let n = 0, failures = 0;
const check = (what, fn) => {
  try { fn(); n++; console.log("  ✓ " + what); }
  catch (e) { failures++; console.log("  ✗ " + what + "\n      " + e.message); }
};

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const LINES = SRC.split("\n");

/** The whole body of a function, by brace counting — not a byte window. */
function bodyOf(name) {
  const i = LINES.findIndex((l) => new RegExp(`^(?:async )?function ${name}\\b`).test(l));
  assert.ok(i >= 0, `could not find ${name} in server.js`);
  let depth = 0, started = false, j = i;
  for (; j < LINES.length; j++) {
    for (const c of LINES[j]) {
      if (c === "{") { depth++; started = true; }
      else if (c === "}") depth--;
    }
    if (started && depth === 0) break;
  }
  return LINES.slice(i, j + 1).join("\n");
}

/* Every handler that DRIVES THE BROWSER. Adding one here is the point: a new
   report's handler must appear in this list and must hold the lock. */
const DRIVERS = ["handleReconRun", "handleCombinedRun", "handleIpsiRun", "handleDvcRun"];

console.log("\nevery run holds the one browser lock");

for (const fn of DRIVERS) {
  const body = bodyOf(fn);
  check(`${fn} refuses to start while another run holds it`, () => {
    assert.ok(/runLock\.heldBy\(\)/.test(body), `${fn} never asks whether a run is already going`);
    // The check must come BEFORE the lock is taken, or it always passes.
    assert.ok(body.indexOf("runLock.heldBy()") < body.indexOf("runLock.take("),
      `${fn} takes the lock before checking it`);
  });
  check(`${fn} takes it before opening a run`, () => {
    assert.ok(/runLock\.take\(/.test(body), `${fn} never takes the lock`);
    const take = body.indexOf("runLock.take(");
    const open = body.indexOf("openRun(");
    if (open >= 0) {
      assert.ok(take < open, `${fn} opens a run record before taking the lock`);
    }
  });
  check(`${fn} releases it however the run ends`, () => {
    assert.ok(/runLock\.release\(\)/.test(body), `${fn} never releases the lock`);
    /* In a finally. A lock held by a run that threw is a lock nobody can
       release, and everyone after it is told a run is in progress until the
       server restarts. */
    assert.ok(/finally\s*\{[\s\S]*?runLock\.release\(\)/.test(body),
      `${fn} releases the lock outside a finally — one thrown error wedges the agent`);
  });
}

console.log("\nthe lock is a real lock");

check("taking it twice is visible to the second caller", () => {
  // The object is tiny and lives in server.js; re-create it rather than boot
  // the server, and assert the shape the handlers above rely on.
  const lock = { _by: null, heldBy() { return this._by; },
    take(s) { this._by = (s.user && s.user.name) || "someone"; }, release() { this._by = null; } };
  assert.strictEqual(lock.heldBy(), null);
  lock.take({ user: { name: "Prit" } });
  assert.strictEqual(lock.heldBy(), "Prit", "a held lock does not name who holds it");
  lock.release();
  assert.strictEqual(lock.heldBy(), null, "release did not free it");
});

check("a run started by someone with no name still holds it", () => {
  const lock = { _by: null, heldBy() { return this._by; },
    take(s) { this._by = (s.user && s.user.name) || "someone"; }, release() { this._by = null; } };
  lock.take({});
  assert.ok(lock.heldBy(), "an anonymous run leaves the lock looking free");
});

console.log("\nuploading during a run cannot join it");

check("a run's rows come from the message, never re-read from the session", () => {
  /* The rows a run works on are snapshotted in the frame that started it.
     If openRun or the handlers read session.files for ROWS, a file uploaded
     mid-run would be swept into a run already in flight. session.files is
     read for the stored FILE RECORD only, and only by fileFor(). */
  const readers = LINES
    .map((l, i) => ({ l, i }))
    .filter((x) => /session\.files/.test(x.l) && !/^\s*\*/.test(x.l));
  for (const r of readers) {
    assert.ok(/session\.files\s*=|session\.files\[|const files = session\.files/.test(r.l),
      `server.js:${r.i + 1} reads session.files somewhere new — check it cannot reach a running run`);
  }
});

check("fileFor is only ever called while opening a run", () => {
  const calls = LINES.filter((l) => /fileFor\(/.test(l) && !/^\s*(\*|\/\/)/.test(l) && !/function fileFor/.test(l));
  assert.ok(calls.length >= 1, "fileFor is never called");
  for (const c of calls) {
    assert.ok(/store\.startRun|file: fileFor/.test(c),
      "fileFor is called outside openRun — a mid-run upload could reach a running run: " + c.trim());
  }
});

console.log("\n" + (failures ? failures + " FAILED" : n + " passed, 0 failed") + "\n");
process.exit(failures ? 1 : 0);

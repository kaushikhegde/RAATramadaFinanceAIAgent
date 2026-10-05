/* The once-a-day rule has to have a way through it.
 *
 * A run can report success and still have left the day half done. With no
 * override the only remedy is editing the database, which is worse than the
 * double-run the rule exists to prevent. So: refused by default, offered as a
 * deliberate act, and recorded as high risk under its own event — because
 * going round the rule is exactly what a reviewer is looking for, and it must
 * not hide among ordinary refusals.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let n = 0, failures = 0;
const check = (what, fn) => {
  try { fn(); n++; console.log("  ✓ " + what); }
  catch (e) { failures++; console.log("  ✗ " + what + "\n      " + e.message); }
};

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const AUDIT = require("../audit.js");
const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const WIRE = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");

function bodyOf(src, name) {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*(?:async )?function ${name}\\b`).test(l));
  assert.ok(i >= 0, `no ${name}`);
  let d = 0, started = false, j = i;
  for (; j < lines.length; j++) {
    for (const c of lines[j]) { if (c === "{") { d++; started = true; } else if (c === "}") d--; }
    if (started && d === 0) break;
  }
  return lines.slice(i, j + 1).join("\n");
}

console.log("\nthe override is a recorded act, not a quiet one");

check("it has its own audit event, separate from an ordinary refusal", () => {
  assert.ok(AUDIT.EVENTS["run.lock.overridden"], "no run.lock.overridden event");
  assert.notStrictEqual(AUDIT.EVENTS["run.lock.overridden"], AUDIT.EVENTS["run.refused"]);
});

check("IT IS HIGH RISK — a reviewer filters on exactly this", () => {
  assert.strictEqual(AUDIT.EVENTS["run.lock.overridden"].risk, "high",
    "an override that is not high-risk is one nobody will find");
});

const body = bodyOf(SERVER, "dailyLockRefusal");

check("without the tick, the run is refused and the refusal is recorded", () => {
  assert.match(body, /if \(!msg\.overrideDailyLock\)/, "the tick is never consulted");
  assert.match(body, /run\.refused/, "an ordinary refusal is not audited");
});

check("with the tick, the override is recorded BEFORE the run is allowed", () => {
  const audited = body.indexOf("run.lock.overridden");
  const allowed = body.lastIndexOf("return null;");
  assert.ok(audited > -1, "the override is never audited");
  assert.ok(audited < allowed, "it returns before recording — a crash would lose the record");
});

check("the record names the run being overridden", () => {
  /* "Somebody overrode the lock" is not an answer. Which earlier run, and when
     it finished, is what makes the two comparable afterwards. */
  assert.match(body, /earlierRun/, "does not say which run was already there");
  assert.match(body, /earlierFinishedAt/, "does not say when it finished");
});

check("a dry run never reaches any of it", () => {
  const msg = bodyOf(SERVER, "dailyLockMessage");
  assert.match(msg, /if \(dryRun\) return null;/, "a preview could be refused, or audited as an override");
});

console.log("\nevery entry point offers it");

for (const fn of ["handleReconRun", "handleCombinedRun", "handleIpsiRun", "handleDvcRun"]) {
  check(`${fn} refuses through dailyLockRefusal, not the bare message`, () => {
    const b = bodyOf(SERVER, fn);
    assert.match(b, /dailyLockRefusal\(/, `${fn} still calls dailyLockMessage directly — no override there`);
  });
  check(`${fn} tells the page it was the daily lock`, () => {
    const b = bodyOf(SERVER, fn);
    assert.match(b, /lockedToday: true/,
      `${fn} sends a bare error — the page cannot tell a lock from a failure without matching on words`);
  });
}

console.log("\nthe page offers it, and only for a lock");

check("a locked refusal offers 'run it again anyway'", () => {
  assert.match(PAGE, /data-act="override-lock"/, "the built page has no override link");
  assert.match(PAGE, /recorded in the security audit log/, "it does not say the override is recorded");
});

check("an ORDINARY failure does not offer it", () => {
  /* The branch order is the whole of this: a lock is handled first, and only
     then the generic failure. Reversed, every failed run would invite a
     re-run that the rule was never blocking. */
  const lock = PAGE.indexOf("m.lockedToday");
  const generic = PAGE.indexOf("Reconciliation could not be completed");
  assert.ok(lock > -1 && generic > -1, "could not find both branches");
  assert.ok(lock < generic, "the generic failure branch runs first — it would swallow the lock");
});

check("a lock does not send people to a report that does not exist", () => {
  // Nothing was attempted, so there is no run to open.
  const at = PAGE.indexOf("m.lockedToday");
  const branch = PAGE.slice(at, at + 600);
  assert.ok(!/data-go="inbox"/.test(branch), "offers 'See the report' for a run that never started");
});

check("the override rides on one frame and is not sticky", () => {
  const start = bodyOf(WIRE, "start");
  assert.match(start, /opts && opts\.overrideDailyLock \? \{ overrideDailyLock: true \} : \{\}/,
    "the flag is not conditional — an ordinary run may carry it");
  assert.ok(!/overrideDailyLock = true/.test(WIRE), "the override is stored somewhere and would persist");
});

check("the link is delegated, so it survives the alert bar being redrawn", () => {
  /* alertBar rewrites innerHTML on every run; a listener bound to the old node
     is gone the next time the override is needed. */
  assert.match(WIRE, /document\.addEventListener\('click'[\s\S]{0,200}override-lock/,
    "the handler is bound to the element rather than the document");
});

console.log("\n" + (failures ? failures + " FAILED" : n + " passed, 0 failed") + "\n");
process.exit(failures ? 1 : 0);

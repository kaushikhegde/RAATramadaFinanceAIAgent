"use strict";

/**
 * THE SECURITY AUDIT LOG, AGAINST THE STANDARD IT CLAIMS TO SATISFY.
 *
 * RAA Logging and Monitoring Standard v1.1, §3.1 Logging Requirements.
 *
 * A logging standard is easy to half-implement and impossible to half-pass: the
 * log looks full, the reviewer reads it, and the one field they needed was the
 * one quietly dropped as "not feasible". So this file asks three things:
 *
 *   1. does an event carry everything §3.1.1 lists?
 *   2. does anything secret ever reach a line? (CLAUDE.md §4, §5)
 *   3. is every event in the catalogue actually EMITTED somewhere, and is
 *      every hook site still there?
 *
 * Offline: no disk, no database, no network (CLAUDE.md §7). The sinks are
 * cleared and replaced with an array, which is the whole reason `audit.js`
 * has pluggable sinks at all.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const audit = require("../audit");

const ROOT = path.join(__dirname, "..");
let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

const collected = [];
audit.clearSinks();
audit.addSink((line) => collected.push(line));

const GOOD = {
  user: "kaushik.hegde@raa.com.au",
  ip: "10.14.2.9", port: 3000, url: "/api/export", method: "POST",
  userAgent: "Mozilla/5.0",
  target: "Tramada TTMS · bpay",
};

console.log("\n§3.1.1 — what every event must carry");

check("the five required details are all on a well-formed event", () => {
  const line = audit.buildEvent("run.started", GOOD);
  const got = audit.fieldsPresent(line);
  for (const [field, clause] of Object.entries(audit.STANDARD_FIELDS)) {
    assert.strictEqual(got[field], true, `missing "${clause}" (${field})`);
  }
});

check("...and the where-clause carries address, port, URL and method", () => {
  const line = audit.buildEvent("run.started", GOOD);
  assert.deepStrictEqual(Object.keys(line.where).sort(),
    ["ip", "method", "port", "url", "userAgent"]);
});

check("the timestamp is ISO 8601, not a locale string", () => {
  const line = audit.buildEvent("run.started", GOOD, new Date("2026-09-28T04:05:06.000Z"));
  assert.strictEqual(line.at, "2026-09-28T04:05:06.000Z");
});

check("a missing where-clause is REPORTED, not silently accepted", () => {
  /* "Where feasible" is an invitation to drop a field and call it infeasible.
     The line is still written — a run event with no address is better than no
     run event — but fieldsPresent says so, and the docs report it. */
  const line = audit.buildEvent("run.started", { user: "a@b", target: "x" });
  assert.strictEqual(audit.fieldsPresent(line).where, false);
  assert.strictEqual(line.where, undefined);
});

check("an event with no account is attributed to 'anonymous', never blank", () => {
  const line = audit.buildEvent("access.denied", { ip: "1.2.3.4", target: "/api/runs" });
  assert.strictEqual(line.user, "anonymous");
  assert.strictEqual(audit.fieldsPresent(line).user, true);
});

console.log("\n§3.1.1 — configuration changes carry the OLD and the NEW");

check("both halves are written when either is given", () => {
  const line = audit.buildEvent("config.changed", { ...GOOD, after: { x: 2 } });
  assert.deepStrictEqual(line.before, null);
  assert.deepStrictEqual(line.after, { x: 2 });
});

check("and neither appears on an event that is not a change", () => {
  const line = audit.buildEvent("run.started", GOOD);
  assert.ok(!("before" in line) && !("after" in line));
});

console.log("\nCLAUDE.md §4 / §5 — nothing secret reaches a line");

check("a field NAMED like a secret is redacted whatever it holds", () => {
  const line = audit.buildEvent("signin.success", {
    ...GOOD, password: "hunter2", apiKey: "abc", sessionToken: "x", Authorization: "Bearer y",
  });
  for (const k of ["password", "apiKey", "sessionToken", "Authorization"]) {
    assert.strictEqual(line.detail[k], audit.REDACTED, k + " reached the log");
  }
});

check("a card number is redacted even in a field nobody expected", () => {
  // §4: "how a PAN ends up in a log file". 4111 1111 1111 1111 is the
  // canonical Visa test number and passes Luhn.
  const line = audit.buildEvent("upload.received", { ...GOOD, originalName: "4111 1111 1111 1111.csv" });
  assert.strictEqual(line.detail.originalName, audit.REDACTED);
});

check("...and so is one nested inside an object", () => {
  const line = audit.buildEvent("upload.received", { ...GOOD, meta: { note: "card 4111111111111111" } });
  assert.strictEqual(line.detail.meta.note, audit.REDACTED);
});

check("a JWT is redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";
  const line = audit.buildEvent("signin.success", { ...GOOD, note: jwt });
  assert.strictEqual(line.detail.note, audit.REDACTED);
});

check("a 16-digit reference that is NOT a card is left alone", () => {
  /* The guard has to be a PAN detector, not a long-number detector. Tramada
     references, receipt numbers and booking numbers are digits too, and a log
     that redacts the reference a dispute is about is a log that answers
     nothing. Luhn is what tells them apart. */
  const line = audit.buildEvent("receipt.filed", { ...GOOD, reference: "1234567812345678" });
  assert.strictEqual(line.detail.reference, "1234567812345678");
});

check("a booking number is left alone", () => {
  const line = audit.buildEvent("receipt.filed", { ...GOOD, bookingNo: "15938" });
  assert.strictEqual(line.detail.bookingNo, "15938");
});

console.log("\nrecording must never be able to stop a run (CLAUDE.md §6b)");

check("a sink that throws does not throw back to the caller", () => {
  const undo = audit.addSink(() => { throw new Error("disk full"); });
  try {
    const line = audit.record("run.started", GOOD);
    assert.ok(line && line.event === "run.started");
  } finally { undo(); }
});

check("a hostile field does not throw either", () => {
  const nasty = {};
  Object.defineProperty(nasty, "boom", { get() { throw new Error("no"); }, enumerable: true });
  const line = audit.record("run.started", { ...GOOD, nasty });
  assert.ok(line && line.at, "no line came back at all");
});

check("and a cyclic object does not", () => {
  const a = { name: "a" };
  a.self = a;
  const line = audit.record("run.started", { ...GOOD, a });
  assert.ok(line && line.at);
});

console.log("\n§3.1.3 — the event catalogue");

const ROWS = new Set([
  "Log on, log off",
  "Failed logon attempts",
  "Account lockout events",
  "Account and role creation/ modification/ termination",
  "Account disabling and enabling",
  "Privileged user actions",
  "High-risk user actions",
  "Password resets",
  "Usage information",
  "Usage information (profile updates)",
  "Database transaction logs",
  "Direct changes made to log data",
]);

check("every declared event names a row of the standard's table", () => {
  for (const [name, def] of Object.entries(audit.EVENTS)) {
    assert.ok(ROWS.has(def.row), `${name} claims row "${def.row}", which is not in §3.1.3`);
  }
});

check("the risk vocabulary is closed", () => {
  for (const [name, def] of Object.entries(audit.EVENTS)) {
    assert.ok(["normal", "high"].includes(def.risk), `${name} has risk "${def.risk}"`);
  }
});

check("the standard's own rows are the three the app can answer", () => {
  /* Log on/log off, failed logons, high-risk actions, usage, database and log
     changes are this app's to record. Account creation, lockout, enabling and
     password resets belong to Entra and are NOT claimed here — see
     docs/logging-and-monitoring.md. Asserted so that claiming one later is a
     deliberate act with a test to change. */
  const claimed = new Set(Object.values(audit.EVENTS).map((e) => e.row));
  for (const notOurs of ["Account lockout events", "Password resets",
    "Account and role creation/ modification/ termination", "Account disabling and enabling"]) {
    assert.ok(!claimed.has(notOurs),
      `the catalogue claims "${notOurs}", which Entra owns — either wire it or drop the claim`);
  }
});

check("an unknown event is RECORDED and flagged, never dropped", () => {
  /* A log that discards what it was not expecting goes quiet exactly when
     something unexpected is happening. */
  const line = audit.buildEvent("something.new", GOOD);
  assert.strictEqual(line.unknownEvent, true);
  assert.strictEqual(line.category, "Uncategorised");
});

check("a failed-logon event defaults to outcome 'failure'", () => {
  assert.strictEqual(audit.buildEvent("signin.failure", GOOD).outcome, "failure");
  assert.strictEqual(audit.buildEvent("access.denied", GOOD).outcome, "failure");
  assert.strictEqual(audit.buildEvent("signin.success", GOOD).outcome, "success");
});

console.log("\n§3.1.1 — the hash chain (direct changes to log data)");

check("each line links to the one before it", () => {
  audit._resetChainForTests();
  const a = audit.record("signin.success", GOOD);
  const b = audit.record("run.started", GOOD);
  assert.strictEqual(a.seq, 1);
  assert.strictEqual(b.seq, 2);
  assert.strictEqual(b.prev, a.hash);
  assert.strictEqual(audit.verifyChain([a, b]).ok, true);
});

check("an EDITED line is detected, and named", () => {
  audit._resetChainForTests();
  const a = audit.record("signin.success", GOOD);
  const b = audit.record("statement.committed", { ...GOOD, transactions: 18 });
  // Somebody changing what a committed page said it committed.
  const faked = { ...b, detail: { ...b.detail, transactions: 0 } };
  const r = audit.verifyChain([a, faked]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "edited");
  assert.strictEqual(r.index, 1);
});

check("a DELETED line is detected at the gap", () => {
  audit._resetChainForTests();
  const a = audit.record("signin.success", GOOD);
  audit.record("receipt.filed", GOOD);          // the one somebody removes
  const c = audit.record("signout", GOOD);
  const r = audit.verifyChain([a, c]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "deleted");
});

check("REORDERED lines are detected", () => {
  audit._resetChainForTests();
  const a = audit.record("signin.success", GOOD);
  const b = audit.record("run.started", GOOD);
  const c = audit.record("signout", GOOD);
  // b and c swapped: the hashes are all genuine, the order is not.
  assert.strictEqual(audit.verifyChain([a, c, b]).ok, false);
});

check("a line written before the chain existed is 'unsealed', not tampering", () => {
  /* An old file is not an attack, and calling it one would train whoever runs
     the verifier to ignore it. */
  const r = audit.verifyChain([{ at: "2026-01-01T00:00:00.000Z", event: "run.started" }]);
  assert.strictEqual(r.reason, "unsealed");
});

check("the chain survives a restart by resuming from the last line", () => {
  audit._resetChainForTests();
  const a = audit.record("signin.success", GOOD);
  const b = audit.record("run.started", GOOD);
  audit._resetChainForTests();                   // as if the process restarted
  assert.strictEqual(audit.resumeChain(b), true);
  const c = audit.record("signout", GOOD);
  assert.strictEqual(audit.verifyChain([a, b, c]).ok, true,
    "a restart broke the chain — every restart would look like a deletion");
});

check("resuming from nothing refuses rather than pretending", () => {
  assert.strictEqual(audit.resumeChain(null), false);
  assert.strictEqual(audit.resumeChain({ hash: "short" }), false);
});

check("the hash does not depend on the order fields were set", () => {
  /* JSON.stringify keeps insertion order, so without a stable stringify the
     same event built two ways would hash differently and a clean chain would
     read as broken. */
  const one = audit.stableStringify({ b: 1, a: { d: 4, c: 3 } });
  const two = audit.stableStringify({ a: { c: 3, d: 4 }, b: 1 });
  assert.strictEqual(one, two);
});

console.log("\nretention — nothing is deleted until RAA names a period");

const core = require("../recon-core");
const FILES = ["audit-2026-06-01.jsonl", "audit-2026-09-20.jsonl",
  "audit-2026-09-28.jsonl", "notes.txt"];

check("no policy set, nothing is pruned", () => {
  /* The default has to be keep-everything. A log kept too long is an
     inconvenience; one deleted too early is the question nobody can answer. */
  for (const days of [null, undefined, 0, "", "abc", -5]) {
    assert.deepStrictEqual(core.auditFilesToPrune(FILES, { days, today: "2026-09-28" }), [],
      `days=${days} deleted something`);
  }
});

check("90 days keeps the last 90 and prunes the rest", () => {
  assert.deepStrictEqual(core.auditFilesToPrune(FILES, { days: 90, today: "2026-09-28" }),
    ["audit-2026-06-01.jsonl"]);
});

check("the period is inclusive of today", () => {
  // 1 day means today only.
  assert.deepStrictEqual(core.auditFilesToPrune(FILES, { days: 1, today: "2026-09-28" }),
    ["audit-2026-06-01.jsonl", "audit-2026-09-20.jsonl"]);
});

check("it never touches a file that is not an audit log", () => {
  const out = core.auditFilesToPrune(["notes.txt", "uploads.csv", "audit-2020-01-01.jsonl"],
    { days: 1, today: "2026-09-28" });
  assert.deepStrictEqual(out, ["audit-2020-01-01.jsonl"]);
});

check("it decides from the DAY IN THE NAME, never a file's mtime", () => {
  /* A restore, a backup or an rsync rewrites mtime, which would silently make
     last year's log look like today's — or today's look like last year's. */
  const src = fs.readFileSync(path.join(ROOT, "recon-core.js"), "utf8");
  const at = src.indexOf("function auditFilesToPrune");
  const body = src.slice(at, at + 900);
  assert.ok(/f\.slice\(6, 16\)/.test(body), "the day is no longer read from the filename");
  assert.ok(!/mtime/i.test(body), "mtime has crept into the retention decision");
});

check("deleting log data is itself written down, before it happens", () => {
  const store = fs.readFileSync(path.join(ROOT, "run-store.js"), "utf8");
  const at = store.indexOf("function pruneAudit");
  const recordAt = store.indexOf('audit.record("audit.pruned"', at);
  const unlinkAt = store.indexOf("fs.unlinkSync", at);
  assert.ok(recordAt > at && recordAt < unlinkAt,
    "the prune is recorded after the files are gone — possibly into one of them");
});

console.log("\nevery catalogued event is actually emitted somewhere");
{
  const files = ["server.js", "azure-auth.js", "run-store.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

  check("no event is declared and then never recorded", () => {
    /* The catalogue is what /api/audit publishes and what a reviewer reads as
       "this is what the app logs". An entry nothing emits is a claim, not a
       log line. */
    const missing = Object.keys(audit.EVENTS).filter((name) => !files.includes(`"${name}"`));
    assert.deepStrictEqual(missing, [], "declared but never emitted: " + missing.join(", "));
  });

  check("and nothing is emitted that the catalogue does not declare", () => {
    const emitted = new Set([
      ...[...files.matchAll(/(?:req\.audit|wsAudit\(session,|audit\.record|say\(req,)\s*\(?\s*"([a-z][a-z.]+)"/g)]
        .map((m) => m[1]),
    ]);
    const stray = [...emitted].filter((e) => !audit.EVENTS[e]);
    assert.deepStrictEqual(stray, [],
      "emitted but uncatalogued, so /api/audit cannot explain it: " + stray.join(", "));
  });
}

console.log("\nthe hook sites");
{
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const auth = fs.readFileSync(path.join(ROOT, "azure-auth.js"), "utf8");

  check("the sink is installed before anything can emit", () => {
    const install = server.indexOf("audit.addSink(store.appendAudit)");
    assert.ok(install > 0, "no sink is installed — every event would be built and dropped");
    assert.ok(install < server.indexOf("azureAuth.install(app)"),
      "the sink goes on after the auth routes, so a sign-in event would be lost");
  });

  check("the where-clause middleware runs before the auth routes", () => {
    /* Mounted after them, /auth/callback would have no req.audit and the two
       events a reviewer most wants — signed in, failed to sign in — would
       carry no address at all. */
    assert.ok(server.indexOf("req.audit = (name, fields = {})") < server.indexOf("azureAuth.install(app)"));
  });

  check("sign-in, sign-out and denied access are all hooked", () => {
    for (const e of ["signin.success", "signin.failure", "signout", "access.denied"]) {
      assert.ok(auth.includes(`"${e}"`), e + " is not recorded in azure-auth.js");
    }
  });

  check("the logout event is recorded BEFORE the session is destroyed", () => {
    const at = auth.indexOf('say(req, "signout"');
    const destroy = auth.indexOf("req.session.destroy", at - 400);
    assert.ok(at > 0 && at < auth.indexOf("req.session.destroy(() => {", at - 400),
      "signout is recorded after destroy, so it cannot name who signed out");
  });

  check("a committed statement page is its own event, not a run detail", () => {
    assert.ok(server.includes('"statement.committed"'),
      "committing a bank statement page is not audited");
    const at = server.indexOf('audit.record("statement.committed"');
    assert.ok(/out\.finished && out\.finished\.done/.test(server.slice(at - 400, at)),
      "it is recorded without checking Done was actually pressed");
  });

  check("reading the audit log is itself audited, before the read", () => {
    const route = server.indexOf('app.get("/api/audit"');
    assert.ok(route > 0, "there is no way to read the log back");
    const readAt = server.indexOf("store.readAudit", route);
    const auditAt = server.indexOf('req.audit("audit.read"', route);
    assert.ok(auditAt > route && auditAt < readAt,
      "the read is recorded after it happens, so a read that then fails leaves no trace");
  });

  check("/api/audit sits behind requireAuth", () => {
    assert.ok(server.indexOf("app.use(azureAuth.requireAuth)") < server.indexOf('app.get("/api/audit"'),
      "the log that says what everybody did is readable without signing in");
  });

  check("a run's audit events are recorded even if the run record fails to close", () => {
    const close = server.indexOf("function closeRun");
    const auditAt = server.indexOf("audit.record(error ?", close);
    const storeAt = server.indexOf("store.finishRun", close);
    assert.ok(auditAt > close && auditAt < storeAt,
      "the audit line is written after finishRun, which is wrapped in a catch that swallows");
  });
}

console.log("\n  " + n + " checks passed\n");

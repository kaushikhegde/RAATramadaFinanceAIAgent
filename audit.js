/**
 * audit.js — the security audit log.
 *
 * RAA Logging and Monitoring Standard v1.1, §3.1 Logging Requirements.
 * Everything in this file is traceable to a line of that document, and
 * `docs/logging-and-monitoring.md` maps it clause by clause — including the
 * clauses this app does NOT satisfy and who owns them instead. A standard
 * half-implemented and reported as done is worse than one not started.
 *
 * ── Why this is not `console.log` ────────────────────────────────────────────
 *
 * §3.1.1 requires each event to carry five things: when, what, where from, who,
 * and what it touched. A printed sentence carries none of them in a form
 * anything can query, and a reviewer asking "who committed that statement page
 * on the 12th" cannot grep a sentence for an answer it never held. So an event
 * is a RECORD with named fields, written as one JSON object per line.
 *
 * ── Recording an event must never be able to stop a run (CLAUDE.md §6b) ──────
 *
 * The same trade `run-store.js` makes, for the same reason. `record()` builds
 * the line synchronously, hands it to every installed sink inside a try/catch
 * that swallows, and returns the line. A full disk or a dead database loses the
 * archive copy of an event; it does not abandon a run with real receipts
 * already filed. `record()` has no throwing path — that is a tested property,
 * not an intention.
 *
 * ── Nothing secret is ever written here (CLAUDE.md §4, §5) ───────────────────
 *
 * "Adding card handling to a service with no UI for it and no redaction on its
 * socket is how a PAN ends up in a log file" (§4). This file is a log file, so
 * it redacts: any field whose NAME looks like a secret, and any value that
 * looks like a card number or a bearer token, is replaced before it is written.
 * The standard asks for the identity of the actor and the resource, never their
 * credentials.
 */

"use strict";

const crypto = require("crypto");

/* ── §3.1.1: what every event must carry ─────────────────────────────────────
 *
 *   "Where feasible, logs captured must contain the following details for each
 *    event:  Date and timestamp of the event.  Event type.  Originating IP
 *    Address/ MAC Address/ Web URL/ source/ destination/ and Port Number.
 *    User ID/ account attributable to the event.  Identity or name of the
 *    affected system, application, database, or resource."
 *
 * Named here, once, so the test can assert the standard's list against the
 * code's rather than against a second copy of the list written out by hand.
 * `where` is one clause in the standard covering several fields, so it is one
 * entry here holding all of them.
 */
const STANDARD_FIELDS = {
  at: "Date and timestamp of the event",
  event: "Event type",
  where: "Originating IP Address/ MAC Address/ Web URL/ source/ destination/ and Port Number",
  user: "User ID/ account attributable to the event",
  target: "Identity or name of the affected system, application, database, or resource",
};

// The concrete fields the `where` clause becomes on an HTTP application.
// There is no MAC address to have: this process sees a TCP peer, not a NIC.
const WHERE_FIELDS = ["ip", "port", "url", "method", "userAgent"];

/* ── §3.1.3: the event catalogue ─────────────────────────────────────────────
 *
 * The standard's Application and Database Logs table lists what an application
 * must log under "Account Usage Information". Every event this app can emit is
 * declared here against the row of that table it satisfies, so the mapping is
 * data — readable by the test, by the docs generator, and by whoever at RAA has
 * to sign this off — rather than a claim in a comment.
 *
 * `risk: "high"` marks the standard's "High-risk user actions" and
 * "Privileged user actions". Here that means anything irreversible and
 * financial: a receipt filed, a statement page committed, a payment session
 * saved, a mail sent to Travel Accounts.
 */
const EVENTS = {
  // "Log on, log off." / "Failed logon attempts."
  "signin.success": { row: "Log on, log off", risk: "normal" },
  "signin.failure": { row: "Failed logon attempts", risk: "normal" },
  "signout": { row: "Log on, log off", risk: "normal" },
  /* An unauthenticated request to a guarded route. Not a failed PASSWORD —
     nobody typed one — but it is the same question a reviewer is asking of the
     failed-logon row: who is knocking on this app without a session. */
  "access.denied": { row: "Failed logon attempts", risk: "normal" },

  // "Usage information (transactions, profile updates, etc.)."
  "upload.received": { row: "Usage information", risk: "normal" },
  "run.started": { row: "Usage information", risk: "high" },
  "run.finished": { row: "Usage information", risk: "normal" },
  "run.refused": { row: "Usage information", risk: "normal" },
  "export.downloaded": { row: "Usage information", risk: "normal" },
  "row.edited": { row: "Usage information", risk: "normal" },
  "row.resolved": { row: "Usage information", risk: "normal" },

  /* "Privileged user actions." / "High-risk user actions."
     Everything here writes to Tramada or sends mail, and none of it rolls
     back. This is the list a reviewer actually wants. */
  "receipt.filed": { row: "High-risk user actions", risk: "high" },
  "statement.committed": { row: "High-risk user actions", risk: "high" },
  "ipsi.receipt.issued": { row: "High-risk user actions", risk: "high" },
  "tokio.session.saved": { row: "High-risk user actions", risk: "high" },
  "email.sent": { row: "High-risk user actions", risk: "high" },

  /* §3.1.1 — "Where logging of configuration changes is allowed by the system
     the old and new configuration must be captured." The supplier cheat sheet
     is the only configuration a person can change from inside this app. */
  "config.changed": { row: "Usage information (profile updates)", risk: "high" },

  // "Database transaction logs."
  "store.write.failed": { row: "Database transaction logs", risk: "normal" },

  /* §3.1.1 — "Direct changes made to log data must be captured." Nothing in
     this app edits or deletes an audit line, so what there is to capture is
     every READ of the log and every roll of a file. An audit trail that cannot
     say who read it is missing the one event an insider cares about. */
  "audit.read": { row: "Direct changes made to log data", risk: "normal" },
  "audit.rotated": { row: "Direct changes made to log data", risk: "normal" },
  /* The chain below could not be picked up where the last run left it — the
     newest file was unreadable, or its last line was not one whole object.
     Not proof of tampering, but the only honest thing to do about a gap is to
     write one down where the gap is. */
  "audit.chain.broken": { row: "Direct changes made to log data", risk: "high" },
  /* Retention. §3.1.1 again: deleting log data is a direct change to it, so
     the deletion is the last thing written about what was deleted. */
  "audit.pruned": { row: "Direct changes made to log data", risk: "high" },
};

/* ── redaction ───────────────────────────────────────────────────────────────
 *
 * Two separate guards, because they fail differently. The first catches a field
 * somebody NAMED badly (`password`, `token`, `secret`); the second catches a
 * value that looks dangerous whatever it was called, which is the case where
 * the caller did not realise what they were passing.
 */
const SECRET_NAME = /pass(word|phrase)?|secret|token|credential|cookie|authorization|api[-_ ]?key|pin\b|cvv|cvc|card(number|no)?|pan\b/i;

// 13-19 digits, optionally spaced or hyphenated in groups. §4: no PAN reaches a
// log file from here, including one that arrived in a field nobody expected.
const LOOKS_LIKE_PAN = /(?:\d[ -]?){13,19}/;
// JWTs and bearer-ish blobs.
const LOOKS_LIKE_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

const REDACTED = "[redacted]";

/** Luhn, so a booking reference of 16 digits is not mistaken for a card. */
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactValue(v) {
  if (v == null) return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === "object") return redact(v);
  const s = String(v);
  if (LOOKS_LIKE_TOKEN.test(s)) return REDACTED;
  const m = s.match(LOOKS_LIKE_PAN);
  if (m) {
    const digits = m[0].replace(/[^0-9]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return REDACTED;
  }
  return s;
}

/** A shallow-or-deep copy with every secret-looking name or value removed. */
function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_NAME.test(k) ? REDACTED : redactValue(v);
  }
  return out;
}

/* ── building an event ───────────────────────────────────────────────────── */

/** ISO 8601 with the offset, not a bare Z — §3.1.1's "date and timestamp". */
function stamp(d) {
  const t = d instanceof Date ? d : new Date();
  return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

/**
 * The line that gets written. PURE — no clock beyond `now`, no I/O, no throw.
 *
 * An unknown event name is recorded rather than dropped, flagged
 * `unknownEvent`. A log that silently discards what it was not expecting is a
 * log that goes quiet exactly when something unexpected is happening; the flag
 * is so the gap shows up in review instead.
 */
function buildEvent(name, fields = {}, now = new Date()) {
  const known = EVENTS[name] || null;
  const f = redact(fields);
  const where = {};
  for (const k of WHERE_FIELDS) if (f[k] != null && f[k] !== "") where[k] = f[k];

  const line = {
    at: stamp(now),
    event: String(name || "unknown"),
    outcome: f.outcome || (known && known.row === "Failed logon attempts" ? "failure" : "success"),
    // §3.1.3's own row name, carried on the line so a reviewer can group by the
    // standard's categories without holding this file open beside the log.
    category: known ? known.row : "Uncategorised",
    risk: known ? known.risk : "unknown",
    user: f.user || "anonymous",
    target: f.target || "recon-agent",
    ...(Object.keys(where).length ? { where } : {}),
  };
  if (!known) line.unknownEvent = true;

  /* §3.1.1's configuration clause. Both halves or neither: "after" on its own
     records a change without saying what it replaced, which is the half that
     makes the line useless. */
  if (f.before !== undefined || f.after !== undefined) {
    line.before = f.before === undefined ? null : f.before;
    line.after = f.after === undefined ? null : f.after;
  }

  const SKIP = new Set([...WHERE_FIELDS, "user", "target", "outcome", "before", "after"]);
  const detail = {};
  for (const [k, v] of Object.entries(f)) if (!SKIP.has(k)) detail[k] = v;
  if (Object.keys(detail).length) line.detail = detail;

  return line;
}

/**
 * Which of §3.1.1's five required fields this line actually carries.
 *
 * The standard says "where feasible", which is an invitation to quietly drop
 * one and call it infeasible. So every line is measured against the list, the
 * answer is queryable, and `docs/logging-and-monitoring.md` reports it.
 */
function fieldsPresent(line) {
  return {
    at: !!line.at,
    event: !!line.event,
    where: !!(line.where && Object.keys(line.where).length),
    user: !!line.user,
    target: !!line.target,
  };
}

/* ── the hash chain ──────────────────────────────────────────────────────────
 *
 * §3.1.1: "Direct changes made to log data must be captured."
 *
 * Append-only by file mode and by convention is not the same as append-only in
 * fact. Anyone who can write to the volume can open a .jsonl, delete the line
 * that incriminates them, and nothing about the file afterwards looks wrong —
 * which is the whole problem with an audit log as a plain list of events.
 *
 * So each line carries the hash of the one before it. Editing a line changes
 * its hash and orphans every line after it; deleting one breaks the link at
 * that exact point; reordering breaks the sequence numbers, which are inside
 * the hashed body rather than beside it. None of that stops somebody with write
 * access — nothing on the same disk can — but it moves tampering from
 * undetectable to obvious, and it names the line where it happened.
 *
 * NOT a signature. A signature would need a key this process does not have and
 * would still be re-appliable by anyone holding it. This is a tripwire, and it
 * is described as one in docs/logging-and-monitoring.md rather than as proof.
 */
const GENESIS = "0".repeat(64);

let chain = { seq: 0, hash: GENESIS };

/**
 * Deterministic JSON: keys in sorted order at every level.
 *
 * `JSON.stringify` preserves insertion order, so the same event built by two
 * code paths that set the fields in a different order would hash differently
 * and the chain would read as broken when nothing was wrong.
 */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function sha256(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }

/**
 * Link one line to the chain. `seq` and `prev` go INSIDE the hashed body —
 * beside it they could be renumbered without the hash noticing.
 */
function sealLine(line, prev = chain) {
  const linked = { ...line, seq: (prev.seq || 0) + 1, prev: prev.hash || GENESIS };
  return { ...linked, hash: sha256(stableStringify(linked)) };
}

/**
 * Pick the chain up where the last process left it.
 *
 * Called by `run-store` at boot with the last line of the newest audit file.
 * Without this every restart would begin a fresh chain, and a fresh chain is
 * indistinguishable from somebody deleting everything before it.
 */
function resumeChain(last) {
  if (last && typeof last.hash === "string" && last.hash.length === 64) {
    chain = { seq: Number(last.seq) || 0, hash: last.hash };
    return true;
  }
  return false;
}

function chainState() { return { ...chain }; }

/** For tests, and for a store that has just been reset. */
function _resetChainForTests() { chain = { seq: 0, hash: GENESIS }; }

/**
 * Check a run of lines, in file order. Returns the first break and why.
 *
 * Three ways a chain breaks, and they are reported apart because they mean
 * different things to whoever is reading:
 *
 *   edited     the line does not hash to its own recorded hash
 *   deleted    `prev` does not match the previous line's hash
 *   reordered  `seq` did not go up by one
 *
 * A line with no hash at all is reported as `unsealed` rather than as tampering
 * — an old file written before this existed is not an attack.
 */
function verifyChain(lines) {
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || typeof l.hash !== "string") {
      return { ok: false, index: i, reason: "unsealed", line: l || null };
    }
    const { hash, ...body } = l;
    if (sha256(stableStringify(body)) !== hash) {
      return { ok: false, index: i, reason: "edited", line: l };
    }
    if (prev === null) {
      // The first line of the run being checked. It may legitimately be
      // mid-chain — a day's file starts wherever the previous day ended.
      prev = l;
      continue;
    }
    if (l.prev !== prev.hash) return { ok: false, index: i, reason: "deleted", line: l };
    if (Number(l.seq) !== Number(prev.seq) + 1) {
      return { ok: false, index: i, reason: "reordered", line: l };
    }
    prev = l;
  }
  return { ok: true, checked: lines.length, last: prev };
}

/* ── sinks ───────────────────────────────────────────────────────────────── */

/* Installed by server.js at boot; empty in the offline suite, which is what
   keeps the tests off the disk and off the wire (CLAUDE.md §7). */
const sinks = [];

function addSink(fn) { sinks.push(fn); return () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1); }; }
function clearSinks() { sinks.length = 0; }

/**
 * Write one event. NEVER THROWS, whatever a sink does — see the header.
 * Returns the line, so a caller can assert on it and a test can read it.
 */
function record(name, fields, now) {
  let line;
  try {
    line = buildEvent(name, fields, now);
  } catch (err) {
    // Building the line is pure and should not be able to fail, but a caller
    // can hand in something hostile (a getter that throws, a cyclic object).
    // A broken event is still an event: record that one happened.
    line = { at: stamp(), event: String(name || "unknown"), outcome: "failure",
      category: "Uncategorised", risk: "unknown", user: "anonymous",
      target: "recon-agent", buildError: String(err && err.message) };
  }
  /* SEALED BEFORE THE SINKS, so the file, the database and the caller all hold
     the same bytes — a hash computed over one shape and verified against
     another reads as tampering on every single line. Sealing cannot throw
     either: a line that could not be hashed is still written, unsealed, and
     `verifyChain` reports it as `unsealed` rather than as an attack. */
  try {
    line = sealLine(line);
    chain = { seq: line.seq, hash: line.hash };
  } catch (_) { /* an unsealed line beats no line */ }

  for (const sink of sinks) {
    try { sink(line); } catch (_) { /* §6b: losing the archive copy is not a reason to stop */ }
  }
  return line;
}

module.exports = {
  STANDARD_FIELDS, WHERE_FIELDS, EVENTS,
  buildEvent, fieldsPresent, redact, record,
  addSink, clearSinks,
  sealLine, verifyChain, resumeChain, chainState, stableStringify, GENESIS,
  _resetChainForTests,
  REDACTED,
};

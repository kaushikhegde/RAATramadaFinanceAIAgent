# Logging and Monitoring — what this app does, clause by clause

Against **RAA Logging and Monitoring Standard v1.1**, §3.1 Logging Requirements
(pages 4–5 of the standard).

This document is written to be read next to the standard by whoever has to sign
it off. It says what is implemented, **and what is not and who owns it
instead**. A standard half-implemented and reported as done is worse than one
not started: the gap stops being a gap and becomes an assumption.

Where the code is:

| | |
|---|---|
| What an event *is* | `audit.js` — pure, no I/O, tested offline |
| Where an event *lands* | `run-store.js` — `appendAudit` / `readAudit` |
| Where events are *raised* | `server.js`, `azure-auth.js` |
| Reading it back | `GET /api/audit`, and the **Security audit log** screen |
| Checking it was not tampered with | `npm run audit:verify` → `tools/verify-audit-log.js` |
| Retention | `AUDIT_RETENTION_DAYS` (unset = keep everything) |
| Tests | `test/test-audit.js` (45 checks), `test/test-audit-api.js` (13, end to end) |

---

## §3.1.1 Baseline Requirements

> **"Event logging and audit trails must be enabled on information assets."**

Done. Every sign-in, every run, every write into Tramada and every read of the
log itself is recorded. The catalogue is `audit.EVENTS` and is published by
`GET /api/audit` alongside the results, so a reviewer never has to open this
repo to know what the app is capable of logging.

> **"Where feasible, logs captured must contain the following details for each
> event…"**

All five, on every line:

| The standard asks for | The field | Notes |
|---|---|---|
| Date and timestamp of the event | `at` | ISO 8601, UTC |
| Event type | `event`, plus `category` and `risk` | `category` is the §3.1.3 row it satisfies, carried on the line |
| Originating IP Address / MAC Address / Web URL / source / destination / Port Number | `where.ip`, `where.port`, `where.url`, `where.method`, `where.userAgent` | **No MAC address.** This process sees a TCP peer, not a NIC — the address is the one that reached it. `where.ip` honours the proxy header, or every event behind the container's proxy would come from one machine |
| User ID / account attributable to the event | `user` | The Entra account's email. `anonymous` where there is genuinely none — an unauthenticated request, or a deployment with no sign-in configured — never blank |
| Identity or name of the affected system, application, database, or resource | `target` | e.g. `Tramada bank statement page 41`, `Tramada receipt R.0000009413`, `uploads/20260928-…-mint.xlsx`, `audit_log` |

"Where feasible" is an invitation to drop a field and call it infeasible, so
`audit.fieldsPresent(line)` reports which of the five a given line carries, and
the offline test asserts a well-formed event carries all of them. A line that is
missing one is still written — a run event with no address beats no run event —
but it is missing visibly.

> **"Where logging of configuration changes is allowed by the system the old and
> new configuration must be captured."**

Done, for the one piece of configuration a person can change from inside this
app: the **supplier cheat sheet**, which decides which supplier a settlement
line is matched to and therefore what future runs reconcile. `config.changed`
carries `before` and `after` — the changed keys with their old and new values,
plus the pair counts, capped at 50 changed keys with `truncated: true` beyond
that. Both halves or neither: `after` alone records a change without saying what
it replaced.

The same before/after applies to `row.edited`, a person overwriting a verdict
the agent reached on a financial run.

> **"Direct changes made to log data must be captured."**

Nothing in this app edits or deletes an audit line. The Postgres table is
insert-only and the files are opened for append. So what there is to capture is
**who went looking**: every call to `GET /api/audit` writes an `audit.read`
event carrying the filter used, recorded *before* the results are built so a
read that then fails still leaves a trace. A daily file roll writes
`audit.rotated` as the first line of the new file, naming the one it followed.

**And a hash chain**, because append-only by file mode is not append-only in
fact. Each line carries the hash of the one before it, and the sequence number
and the link are *inside* the hashed body rather than beside it. Editing a line
changes its hash and orphans everything after it; deleting one breaks the link
at exactly that point; reordering breaks the sequence. `npm run audit:verify`
walks the files — across day boundaries, so a whole day deleted is caught too —
and says which line broke and how:

```
  ✓ audit-2026-09-27.jsonl — 412 lines, chain intact
  ✗ audit-2026-09-28.jsonl — line 3: the link to the previous line is broken — a line was removed
      2026-09-28T09:16:24.486Z  run.started  kaushik.hegde@raa.com.au
```

Exit code 1 on any failure, so it can sit in a cron or a health check. The chain
is picked up from the last line of the newest file at boot — without that, every
restart would start a fresh chain, and a fresh chain is indistinguishable from
somebody having deleted everything before it. If it cannot be picked up, an
`audit.chain.broken` line is written *at the gap*, because a break nobody can
date is worse than one that is labelled.

**This is a tripwire, not proof.** Anyone with write access to the volume could
recompute the chain from the line they changed onwards. It catches the realistic
case — one file opened, one line deleted — and it is described that way here
rather than as something stronger.

> **"The scope of logging … must be reviewed annually or whenever a threat
> environment changes."**

**Not automated — a process obligation on RAA.** What this app provides for that
review: `GET /api/audit` returns `catalogue` (every event type it can emit, with
the §3.1.3 row each satisfies) and `standardFields` (this table), so the annual
review is a comparison against a live list rather than against this document.

---

## §3.1.2 Operating System Logs

**Not this application's to provide.** Log on/off, power events, failed logons at
the OS, account lockout, account and role lifecycle, password reset, remote
connection initiation and software installation are all properties of the host
and the container platform, not of a Node process running inside one.

Owner: whoever operates the container host and the image (see `Dockerfile`,
`docker-compose.yml`). This app writes to stdout as well as to its own files, so
a platform-level collector picks up the process's own lifecycle.

---

## §3.1.3 Application and Database Logs

The standard's **Account Usage Information** table, row by row.

| Row of the standard | Status | Where |
|---|---|---|
| Log on, log off | **Done** | `signin.success`, `signout` — `azure-auth.js` |
| Failed logon attempts | **Done** | `signin.failure` (with the reason: a bad `state` parameter and a misconfigured tenant are two different incidents), and `access.denied` for an unauthenticated request to a guarded route |
| Account lockout events | **Not ours — Microsoft Entra ID** | This app has no password, no lockout counter and no account store. Entra owns sign-in; its sign-in logs carry lockout. Deliberately *not* claimed: `test/test-audit.js` fails if the catalogue starts claiming it |
| Account and role creation / modification / termination | **Not ours — Entra + the Tramada tenant** | No account is created here |
| Account disabling and enabling | **Not ours — Entra** | |
| Privileged user actions | **Done** | This app has no roles, so "privileged" and "high-risk" are one list — below |
| High-risk user actions | **Done** | `receipt.filed`, `statement.committed`, `ipsi.receipt.issued`, `tokio.session.saved`, `email.sent`, `run.started`, `config.changed`. Everything on that list is irreversible and financial |
| Password resets | **Not ours — Entra** | |
| Usage information (transactions, profile updates, etc.) | **Done** | `upload.received`, `run.started`, `run.finished`, `run.refused`, `export.downloaded`, `row.edited`, `row.resolved` |
| Database transaction logs | **Partial** | `store.write.failed` records every swallowed database write — the failure nobody would otherwise notice, because the run carries on and the screen still looks right. Statement-level Postgres logging is a database configuration, not an application one |

### The high-risk events, in full

| Event | What it means happened |
|---|---|
| `receipt.filed` | A real receipt now exists in Tramada against a real booking. Once per receipt, not once per row update |
| `statement.committed` | A bank statement page was ticked and Done was pressed. Only written when Done actually was — nothing matched means it is never pressed (CLAUDE.md §6) |
| `ipsi.receipt.issued` | One Finance Merchant Payment Receipt covering a whole IPSI settlement. A dry run does not qualify |
| `tokio.session.saved` | A Tramada payment session was saved. Carries `issueClicked: false` — BR16 says Issue is a person's click, and the audit log is where that has to be provable later |
| `email.sent` | A mail to Travel Accounts. `transmitted` distinguishes a real send from a `.eml` draft written to disk |
| `run.started` | A run began. `dryRun` is on the line, because a rehearsal and a run that files receipts are two different events |
| `config.changed` | The supplier cheat sheet was edited, with old and new |

---

## What is never written

CLAUDE.md §4 and §5. A log file is exactly where a credential or a card number
ends up if nothing stops it, so two guards run on every field of every event:

1. **By name** — anything matching `password`, `secret`, `token`, `credential`,
   `cookie`, `authorization`, `api key`, `pin`, `cvv`, `card number`, `pan` is
   replaced with `[redacted]`, whatever it holds.
2. **By shape** — a value that Luhn-validates as a 13–19 digit card number, or
   looks like a JWT, is replaced, *wherever it appears* and however the field was
   named, including nested inside an object.

Luhn matters: Tramada references, receipt numbers and booking numbers are digits
too, and a log that redacts the reference a dispute is about answers nothing.
`test/test-audit.js` asserts both directions — a test PAN is redacted, a 16-digit
non-card reference is not.

Uploaded reports are logged by **name and size only**. The bytes are already
kept, under `uploads/`, with the run that used them (CLAUDE.md §6b).

---

## Where it lands

Two places, on purpose.

**The file** is the record: `logs/audit-YYYY-MM-DD.jsonl` on the
`RECON_STORE_DIR` volume, beside the uploaded report bytes. One JSON object per
line, one file per day, opened for append with mode `0640`. It survives a
deployment where `DATABASE_URL` was never set — which is exactly the deployment
where somebody is most likely to be poking around.

**The database** is what makes it queryable: an insert-only `audit_log` table
with the standard's fields as columns (`at`, `event`, `outcome`, `category`,
`risk`, `user_id`, `target`) plus the whole event as `line` JSONB, indexed on
time, user and event. So "every high-risk action by this account last month" is
a SQL query, not a grep.

**Recording an event can never stop a run.** The same trade `run-store.js`
makes and for the same reason (CLAUDE.md §6b): `audit.record` builds the line
synchronously, hands it to each sink inside a `try`/`catch` that swallows, and
returns. A full disk or a dead database loses the archive copy of an event; it
does not abandon a run with real receipts already filed. That `record` has no
throwing path is a tested property — the offline suite hands it a throwing sink,
a getter that throws and a cyclic object.

---

## Reading it

**The Security audit log screen**, in the sidebar, behind the same Entra sign-in
as everything else — this is the most sensitive screen in the app, because it is
the one that says what everybody else did. Filters by date range, event type,
risk and account; shows failures and high-risk actions in their own colours; and
exports what is on screen to CSV, because a reviewer wants a file rather than a
screenshot. It reads on arrival rather than polling — a page that polled would
record a read every few seconds under whoever left the tab open.

The event dropdown is built from the **catalogue**, not from what happens to be
in the results, so you can filter to "failed sign-ins" before one has ever
happened — which is exactly when you want to.

Underneath it is `GET /api/audit`:

```
GET /api/audit?from=2026-09-01&to=2026-09-30&risk=high&user=kaushik&limit=500
```

Filters: `from`, `to` (ISO timestamps, string compare), `event`, `user`
(substring), `risk`, `limit` (default 200, max 2000). Returns `{ total, events,
catalogue, standardFields }`, newest first.

The API answers from an in-memory ring of the most recent 5,000 events, for the
same reason every other read in `run-store.js` is synchronous. **Anything older
is in the files on the volume** — that is what they are for.

---

## Known gaps

Stated rather than left to be discovered.

1. **The retention PERIOD has not been set** — RAA has to name it. The
   mechanism is built and tested: set `AUDIT_RETENTION_DAYS` and the sweep runs
   at boot and daily, deleting whole day-files older than the window and the
   matching rows. With it unset **nothing is deleted**, which is the safe
   direction to be wrong in — a log kept too long is an inconvenience, one
   deleted too early is the question nobody can answer. The sweep decides from
   the day in the filename, never a file's mtime, because a restore or an rsync
   rewrites mtime. Deleting log data is itself a change to log data, so the
   prune is recorded *before* the files go.
2. **No forwarding to a SIEM.** Nothing ships to Azure Monitor, Log Analytics or
   Sentinel. `audit.addSink()` exists for exactly this — a forwarder is one
   function, and it needs a workspace and a key from RAA before it can be
   tested against anything real.
3. **No alerting.** The standard's DETECT/RESPOND framing implies someone or
   something is watching. Right now the log is a record to be read, not a
   trigger. `risk: "high"` is on every line so a rule has something to key on,
   and the Security audit log screen filters to high-risk in one click — but
   somebody has to open it.
4. **§3.1.2 (operating system logs) is out of scope here** — see above.
5. **The hash chain is a tripwire, not a signature** — see above. A signature
   would need a key this process does not hold, and would still be re-appliable
   by anyone holding it.

---

*Built 28-Sep-2026 against Logging and Monitoring Standard v1.1, pages 4–5.
Hash chain, retention mechanism and review screen added the same day.
Sections beyond §3.1.3 were not in the extract supplied; anything they require
is not covered here and has not been assessed.*

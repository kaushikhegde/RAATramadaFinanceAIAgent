# CLAUDE.md — rules for working in this repo

Read this before changing anything.

This repo was lifted out of the RAA Travel back-office assistant, which also did
chat, Room-Res hotel quotes, travel insurance and PDF itineraries. The rules
below came with it. Sections 1 and 4 describe things that are **not** in this
repo at all, and are kept because they are standing rules about what must never
appear in it.

---

## 0. WHERE FILES GO

The root holds **the app and nothing else**. A new file belongs in a folder:

| folder | what lives there | how it reaches the root |
|---|---|---|
| `design/` | `recon-ui-mockup.html` (client-supplied, never edited) and `recon-wire.html` | — |
| `fixtures/` | sample workbooks, CSVs, scraped rows the tests read | `path.join(__dirname, "..", "fixtures", …)` |
| `shots/` | render checks; screenshots into `shots/out/` | `require("../server")` |
| `test/` | the offline suite | `require("../recon-core")` |
| `tools/` | build and fixture-making scripts | `require("../recon-core")` |
| `docs/` | everything except `README.md` and this file | — |
| `cheat-sheets/` | the supplier name sheet | — |

At the root: `server.js`, `recon-core.js`, `recon-run.js`, `run-store.js`,
`xlsx-lite.js`, `xlsx-write.js`, `tramada-*.js`, and the config.

**Do not put a test, a shot or a tool in the root**, even if a `package.json`
script would still find it there. It was flat once, the folders were added
afterwards, and for a while both copies existed and drifted — the newer one at
the root, the correctly-pathed one in the folder. Every script in
`package.json` names its folder. Keep it that way.

---

## 1. NEVER USE JETSTAR. EVER.

**Do not write, restore, reference, import, suggest, or "helpfully" reinstate any
Jetstar code, and do not automate jetstar.com or any other airline website.**

This project does not book anything. It reconciles payments that were made
elsewhere. If a task looks like it needs an airline site, it does not — ask.

There is no `jetstar/` folder here and none is coming. Also banned:

- the word "Jetstar" in any user-facing string, comment, log line, variable,
  function name, filename, or npm script;
- any prompt text telling the user that "an airline needs/requires" something —
  no airline is involved;
- `SKIP_JETSTAR` and any equivalent flag.

---

## 2. What this project actually is

The bank reconciliation half of that assistant, on its own. One page, one job.

| | |
|---|---|
| **Tramada (TTMS)** | `tramada-*.js` — bookings, segments, receipts |
| **The rules** | `recon-core.js` — pure, tested, no browser anywhere near it |
| **The browser** | `recon-run.js` — pages and clicks, no judgements |

```
public/index.html ⇄ WebSocket ⇄ server.js ⇄ recon-core.js   (decides)
                                          ⇄ recon-run.js  → real Chrome on CDP :9222
```

**No model is involved.** There is no chat here and nothing to converse with:
a report goes in, a run happens, rows come back. That is deliberate — a
reconciliation that files real receipts has no business being talked into
anything.

**If you find a rule being decided outside `recon-core.js`, it is in the wrong
place.** That separation is why the allocation logic can be tested against
captured page values instead of against a live financial form.

Run it: `npm run start:chrome` in one terminal, `npm start` in another, then
http://localhost:3000. See README.md.

---

## 3. Money and consequences

Most of what this app does is irreversible and financial. The conventions below
are not style preferences.

- **Dry-run first.** Anything that commits (receipts, policies) previews before
  it commits. `dryRunReceipt` defaults to `true`. Follow that pattern.
- **Confirmation gates go through `intent.js`.** Never write an inline
  `/yes|confirm|go/` test. That is exactly the bug that made `"no, don't run
  it"` run the pipeline. `readConfirmation()` returns `yes` / `no` / `unclear`,
  refusal wins, and **`unclear` must never be treated as yes**.
- **Stop and ask rather than guess.** When only a human can answer, throw an
  `Error` with a `needs*` property (`needsCreditor`, `needsCity`, `needsPhone`,
  `needsDeclaration`) carrying the context the question needs. Throw it
  **before** the destructive step so the run can be resumed with the answer.
- **Never invent a number.** No booking numbers, amounts, references, premiums
  or policy numbers that did not come back from a real page.
- **Assert, don't assume.** Read the value back after setting it; check for the
  error box after saving; verify a premium adds up before filing it.

---

## 4. Card data

**Card numbers never go anywhere near this project, because nothing here takes
one.** There is no card form, no vault and no payment capture: a run reads a
report, files receipts against bookings, and reads a statement page.

If a future change looks like it needs a PAN, it does not belong here — the
original repo has `card-vault.js` and the rules that go with it. Adding card
handling to a service with no UI for it and no redaction on its socket is how a
PAN ends up in a log file.

---

## 5. Browser automation conventions

`recon-run.js` is the reference implementation here.

- `openBrowser(onProgress)` — CDP connect, never a throwaway Chrome, and fail
  with a message naming the portal.
- Auth check hits a **protected page**, never the login page (a login route
  serves its form even when you are signed in).
- **Never type credentials.** The human signs in; `ensureLoggedIn` polls for up
  to five minutes and `onNeedLogin()` tells them to.
- Sticky page (`_sticky` + `closeXPage()`) when the flow spans a human question.
  The **caller** owns the release.
- `finally`: close the tab on success, **leave it open on failure** so the
  broken form is inspectable. Always `browser.close()` (CDP: drops the
  connection only).
- Callbacks: `onProgress(pct, msg)`, `onStage(name, data)`, `onError(msg)`,
  `onNeedLogin()`. Wrap every run-level function in
  `try { … } catch (err) { onError(err.message); throw err; }`.
- Angular/React pages ignore `element.value = x`. Use `reactSet()` (native
  prototype setter + `input`/`change`). **PrimeNG calendars ignore even that** —
  they need real keystrokes.
- Autocompletes: type, wait for the suggestion, click, **then verify**. A click
  that appears to land often does not.
- Read the field map before touching a portal: `docs/tramada-field-map.md`.

---

## 6. Discover, don't hard-code

Read what the page says; never encode today's answer as tomorrow's bug.

- **Grid columns come from the header row, never from a position.** The Bank
  Statements grid opens with an `Action` column, and counting from zero put the
  page number on the word `TRUST` — nine existing pages read as none, and the
  run tried to create page 1 on an account holding 1–9. Same rule for the CSV,
  the workbook and the transaction list. `recon-core.mapColumns`.
- **The next statement page is read fresh every run**, never remembered. A
  second run in a day has to land after the page the first one made.
- **An empty result list only means "nothing there" when the screen says so.**
  Otherwise it means the list did not render, and computing anything from it
  invents a number (§3).
- **Never confirm a write by its URL.** The reconcile screen has two routes and
  creating a statement lands on the one that looks like the form you submitted,
  so a page created perfectly well was reported as a failure. Confirm by what is
  on screen.
- **A readonly input accepts everything you type and keeps none of it.** No
  error, no exception, no change. Tramada ships the statement balances readonly
  behind an unnamed `Edit` button, which is how the opening balance went missing.
  Click Edit, assert `readOnly` actually cleared, type, read back.
- **Setting `.checked` is not ticking a box.** Both the receipt form's segments
  and the reconcile screen's transactions hang their arithmetic off a bound
  click handler. Real clicks, then verify — and expect the row to move, because
  the reconcile screen's handler reorders the table under you.
- **Sort submits; filter does not.** `#sortButton` is `type="submit"` and comes
  back having wiped every tick. `#filterButton` is `type="button"` and only
  hides rows in the page already on screen. That is the whole reason two report
  types can share one statement page: sort once, then swap the filter per
  report and the ticks made under the first one survive.
- **Two reports = one run, never two concurrent ones.** `runTramadaReceipt`
  closes the shared CDP browser in its `finally`, so a second flow running
  alongside would close the first's page mid-run with real receipts already
  filed. `runCombinedReconciliation` does both in order, on one page.
- **The run commits the statement page** (`#done`), as of 10-08-2026. Only rows
  it positively matched are ticked, never `Select All`; every tick is verified
  before Done; nothing matched means Done is not pressed. If you are relaxing
  any of those three, you are removing the only thing between this and
  committing a page it never read.

---

## 6b. Every run is written down

`run-store.js` — `uploads/` on disk for the report exactly as it arrived,
**Postgres** (reached over `DATABASE_URL`) for the run. The Run overview screen
reads this store and nothing else. The store keeps an in-memory cache of every
run, loaded from Postgres by `init()` at boot and kept in step by each write, so
its public functions still return synchronously and the reads never touch the
wire per request. With no `DATABASE_URL` it runs on that cache alone — offline,
un-persisted — which is what keeps the test suite offline (§7).

- **Keep the bytes, not just the parse.** "What was actually in the file" is the
  only thing that settles a disputed figure weeks later. The bytes stay on the
  `RECON_STORE_DIR` volume in `uploads/`, **not** in Postgres — a database backup
  has no business carrying binary report files; only the `file` metadata is
  stored with the run.
- **Write a row when its verdict is known, not at the end.** A run that dies on
  row 7 has filed six real receipts and nothing rolls back. `patchRow` enqueues
  its `UPDATE` the moment it is called, from the same `onRow` callback that feeds
  the page.
- **Recording a run must never be able to stop one.** Every store write updates
  the cache synchronously and then enqueues the database work on a serial FIFO
  chain whose failures are swallowed. A database that is down, slow or read-only
  is a reason to lose the archive copy; it is not a reason to abandon a run with
  receipts already filed — and the FIFO chain is what stops two enqueued writes
  from racing or reordering.
- **Postgres owns durability now.** There is no file to corrupt, so the old
  "a `runs.json` that will not parse is moved aside, never overwritten" drill is
  gone. Its replacement is the round-trip test in `test/test-store-pg.js`, which
  proves a run written by one process is read back whole by the next; it runs
  only when a `DATABASE_URL` is given and is deliberately **not** in `npm test`.
- The figures themselves are decided in `recon-core.js` (`runTotals`,
  `overviewFrom`) and tested offline — **never** re-implemented as SQL
  aggregates, which would drop them out of those offline tests. `listRuns()`
  reads rows out of the cache and hands them to `overviewFrom`. A dashboard is
  the one screen whose being wrong is invisible — every figure on it looks like a
  figure, and nobody
  re-adds one.

---

## 7. Tests

```
npm test          # everything, offline, no browser
```

Offline tests only — no network, no Playwright, no mocks of Playwright.
Fixtures are **verbatim captured page text**, with the source and date in a
comment, so a regression surfaces here instead of halfway through a live run.

Harness is nine lines of `check`/`ok` and `process.exit(fail === 0 ? 0 : 1)`.
No framework. Match the existing style.

When you fix a bug, add the input that caused it as a test case with a comment
saying what it used to do.

---

## 8. Comments

Explain **why**, and specifically what went wrong that made the line necessary.
The existing code does this well — keep it up:

```js
// Longest first — "credit card swipe" has to win over "credit card". "cc" is
// deliberately NOT an alias: references like `CC-1234` are real, and mistaking
// one for a payment type would file the reference as the method and lose it.
```

A comment that restates the code is worse than none.

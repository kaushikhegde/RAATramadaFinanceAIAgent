# CLAUDE.md — rules for working in this repo

Read this before changing anything.

This repo was lifted out of the RAA Travel back-office assistant, which also did
chat, Room-Res hotel quotes, travel insurance and PDF itineraries. The rules
below came with it. Sections 1 and 4 describe things that are **not** in this
repo at all, and are kept because they are standing rules about what must never
appear in it.

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

**Where a new file goes.** Everything `npm start` loads sits at the root —
`server.js`, `recon-core.js`, `recon-run.js`, `run-store.js`, `xlsx-*.js`,
`tramada-*.js` — and everything else is in a folder:

| | |
|---|---|
| `test/` | `npm test`. Offline, no browser. New test goes here. |
| `shots/` | `npm run shots`. Render checks; their PNGs go to `shots/out/`. |
| `tools/` | The build and the one-off CLIs — `build-recon.js`, `make-fixtures.js`, `run-bookings.js`, `statement-csv.js`, `probe-payment-form.js`. Nothing the server requires. |
| `fixtures/` | Sample reports and workbooks the tests and tools read. |
| `design/` | `recon-ui-mockup.html` + `recon-wire.html`, the build's two sources. |
| `docs/` | The field map, the BPay conformance notes, the history. |
| `public/` | The built page. Generated — see §"never hand-edit" in README. |

`uploads/`, `runs.json` and `csv_uploads/` are written by a run and stay at the
root, because `run-store.js` resolves them from its own `__dirname`. **A module
the server requires does not move into a folder** without every `require` in
`server.js` and the `tramada-*` chain moving with it.

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
- **The closing balance is Westpac's, not a copy of the opening one.** It used
  to be `typeInto("#closingBalance", carried)` — the same figure in both boxes,
  so the variance was $0.00 by construction and the one check a bank statement
  exists to perform could not fail. It comes from the dashboard now, and a run
  without one stops rather than inventing one.
- **A label is a whole line, not a substring.** `grab("Debtor")` finds the word
  **Debtors** in the navigation bar and comes back with `"s"` — and then every
  booking in the file is reported as the wrong debtor. Match the line that IS
  the label, and take the next non-empty line.
- **Read a dropdown's value off the `<select>`.** `Level 1 Branch` reads
  `[WEST] RAA West Croydon`; the preferred consultant three fields above it
  reads `Kaushik Hegde [ADL]`. A text scrape for `[XXX]` takes whichever comes
  first, which is a wrong shop on every booking that consultant made.

---

## 6c. The BPAY guide is the specification, and it is not always right

`Reconciliation Guide — BPAY` (RAA Finance) is what the BPay half of this repo
implements: 35 steps and BR01–BR14. Three things follow.

**Its exact words go in the Remarks column.** `recon-core.REMARKS` holds them
once. "Please allocate" retyped as "please allocate" is a remark that stops
grouping with its own kind on a spreadsheet somebody sorts by hand.

**No partial allocation.** BR07–BR11 allow three ticks — one whole segment, all
of them, or all of them on an overpayment — and nothing else. `decideAllocation`
used to run a subset-sum search and report "Part allocated"; choosing which of
two identical segments a part-payment belongs to is the judgement the guide
reserves for a person, and the old code made it silently and filed it.

**Where it disagrees with the screen, the screen wins — loudly.** Steps 11 and
30 ask for a *Debtor Payment Receipt*; the booking Receipts screen has never
offered one (`docs/tramada-field-map.md` §4b, measured 06-08-2026 and again
17-08-2026) and every receipt this system has filed is a Client Payment Receipt.
The code files what the screen can file, selects it **by label**, and throws
with the real option list when it is missing — so an instance that genuinely
differs stops the run instead of filing under something else. Raise the
disagreement with Finance; do not settle it by guessing.

**Not implemented yet, deliberately:** BR12 (one bank statement per day — today
each run creates its own page, see §6 above) and step 35 (emailing the
spreadsheet to TAccounts@raa.com.au — nothing here sends mail, and putting an
SMTP credential in a service with no redaction on its socket is the §4 mistake
in a different costume).

---

## 6b. Every run is written down

`run-store.js` — `uploads/` for the report exactly as it arrived, `runs.json`
for the run. The Run overview screen reads this and nothing else.

- **Keep the bytes, not just the parse.** "What was actually in the file" is the
  only thing that settles a disputed figure weeks later.
- **Write a row when its verdict is known, not at the end.** A run that dies on
  row 7 has filed six real receipts and nothing rolls back.
- **Recording a run must never be able to stop one.** Every store call at the
  server boundary swallows its own failure. A full disk is a reason to lose the
  archive copy; it is not a reason to abandon a run with receipts already filed.
- **A `runs.json` that will not parse is moved aside, never overwritten.** It is
  somebody's record of money that moved, and it became interesting at exactly
  the moment it stopped parsing.
- The figures themselves are decided in `recon-core.js` (`runTotals`,
  `overviewFrom`) and tested offline. A dashboard is the one screen whose being
  wrong is invisible — every figure on it looks like a figure, and nobody
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

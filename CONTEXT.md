# CONTEXT.md — what a new session needs to know

This repo is the bank reconciliation half of the RAA Travel back-office
assistant, lifted out on 07-08-2026. Only the reconciliation notes came with it;
the chat, Room-Res and insurance history stayed behind in `booking-automation`.

**Standing rule: do not run `git` through `device_bash` — not even reads.**

Start with README.md for what the thing does. This file is the archaeology:
what bit, and why the code looks the way it does.

---

## 1. State

Working, and never yet run end to end against Tramada.

- **Offline:** 223 assertions pass. The page renders, an upload previews, a run
  starts, the frames arrive and the table fills in. All of that is verified.
- **Live:** the receipt half has filed real receipts (`R.0000009401`,
  `R.0000009402`, allocated correctly). The statement half has created page 10.
  Nothing has yet run all the way through **create page → sort → filter → match**
  in one go, because each attempt found a new thing (see §3c, §3d).
- The Mint flow has never been run live at all.

The one thing that cannot be checked here: whether `Creditor Payment` is the
Rec/Pay Type Mint settlements actually post under. If it is not, it is a
one-line change in `recon-run.js`.

---

## 2. Finance → Bank Statements is now mapped

Read live on 06-Aug-2026 through the Chrome extension. Full map in
`docs/tramada-field-map.md` §5 — routes, both forms' field ids, the filter
controls, and the real dropdown vocabularies.

Three things there that would each have cost a run:

- **Filtering hides rows, it does not remove them.** Page 9 filtered to Debtor
  Payment Receipt: **4,242 rows in the DOM, 47 visible.** A scraper reading
  `tbody tr` gets everything and looks like it filtered. Read
  `tr.offsetParent !== null` only.
- **Opening and Closing Balance are optional on the new-statement form** — only
  Bank Account, Page Number and Statement Date are required. That is why they
  have to be asked for in chat: the form takes a statement without them.
- **`#recPayType` and the grid use different strings.** The filter offers
  `EFT`; the grid cell says `ET`.

Trust Account holds pages 1–9, so the next page is 10. `statement-rows.json`
holds six real Debtor Payment Receipt lines captured from page 9, and
`tramada-statement-lines.csv` is generated from them.

**Reconciliation matches the RECEIPT NUMBER against `Trans. No`, not the
reference.** The receipt form hands back `R.0000009403` and that same number is
the reconciliation grid's `Trans. No`. Matching reference-to-reference was
comparing free text a consultant typed, on rows the run did not create.
`recon-core.receiptKey()` normalises case, punctuation and zero padding — fine
for a machine-issued identifier, deliberately not done to references — and keeps
the letter, so a `P.` payment never matches an `R.` receipt. A row whose receipt
failed now says "nothing to look for" rather than blaming the statement.

**Sort first, then filter — sorting clears the filter.** `#sortButton` rebuilds
the list and drops `#filterColumn`/`#recPayType`. `filterAndRead()` sorts, then
re-selects the filter column (the rebuilt screen has it blank again), filters,
and asserts `#recPayType` still reads the type it asked for.

**Creating a statement lands on `finance-statement.htm`, not
`finance-statement-generation.htm`.** The reconcile screen has two routes and
creation lands on the one that looks like the form just submitted. The run
checked for the other, so page 10 was created, rendered on screen, and reported
as "The new statement wasn't created". Success is now confirmed by the screen —
heading `Reconcile Bank Statement Page {n}` plus `#filterColumn`/`#sortBy` —
which also lets it assert the page number it landed on. Alongside that, the
failure message was built by scanning every `<td>` for the word "error" and
found a transaction whose Reference read `July Staff Errors`, so a successful
run reported *"Tramada said: July Staff Errors"*. Error containers first now,
then a tight phrase match, never a data cell.

**The search results grid opens with an `Action` column.** Read positionally,
`pageNo` lands on `"TRUST"`; nine existing pages were all discarded as
unreadable page numbers and the run answered "start at page 1" while the grid on
screen showed 1–9. Both statement grids are now read **by header name** through
`recon-core.mapColumns` / `rowsByHeader`, which is tested against the captured
headers — the browser reads text out, node decides which column is which. This
is the `parseReconCsv` rule applied where it was missing.

**Changing the bank account posts the form back — on BOTH statement screens.**
Found in a live run 07-08-2026. The `<select>` submits on change and returns a
fresh document with `#pageNumber` reset to its default of 1. On the search form
this meant `#searchButton` was clicked mid-postback and the result list came
back empty; zero pages reads as "no statements", so the next page number was
computed as 1. On the new-statement form it meant the typed page number was
reset. Both ended at *"Page Number already exists for bank account 'TRUST'"* on
an account holding pages 1–9. `selectAccountAndWait()` now detects the reload
(hold a node, watch it detach) and asserts the account stuck; the read-back moved
to immediately before Continue, after a settle; and an empty result list only
means page 1 when the screen actually says so — otherwise the run stops rather
than guessing a number. Full note in `docs/tramada-field-map.md` §5.

---

## 3. Two reports: BPay receipts, and the Mint daily settlement

Two files, two shapes, two jobs. **A run creates its own statement page, so only
one report can run at a time** — the UI holds both but Start run refuses while
both are loaded and says why.

| | BPay receipts CSV | Mint daily settlement |
|---|---|---|
| File | `.csv`, parsed in the browser to preview and re-parsed server-side | `.xlsx`, sent to the server whole and parsed there |
| Columns | Date, Reference, Rec/Pay Type, Amount, Booking No | Transaction Reference, Amount, To Company |
| Files receipts | **yes**, one per row, allocated by whole segments | **no** — nothing is written |
| Statement filter | `Client Payment Receipt` | `Creditor Payment` |
| Reconciled when | the receipt number it was handed is a `Trans. No` on the page, at the same amount | the transaction reference is a `Trans. No` on the page |
| A difference | wrong amount ⇒ **Not reconciled** | wrong amount or company ⇒ **Reconciled**, difference reported |

The Mint asymmetry is deliberate and was asked for: a settlement that arrived
for a different figure *did arrive*, and reporting it the same as one that never
came would send someone looking in the wrong place. The difference goes in the
`Why` column and into a `Check the difference` chip.

**`xlsx-lite.js` reads the workbook with no dependencies.** `device_bash` has no
network, the project is offline by design (CLAUDE.md §7), and an .xlsx is a ZIP
of XML that node's own `zlib` can open. It handles shared strings, inline
strings, numbers and booleans; it does NOT do formulas beyond their cached
value, styles, or date conversion — a date arrives as Excel's serial number,
because nothing here needs dates.

Two things it gets right that a quick version would not, both caught by testing
against the client's actual `mint.xlsx`:

- **Self-closing tags come first in every regex alternation.** Written the other
  way round, `<c r="O2" s="12"/>` has no `</c>` of its own, so the lazy match
  runs on and closes on the *next* cell's — swallowing it. The sample's empty
  Settlement Amt cell ate the Statement Date beside it and every row came back
  one column short.
- **Cells are placed by their `r` reference, not pushed in document order.** A
  sparse row omits its empty cells entirely, so appending would slide every
  later value left. That is the same column-shift this project has now been bitten
  by three times.

**Amounts are normalised for display.** A workbook stores what the binary float
holds, so `10383.96` arrives as the string `10383.959999999999` and the inbox
showed it verbatim beside a company name. `parseMintRows` sets `amount` from the
cents and keeps the original in `rawAmount`. The comparison was never affected —
`cents()` rounds — it just looked like a fault in the file.

---

## 4. `public/index.html` is generated — never hand-edit it

The client wants their mockup verbatim, and the mockup keeps changing. So the
page is reassembled rather than patched:

    node build-recon.js
    # public/index.html ← recon-ui-mockup.html + recon-wire.html

`recon-wire.html` holds the only three additions, split by `<!--@CSS-->`,
`<!--@NAV-->` and `<!--@SCRIPT-->`. `build-recon.js` dies if an anchor
(`</style>`, `<header class="top">`, `</body>`) has gone and warns if a wiring
hook id has. Editing `public/index.html` by hand means losing the edit the next
time the client sends a mockup — put it in `recon-wire.html` instead.

**The mockup's own `<script>` is DISABLED at build time, and has to be.** It is
not a styling prototype — it is a working demo with ~90 KB of state, an
`UPLOADS` store, a source-type detector, and `document.addEventListener('click')`
and `('change')` delegates that catch every event in the page.

Two scripts therefore ran, and the demo won the arguments that mattered:
uploading one CSV redrew the Sources screen with FIVE reports (Westpac, Mint,
BPay, passenger refunds, Nuve) out of its own fixtures, its "Process all 1"
button did nothing because the real run is not what it calls, and the inbox
showed demo rows. Cloning `#filePicker` and `#startRun` to strip their listeners
was the first attempt and it could never have worked — **a delegate on
`document` is not attached to the node.**

`build-recon.js` rewrites the tag to `type="text/x-mockup-demo"`, so the source
stays in the file exactly as the client wrote it and the browser does not run
it. The only thing it did that the page needs — `go(id)` screen switching — is
reimplemented in `recon-wire.html` (toggle `.on` on `.screen`, `.nav-item` and
`.rbtn`, set `#topTitle`), which is why the build now also warns if `data-go`,
`#topTitle` or `.screen` disappear.

What that leaves is dead demo furniture, which is wired or hidden rather than
left to look real: the inbox's report/date/shop selects are hidden (this run has
no such concepts), status and search are wired to the real rows, the sidebar's
`27` badge counts rows that are not both allocated and reconciled, the "Ask the
agent" panel and its launcher are hidden, and the sidebar's "Agent brain" card —
"87% of lines coded without a human this week" — is tagged `sample`, because it
is on every screen including the two real ones.

**Switching the demo off also took away things worth having, and those get
rebuilt rather than dropped.** The first casualty was the source card: the demo
drew a `.dz` tile per report and, once it was gone, an upload showed nothing but
a line of text. `renderSource()` rebuilds it in the same markup — `.dz.done`,
`.di`, `h4`, `.file`, `.result`, `.actions` — with only measured facts in it:
the file's own name and size, the row count, the balances typed above, the
number of distinct bookings and the money about to be receipted. Its badge
tracks the run (`not run yet` → `running…` → `processed`).

The card is titled **"BPay receipts CSV"** — the client's name for this file.
That is a fixed label, not a detection: nothing here works out what kind of
report was dropped in. The demo's detector is what turned one upload into five,
and there is no equivalent; the CSV is read by its headers and that is all.

`Preview` on the card opens the parsed rows in place. `readyNote` has always
promised "the preview below is the only check before it does", and until now
there was no preview for it to mean.

The wiring leans on almost nothing in the mockup: one real id (`inboxGrid`),
everything else `querySelector`. That is deliberate — the 06-Aug mockup dropped
four whole screens (Auto-coding, Exceptions, Agent performance, Rules) and the
rebuild was clean.

**`markSamples()` marks screens the wiring does not drive, and it must not
assume a screen has a header.** It tagged `.page-h` only, and the new mockup's
Run overview opens straight onto its hero band — so that screen showed 84%
complete, 412 of 489 lines and −$7,252,720.99 of invented balances with nothing
saying they were invented. A screen with no `.page-h` now gets a banner across
the top instead. Screenshot every screen after a rebuild, not just the wired
ones; that is what caught it.

---

## 5. Upload → run: the frames, and why the pipe being connected wasn't enough

    pane  ──recon_run{rows, statementDate, openingBalance, closingBalance}──▶ server.js
    pane  ◀──recon_progress{message, ok}   every step of runReconciliation
    pane  ◀──recon_login{message}          a human has to sign in; the run waits 5 min
    pane  ◀──recon_row{n, row}             a patch merged into that row
    pane  ◀──recon_done{pageNumber|error}  the run is over

**The wiring was all there and the feature still looked dead**, because the pane
handled `recon_row` and `recon_done` and dropped everything else. A run is
minutes long — several page loads per row before a receipt exists — so the
screen showed "running" badges and then nothing at all. Worse, the sign-in
prompt was a `recon_progress` frame, so the one message that needs a human to
go and DO something was the one message never shown; the run then waited its
five minutes and failed. **Connected is not the same as visible. Drive the page
and watch it, or this class of bug ships.**

Four more found the same way, all invisible to node tests:

- The stop reason was written straight into `#ibLede` and then wiped by the next
  `render()`. A failed run reported "0 allocated, 0 reconciled" and never said
  why. Anything a repaint has to keep must live in state, not in the DOM.
- Raw Playwright messages went into the Why column — a paragraph of ANSI escape
  codes with the reason buried inside. `core.tidyError` now cuts the call log,
  and closes the `[` that the cut leaves hanging (wrappers embed the inner
  failure as `... [${err.message}]`, so the cut lands inside the brackets).
- Rows the run never reached kept saying "Pending" as though a check were still
  coming. They say **"Not checked"** now — deliberately not "Not reconciled",
  which would claim something was looked at.
- "1 rows".

`shot-recon-run.js` replays a scripted run over a stub WebSocket and photographs
the inbox midway and finished. **It proves nothing about the automation** — the
frames are hand-written and Tramada is never opened — but every bug above was
obvious in its screenshots and invisible everywhere else. The rules are tested
for real in `test-recon-core.js`; this covers the half that only fails when you
look at it.

The run's own activity feed is the mockup's `.card` + `ul.tl` timeline, in the
inbox's 316px column — the same object the Run overview screen has full of
invented lines, with real content in it.

---

## 6. Dummy data

`tramada-statement-lines-dummy.csv` — six `Debtor Payment Receipt` credit rows
pulled from **Bank Statement Page 9** in the Tramada sandbox, with a `Booking No`
column of randomly assigned numbers.

Two things to know if it gets reused:

- **The booking numbers are random pairings, not the real booking for each
  receipt.** Fine for a mockup, wrong for measuring a matcher's accuracy.
- On Page 9 the `Debtor Payment Receipt` type has only **two** payees ever
  (`RAA of SA Limited (Retail)`, `RAA Group`), so payee is nearly useless as a
  matching signal — the reference does all the work, and those references are
  wildly inconsistent (`Deposit - Jill Shields`, `Trip File Tsfr 1105`,
  `VIX122334`, bare `NW`, `PROMO`).

The Tramada reconcile screen holds ~4,200 rows; the ten visible in a screenshot
are a thin slice. Read the page, don't infer the vocabulary from an image.

---

## 7. Working notes

- **`device_stage_files` caches per path: the FIRST stage of a path is fresh,
  every later stage of that same path returns the first copy.** It reports the
  live `bytes` and `mtimeMs` while delivering the old bytes, so the response
  looks right — only the content is wrong. `/mnt/user-data/uploads/` is
  read-only, so the stale copy cannot be deleted and the path is spent.
  Measured 06-Aug-2026: `recon-ui-mockup.html` came back 140,776 bytes against
  167,890 on disk; `public/recon.html` staged correctly the first time, then
  returned that same first copy after a rebuild, `bytes` field and all.
  **Compare `md5sum` on both sides — sizes and mtimes will agree when the
  content does not.** To move a changed file device → container, either read it
  through `device_bash` (gzip + base64, ~20 KB of base64 per call) or apply the
  same edit to both copies and verify by `md5sum`.
- `npm test` runs offline by design — it is offline by design, and the
  device already has `node_modules`. Only `git` is off limits there.

- **Screenshot the thing before believing it.** `shot-recon.js`,
  `shot-recon-run.js` and `shot-mint-run.js` exist to make looking cheap. Every
  bug in the pane's neighbourhood was invisible to the test suite and obvious in
  a picture.
- **A duplicate `function` declaration is not a lint nit.** The later one wins
  for the whole module. That cost a day in the repo this came from.

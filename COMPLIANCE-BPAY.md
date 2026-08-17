# BPay compliance against *Reconciliation Guide — BPAY (daily)*

Steps 1–34 (step 35, the email, out of scope) and BR01–BR14.

Audited 17-Aug-2026 against the code as it then stood; **implemented the same
day**, so this file now reads as a record of what was done rather than a list of
gaps. The "before" column is kept deliberately — several of the changes reversed
behaviour that was itself deliberate, and the reason it was that way is worth
having when somebody asks why it changed.

---

## Verdict

**Yes, with three items still open.** Every step and business rule that the code
can settle on its own is implemented and tested. What remains needs someone
outside the code to answer — the three under *Still open* at the bottom.

| | DONE | PARTIAL | MISSING |
|---|---|---|---|
| Steps 1–34 (39 rows, counting 5.1–5.4 and 17.1–17.5) | **34** | 4 | 1 |
| BR01–BR14 | **13** | 0 | 1 |

Every `PARTIAL` on a step is a navigation difference — the run reaches a screen
by URL where the guide clicks a menu — with one exception (step 29/32, the
filter, noted below). The single `MISSING` on both counts is step 30 / BR12's
second clause, and both are decisions rather than defects.

Tests: **694 offline assertions** (`npm test`) and **110 render checks**
(`npm run shots`). The BR rules are `test-bpay-rules.js`; the columns and the
exported file are `shot-bpay-rules.js`, which drives the built page.

---

## Steps 1–34

| Step | Verdict | Evidence | Note |
|---|---|---|---|
| 1 · Upload the BPay spreadsheet | DONE | `recon-wire.html:48` now accepts `.csv` **and** `.xlsx`; workbook path `server.js:100`, `:120` `bpay: reconCore.parseReconRows` | Was CSV-only. A BPay workbook was read as text and refused with "the header is missing" while the identical container from Mint went through. |
| 2 · Login, Bookings → Search | PARTIAL | `tramada-receipt.js:147` `ensureLoggedIn`; `:284` `goto(...booking-summary.htm)` | Same destination, different route. The run never types credentials — a human signs in. |
| 3 · Booking no. → Search | DONE | `tramada-receipt.js:284`; landing checked `:311`; order `recon-run.js:1098`; BR01 remark `recon-core.js:202` | Top-down, continues with the next row on failure, and a line with no booking number now carries *"No booking number found"* into the report instead of vanishing. |
| 4 · Departure date is future | DONE | scraped `tramada-receipt.js:307`; compared `recon-core.js:isPastDate`; used `recon-run.js` gate | Day granularity, UTC, three date formats. Unreadable is `null`, never `false`. |
| 5.1 · owing + future → continue | DONE | `recon-core.js decidePreReceipt` → `{proceed:true, remark:""}` | |
| 5.2 · owing + past → remark, continue | DONE | same, remark `REMARKS.departurePassed` | The receipt is still raised; the remark is a warning, not a stop. |
| 5.3 · nothing owing + future → **STOP** | DONE | gate returns `proceed:false`; `recon-run.js` `continue`s before the commit call | Previously filed an unallocated receipt anyway. |
| 5.4 · nothing owing + past → **STOP** | DONE | same, remark `REMARKS.noOutstandingPassed` | |
| 6 · Debtor = "RAA of SA Limited (Retail)" | DONE | `recon-core.js RETAIL_DEBTOR`; compared trimmed and case-folded | Blank counts as wrong, and the reason names what was found instead. |
| 7 · Cons1 → Consultant column | DONE | `tramada-receipt.js:309` `consultant: grab("Cons1")` → `recon-run.js` → export | Cons1 is on the summary page the run already opens, so it costs no extra navigation. |
| 8 · Click Profile | DONE | `tramada-receipt.js:343` `getBookingBranch` opens `booking-profile.htm` | By URL. Only on the read pass, so the page is opened once per row. |
| 9 · Level 1 Branch → Shop column | DONE | same function; bracketed shortcode extracted (`[ADL]` → `ADL`) | **Never throws.** This page's markup has not been measured against the live portal, so a branch that cannot be read is a blank cell and a note, not a stopped receipt. |
| 10 · Booking Receipts page | DONE | `tramada-receipt.js:446-450` | |
| 11 · "Debtor Payment Receipt" + Add/Issue | PARTIAL | `tramada-receipt.js:474`; no `#receiptCategory` selection | **Open question 1.** Measured live on booking 13127: this form offers no Debtor Payment Receipt option at all. |
| 12 · Transaction Type = EFT | DONE | `recon-run.js:995` → `tramada-receipt.js:480` | |
| 13 · Payer name = "BPAY" | DONE | `recon-run.js` `BPAY_PAYER = "BPAY"`, passed on both the probe and the commit | Was the booking's client name, asserted as a business rule in two comments. Both corrected. |
| 14 · Date received | DONE | `recon-run.js:998` → `tramada-receipt.js:488` | |
| 15 · Amount received | DONE | `recon-run.js:996` → `tramada-receipt.js:490` | |
| 16 · Reference ← "Receipt No" | DONE | `recon-core.js HEADERS.reference` now includes `receipt no`, `receipt no.`, `receiptno`, `receipt number` | A sheet headed `RECEIPT NO` used to be refused outright. `Rec/Pay Type` is now optional — the guide's file has no such column. |
| 17.1 · = one segment → tick it | DONE | `recon-core.js decideAllocation`, BR07 branch | |
| 17.2 · = all segments → tick all | DONE | BR08 branch → `"ALL"` → `#selectAll` | |
| 17.3 · ambiguous → tick nothing | DONE | falls through to the BR09/BR10 branch, `allocation: []`, remark *"Please allocate"* | Was: ticked the best-fitting subset and reported "Part allocated". |
| 17.4 · no match → tick nothing | DONE | same branch; the prose distinguishes it from 17.3 | |
| 17.5 · overpayment → tick all + remark | DONE | BR11 branch, remark *"Overpayment, please check"* | |
| 18 · Click Issue | DONE | `tramada-receipt.js:1100`; success only on a real `R.…` number | |
| 19 · Loop to next row | DONE | `recon-run.js:984` with per-row try/catch | |
| 20 · Finance tab | PARTIAL | `recon-run.js:250` `goto(.../finance-statements.htm)` | Route reached by URL. |
| 21 · Bank Statements nav | PARTIAL | same | |
| 22 · Reconcile New Statement + Continue | DONE | `recon-run.js:252-253` | |
| 23 · "[TRUST] Trust Account" | DONE | `recon-run.js:920`, asserted `:149` and again before submit | |
| 24 · Page number = latest + 1 | DONE | `core.nextPageNumber`, retries forward on "already exists" | |
| 25 · Statement Date from the BPay sheet | PARTIAL | `recon-run.js:284`, from `#rcDate` | A human types it and it is verified on the form, but it is not derived from the file's own dates. **Open question 3.** |
| 26 · Opening balance appears | DONE | `recon-run.js:297`, throws if absent | Left exactly as Tramada presents it. |
| 27 · Closing Balance from the dashboard | DONE | `recon-run.js:310-313` types the given figure; `:351` checks it took | Was copied from the opening — which makes the variance $0.00 by construction whatever was banked. With no figure given the opening is carried across and the log says so. |
| 28 · Continue | DONE | `recon-run.js:365`; confirmed by heading and controls | |
| 29 · Column = Rec/Pay Type | PARTIAL | `recon-run.js:504`, gated by `filterFor(combined)` | Applied on a single-report run, skipped when several run together — as requested on 11-Aug. `RECON_APPLY_FILTER=true` forces it. |
| 30 · Filter by = Debtor Payment Receipt | MISSING | `recon-run.js:523` uses `"Client Payment Receipt"` | Deliberate. **Open question 1** — filtering to Debtor Payment Receipt would match the pre-existing lines the file was scraped from and never see what the run filed. |
| 31 · Click Sort | DONE | `recon-run.js:473`, unconditional | Runs *before* the filter on purpose: sorting clears the filter, so the guide's order would silently leave every row showing. |
| 32 · Click Filter | PARTIAL | `recon-run.js:507`, same gate as 29 | |
| 33 · Cross-check Reference + Amount, tick | DONE | `recon-core.js:340,347` — both must match; tick verified `recon-run.js:821` | Matches on Tramada's Trans. No against the receipt number Tramada handed back, which is the same identity the guide is pointing at and a stronger one than the grid's Reference column. |
| 34 · Sort output by Shop, then Consultant | DONE | `core.sortForFinance`, and the same rule in `recon-wire.html` where the file is built | Blanks sink to the bottom; ties keep the uploaded order. |

---

## BR01–BR14

| BR | Verdict | Evidence |
|---|---|---|
| **BR01** "No booking number found" | DONE | `recon-core.js REMARKS.noBooking`; the row stays out of `rows` (it cannot be run) but carries its remark into the report — `recon-wire.html` `allResults()` appends it after every runnable row, so it is seen and exported but never sent to a run |
| **BR02** "Please review, departure date has passed" | DONE | `decidePreReceipt`, `proceed: true` |
| **BR03** "No outstanding amount found" | DONE | `decidePreReceipt`, `proceed: false` |
| **BR04** "No outstanding amount found, departure date has passed" | DONE | `decidePreReceipt`, `proceed: false` |
| **BR05** "Please review, incorrect debtor found" | DONE | `RETAIL_DEBTOR`, checked after the balance, as the guide orders it |
| **BR06** Payer name = "BPAY" | DONE | `recon-run.js BPAY_PAYER` |
| **BR07** = one segment → tick | DONE | `decideAllocation` |
| **BR08** = all segments → tick all | DONE | `decideAllocation` |
| **BR09** ambiguous → no tick + "Please allocate" | DONE | `decideAllocation` |
| **BR10** no match → no tick + "Please allocate" | DONE | `decideAllocation` |
| **BR11** overpayment → tick + "Overpayment, please check" | DONE | `decideAllocation` |
| **BR12** one statement a day, BPay only | PARTIAL→see note | `core.pageForDate` + `recon-run.js openFreshStatementPage` stop a second page for a date that already has one. **The second clause — "only BPAY will create the bank statement" — is not enforced**: a solo Mint or TravelPay run still creates its own page, because those reports have their own guides and no page means nothing to reconcile against. **Open question 2.** |
| **BR13** exact to the cent | DONE | integer cents throughout, strict `===`, no epsilon anywhere on a money comparison |
| **BR14** sort by Shop then Consultant | DONE | `core.sortForFinance` and its twin in the page |

A stop beats a warning: where both apply, the Remarks column takes the stop —
that is the one telling Finance what to do — and the warning survives in `Why`.
Where a row is both raised *and* remarked twice (BR02 plus an allocation
remark), both strings appear, joined by ` · `.

---

## The file Finance receives

`recon-wire.html` `exportCsv`, twelve columns:

```
Date, Reference, Rec/Pay Type, Amount, Booking No,
Consultant, Shop, Receipt No, Allocation, Reconciled, Remarks, Why
```

sorted by Shop then Consultant, including the lines that could not be run.
Two defects found in the audit were fixed alongside: it read the live run's rows
while the table showed a past run's (so the button produced a header-only file
with the wrong header set), and it took its column set from whichever cards were
loaded rather than from what was on screen.

---

## Verified in the browser, against the live sandbox

Two dry runs on 17-Aug-2026, driven through Chrome against
`raatravelsandbox`, statement date 17-08-2026, Trust account. What they proved
that no offline test can:

| | seen live |
|---|---|
| 20–22 | Finance → Bank Statements → Reconcile New Statement reached, form loaded |
| 23 | `[TRUST] Trust Account` selected and held |
| 24 | *"13 existing pages read (highest 13); creating page 14"* — latest + 1 |
| 25 | statement date 17-08-2026 typed and kept |
| **26 / 27** | *"Page 14 created, opening 1300000.00, closing 1300395.54"* — **two different figures.** The opening is Tramada's; the closing is the one typed into the dashboard. Before this week both read 1300000.00 |
| 28 | landed on Reconcile Bank Statement Page 14 |
| 29–32 | *"204 transactions showing after the filter"* |
| **BR03** | *"Row 1: No outstanding amount found — the booking has nothing outstanding"*, and **no receipt was raised**. This is the rule that used to be inverted |
| BR01 | the line with no booking number carried *"No booking number found"* and was still in the inbox and the export |
| Dry run | *"Nothing matched, so Done was not pressed — the page is left open, uncommitted"* |
| Store | the run recorded `columns: 5`, `format: "csv"`, `dryRun: true`, opening and closing as separate figures |

And in the page itself, on the same machine: the file's own columns in the
inbox under their own headings, `Customer` carried through untouched, the
file's existing Remarks column reused rather than duplicated, Consultant and
Shop editable, a hand-corrected Shop reaching the exported file, BR14 ordering
applied, and an .xlsx exported, re-uploaded and exported again with **the same
twelve columns each time**.

Three defects were found this way and fixed:

1. **Re-uploading an exported file grew a duplicate column every round** — the
   `Tramada Receipt No` column was appended again each time, because the code
   looked for a column before deciding what it would be called. Both the export
   and the inbox table are now idempotent, and a test runs the loop three times.
2. **An edit was lost unless the cell lost focus.** Now every keystroke updates
   the row and only the commit goes to the server.
3. **A row stopped by a rule had its explanation talked over** by the
   reconciliation phase — *"no receipt number came back"* replaced *"the
   booking has nothing outstanding"*, which answers a question nobody asked.

### Second pass, 17-Aug-2026 — RAA's real file, end to end

Re-run against booking **13394** using RAA's own column names and their
two-digit date. This time the whole chain ran:

```
Row 1: $145.54 settles all 1 segment exactly          BR08
Row 1: receipt R.0000009452                           step 18
Page 14 created (19-08-2026), opening 1300000.00, closing 1300145.54
Sorting by date descending, then filtering to Client Payment Receipt
205 transactions showing after the filter             steps 29-32
Row 1: Reconciled — receipt R.0000009452 found at $145.54   step 33
1 transaction ticked
Dry run — Done was NOT pressed
```

and the row came back with **CONSULTANT `Kaushik Hegde`** and **SHOP `ADL`**,
read off the booking — steps 7 and 9, which the first pass never reached. The
exported file was `BPAY 17.08.26-reconciled.csv`, every original column in
place, `TOTAL` / `NO OF TRANX` / `Time report sent` carried on the last row.

A third run, over the booking the second run had just paid in full, returned
*"No outstanding amount found — no receipt raised"* and filed nothing. BR03,
proven on a booking whose state changed inside the session.

### Third pass — the one a human caught

The second pass reported **SHOP `ADL`** for booking 13394. It is a West Croydon
booking. The report looked right because ADL is a real branch, every test
passed, and the column was populated — so nothing in this project could have
told the difference. It took someone who knew the booking.

7. **The branch was read from the page's text, and a `<select>` renders as ALL
   of its options in `innerText`.** "The line after the Level 1 Branch label" is
   the FIRST OPTION — `[ADL] RAA Adelaide` — for every booking in the system,
   whatever is selected. Three lines above it sits a decoy: the Consultant 1
   dropdown reads `Kaushik Hegde [ADL]`, the consultant's own branch. Both the
   branch and the debtor now come from `options[selectedIndex]` of a named
   control (`#level1Branch`, `#retailDebtor`), measured and written down in
   `docs/tramada-field-map.md` §4c. Re-run against 13394: **SHOP `WEST`**.

The lesson is not "use better selectors". It is that **a populated column is not
a correct one**, and a check that only asks "did a value appear?" will pass
forever on the wrong value. Where a scrape feeds a column Finance acts on, the
verification has to be a value somebody can independently confirm.

Two more defects found this way:

4. **BR05 was stopping every row.** The debtor scrape matched the word
   *"Debtors"* in Tramada's Finance nav and captured the `"s"`, so every booking
   read as the wrong debtor. A label that gates money is not a substring
   search; it now needs a word boundary and a line start.
5. **A two-digit year was handed to Tramada untouched.** `07-01-26` went
   straight into a live receipt's Date Received field. It now reads as 7 January
   2026 and is typed as `07-01-2026`.
6. **Rows that can never run said "running"** for the whole run and "Pending"
   afterwards — the BR01 line and the file's TOTAL row. They now read *Not run*.

Two things the run could NOT prove, and one limitation worth writing down:

- **Still not exercised on a live booking: BR02, BR04, BR09, BR10, BR11.** They
  need a booking whose departure date has passed, and one with several segments
  of different sizes. Everything else in the guide has now run against Tramada
  at least once. BR05 and BR07/BR08 have.
- **BR12's guard did not fire on the second run**, and that is Tramada's doing
  rather than a defect: a statement page that was never committed does not
  appear in the statement list the guard reads, so both runs saw "highest 13"
  and both created page 14. The guard stops a second run against a **committed**
  statement; it cannot see an abandoned rehearsal. Arguably right — an
  uncommitted page is not a statement — but it is not what BR12 literally says,
  so it is written down here rather than left to be discovered.
- The first run failed every row with *"Booking could not be opened"*, which
  turned out to be an expired Tramada session. The message now says which of the
  two it was, and tells you to sign in.

## Still open

**1 · "Debtor Payment Receipt" (steps 11 and 30).** Measured live, the booking
receipt form does not offer that type, and the reconcile screen's Debtor Payment
Receipt rows are the *pre-existing* lines the BPay file was scraped from — not
what the run files. Either the guide is describing a different screen, or it
means what Tramada calls Client Payment Receipt. Five minutes with whoever wrote
the guide settles it.

**2 · BR12's second clause.** "Only BPAY process will create the bank statement
in Tramada." Enforcing that would leave a solo Mint or TravelPay run with no
page to reconcile against, and those reports have their own guides which this
audit has not seen. The one-page-per-date guard is in; the BPay-only half waits
on the other guides.

**3 · The real input file.** The parser now accepts the guide's own column names
and either container, but it has still never seen a genuine BPay export from
Finance. One real file would confirm the header names and settle whether the
statement date can be derived from the rows rather than typed (step 25).

**And one requirement deliberately not met.** "Other features" says do not store
a history — a new upload overwrites the previous spreadsheet. The app does the
opposite by design: every upload is kept under a timestamped name and every run
is appended to `runs.json`, which is what the past-runs picker reads. That was
asked for on 11-Aug. It is left as it is until somebody chooses between the two.

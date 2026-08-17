# BPAY guide → code, step by step

What `Reconciliation Guide — BPAY` (RAA Finance) asks for, and what this repo
does about it as of **17-08-2026**.

Three verdicts are used:

| | |
|---|---|
| **was already right** | the code did this before the guide arrived |
| **changed** | the code did something else, and now does this |
| **open** | not implemented, with a reason |

Everything under **changed** has an offline test in `test-recon-core.js`, and
the old expectation is kept in a comment beside the new one.

---

## The one place the guide and Tramada disagree

Steps 11 and 30 both say **Debtor Payment Receipt**. Checked live on the
sandbox, 17-08-2026:

- The booking Receipts screen's dropdown (`#receiptCategory`, the one beside
  *Add / Issue Receipt* in the guide's screenshot) offers **Client Payment
  Receipt · Agency CC Client Receipt · Migration Client Payment Receipt ·
  Creditor Refund Receipt**. There is no Debtor Payment Receipt on it.
- The reconcile screen's Rec/Pay Type filter *does* list Debtor Payment
  Receipt, among fifteen types — so the name is real. It belongs to receipts
  raised in the **Debtors** module against a debtor account. Those have no
  booking, so they have no *Segments to Allocate*, which is step 17 and the
  reason this run exists.
- The receipts this system has already filed — `R.0000009444`–`R.0000009446`,
  references `BP-HM51N-133xx` — sit on Trust statement page 13 as **Client
  Payment Receipt**, trans type `ET`.

**What the code does.** It files a Client Payment Receipt and filters the
reconcile screen to the same, which is what it has always done — but it now
*selects* the category by label rather than accepting the page default, and
throws listing the options the page really offers if the one it wants is
missing. If RAA production has a Debtor Payment Receipt on the booking form,
the first run there stops and says so instead of filing under something else.

**This needs a decision from RAA Finance, not from the code.**

---

## Steps 1–19 — the receipts

| Step | Verdict | Where |
|---|---|---|
| 1 · upload the spreadsheet | **changed** | Two separate problems, both fixed. **Columns:** `Receipt No` now maps to the reference (step 16), `Booking no.` with the dot to the booking, `Date received` to the date, and `Rec/Pay Type` is optional — it used to be required, so the real file was rejected with *"the header is missing: reference, recPayType"*. **Container:** BPay was the only report that had to be a CSV (`accept: '.csv,text/csv'`, read as text in the browser), so Finance's actual `.xlsx` could not even be selected in the file picker. `parseReconRows` reads a grid, a grid comes from either container, and the page now routes any workbook to the server like every other report. |
| 2–3 · find the booking | was already right | `readBookingFacts` matches on the booking **number** in the header, not on the page loading — Tramada answers 200 for an id that does not exist. |
| BR01 · not found | **changed** | Skipped with `No booking number found`. Previously the row went straight to the receipt form and failed there with a Playwright message. |
| 4 · departure date | **changed** | Read from the summary. Nothing read it before. |
| 5 · Client/Debtor Balance | **changed** | Read from the summary. The run used to learn what was outstanding only from the *receipt form's* segment dues, which is a different question — a booking can owe money with no allocatable segment. |
| BR02 · owes, departed | **changed** | Receipted anyway, remark `Please review, departure date has passed`. |
| BR03 / BR04 · owes nothing | **changed** | No receipt. Remark distinguishes departed from not. |
| 6 / BR05 · debtor | **changed** | Must be `RAA of SA Limited (Retail)`, compared on case and spacing only — `RAA of SA Limited` without the bracket is a different debtor and does not pass. |
| 7 · Cons1 → Consultant | **changed** | New. Read off the booking's left panel. |
| 8–9 · Level 1 Branch → Shop | **changed** | New. Read off `#level1Branch` on the Profile page, shortcode from the brackets (`[WEST]` → `WEST`). Read from the `<select>`, not the page text: the preferred consultant carries their own branch tag and a text scrape takes the wrong one. |
| 11 · receipt category | **changed** | Selected by label, verified, throws with the real list. See above. |
| 12 · Transaction Type EFT | was already right | `#receipttransactionTypeCode` → `ET`. |
| 13 / BR06 · Payer name `BPAY` | **changed** | Was the booking's client name, so each receipt looked like an unrelated counter payment. Now the literal `BPAY`, read back after typing. |
| 14–16 · date, amount, reference | was already right | Reference was already read back after typing; date and amount are not. |
| 17 / BR07–BR11 · allocation | **changed** | See below — the largest single change. |
| 18 · Issue | was already right | Polls for the receipts list, re-clicks once, asserts an `R.` number came back. |
| 19 · next row | was already right | Each row is its own try/catch: a booking that fails does not stop the rest, because filed receipts do not roll back. |

### Step 17 in detail

The old rule was an exhaustive subset-sum: pick whichever combination of whole
segments came closest to the receipt without exceeding it, and call it
`Part allocated` when that landed short. Against 200 + 200, a $300 receipt
settled one segment and moved on.

BR09 and BR10 forbid that. Deciding *which* of two identical segments a
part-payment belongs to is the judgement the guide reserves for a person, and
the old code was making it silently and filing it.

| receipt vs segments | ticks | status | remark |
|---|---|---|---|
| equals one segment | that segment | Allocated | — |
| equals all of them | all (Select All) | Allocated | — |
| more than all of them | all (Select All) | Allocated | `Overpayment, please check` |
| anything else | nothing | Not allocated | `Please allocate` |

The receipt is still filed in every case — *"AI Agent can continue to receipt
even when unable to allocate to the segments"*. `Part allocated` is no longer
reachable for a BPAY row, and there is a test that says so for eleven amounts
so a future convenience cannot quietly bring it back.

Where two segments owe the same amount, the first on the form is taken and the
tie is named in the row's reason rather than presented as a reasoned choice.

---

## Steps 20–33 — the statement page

| Step | Verdict | Where |
|---|---|---|
| 20–23 · new statement, Trust account | was already right | Account is selected first and waited on — it posts back and resets the page number. |
| 24 · page number | was already right | Highest existing + 1, read fresh every run, never remembered. Moves forward on *already exists*, max three attempts. |
| 25 · statement date | was already right | Real keystrokes, read back before submit. |
| 26 · opening balance | was already right | Left exactly as Tramada's form filled it. Now also asserted not to have drifted while the form was being filled. |
| 27 · closing balance | **changed** | The dashboard's figure is typed. It used to be a **copy of the opening balance** — the same number in both boxes, so the variance was $0.00 by construction and the one check a bank statement exists to perform could not fail. A run with no closing balance now stops rather than inventing one. |
| 28–32 · filter, sort | was already right | Sort first (it submits and clears everything), then filter (client-side, ticks survive). The filter is asserted to have stuck. |
| 33 · cross-check and tick | **deviates — needs a decision** | See below. |

### Step 33 reads a different column from the one the guide names

The guide: *"Reference numbers in Tramada should match Receipt no in
spreadsheet. Amount in the Credit column in Tramada should match Amount in the
spreadsheet."* — match on the **Reference** column.

The code matches on **Trans. No**, the receipt number Tramada handed back when
it issued the receipt (`MATCHERS.bpay`, `recon-core.js`). Amounts are compared
exactly to the cent either way, which satisfies BR13.

This was a deliberate earlier decision and there is a real argument for it: the
receipt number is a machine-issued identifier for the thing *this run just
filed*, whereas Reference is a free-text column a consultant can type into on
rows the run never created. Matching on Reference once matched pre-existing
statement lines instead of our own work.

But it is not what the guide says, and the difference is visible in one case: a
row whose receipt this run did not file — filed manually earlier, say — has no
`receiptNo`, so it comes back *"no receipt number came back, so there is
nothing to look for"* and never reconciles, where a person following the guide
would have found it by Reference and ticked it.

**Options, for Finance to pick:** match on Reference as written; keep Trans. No;
or try Trans. No first and fall back to Reference, which reconciles the manual
case without weakening the normal one. Not changed unilaterally — it decides
which statement lines get ticked and committed.

---

## Steps 34–35 and the extras

| Item | Verdict | Where |
|---|---|---|
| Remarks column | **changed** | New, end to end: decided in `recon-core`, written to `runs.json` per row as it happens, shown in the results table, exported. Exact strings held once in `REMARKS`. |
| BR14 · sort by Shop then Consultant | **changed** | `sortForFinance`. Blanks sort **last** — a row whose branch could not be read is the one a person most needs to see. |
| Export as CSV | **changed** | `GET /api/runs/:id/export.csv`, built server-side from `runs.json`. The page's own copy is one socket's worth of frames; reload it and Consultant, Shop and Remarks are gone. Every row is in the file, including the ones no receipt was raised for — that is what the Remarks column is for. |
| One export per day, overwritten | **changed** | Named `bpay-reconciliation-YYYYMMDD.csv` from the statement date. The raw upload is still archived per run under `uploads/` — that is evidence of what arrived, and a different thing from the working file that goes back out. |
| Dashboard shows reconciled / not / remarks | **changed** | Consultant, Shop and Remarks columns added to the results table. |
| BR13 · exact to the cent | was already right | Integer cents throughout; nothing rounds a number it merely failed to parse. |

### Open

| Item | Why |
|---|---|
| **BR12** · one bank statement per day | Today each run creates its own page, on purpose — two runs in a day leave two pages, which is visible and undoable. Enforcing one per day means deciding what a second run *does* instead (append to the existing page? refuse?), and that is a Finance decision. Note the sandbox already has three pages dated 12-08-2026. |
| **Step 35** · email to TAccounts@raa.com.au | Nothing in this repo sends mail. Adding SMTP credentials to a service with no redaction on its socket is worth doing deliberately, not as the last line of a change this size. The file is one click away in the meantime. |
| **Step 33** · which column reconciles | Deviates on purpose — see above. Needs a Finance decision, not a code decision. |
| Two BPAY statements on one day (SA holiday) | The run handles one upload at a time and each gets its own statement page, which is the right shape for this. Untested against two same-day uploads. |

---

## Files changed

```
recon-core.js            REMARKS, decideBookingEligibility, decideAllocation rewritten,
                         sortForFinance, bpayExportCsv, header aliases
recon-run.js             inspectBookings + readBookingFacts (new phase 0),
                         payer name, receipt category, real closing balance
tramada-receipt.js       receipt category selected by label; payer name read back
server.js                GET /api/runs/:id/export.csv
recon-wire.html          Consultant / Shop / Remarks columns; export via the server
public/index.html        rebuilt from the above
test-recon-core.js       +70 assertions; old expectations kept as comments
docs/tramada-field-map.md  §4b re-verified, §4c added
CLAUDE.md                §6 additions, §6c added
```

`npm test` — 8 files, all green.

# Bank reconciliation agent

Files the day's payments into Tramada, creates the bank statement page, and
checks that what it filed reached it.

Two reports, two jobs:

| | **BPay receipts** | **Mint daily settlement** |
|---|---|---|
| File | `.csv` | `.xlsx` or `.csv` |
| Columns | Date, Reference, Rec/Pay Type, Amount, Booking No | Transaction Reference, Amount, To Company |
| Writes to Tramada | **yes** — one receipt per row | **no** — nothing is filed |
| Statement filter | `Client Payment Receipt` | `Creditor Payment` |
| Reconciled when | the receipt number it was handed appears as a `Trans. No` at the same amount | the transaction reference appears as a `Trans. No` |

Load one report or both. **Both run together on ONE statement page** — a freshly
created page already lists every unpresented transaction on the account, so the
BPay receipts and the Mint creditor payments are both already on it. The BPay
rows are filed first, then each report is matched under its own filter, and the
page is committed once.

They cannot run as two *concurrent* flows: `runTramadaReceipt` closes the shared
CDP browser in its `finally`, so a second flow would pull the page out from
under the first with real receipts already filed. One run does both, in order.

## Running it

```bash
npm install
npx playwright install chromium      # only if you have no Chrome to drive
cp .env.example .env                 # nothing in it is required to start

npm run start:chrome                 # opens Chrome with CDP on 9222
#   ↳ SIGN INTO TRAMADA IN THAT WINDOW. The run waits for you and never
#     types credentials itself.

npm start                            # http://localhost:3000
```

Then: drop a report on its card, fill in the statement date and the opening and
closing balances, and press **Start run**.

**Start run writes to Tramada immediately.** For a BPay report it files a real
receipt per row against a real booking, and nothing rolls back. The card's
**Preview** is the only check before it does.

## What it touches, and what it will not

On the reconciliation page it sets the sort and the filter, writes the statement
balances, ticks the transactions it matched, and presses **Done**. Export is
never clicked.

**Done commits the page.** Until 10-Aug-2026 this run deliberately stopped short
of it, and the line it would not cross was the difference between a run that
reads a statement and a run that commits one. It crosses that line now, so two
rules hold it in place:

- only rows the run positively **matched** are ticked — never `Select All`,
  which would tick all ~4,200 unpresented transactions sitting on a fresh page;
- every tick is **verified** before Done is pressed, and Done is skipped
  entirely when nothing matched. Committing a page whose ticks never registered
  is worse than not committing at all.

The balances are written on the reconcile screen itself, where all three fields
ship `readonly` behind an unnamed **Edit** button. Typing into a readonly input
succeeds silently and changes nothing — which is why the opening balance used to
go missing.

## Where a run is written down

```
uploads/20260810-143002-mint.xlsx     the report exactly as it arrived
runs.json                             every run, its rows and its money
```

The **Run overview** screen is fed from `runs.json` and nothing else. Before it
existed that screen showed the design mockup's invented figures behind a "sample
data" banner, because a finished run had nowhere to go.

Read over HTTP rather than pushed down the socket, so the figures are right on a
page opened long after the run finished:

| | |
|---|---|
| `GET /api/overview` | the dashboard's figures |
| `GET /api/runs` | every run, in full |
| `GET /api/runs/:id` | one run |

Rows are written **as they happen**, not at the end: a run that dies on row 7
has still filed six real receipts, and their numbers have to outlive the process
that filed them. Writes are atomic, and a `runs.json` that will not parse is
moved aside rather than overwritten — it is still somebody's record of money
that moved.

## The code

| | |
|---|---|
| `recon-core.js` | Every decision, pure and tested. Allocation, matching, page numbers, column mapping, error tidying. **If you find a rule anywhere else, it is in the wrong place.** |
| `recon-run.js` | The browser half. Pages and clicks, no judgements. |
| `xlsx-lite.js` | Reads .xlsx with no dependencies — a workbook is a zip of XML and node ships `zlib`. |
| `tramada-receipt.js` | The booking receipt form. |
| `server.js` | One page, one socket, and the run history over HTTP. |
| `run-store.js` | `uploads/` and `runs.json` — where a run is written down. |
| `recon-wire.html` | The live wiring added to the client's mockup. |
| `build-recon.js` | `public/index.html` ← `recon-ui-mockup.html` + `recon-wire.html` |

### The page is generated — never hand-edit `public/index.html`

```bash
npm run build
```

The client's mockup arrives as `recon-ui-mockup.html` and changes. It is not a
styling prototype: it carries ~90 KB of its own demo JavaScript with
`document`-level click and change handlers, so **the build disables its script**
and the wiring reimplements the one thing the page needs from it (screen
navigation). Put your changes in `recon-wire.html`; anything typed straight into
`public/index.html` is lost on the next mockup.

Screens the wiring does not drive keep the mockup's invented figures and are
marked *sample data*.

## Tests

```bash
npm test        # 356 assertions, all offline — no network, no browser
npm run shots   # screenshots of the page, a BPay run and a Mint run
```

The tests never open Tramada and never launch Playwright. The rules are checked
against values captured from the live pages; `test-xlsx-lite.js` runs against
the client's actual `mint.xlsx`, which is how it caught a parser bug that a
hand-written fixture would have agreed with.

The screenshot tools are not tests — they replay invented frames and prove
nothing about the automation. They exist because a whole class of bug here only
fails when you look at it: progress frames arriving and being dropped, a stop
reason wiped by the next repaint, a raw Playwright call log rendered into a
table cell. None of those show up in a node test.

## Sample data

| | |
|---|---|
| `tramada-statement-lines.csv` | Six real statement lines, for BPay |
| `mint.xlsx` | The client's own Mint export |
| `mint-payments.csv` | Three real creditor payments, all correct |
| `mint-payments-varied.csv` | The same three distorted, plus one that does not exist — one run, every outcome |
| `bookings.json` + `run-bookings.js` | Builds bookings for a BPay run to reconcile against |

## Building something to reconcile against

```bash
npm run start:chrome        # once, and sign into Tramada in that window
node make-fixtures.js all   # or: bpay | travelpay | mint
```

Creates REAL bookings, and then whatever that report needs to exist before its
run can find anything — receipts for TravelPay, receipts *and* creditor
payments to Ready Rooms for Mint. **BPay gets no receipts, on purpose**:
raising them is the BPay run's whole job, and pre-receipting would leave every
row with nothing outstanding and a fixture that comes back green while testing
the opposite.

Mint takes the client's receipt **before** it pays the creditor, and it has to:
a costed segment is not payable to a creditor until the client's money has been
received and allocated against it. Skip that and the payment form's Segments To
Allocate table is simply empty.

| | creates in Tramada | writes |
|---|---|---|
| `bpay` | bookings + costings | `csv_uploads/tramada-statement-lines.csv` |
| `travelpay` | + receipts | `csv_uploads/travelpay-payments.csv` |
| `mint` | + receipts, then creditor payments | `csv_uploads/mint-payments.csv` |
| `ipsi` | bookings + costings only | `csv_uploads/ipsi-payments.csv` |

**The CSV is written as the work happens**, not at the end — a row goes down
the moment its booking exists. A column that can only come from a later step
(a receipt number, a `P.` number) is left blank and filled in when that step
succeeds; if it never does, the row still names a real booking and a real
amount and the run tells you which rows need a value pasted in. Nothing that
was really created in Tramada ends up in no file.

`ipsi` doesn't go looking for your receipts. It creates the bookings, writes
the file, and leaves **Merchant Reference blank for you** to paste in once
you've raised the Credit Card Swipe receipts — that form wants a real card
number, so it's yours to do. A blank one falls back to matching on Booking
Number and amount.

The bookings each run created are listed in
`created-bookings-{bpay,travelpay,mint}.json`.

`all` runs the three **in order, never in parallel** — every Tramada module
closes the shared CDP browser in its `finally`, so two at once would close it
out from under each other with real bookings, receipts and payments already
created.

`--dry-run` says what it would do and touches nothing. `--limit 1` tries the
whole chain against a single booking, which is worth doing before `mint` —
that is the one that moves money out.

### Every run signs its own references

Each run rolls a five-character tag and prints it before it starts:

```
run tag X8KGJ — references look like TP-X8KGJ-13196
```

Every reference it writes carries it — `BP-X8KGJ-13187`, `TP-X8KGJ-13196`,
`MP-X8KGJ-13199`, `IP-X8KGJ-0001` — so one search in Tramada finds a whole
run, and no two runs can be mistaken for each other. They used to be
`TRAVELPAY-13196` and, for IPSI, `FIXTURE0001` on every run ever made; a
receipt is found again *by* its reference, so a repeat lets a run read back an
earlier attempt's transaction and report the wrong number. `--tag X8KGJ` pins
it when you want a second run findable beside the first.

One booking, one segment, one costing — see `bookings.json`'s own comment.
A receipt allocated with `"ALL"` clicks Tramada's Select All, which ticks
*every* row on the form, so a second row is a receipt that gets refused.

## Where the portal is written down

`docs/tramada-field-map.md` — routes, field ids, the real dropdown
vocabularies, and the things that cost a run to discover: which fields need real
keystrokes, that changing the bank account posts the form back, that sorting
clears the filter, and that filtering hides rows rather than removing them.

Read it before touching a Tramada page. `CLAUDE.md` has the standing rules.

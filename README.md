# Bank reconciliation agent

Files the day's payments into Tramada, creates the bank statement page, and
checks that what it filed reached it.

Two reports, two jobs:

| | **BPay receipts** | **Mint daily settlement** |
|---|---|---|
| File | `.csv` | `.xlsx` or `.csv` |
| Columns | Date, Reference, Rec/Pay Type, Amount, Booking No | Transaction Reference, Amount, To Company |
| Writes to Tramada | **yes** — one receipt per row | **no** — nothing is filed |
| Reconciled when | the receipt number it was handed appears as a `Trans. No` at the same amount | the transaction reference appears as a `Trans. No` |

Load one report or both. **Both run together on ONE statement page** — a freshly
created page already lists every unpresented transaction on the account, so the
BPay receipts and the Mint creditor payments are both already on it. The BPay
rows are filed first, then each report is matched against the page, and the
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

Then: drop a report on its card, fill in the statement date, and press
**Start run**. (The balance boxes are still on the screen but no longer reach
Tramada — see below.)

**Start run writes to Tramada immediately.** For a BPay report it files a real
receipt per row against a real booking, and nothing rolls back. The card's
**Preview** is the only check before it does.

## In Docker

```bash
docker compose up --build          # or: npm run docker:up

#   app     http://127.0.0.1:3000
#   screen  http://127.0.0.1:6080/vnc.html   ← SIGN INTO TRAMADA HERE
```

Open the screen first. It is a real X display inside the container with Chrome
already on the Tramada login page — sign in there, by hand, exactly as you would
locally, then go to the app and start a run. The rule has not moved: the run
attaches to a browser a **human** signed into, and never types credentials.

That is also why there is a window manager and a VNC server in the image at all.
"Headless" here means no monitor, not no display — a run needs a browser a person
can reach, because Tramada will ask for a password, and one day an OTP.

**What survives a restart.** `./data` holds the Chrome profile — so the Tramada
session outlives `docker compose down` — along with `runs.json` and `uploads/`.
`./csv_uploads` is bound to the same folder the fixture generator writes to, so a
CSV made inside the container is a file you can pick up and upload. Delete
`./data/chrome-profile` and the next start is a signed-out browser.

**Both ports are published to `127.0.0.1` only**, and the VNC server has no
password by design — the loopback bind is what keeps it shut. From another
machine, tunnel rather than republish:

```bash
ssh -L 6080:localhost:6080 -L 3000:localhost:3000 you@thathost
```

**Port 9222 is deliberately not published.** Anything that can reach the
debugging port drives a browser signed into a finance system; the app reaches it
on `127.0.0.1` inside the container, and nothing outside needs to.

Point it at a different portal with `TRAMADA_URL` in a `.env` beside the compose
file. Everything else has a working default.

If any of the six processes dies — Xvfb, fluxbox, Chromium, x11vnc, websockify,
node — the container stops and says which one. That is on purpose: restarting a
dead Chrome on its own would hand back a browser nobody is signed into, and a run
would then sit waiting for a login against a window that was never there.

## The BPay rules

The run reproduces *Reconciliation Guide — BPAY (daily)*. Two parts of it are
worth knowing before you watch a run, because both make the agent do LESS than
you might expect.

**Three checks happen before any receipt is raised** (steps 4–6). The run reads
the booking's departure date, what it still owes, and its debtor, and decides:

| | departure ahead | departure passed |
|---|---|---|
| **something owing** | receipt raised | receipt raised, remarked *"Please review, departure date has passed"* |
| **nothing owing** | **no receipt** — *"No outstanding amount found"* | **no receipt** — *"No outstanding amount found, departure date has passed"* |

and on top of that, a debtor that is not **RAA of SA Limited (Retail)** stops
the receipt with *"Please review, incorrect debtor found"*. A field that cannot
be read also stops the row, remarked *"Please review"* — the alternative is
filing a real receipt on the strength of something nobody managed to read.

**Allocation is exact, or nothing** (BR07–BR11). A box is ticked in three cases
only: the amount equals one segment, it equals all of them added up, or it
exceeds all of them (which ticks everything and remarks *"Overpayment, please
check"*). Anything else — including an amount that happens to fit some
combination of segments — ticks **nothing** and remarks *"Please allocate"*.
The receipt is still filed either way; the money was banked and has to be
recorded. Only the allocation waits for a person.

This replaced a best-fit rule that settled the largest combination not exceeding
the receipt. $300 against two $200 segments used to tick one of them; it no
longer does.

**The Remarks column has a closed vocabulary.** Seven strings, quoted verbatim
from the guide's business-rules table, in `recon-core.js`'s `REMARKS`. Finance
filters and counts that column, so a sentence that is merely similar is a
different value to anything reading the file. The prose explanation lives in
`Why`, beside it.

**One statement page per statement date** (BR12). A second run against a date
that already has a page stops and names the page rather than creating another.
Keyed on the statement DATE, not on today, so the guide's public-holiday case
still works: two files uploaded on one Tuesday, dated Monday and Tuesday, get
their two pages.

## What it touches, and what it will not

On the reconciliation page it sets the sort, writes the statement balances,
ticks the transactions it matched, and presses **Done**. Export is never
clicked.

**The Rec/Pay Type filter depends on how many reports you ran.** One report on
its own is filtered to its own type — there is one type to show and showing it
is what the screen is for. Several at once are not: swapping the filter per pass
meant re-reading the grid each time, where one unfiltered read serves them all.
Matching is unaffected either way — a row is found by its receipt number or its
reference, and both are as unique across the whole page as within one type.
`RECON_APPLY_FILTER=true|false` forces it.

**The opening balance is Tramada's; the closing balance is yours.** Choosing the
bank account fills the new-statement form's Opening Balance with the account's
own figure — it is yesterday's closing balance, it is right by definition, and
the run never types over it. The Closing Balance box on the Sources screen is
the one a Finance team member fills in off the Westpac statement, and that is
the figure the run types in (step 27). Leave it blank and the opening is carried
across instead, with the log saying which of the two happened.

This was the other way round until 17-Aug-2026 — closing was copied from
opening, which makes the variance $0.00 by construction whatever was actually
banked, and so proves nothing. `RECON_ALLOW_SECOND_STATEMENT=true` is unrelated
but sits nearby: it lifts BR12's one-page-per-day guard.

**A receipt already on the booking is never filed twice.** Before it opens
anything, the run reads the booking's own Receipts list and looks for the same
**reference AND the same amount**. If it finds one, that row takes the receipt
number that is already there and nothing is filed — so uploading the same CSV
twice does not take the money twice. The row still reconciles, against the
receipt that already exists.

Both have to match. A booking can legitimately take two receipts for the same
amount under different references, and one reference can be followed by a
correcting receipt for a different figure; it is the pair that makes it the same
receipt. `skipIfAlreadyFiled: false` overrides it for a caller that really means
to file a second identical receipt.

**Done commits the page.** Until 10-Aug-2026 this run deliberately stopped short
of it, and the line it would not cross was the difference between a run that
reads a statement and a run that commits one. It crosses that line now, so two
rules hold it in place:

- only rows the run positively **matched** are ticked — never `Select All`,
  which would tick all ~4,200 unpresented transactions sitting on a fresh page;
- every tick is **verified** before Done is pressed, and Done is skipped
  entirely when nothing matched. Committing a page whose ticks never registered
  is worse than not committing at all.

On the reconcile screen the balance fields ship `readonly` behind an unnamed
**Edit** button, and typing into a readonly input succeeds silently and changes
nothing — which is why the opening balance used to go missing. The run only
clicks Edit when the page does **not** already show the figures it wants; since
the statement is created with opening and closing equal, that is usually never.

### Dry run

Next to the statement date and balances on the Sources screen there is a
**Dry run** checkbox. Ticked, the run is a dry run; unticked, it is not.

A dry run holds back **the two finance screens, and nothing else**:

| | full run | dry run |
|---|---|---|
| Receipts filed against the bookings | yes | **yes** |
| Creditor payments raised | yes | **yes** |
| Bank statement page created | yes | yes |
| Sorted, filtered, read, balances written | yes | yes |
| Matched rows ticked and verified | yes | yes |
| **Done pressed on the statement page** | yes | **no** |
| **Finance Receipts merchant receipt issued** | yes | **no** |

So everything that makes the run worth watching still happens — the receipts are
real, so the statement page really does have this run's transactions on it, and
they really are matched and ticked. What is withheld is the click that makes the
*statement* permanent, and the Finance Receipts Issue. The page is left open on
screen with the ticks in place, for you to look at before committing it by hand.

The run is still recorded in `runs.json`, marked `dryRun: true` — a history that
could not tell a committed statement from an uncommitted one would be worse than
no history.

The mode is read once, at the moment Start run is pressed. Ticking the box
mid-run cannot change what the run in flight is allowed to do.

### Looking at a past run

The inbox's **Report date** select is the run picker: *This run*, or any run
before it, read back from `runs.json`. Choosing one draws that run's rows in the
same table, with the chip reading **past run** rather than *live run*; the
**Report** select beside it narrows a combined run to one of its four reports. A
new run always snaps the screen back to now — a row arriving for a run you are
not looking at is how yesterday's numbers get read as today's.

Both were controls the mockup drew and nothing filled. `#ibShop` still isn't
filled, because there are no shops here.

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

## Layout

```
server.js  recon-core.js  recon-run.js  run-store.js     the app itself: what
xlsx-lite.js  xlsx-write.js  tramada-*.js                 `npm start` needs

public/       the built page — generated, never hand-edited
design/       the client's mockup + this project's wiring, which build fuses
test/         npm test — offline, no browser, no network
shots/        npm run shots — render checks; PNGs land in shots/out/
tools/        the build, the fixture makers, the one-off CLIs
fixtures/     the sample reports and workbooks tests and tools read
docs/         the field map, the BPay conformance notes, the history

uploads/  runs.json  csv_uploads/     written by a run, not checked in
```

Everything the running app loads is at the root; everything else is in a
folder. A file's folder is the answer to "do I need this to reconcile?".

## The code

| | |
|---|---|
| `recon-core.js` | Every decision, pure and tested. Allocation, matching, page numbers, column mapping, error tidying. **If you find a rule anywhere else, it is in the wrong place.** |
| `recon-run.js` | The browser half. Pages and clicks, no judgements. |
| `xlsx-lite.js` | Reads .xlsx with no dependencies — a workbook is a zip of XML and node ships `zlib`. |
| `tramada-receipt.js` | The booking receipt form. |
| `server.js` | One page, one socket, and the run history over HTTP. |
| `run-store.js` | `uploads/` and `runs.json` — where a run is written down. |
| `design/recon-wire.html` | The live wiring added to the client's mockup. |
| `tools/build-recon.js` | `public/index.html` ← `design/recon-ui-mockup.html` + `design/recon-wire.html`, plus the tab title and favicon |

### The page is generated — never hand-edit `public/index.html`

```bash
npm run build
```

The client's mockup arrives as `design/recon-ui-mockup.html` and changes. It is not a
styling prototype: it carries ~90 KB of its own demo JavaScript with
`document`-level click and change handlers, so **the build disables its script**
and the wiring reimplements the one thing the page needs from it (screen
navigation). Put your changes in `design/recon-wire.html`; anything typed straight into
`public/index.html` is lost on the next mockup.

Screens the wiring does not drive keep the mockup's invented figures and are
marked *sample data*.

## Tests

```bash
npm test        # 694 assertions, all offline — no network, no browser
npm run shots   # 109 render checks — the page, a BPay run, a Mint run, the overview
                #   the PNGs it writes go to shots/out/
```

The tests never open Tramada and never launch Playwright. The rules are checked
against values captured from the live pages; `test/test-xlsx-lite.js` runs
against the client's actual `fixtures/mint.xlsx`, which is how it caught a parser bug that a
hand-written fixture would have agreed with.

The screenshot tools are not tests — they replay invented frames and prove
nothing about the automation. They exist because a whole class of bug here only
fails when you look at it: progress frames arriving and being dropped, a stop
reason wiped by the next repaint, a raw Playwright call log rendered into a
table cell. None of those show up in a node test.

## Sample data

| | |
|---|---|
| `fixtures/tramada-statement-lines.csv` | Six real statement lines, for BPay |
| `fixtures/mint.xlsx` | The client's own Mint export |
| `fixtures/mint-payments.csv` | Three real creditor payments, all correct |
| `fixtures/mint-payments-varied.csv` | The same three distorted, plus one that does not exist — one run, every outcome |
| `fixtures/bookings.json` + `tools/run-bookings.js` | Builds bookings for a BPay run to reconcile against |

## Building something to reconcile against

```bash
npm run start:chrome        # once, and sign into Tramada in that window
npm run fixtures            # or: fixtures:bpay | fixtures:travelpay | fixtures:mint
#   long form: node tools/make-fixtures.js all
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

One booking, one segment, one costing — see `fixtures/bookings.json`'s own
comment.
A receipt allocated with `"ALL"` clicks Tramada's Select All, which ticks
*every* row on the form, so a second row is a receipt that gets refused.

## Where the portal is written down

`docs/tramada-field-map.md` — routes, field ids, the real dropdown
vocabularies, and the things that cost a run to discover: which fields need real
keystrokes, that changing the bank account posts the form back, that sorting
clears the filter, and that filtering hides rows rather than removing them.

Read it before touching a Tramada page. `CLAUDE.md` has the standing rules.

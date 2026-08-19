# Tramada (TTMS) field map

What the forms actually contain, measured against **raatravelsandbox TTMS
v7.10.3**. Read this before touching `tramada-*.js` (CLAUDE.md §5).

Everything here was read off a live page. Where a date is given, that is when it
was last confirmed — not when it was guessed.

---

## 1. Pages

| Page | Route |
|---|---|
| Hotel segment | `booking/booking-hotel-segment.htm?mode=add&parentId={bookingNo}` |
| Flight segment | `booking/booking-flight-segment.htm?mode=add&parentId={bookingNo}` |
| Ticket costing | `booking/booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId={bookingNo}` |
| Costing list | `booking/booking-costings.htm?mode=edit&id={bookingNo}` |
| Client search | `client/client-search.htm` |

`parentId` is the booking number, URL-encoded. It is the only thing on the URL
that says which booking a form belongs to, which is why the resume guard reads
it rather than trusting that we opened it ourselves.

Only **costed** segments are receiptable. A hotel is costed inline on its own
form; a flight carries no price on the segment form and needs a separate Ticket
costing entry.

---

## 2. The creditor field — `#costingcreditor`

The same id appears on the hotel, flight, tour, insurance and service-fee
costing forms. Measured on the **hotel** segment form, booking 13124,
04/05-Aug-2026.

```
#costingcreditor
  data-field-type = ctrl-type-AutoCompleteAndEditToggleTextField
  class           = autocomplete-text
  autocomplete    = off
  value format    = "[RAA] RAA MEMBERSHIPS"          ← [CODE] NAME
  committed code  → #hiddenSelectedSupplierCode      (itinerary.creditor.creditorCode)
```

### It is not a `<select>`, and there is no creditor endpoint

The receipt form's equivalent **is** a `<select>` — `chooseReceiptCreditor`
finds it at `#creditor` / `#receiptcreditor` / `select[name*="reditor"]` and
reads every `<option>` out of it in one go. It is tempting to assume the segment
form works the same way. It does not.

Typing into `#costingcreditor` **POSTs back to the segment page itself** —
`booking-hotel-segment.htm?parentId=…`, body key `costing.creditor`. There is no
standalone creditor lookup route anywhere in TTMS.

Two consequences, and they are the reason the hotel flow is shaped the way it
is:

- **Creditor names can only be obtained from an open segment form.** "Resolve
  the creditor before opening the form" is not possible. This is why
  `tramada-segments.js` holds a **sticky page** across the creditor question
  (`withSegmentPage` / `closeSegmentPage`, caller owns the release) rather than
  the throwaway `withPage()` it used before.
- **A resumed run re-enters at `finishHotelSegment()`**, not at the top of the
  form. The ~10 fields above the creditor are already filled and typing them
  again is what the sticky page exists to avoid.

### The dropdown has no hook

Tramada marks the input, not the list. The suggestions render as plain
`li` / `div` / `td` / `a` nodes with no stable class or id, so
`_findSuggestion` and `_listSuggestions` locate them **geometrically**: visible,
top edge within ~340px below the field's bottom, horizontally overlapping the
field's column, leaf-ish (a node containing an `li` or `a` is a wrapper
repeating its children's text).

It is worth knowing this is a heuristic. It is not fragile by choice — there is
nothing better to hook.

### It repositions while it renders

`readCreditorOptions` polls until the list is **stable** — same length and same
first entry on two consecutive reads — rather than reading it once. A
single-shot read caught the list mid-render and returned a partial set.

### The landmine that made all of this do nothing (05-Aug-2026)

`tramada-segments.js` declared `function _listSuggestions(...)` **twice** at
module level: the live creditor enumerator taking `{ sel, raw }`, and a dead
client-dropdown scraper taking a plain selector string, left behind when the
client lookup moved to the client-search page.

A duplicate declaration is not inert — the later one wins for the whole module.
So `readCreditorOptions`'s `page.evaluate(_listSuggestions, { sel, raw })`
reached the *dead* one, the browser threw

```
SyntaxError: Failed to execute 'querySelector' on 'Document':
'[object Object]' is not a valid selector.
```

the `catch` swallowed it, and the creditor question offered an **empty option
list on every single run** — the exact feature it had been added for, silently
never working. The dead copy is deleted and `test-roomres.js` now fails on any
duplicate top-level function name in these modules.

---

## 3. The hotel segment form

Fields filled before the creditor is reached, in order:

| Field | Notes |
|---|---|
| `#supplierName` | **validated autocomplete of known suppliers.** Tried first |
| `#hotelName` | free-form fallback when no listed supplier matches — used rather than hard-failing the run |
| `#checkInLocation` | the City Code. Tramada **rejects the save** without one, and it wants a *city* where Room-Res reports a *suburb* — `cityCandidatesFor()` supplies candidates; an exhausted list throws `needsCity` |
| `#roomTypeCode` | `<select>` |
| `#roomType` | free-form room type |
| `#checkInDate` / `#checkOutDate` | `dd-mm-yyyy` (`toTramadaDate`) |
| `#itinerarystatusTypeCode` | `<select>`, defaults to `HK` |
| `#costingcreditor` | ← the run stops here when the creditor is unknown |
| `#costingcreditorInvoiceNumber` | the confirmation / quote reference |

**Tramada rewrites a picked supplier into its own casing and wording.** "Novotel
Bali Ngurah Rai Airport" comes back as `[NOV] NOVOTEL BALI AIRPORT`. Nothing
should compare these strings whole; `shouldResumeHotelForm` matches on the first
significant word for exactly this reason.

### Resuming

`shouldResumeHotelForm(facts, bookingNo, seg)` is **pure** and tested offline
against captured page facts, because being wrong means filling a *different
booking's* form. It answers `true` only when all of:

- the URL is `booking-hotel-segment.htm`
- with `mode=add`
- whose `parentId` decodes to this booking number
- `#costingcreditor` is present (the form really loaded)
- `#hotelName` or `#supplierName` still contains the first word of the hotel we
  were filling

Anything else is `false`, which falls back to the full path — the behaviour that
shipped before resume existed, and safe.

The throw that pauses the run sits **before** `saveSegmentForm`, so a replay
cannot duplicate a segment. That was verified before the resume work started,
and it is what makes the old replay a waste-and-confusion bug rather than a
data-corruption one.

---

## 4. Client search — `client/client-search.htm`

Served under more than one route depending on how you arrive; `readClientMatches`
tries `client-search.htm`, `client-search.htm?mode=search` and
`client-list.htm`, and if none yields the form it reports what *did* load rather
than a bare timeout.

```
#searchForm_profileName   client code
#searchForm_firstName
#searchForm_lastName
#searchButton
```

**Clear the fields first.** The form remembers the previous search and silently
ANDs a stale surname with the new one, finding nothing.

The results table returns `clientCode`, `clientName`, `accountType`, `branch`,
`debtorCode`, `debtorName`. This replaced scraping the booking form's `#client`
autocomplete, which depended on dropdown geometry and render timing and then
*guessed* the client code by splitting a display string on whitespace.

**Account Type matters beyond tidiness:** it decides which debtor widget the
booking form renders, and it is not implied by the debtor — the sandbox has
Corporate clients whose debtor is the retail entity.

---

## 4b. The receipt form — `booking-client-payment-receipt.htm`

Reached from `booking-receipts.htm?mode=edit&id={bookingNo}` → **Add / Issue
Receipt**. Measured live 06-Aug-2026 on booking 13127.

~~A booking can only raise a **Client Payment Receipt**.~~ **CORRECTED
17-Aug-2026 — see §4d.** Booking 13127's client is a retail account, and that
is what decides the list. A debtor-account client (`GRAY/MEGAN DR`) offers
`Debtor Payment Receipt` and no Client variant at all. What was measured here
was true of this booking and false as a rule.

```
#receipttransactionTypeCode   Cash | Cheque | Credit Card CCCF | Credit Card Swipe | EFT
#receiptagencyBankAccount     [TRUST] Trust Account
#receiptpayerName  #receiptdateReceived  #receiptreceiptAmount  #receiptreferenceNumber
#receiptincludeSfeCharge  #receiptsfeAmount  #receipttotalAmountToCharge
#roundRemaining               "Round Remaining"
#issue                        "Issue"
```

### Unallocated Receipt Amounts To Include

Its own table with its own Select All / Deselect All, listing every previously
**unallocated** receipt on the booking (`#unallocatedBookingReceiptsToAllocate`,
one checkbox per row, duplicate id). Ticking these pulls their amounts into this
receipt's allocation. The reconciliation run deliberately leaves them alone —
one CSV row raises one receipt and allocates only its own amount.

### Segments To Allocate

```
0 D | 1 Seg. Type | 2 Invoice No. | 3 Reference | 4 Creditor ID
5 Debtor Invoiced | 6 Debtor Receipted | 7 Debtor Due | 8 Allocate | 9 A
```

**Debtor Due is cells[7].** `readAllocatableSegments` read cells[6] — *Debtor
Receipted*, which is 0.00 on a booking nothing has been receipted against — so
every allocate-or-not decision compared against $0.00. It went unnoticed for as
long as every caller passed `"ALL"`, which never reads the figure.

Per row: `#allocationAmount_{segId}` and a `segmentsToAllocate` checkbox
(duplicate id — locate it via the row, `tr:has(#allocationAmount_{segId})`).

#### The amount box is dead until its row is ticked

It ships as `disabled readonly`, class `disabled text-readonly`. **The row
checkbox's click handler is what enables it** — the same handler Select All
fires for every row at once. Typing first means clicking a permanently disabled
input:

```
locator.click: Timeout 30000ms exceeded ... element is not enabled
```

So the order is: **tick the row, wait for the box to become editable, then type
the amount** — with real keystrokes, and read it back. And tick it with a real
click: setting `.checked = true` does not run the handler, so the box stays
disabled and the footer tally never recomputes.

Ticking normally auto-fills the segment's full due; a partial allocation
overwrites it.

Footer, live: `Amt Rcvd + Unalloc Rcpts − Seg Total − RO Amt = Unalloc`.

#### Which rows appear — and what Select All really does

Measured 10-Aug-2026, on the bookings `make-fixtures.js travelpay` created.

| What the booking carries | Rows on this form |
|---|---|
| Flight segment, no costing | **none** — a flight is not allocatable until costed |
| Flight segment + ticket costing | one, worth the costing's fare |
| Hotel segment | one, worth **rate × nights × rooms** — not the rate |
| Flight + costing + hotel | **two** |

Verified on booking 13127: rate 100.00 over 2 nights showed Due inc GST 200.00.

**Select All ticks every row and fills each with its full due. It does not stop
at the amount received.** If the total exceeds it, Issue is refused outright:

```
Allocation cannot be greater than Amount Received
```

and the message arrives as a banner on a page that no longer shows which row
was to blame. Three receipts died this way on 10-Aug-2026 — bookings 13196,
13199 and 13202 — each receipted for its ticket fare while Select All also
ticked its hotel.

So a caller passing `"ALL"` is promising the receipt covers **every** row on
the form, not just the ones it was thinking about. `allocateSegments` now adds
the filled boxes up and refuses before Issue rather than after; see
CODE-REVIEW.md §4, which is guarded but not yet fixed at the source.

---

## 4d. `#receiptCategory` — the type depends on the CLIENT

On `booking/booking-receipts.htm?mode=edit&id={no}`, above the receipts grid.
This is step 11's "top right dropdown", and it decides which form **Add / Issue
Receipt** opens — so it is set *before* the button is clicked, not on the form.

Measured 17-Aug-2026, same debtor on both bookings
(`RAA of SA Limited (Retail)`):

| booking | client | `#receiptCategory` offers |
|---|---|---|
| 13115 | `GRAY/MEGAN DR` | **Debtor Payment Receipt** `DEBTOR_PAYMENT_RECEIPT` · Agency CC Debtor Receipt `AGENCY_CC_DEBTOR_PAYMENT_RECEIPT` · Migration Debtor Payment Receipt `MIGRATION_DEBTOR_PAYMENT_RECEIPT` · Creditor Refund Receipt `CREDITOR_REFUND_RECEIPT` |
| 13394 | `GRAY/SPIDER MS` | **Client Payment Receipt** `CLIENT_PAYMENT_RECEIPT` · Agency CC Client Receipt `AGENCY_CC_CLIENT_PAYMENT_RECEIPT` · Migration Client Payment Receipt `MIGRATION_CLIENT_PAYMENT_RECEIPT` · Creditor Refund Receipt `CREDITOR_REFUND_RECEIPT` |

**The two lists never overlap**, and the one you get is decided by the CLIENT's
account type — not the debtor, which is identical on both. Each booking's
correct option is already selected by default; the run selects it explicitly
anyway, because a default is not a guarantee.

### What this corrects

This file used to record, from booking 13127, that a booking "can only ever
raise a Client Payment Receipt" and that there is "no Debtor Payment Receipt
here". The observation was right; the generalisation was wrong. Every booking
measured at the time happened to belong to a retail-account client, so the
Debtor half of the vocabulary was invisible — and the guide's step 11 and step
30 were written off as describing a different screen.

A BPay payment belongs on a debtor-account booking. So:

* the receipt is filed as `DEBTOR_PAYMENT_RECEIPT` (step 11);
* the reconcile page is filtered to `Debtor Payment Receipt` (step 30) — already
  in `#recPayType`'s fifteen values, §5;
* both come from one constant, `core.BPAY_RECEIPT`, because filing under one
  name and searching under another reconciles nothing while looking like it
  worked;
* a booking that offers no Debtor variant stops the row with *"Please review,
  Debtor Payment Receipt not available"* rather than filing under whatever type
  happens to be there.

## 4c. The booking profile — `booking/booking-profile.htm?mode=edit&id={no}`

Measured on booking 13394, 17-Aug-2026. Steps 8 and 9 of the BPay guide.

```
#level1Branch        [WEST] RAA West Croydon      15 options
#level2Branch        (blank)
#form_prefConsultant1  Kaushik Hegde [ADL]        251 options
#prefConsultant2     (blank)
#bankAccount         [TRUST] Trust Account
#retailDebtor        RAA of SA Limited (Retail)   name="debtor"
#accountTypeCode     Retail [RETAIL]
```

### READ THE CONTROL. NEVER THE PAGE TEXT.

`document.body.innerText` renders a `<select>` as **every one of its options**,
one per line. So "the line after the Level 1 Branch label" is not the selected
branch — it is `[ADL] RAA Adelaide`, the first option, for **every booking in
the system**:

```
Level 1 Branch
[ADL] RAA Adelaide          ← what a text scrape returns, always
[BROKENHILL] RAA Broken Hill
[COL] RAA Colonnades
…
[WEST] RAA West Croydon     ← what is actually selected
[WLK] RAA West Lakes
Level 2 Branch
```

Booking 13394 is a West Croydon booking. It was reported as ADL, and it looked
entirely right in the spreadsheet, because ADL is a real branch and a plausible
one. Caught only because a human who knew the booking read the output.

**And there is a decoy three lines up.** `#form_prefConsultant1` reads
`Kaushik Hegde [ADL]` — the CONSULTANT's home branch, not the booking's. A text
scrape that drifted a couple of lines either way finds a bracketed code that is
real, wrong, and invisible in a report.

Both fields are read from `options[selectedIndex]`:

| want | control |
|---|---|
| the booking's shop (step 9) | `#level1Branch` → `core.branchCode()` → `WEST` |
| the debtor (BR05) | `#retailDebtor` — a select beats the summary's prose |

The label-based fallback in `getBookingBranch` finds the `<label>` whose text is
exactly `Level 1 Branch`, walks to its parent `<dd>`, and takes the `<select>`
inside it — still a control, never text.

## 5. Finance → Bank Statements

Measured live on 06-Aug-2026, signed in as `khegde` on raatravelsandbox.

### Routes

| Page | Route |
|---|---|
| Finance landing | `finance/finance.htm` |
| Bank Statements — mode chooser | `finance/finance-statements.htm` |
| Search results | `finance/finance-statements-search.htm` (POST from `#searchForm`) |
| New-statement form target | `finance/finance-statement.htm` |
| The reconcile screen, opened from the search grid | `finance/finance-statement-generation.htm?bankStatementId={n}` |
| The reconcile screen, **straight after creating one** | `finance/finance-statement.htm` |

`Bank Statements` in the left nav opens a two-radio chooser — **Search Existing
Statement(s)** (default) or **Reconcile New Statement** — then `Continue`.

#### Do not confirm a creation by its URL (measured 07-08-2026)

The reconcile screen has **two** routes and creating a statement lands on the
one that looks like the form you just submitted — `finance-statement.htm`, not
`finance-statement-generation.htm`. `recon-run.js` checked for the latter, so
page 10 was created, rendered, and reported as *"The new statement wasn't
created"*.

Confirm it by the screen instead: the heading reads **`Reconcile Bank Statement
Page {n}`** and `#filterColumn` / `#sortBy` are present. That also lets the run
assert it landed on the page number it asked for, which a URL never told it.

**And do not scrape `<td>` for the word "error".** The failure message was built
by scanning every cell for `/error|already exists|must be|required/`, which
found a transaction whose Reference read `July Staff Errors` and reported
*"Tramada said: July Staff Errors"* — on a run that had actually succeeded.
Error containers first, then a tight phrase match (`already exists`, `is
required`, `must be`, `cannot be`, `is invalid`) in small elements only.

### Search form (`#searchForm`)

```
#searchForm_account   name=account   <select>   "" | 2 = [GENERAL] General Account | 1 = [TRUST] Trust Account
#searchForm_fromNo    name=fromNo    text
#searchForm_toNo      name=toNo      text
#after                name=after     text       Statement Date After
#before               name=before    text       Statement Date Before
#searchButton  "Search"      #clearButton  "Clear"
```

Results columns: `Action | Bank Account | Page No | Statement Date | Opening
Balance | Closing Balance | Period Balance | Balanced`.

Trust Account currently holds **pages 1–9**, so the last page number is **9** —
page 9 is `31-05-2020`, opening `111753.97`, closing `1300000.00`, Balanced `N`.
The next new page is therefore 10.

### The mode chooser — two Continue buttons, two different ids

```
#form_selection_search   radio, CHECKED by default   "Search Existing Statement(s)"
#form_selection_issue    radio                       "Reconcile New Statement"
#form_continueButton     "Continue"
```

The **new-statement form's** Continue is `#continue`. The **chooser's** is
`#form_continueButton`. Two pages, two ids; a selector written for one silently
misses on the other.

### Reconcile New Statement

```
#bankAccount     name=bankAccount    <select>   REQUIRED
#pageNumber      name=pageNumber     text       REQUIRED
#statementDate   name=statementDate  text       REQUIRED   dd-mm-yyyy
#openingBalance  name=openingBalance text       optional
#closingBalance  name=closingBalance text       optional
#periodBalance   name=periodBalance  text       optional
#continue "Continue"
hidden: #bankStatementId #hiddenInitialClosingBalance #hiddenInitialStatementDate #hiddenInitialPageNumber
```

Only the first three are mandatory — which is exactly why the opening and
closing balance have to be **asked for in chat**. The form will happily take a
statement without them and the reconciliation is then unanchored.

#### The search RESULTS grid opens with an Action column (measured 07-08-2026)

```
Action | Bank Account | Page No | Statement Date | Opening Balance | Closing Balance | Period Balance | Balanced
```

Eight columns, and the first holds two icon links with no text. Reading them
positionally from zero puts `pageNo` on `"TRUST"` and shifts every other field
one to the left. `nextPageNumber` then saw nine rows whose page numbers were all
the word TRUST, discarded them all as unreadable, and answered **1** — for an
account whose grid was showing 1 through 9 on screen at that moment. The run
went on to try pages 1, 2 and 3, each already taken, and stopped.

Both grids are now read **by header name** — `recon-core.mapColumns` /
`rowsByHeader`, tested against these captured headers. The browser only reads
text out; which column is which is decided in node. Prefix matching handles the
sort arrows that live inside the header cell text.

The reconciliation screen's transaction grid keeps its measured positions as a
fallback for when the header row cannot be read at all — never as the plan.

#### CHANGING THE BANK ACCOUNT POSTS THE FORM BACK (measured 07-08-2026)

**Both** statement screens do this — `#bankAccount` here, and
`#searchForm_account` on the search form. The account `<select>` submits the
form on change, and what comes back is a NEW document with the fields at their
defaults. `#pageNumber` defaults to **1**.

Two failures, one run, same cause:

- On the SEARCH form, `#searchButton` was clicked while the postback was in
  flight. The search ran against nothing and returned an empty list. Zero
  existing pages reads as "this account has no statements", so the next page
  number came out as 1.
- On this form, the postback landed after `#pageNumber` had been typed and reset
  it to 1.

Both ended at Tramada answering **"Page Number already exists for bank account
'TRUST'"** on an account holding pages 1–9.

`selectAccountAndWait()` in `recon-run.js` handles it: hold an element from the
current document, change the account, watch for that element to detach, then
wait for the form to come back and assert the account actually stuck. The
reload is *detected*, not slept through — a fixed sleep is either too short on a
slow day or wasted on every run.

Two consequences worth keeping:

- **Set the account FIRST, then type everything else.** Anything typed before
  the postback settles is thrown away without a word.
- **The read-back has to be the last thing before Continue,** after a settle.
  A read-back taken with a postback in flight agrees with everything you typed
  and is wrong by the time the button is clicked.

#### These fields need REAL KEYSTROKES (measured 06-Aug-2026)

Setting `#pageNumber` and `#statementDate` through the native value setter with
`input`/`change` events — the `reactSet()` approach, and what Playwright's
`fill()` does — **reads back correctly in the DOM and is then discarded on
submit.** The form returns with both fields empty and highlighted yellow, as
though nothing had been typed. Opening Balance survives; those two do not.

Clicking the field and typing character by character works, first time.

This is §5's "PrimeNG calendars need real keystrokes" applying to a
plain-looking text input on a financial form. `recon-run.js` uses
`pressSequentially` and then **reads both values back before clicking
Continue**, because a silently-dropped date would file the statement against
the wrong day and nothing on screen would say so.

#### A brand-new page lists every unpresented transaction

Page 10, created empty on 07-08-2026, immediately showed **4,191 transactions**
dating back to 2020 with their checkboxes **unticked** — where page 9's were
ticked. So a statement page is a working surface over everything unpresented,
not a container for one day's lines, and receipts raised today appear on a page
created today regardless of its statement date. The whole reconciliation step
depends on that being true; it was verified rather than assumed.

### The reconcile screen

```
Statement Balance Details:  #openingBalance  #closingBalance (+ an "Edit" button)  #statementDate
Calculated Balance Details: #fieldGroupUnpresentedBalance  #calculatedClosingBalance
Transaction Filter By:      #filterColumn  → "" | "Rec/Pay Type" | "Trans Type"
                            #recPayType    ← revealed once filterColumn = Rec/Pay Type
                            #transType     ← revealed once filterColumn = Trans Type
Sort:                       #sortBy    → Date | Transaction Number | Receipt/Payment Type |
                                          Transaction Type | Reference |
                                          Receipt For/Payment To | Debit/Credit Amounts
                            #sortOrder → Ascending | Descending
Buttons:  #clearFilterButton · #filterButton · #sortButton · #selectAll · #deselectAll
hidden:   #hiddenSelectedStatementRecords  #hiddenKeepTransaction  #account  #page  #column
```

Transaction columns: `Date | Trans. No | Rec/Pay Type | Trans Type | Reference |
Receipt For/Payment To | Debit | Credit | ☑`.

### The one that would have broken a scraper

**Filtering hides rows; it does not remove them.** On page 9, after filtering to
Debtor Payment Receipt: **4,242 rows in the DOM, 47 visible.** A scraper that
reads `tbody tr` gets all 4,242 and every Rec/Pay Type in the system, while
looking like it respected the filter.

Read visible rows only — `tr.offsetParent !== null`.

Of those 47, **43 carry a reference** and 4 do not. A line with no reference
can't be matched to anything, which is why `statement-csv.js` drops it and says
how many it dropped.

### Vocabulary — read off the live dropdowns

`#recPayType` offers **fifteen** values:

`Client Payment Receipt` · `Client Refund Payment` · `Creditor Payment` ·
`Creditor Refund Receipt` · `Debtor Payment Receipt` · `Debtor Refund Payment` ·
`Deposit` · `Finance Client Payment Receipt` · `Finance Comm. Release Transfer
Payment` · `Finance Merchant Payment Receipt` · `Finance Merchant Refund
Payment` · `Finance Rounding Ledger Transfer` · `Finance Trust PD Comm. Transfer
Payment` · `Override Receipt` · `Pay Direct Comm. Receipt`

CONTEXT.md previously recorded **ten** of these, missing `Finance Merchant
Refund Payment`, `Finance Rounding Ledger Transfer`, `Finance Trust PD Comm.
Transfer Payment`, `Override Receipt` and `Pay Direct Comm. Receipt` — a third
of the vocabulary. It had been inferred from a screenshot. This list came off
the dropdown.

`#transType` offers **eight**: `Agency Credit Card` · `Cash` · `Cheque` ·
`Credit Card CCCF` · `Credit Card Swipe` · `EFT` · `Journal (Zero Balance)` ·
`Pay-mada`. The grid shows short codes (`ET`) rather than these labels, so the
filter vocabulary and the displayed vocabulary are **not the same strings** —
matching a grid cell against a filter option will not work.

### SORT FIRST, THEN FILTER — sorting clears the filter (07-08-2026)

`#sortButton` rebuilds the transaction list and drops whatever `#filterColumn` /
`#recPayType` were set to. Filtering and then sorting leaves the screen showing
every transaction on the page again, which reads as a filter that simply matched
a lot of rows. `filterAndRead()` sorts first, re-selects `#filterColumn` (the
rebuilt screen has it back at its blank default), filters, and then **asserts
`#recPayType` still reads the type it asked for** — a filter that silently reset
would have the matcher searching the whole statement while the log says it
filtered.

### Match the RECEIPT NUMBER against `Trans. No`, not the reference

The booking's receipt form hands back a number — `R.0000009403` — and that same
number is this grid's **`Trans. No`**. That is what reconciles a row.

Matching the CSV's `Reference` against the grid's `Reference` was checking free
text a consultant typed, on rows this run did not create. The receipt number is
Tramada's own identifier for the thing the run actually filed.

`recon-core.receiptKey()` drops punctuation and case and unpads the digits, so
`R.0000009403`, `r.0000009403` and `R9403` are one key — safe for a
machine-issued identifier with a fixed shape, and deliberately not done to
references. The letter is kept: `P.0000009403` is a payment, not that receipt.

### The Mint daily settlement filters on Creditor Payment

A Mint run files nothing. Its rows are settlements Tramada already holds, so the
only question is whether each reached the statement page:

```
sort by Date, Descending  →  filter Rec/Pay Type = "Creditor Payment"
→  each Transaction Reference looked for in the Trans. No column
```

`Creditor Payment` is one of the fifteen `#recPayType` values listed above.

The workbook's `Transaction Reference` (`M00640038`) IS the `Trans. No` — same
normalisation as a receipt number, so padding and case do not matter and the
leading letter still does. `Amount` is compared against the row's amount and
`To Company` against `Receipt For/Payment To`, but **neither can fail the row**:
a settlement that arrived for a different figure did arrive, and reporting it
identically to one that never came sends someone looking in the wrong place. The
difference is named in the `Why` column instead.

### The reconciliation run filters on Client Payment Receipt

A receipt raised against a booking can only be a **Client Payment Receipt** (see
§4b — the booking receipt form offers no Debtor Payment Receipt option). So the
receipts a reconciliation run creates appear on the statement under that type,
and the run filters to it: the match then confirms our own receipts reached the
bank statement. Filtering to Debtor Payment Receipt would only ever match the
pre-existing lines the CSV was scraped from, and never look at what was filed.

Sorted `#sortBy` = Date, `#sortOrder` = Descending, so newly created receipts sit
at the top of the page.

### What Debtor Payment Receipt lines actually look like

All 43 referenced rows on page 9 are **credits**, all `ET`, and the payee is
`RAA of SA Limited (Retail)` (42) or `RAA Group` (1) — so payee is nearly
useless as a matching signal and the reference does all the work. Those
references are wildly inconsistent: `Deposit - Jill Shields`, `Trip File Tsfr
1105`, `VIX122334`, a bare `NW`, `PROMO`, `Trip File Transfer`.

---

## 6. Writing to any of these

- Angular/React pages ignore `element.value = x`. Use `reactSet()` — native
  prototype setter plus `input`/`change`.
- Autocompletes: type with **real keystrokes**, wait for the suggestion, click,
  **then read the value back**. A click that appears to land often does not.
- Check for the error box after saving. A refused save looks like a successful
  one until you look.

---

## The reconcile screen, mapped live (10-08-2026)

Read off `finance-statement-generation.htm?bankStatementId=9` in a signed-in
Chrome. Everything below was measured, not inferred.

### `finance-statement-generation.htm` is a real route

An earlier note in `recon-run.js` called it "a name that never existed". It
exists, and it is the reconcile screen. The search results grid carries **two**
Action links per row, and the difference matters:

```
Reconcile Bank Statement  → finance/finance-statement-generation.htm?bankStatementId=N
Edit Page Balances        → finance/finance-statement.htm?bankStatementId=N
```

`finance-statement.htm` is the balances form (`#pageNumber` readonly,
`#bankAccount` disabled, `#openingBalance` / `#closingBalance` / `#periodBalance`
editable, `#continue` to save). `finance-statement-generation.htm` is the
transaction list, the ticks and Done. Two screens, and both answer to
`#openingBalance` — a selector written for one will find the other quite
happily.

### The balance fields are READONLY until an unnamed button says otherwise

```
#openingBalance  #closingBalance  #statementDate   ← all readonly on load
#fieldGroupUnpresentedBalance  #calculatedClosingBalance   ← readonly, live tallies
```

The only thing that unlocks them is

```html
<input type="button" value="Edit" class="button">   <!-- no id, no name -->
```

inside `dl.edit > dt.input-short-button`. There is exactly one of these on the
page, so `dl.edit input[type="button"][value="Edit"]` finds it.

**This is why the opening balance was never set.** Typing into a readonly input
succeeds silently — no error, no exception, no change — so the run typed the
figure on the NEW-STATEMENT form, where it is accepted, and the reconcile screen
went on showing the account's own number. `setStatementBalances()` clicks Edit,
asserts `readOnly` actually cleared, types, and reads back.

### The transaction checkbox

```html
<input type="checkbox" name="selected" id="selected" value="666">
```

- **`id="selected"` is duplicated across all 4,257 rows.** `#selected` is
  useless. The `value` is the statement record's id and is unique — it is the
  only stable handle on a row.
- It carries a **bound jQuery click handler** (`calculateTotal`). Setting
  `.checked = true` skips it, so the tallies never move and the page submits a
  tick the form does not believe in. Real clicks only — the same rule as the
  receipt form's segment checkboxes, for the same reason.
- `calculateTotal` calls **`moveCheckedToTop()`**: the ticked row *jumps to the
  top of the table*. Anything holding a row index is pointing at a different row
  by the next tick. Address rows by `input[name="selected"][value="<id>"]`.

### Ticking a future-dated transaction raises a `confirm()`

`checkSelectedTransaction` → `transactionDateIsAfterStatementDate` → a browser
confirm, answered into `#hiddenKeepTransaction` (`"true"` / `"false"`), with
`highlightRowInRed` on the row either way.

An unhandled dialog **freezes Playwright outright** — every later command hangs.
Register a dialog handler before the first click. The run accepts, because the
only rows it ticks are ones it matched to a receipt it filed itself, and reports
every firing.

### The buttons

```
#clearFilterButton "Clear Filter"   #filterButton "Filter"   #sortButton "Sort"
#selectAll "Select All"             #deselectAll "Deselect All"
#printButton "Export Results"       #done "Done"      ← submit, name=done
hidden: #hiddenSelectedStatementRecords  #hiddenKeepTransaction
        #bankStatementId #id #version #account #page #column #ascending
```

`#done` submits the form; `preSubmitForm()` gathers the ticked rows into
`#hiddenSelectedStatementRecords` on the way out. **Done commits the page.**

`#selectAll` on this screen ticks every unpresented transaction — 4,257 of them
on page 9. It is not the same button as the receipt form's `#selectAll` and it
is never what a reconciliation run wants.

### What the account actually holds (10-08-2026)

Trust Account holds pages **1–9**; page 9 is `31-05-2020`, opening `111753.97`,
closing `1300000.00`, Balanced `N`, with 4,257 transaction rows of which 52 are
already ticked. The page 10 recorded earlier in this file is gone — a page
number read from the grid, never remembered.

---

## The IPSI search reaches two days back

`From Transaction Date` was left empty, and on that screen empty means
**everything up to the To date** — every swipe receipt ever raised for the
debtor, fetched and rendered before a single row could be ticked. That is most
of why Go took long enough to time out the window it opens.

It is now `To` **minus two days** (`IPSI_FROM_DAYS`). Two rather than one
because a receipt raised late in the evening settles the next day, and a Monday
run has a weekend behind it. An unreadable To date leaves From empty rather than
inventing a range — a wide search is slow, a wrong one quietly misses receipts.

---

## IPSI matches on Transaction Reference

`Transaction Reference` is IPSI's own id for the transaction and is on every
row of the client's 49-row export. It is what gets typed into the Reference
field when the Credit Card Swipe receipt is raised, so it is what the run looks
for on Receipts To Reconcile — falling back to Booking Number + amount, because
ten of those forty-nine rows are Captures whose reference is a different shape
entirely.

**`Merchant Reference` is not read at all.** It used to be the match key, and
two of the four rows on the live screen had none — so those rows were held back
before anything looked at them, for want of a column the run does not need. A
row is only held back now when it has neither a transaction reference nor a
booking number, because then there is genuinely nothing to match it by.

---

## TravelPay's Payment Reference is TravelPay's number

The client's own export:

| Payment Reference | Processor Reference | Processed Amount |
|---|---|---|
| `31282716` | `PR.46nyrd` | 1480.88 |
| `31282311` | `PR.46nvkd` | 1735.84 |

Both are **the merchant gateway's** ids. Tramada's `Trans. No` is an `R.`
receipt number and can never equal one of them, so a TravelPay row cannot be
reconciled against that column.

It reaches Tramada through the **Reference** field on the receipt — that is
where the consultant types the merchant's number when raising it — and the
reconciliation page shows it in its own **Reference** column. So
`matchTravelPayAgainstStatement` looks there first, and only then at
`Trans. No`.

**This went unnoticed because the fixture matched itself.** `make-fixtures.js
travelpay` wrote `9413` into Payment Reference — the receipt number with its
prefix and padding stripped — and a comment claimed `receiptKey` reduced both
sides "the same way, so the two meet in the middle". It does not:
`receiptKey("R.0000009413")` is `R9413`, not `9413`. The two never met, and
TravelPay reconciled nothing. The fixture now writes the reference the receipt
was actually raised under.

---

## The creditor payment form, mapped live (10-08-2026)

`booking/booking-creditor-payment.htm?mode=add&parentId={bookingNo}`, reached
from `booking/booking-payments.htm?mode=edit&id={bookingNo}` → **`#add`**
("Add / Issue Payment"). Measured on booking 13175.

**This is the only form in the project that moves money OUT.**

### It is the receipt form with different columns

```
#paymenttransactionTypeCode   ""  CQ=Cheque  ET=EFT      ← only two, not five
#paymentagencyBankAccount     1=[TRUST] Trust Account
#creditor                     ""  309=READY ROOMS (READY)
#paymentpayeeName  #paymentpaymentDate (dd-mm-yyyy)
#paymentpaymentAmount  #paymentreferenceNumber
#selectAll  #deselectAll  #roundRemaining
#preview (submit)   #issue (submit)
hidden: #parentId #mode #hiddenRecordType=CREDITOR_PAYMENT
        #hiddenAllocatedAmount #hiddenRoundingAmount
```

`#creditor` offers the creditors this booking is **costed to**. Choosing one
posts the segment table back — wait for it.

> **Corrected 10-Aug-2026.** This used to read "only creditors this booking
> actually owes, so a creditor missing from the list is a fact about the
> booking". That was an assumption from a booking that happened to be
> receipted, and it is wrong in the way that matters: READY ROOMS is offered on
> a booking with **nothing payable at all**, and the segment table then comes
> back empty. See below.

### Nothing is payable until the client has paid

**Money in before money out.** A costed segment does not become payable to the
creditor until the client's receipt has been taken **and allocated against
it**. Cost a booking and go straight to this form and Segments To Allocate is
empty — no rows, no header, nothing to tick — even though `#creditor` happily
offers the creditor.

That is trust accounting, not a Tramada quirk: an agency cannot pay a supplier
out of money it has not received.

The first real `make-fixtures.js mint` run walked into this on bookings 13229
and 13232, and because `readPayableSegments` built its header list inside the
loop over the rows, an empty table surfaced as

```
The payment form's segment table has no "Creditor Payable" column (headers: )
```

which points at the wrong thing entirely. The reader now says "nothing is
payable yet — raise the receipt first" when there are no rows, and only talks
about columns when there are rows it cannot read. **So the order is: create the
booking, cost it, receipt the client, THEN pay the creditor.**

### The segment columns are NOT the receipt form's

```
receipt   D | Seg. Type | Invoice No. | Reference | Creditor ID |
          Debtor Invoiced | Debtor Receipted | Debtor Due | Allocate | A
payment   D | Seg. Type | Reference | Creditor ID |
          Creditor Nett | Creditor Paid | Creditor Payable | Allocate | A
```

**Creditor Payable is index 6; Debtor Due is index 7.** The payment form has no
Invoice No. column. `tramada-receipt.js` hardcodes `cells[7]`; `tramada-payment.js`
maps by header name instead (`recon-core.mapColumns`), which is the rule
everything else here already follows.

Booking 13175's row, verbatim: `* | HTL | READY ROOMS | 309 | 300.00 | 0.00 | 300.00`.

`#allocationAmount_{segId}` ships **`disabled readonly`**, and the row checkbox
`input[name="segmentsToAllocate"][value="{segId}"]` is what enables it — same
name and same order-of-operations as the receipt form. Tick first, then type.

### The remittance email

```
#useEmail (UNCHECKED on load)  #emailSubject  #tos  #emailFormat
#documentType   REMITTANCE_PLUS_ALLOCATION | REMITTANCE_ONLY
```

Ticking `#useEmail` mails the creditor a remittance on Issue. Nothing in this
project ticks it. Leave it alone.

### What a payment looks like afterwards

The Booking Payments list is
`Action | Payment No. | Payment Category | Payment Type | Trans. Type | Paid To | Reference | Payment Date | Amount`,
and the number is **`P.0000000161`** — the same shape as a receipt's `R.` and
exactly what Mint's export carries as its Transaction Reference. On the
reconcile page those rows read `Rec/Pay Type = Creditor Payment`, `Trans Type = ET`.

Its sort order is undocumented, so `findIssuedPayment()` searches the whole list
for the reference AND amount it just filed rather than trusting the top row —
see CODE-REVIEW.md §2 for what trusting it costs.

---

## The IPSI flow — Finance Receipts, mapped live (10-08-2026)

Three screens, and the third one is **a separate browser WINDOW**.

### 1. The mode chooser — `finance/finance-receipts.htm?mode=edit&id=1`

Measured 10-08-2026. Same ids as the bank-statements chooser, which is worth
knowing because they are on different screens and could easily not have been:

```
#form_selection_search   radio, name=selection, value="search"  ← CHECKED by default
#form_selection_issue    radio, name=selection, value="issue"   ← the IPSI path
#form_continueButton     "Continue"     (also a plain "Cancel" with no id)
```

Search is checked on load, so the issue radio has to be checked explicitly.

### 2. The search — `finance/finance-receipts-issue.htm`

```
#receiptType         Receipt Category  ← FINANCE_MERCHANT_PAYMENT_RECEIPT
#agencyBankAccount   Bank Account      ← 1 = [TRUST] Trust Account
#debtor              Debtor Code       ← autocomplete, see below
#fromTransactionDate #toTransactionDate  dd-mm-yyyy
#sortBy              "" | BOOKING_NUMBER | REFERENCE | DATE_OF_ISSUE | CARD_HOLDER | TRANS_NUMBER
#sortOrder           ASCENDING | DESCENDING   ← defaults ASCENDING, we want DESCENDING
#goButton "Go"  #backButton  #form_clearButton  #form_advancedSearch
```

`#receiptType`'s full vocabulary, read off the dropdown:
`Finance Client Payment Receipt` · `Debtor Payment Receipt` ·
`Creditor Refund Receipt` · `Pay Direct Comm. Receipt` · `Override Receipt` ·
`Finance Merchant Payment Receipt`.

**`#debtor` is an autocomplete, not a select.**

```html
<input id="debtor" class="autocomplete-text" autocomplete="off"
       data-field-type="ctrl-type-AutoCompleteAndEditToggleTextF">
```

It has bound `input`/`change`/`click` handlers, so typing "Master" and taking
the suggestion is the only way in — the value that ends up there is
`[MASTER] [] MasterCard/Visa/Debit`. This is the same widget `tramada-segments.js`
already fights: its suggestions render as plain `li`/`div`/`td`/`a` with no
stable class, which is why `_findSuggestion` locates them **geometrically**.
Reuse that, do not invent a selector.

**`#goButton` is disabled after it has been clicked — confirmed 10-08-2026.**
Reloading `finance-receipts-issue.htm` brings it back enabled with every field
blank. So it is a submit-once guard: Go cannot be clicked twice on one page
load, and a retry means reloading the search form and filling it again. The
`sortOrder` default is `ASCENDING`, so Descending has to be set every time.

### FILL THE DEBTOR LAST — the selects wipe it (measured 10-08-2026)

This is what made the first live attempt fail with **"Debtor Code must be
entered"**, and it is not obvious from looking at the form.

There is **no hidden companion field**. The form posts the visible `#debtor`
text verbatim — a failed submit was seen posting `debtor=Mas`. So whatever is
in that box at submit time is the whole story.

And **changing `#receiptType`, `#agencyBankAccount` or `#sortOrder` clears
`#debtor`.** Pick the debtor first and then set a dropdown, and the debtor is
silently empty again while still looking filled a moment earlier. Measured: the
field read `[MASTER] [] MasterCard/Visa/Debit`, three selects were set, and the
field read `""`.

The order that works, in full:

```
1. #receiptType      = FINANCE_MERCHANT_PAYMENT_RECEIPT
2. #agencyBankAccount= 1                       ([TRUST] Trust Account)
3. #sortOrder        = DESCENDING              (it defaults to ASCENDING)
4. #toTransactionDate                          (dd-mm-yyyy)
5. #debtor           — click, type, pick from the list        ← LAST
6. verify the form would post debtor=[MASTER] …, THEN click #goButton
```

Typing can also be **truncated** — one attempt left `Mas` in the box from six
real keystrokes, because each character fires a DWR lookup that rewrites the
input. Read the value back before clicking the suggestion, and read the whole
field back again before pressing Go. Both are cheap; a wrong debtor silently
searches the wrong ledger.

### The Debtor Code autocomplete DOES have a hook

This corrects the note in §"The dropdown has no hook" above, which is about the
segment forms' widget. This one is different, and better:

```
li.selected < ul < div#debtor_auto_complete_div.auto_complete < dt.input < dl.edit
```

The container id is the field id plus `_auto_complete_div`, so `#creditor`
gets `#creditor_auto_complete_div`. The highlighted row carries `.selected`.
No geometry needed — `#debtor_auto_complete_div li` is enough.

**It only appears for REAL keystrokes.** Setting `.value` through the native
setter and dispatching `input` (the `reactSet` approach) leaves the field
reading "Master" and no list at all — measured. Click the field, type, then
click the `li`; the field ends up holding `[MASTER] [] MasterCard/Visa/Debit`.

### 3. Go opens a NEW WINDOW — not a tab, not the same page

The form's `target` is empty and `#goButton` carries no inline `onclick`, so the
window is opened from JavaScript: `pop-up.js` holds seven `window.open` calls
and exposes a global `PopUp`.

**The popup cannot be reached by URL either — confirmed 10-08-2026.** Opening
`finance-merchant-payment-receipt.htm?mode=add&receiptType=…&selectedDebtor=MASTER&agencyBankAccount=1`
directly in a tab returns Tramada's **Error Page**. The search results live in a
server-side container (the search form carries `#dataContainerId`), so the popup
only exists as the answer to a Go submit — it cannot be recreated from a URL.

**The Chrome extension cannot see that window — confirmed 10-08-2026.** After
clicking Go, the extension's tab list was unchanged: the search page had
reloaded (its own `action`), no results rendered into it, and the popup was
nowhere in the tab group. So this screen cannot be mapped through the extension
the way the reconcile and creditor-payment screens were; what is written below
comes from the client's screenshots plus the id conventions the rest of Tramada
follows.

**Go takes as long as the SEARCH takes — not as long as a window takes to
paint.** Tramada posts the form, works through the ledger, and only then calls
`window.open`. On a wide date range that is well past 30 seconds, and a 30s
wait failed with

```
page.waitForEvent: Timeout 30000ms exceeded while waiting for event "popup"
```

with the window opening immediately afterwards, orphaned — the wait had already
given up. The run now allows three minutes (`IPSI_POPUP_TIMEOUT_MS`), says how
long it has been waiting every 15s, and watches the whole browser context rather
than only popups attributed to the search page.

Because that context is the human's OWN Chrome, a tab they open while the search
runs is a new window too. A window already showing the receipt form always wins;
failing that exactly one new window is taken; two unidentifiable ones are not
guessed between.

**Playwright is not the extension, and does see it.** A `window.open` popup
arrives as a `Page` on the browser context, so the run can drive it — it just
has to be listening when it opens:

```js
const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 15000 }),
  page.click("#goButton"),
]);
```

A popup that opens while nothing is listening is lost, and every selector after
it would run against the search page instead — finding nothing, and looking for
all the world like an empty result. `enterNewBookingCard` in
`tramada-receipt.js` already does this for the credit-card form, including
fallbacks for same-page and iframe; that is the pattern to copy.

### 4. The popup — `finance/finance-merchant-payment-receipt.htm`

```
?mode=add&isShowUnallocatedReceipts=false
&receiptType=FINANCE_MERCHANT_PAYMENT_RECEIPT&selectedDebtor=MASTER&agencyBankAccount=…
```

Measured 10-08-2026. The popup **can** be loaded in an ordinary tab after all —
but only with the live `dataContainerId` from a real Go submit in the URL
(`…&dataContainerId=161&…`). Without it, Error Page. So: press Go, take the
popup's address, and it opens anywhere; there is no way to conjure one.

**That is what the run does now.** The window is slow — it paints from nothing
and every later step waits on it — so `searchIssueReceipts` waits only for the
popup's navigation to COMMIT, reads the URL, loads it in the tab it already has,
and closes the window. The form is confirmed in the tab **before** the window is
closed; if it does not appear, the window is kept and used exactly as before.
`IPSI_KEEP_POPUP=true` turns it off.

> **Not yet confirmed: pressing Issue from an ordinary tab.** The page rendering
> there is measured; the submit is not. A form built for a popup can reference
> `window.opener` (null in a tab) or call `self.close()`, and if its Issue
> handler does, the click would throw instead of posting. That fails safe —
> nothing is filed and the run reports it — but it has not been proven either
> way. Tick **Dry run** for the first IPSI run after this change: it fills the
> form and stops before Issue, which is exactly the question.

```
#receipttransactionTypeCode   ""  CQ=Cheque  ET=EFT     ← same two as the payment form
#receiptagencyBankAccount     [TRUST] Trust Account
#debtor                       "MasterCard/Visa/Debit"   READONLY
#receiptpayerName  #receiptdateReceived (dd-mm-yyyy)
#receiptreceiptAmount  #receiptreferenceNumber
#receiptchequeDrawer #receiptchequeBank #receiptchequeBranch   ← Cheque only
#roundRemaining
#cancel   #preview   #issue
#documentTemplate "Finance Merchant Payment Receipt" RO
#documentType   RECEIPT_PLUS_ALLOCATION | (one other)
email block: #useEmail #emailSubject #tos #emailFormat …   ← leave alone
```

### Credit Card Swipe lives on the BOOKING form, not this one

The receipts that appear in *Receipts To Reconcile* are typically raised as
**Credit Card Swipe** — but that is a property of how they were created, on
`booking-client-payment-receipt.htm`, whose `#receipttransactionTypeCode`
offers five types (`Cash | Cheque | Credit Card CCCF | Credit Card Swipe | EFT`).

**This screen's select is a different one with a different vocabulary:** `""`,
`CQ=Cheque`, `ET=EFT`. There is no swipe option here and there is nothing to
choose — the merchant payment receipt is EFT.

Nor can a run filter on it: *Receipts To Reconcile* has no transaction-type
column, so the type of the underlying receipt is invisible on this page. IPSI
matching therefore ignores it entirely (Merchant Reference, falling back to
Booking No. + Amount).

One consequence for fixtures: raising a Credit Card Swipe receipt goes through
`enterNewBookingCard`, which types a real PAN into Tramada's card form. That is
why `make-fixtures.js` has no `ipsi` subcommand that creates them — the receipts
are raised by hand and the fixture only writes the CSV that points at them.

### THERE ARE TWO `#selectAll` BUTTONS, one per table

`document.querySelectorAll("#selectAll").length === 2` — a duplicated id, one
above *Payments To Reconcile* and one above *Receipts To Reconcile*. This is the
same trap as the booking receipt form, where the segments one is the second.
Never address it as `#selectAll`; scope it to the table you mean. An IPSI run
should not press either — it ticks only the rows it matched.

### The row checkbox has NO id and NO name

```html
<input type="checkbox" data-fn-click="…" value="22409">
```

Its whole attribute list is `type, data-fn-click, value`. The `value` is the
receipt's internal record id — **not** the receipt number — and it is the only
handle on a row. It carries a bound `click` handler, so `.checked = true` will
not do: real clicks, same rule as everywhere else on this portal.

Because the box has no `name`, it does not post as an ordinary form field; the
handler gathers the selection, exactly like `#hiddenSelectedStatementRecords` on
the reconcile screen. So a tick that did not fire its handler is a tick the
server never hears about — verify each one.

Scope the selector to the Receipts table: `useEmail`, `ccEmails` and `bccEmails`
are also checkboxes on this page, though their value is `"on"` rather than a
record id.

### The two tables

```
Payments To Reconcile   Payment No. | Booking No. | Payment Date | Card Holder | Reference | Paid To | Refund Amount | Due Amount | A
Receipts To Reconcile   Receipt No. | Booking No. | Date Received | Card Holder | Reference | Received From | Receipt Amount | Due Amount | A
```

Each has its own "Allocated Total: 0.00" footer. Real rows, read off the live
screen:

```
R.0000009412 | 13184 | 10-08-2026 | user demo | abc456 | USER/DEMO MR | 9623.23 | 9623.23
R.0000009411 | 13181 | 10-08-2026 | user demo | abc123 | USER/DEMO MR |  200.48 |  200.48
R.0000009410 | 13178 | 10-08-2026 | user demo |        | USER/DEMO MR | 9623.23 | 9623.23
R.0000009405 | 13160 | 10-08-2026 | user demo |        | USER/DEMO MR |  400.97 |  400.97
```

**Note the Reference column is blank on two of the four.** That is exactly why
IPSI matching falls back to Booking No. + Amount — and note the two 9623.23 rows
share an amount, so amount alone would be ambiguous.

`Amount Received` is the total of the rows actually ticked, not the file's
headline settlement figure — a receipt has to balance against what it allocates.

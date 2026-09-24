# Tokio Marine — what the files actually contain

Measured 18-Sep-2026 from the five examples RAA supplied, alongside
"Reconciliation Guide - Tokio Marine 1.docx". Nothing here is inferred from the
guide's prose; where the guide and the spreadsheets disagree, both are recorded.

## The four inputs

| file | sheet | rows | key column |
|---|---|---|---|
| Tokio Marine B2B report | `B2B Template` | 1903 | `xPolicyNo` (A) |
| Tramada Payment Report | `Tramada Payment Report` | 2324 | `Reference` (C) |
| Tramada Costing Report | `Tramada Costing Report` | 863 | `Segment Reference` (L) |
| RCC Report (Finance One) | `RCC Report` | 977 | `Ticket/Booking No.` (D) |

### The B2B report's own 21 columns, in order

```
A xPolicyNo            H xCustomer            O xGSTOnTotalProfit
B xAccountNo           I xSellPriceExclGST    P xTotalProfitShareIncGST
C xTransactionNumber   J xGSTonSellPrice      Q xInsuredName
D xTRVIssuedDate       K xStampDuty           R xOriginatingagent
E xUWETransDate        L xSellPriceIncGST     S xAgent
F xStoreCode           M xNetPrice            T xBranch
G xProductCode         N xTotalProfit         U Varn GST on Comm
```

BR02 — these are the source of truth, kept in this order, unaltered. Everything
calculated is appended to the right.

`xCustomer` (H) and `xInsuredName` (Q) are the two passenger-name columns step 1
says a human removes before the file leaves Finance. In the example they both
read "Insured Name", i.e. already de-identified.

## The appended columns, as the AFTER template really builds them

| col | header | formula in the example |
|---|---|---|
| V | `RAA Commission` | `=L2*30%` |
| W | `RAA Total Nett` | `=L2-V2` |
| X | `Tramada Payment Report` | `XLOOKUP(A2, 'Tramada Payment Report'!J:J, …)` |
| Y | `Tramada Costing Report` | `XLOOKUP(TEXT(A2,"########"), 'Tramada Costing Report'!L:L, …, FALSE)` |
| Z | `RCC Report` | `XLOOKUP(A2, 'RCC Report'!D:D, …)` |

Note the header is **`RAA Total Nett`**, two t's — the guide's prose says "RAA
Total Net" in places. The spreadsheet spelling is the one Finance sees.

`W = L - V` is arithmetically 70% of L, which is what BR03 says. Neither column
is rounded in the example: 218.93 gives 65.679 and 153.251.

### The Payment Report lookup is NOT on a column Tramada exports

`'Tramada Payment Report'!J:J` does not exist in the report as exported — the
standalone file has eight columns, A to H. Column J is a **helper the human
added**:

```
J = IFERROR(IF(LEN(VALUE(MID(C2,FIND("2",C2,1),8)))=8,
             VALUE(MID(C2,FIND("2",C2,1),8)), "CHECK"), "CHECK")
```

It digs the policy number out of `Reference`, which reads
`21087245 - 21087245 - ALTUS/ELIZABETH MRS, …`. So: find the first "2", take
eight characters, and if that is not eight digits say `CHECK`.

Reproducing that literally would inherit its bug — a reference whose first "2"
is not the start of the policy number yields a wrong eight digits, silently.
`tokio-core.js` instead takes the first 8-digit run beginning `21`, and reports
the reference when it cannot find one.

The AFTER workbook also carries helpers K, L, M, N (a B2B cross-check, an
amount check, the nett amount and a difference). They are Finance's own working
and are not part of the guide's steps.

## Found / not found

The three lookup columns hold the policy number when the lookup hits. When it
misses they hold `#N/A` (X and Z) or `FALSE` (Y — its XLOOKUP passes an explicit
`FALSE` default). The guide asks for `N/A`, which is what this project writes.

In the example: 1007 of 1903 rows missed on Payment, 1231 on Costing, 1059 on
RCC.

## The Remarks column does not exist in the template

Step 6 and BR02 both require a `Remarks` column appended after the three lookups
and carrying the reason for every exception and mismatch. The AFTER template
stops at Z. This project appends `AA Remarks`, per the guide.

## RAAQ — a quote, not a policy

`RCC Report!D` carries values like `RAAQ-846157711` alongside real policy
numbers. Per the guide's own note, a `RAAQ` prefix means a consultant never
replaced the quote number with the policy number after payment. Such a row
cannot match a 210-series policy and is remarked rather than silently missed.

## Classification — step 7 and step 8, in full

Step 7 and step 8 are more specific than BR05/BR06, which summarise them. Where
they differ, the steps win.

| branch has "Travel" | in RCC | in Payment or Costing | outcome |
|---|---|---|---|
| no | yes | no | **Retail — remove the line** |
| no | yes | yes | exception, "Please check" |
| yes | yes | yes | exception, "Please check" |
| yes | no | yes | **Travel — reconcile** |
| yes | no | no | exception, "Please check" |

Two combinations are covered by neither step:

- branch has "Travel", in RCC, **not** in Payment or Costing
- branch does **not** have "Travel", **not** in RCC

Both are flagged for human review rather than guessed at. That is a gap to put
back to RAA, not a decision to take here.

## Matching in Tramada — step 12

Match on Reference (the 210 policy number) **and** amount, the amount being
`RAA Total Nett`, within **±1%** (BR13). The same policy can appear more than
once with different amounts where an extension was added later, so the line is
chosen by amount, not by being the first with that policy number (BR12).

Total rounding of about $50 across the whole reconciliation is acceptable
(BR14) — that is Travel Accounts' to apply, not the run's.

## What the agent must never do

- Click **Issue** (BR16, BR18). It saves a session labelled `TOKIO_MMM YY` and
  stops.
- Enter a Transaction Total at upload. There is no figure to balance to until
  Retail is excluded and exceptions are resolved.
- Resolve an exception or a mismatch (BR18).

---

## The Issue Payments screen, mapped live (18-Sep-2026)

Steps 9 and 10. Finance → Payments (`finance/finance-payments.htm`) is a
two-radio chooser; pick **Issue Payment** and Continue, which lands on
`finance/finance-payments-issue.htm`.

```
#form_selection_search / #form_selection_issue   radios
#form_continueButton "Continue"
```

The radio needs a real click — setting `.checked` in script did not stick, and
submitting with it unset silently returns the same chooser.

### The search form — every field step 10 names

```
#paymentType          Payment Category
                      "" | CREDITOR_PAYMENT | DEBTOR_REFUND_PAYMENT
                      | AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT
                      | FINANCE_MERCHANT_REFUND_PAYMENT
                      | FINANCE_COMMISSION_RELEASE_TRANSFER_PAYMENT
#agencyBankAccount    Bank Account          "" | 1=[TRUST] Trust Account
#creditor             Creditor Code         text + autocomplete
#level1Branch         Level 1 Branch        "" | 1=[ADL] … 14=[PLO] …
#fromTransactionDate  From Segment Created Date
#toTransactionDate    To Segment Created Date
#transferDate         Transfer Date
#sortBy               Sort by
                      "" | BOOKING_NUMBER | REFERENCE | CREDITOR_INVOICE_NUMBER
                      | DATE_OF_ISSUE | SEGMENT_TYPE | PASSENGER_NAME
#sortOrder            Sort order            ASCENDING | DESCENDING
#goButton "Go"   #backButton "Back"   #form_clearButton "Clear"
```

Note the ids: the two date fields are **`fromTransactionDate` /
`toTransactionDate`**, though their labels read "Segment Created Date". Going by
the label name would find nothing.

`#agencyBankAccount` offers exactly one account, `[TRUST] Trust Account`, so
BR-wise there is nothing to choose — but it is set explicitly and asserted, the
same as everywhere else in this project.

### Creditor Code — the guide names the wrong code

Step 10 says to type `Tokio..` and select **"[TOK] Tokio Marine Insurance"**.
This sandbox has no such creditor. Typing "Toki" offers exactly one entry:

```
[TOKIOMARINE] Tokio Marine
```

So the code is never hard-coded. The run types the text, reads what the
dropdown offers, and refuses if that is nothing — or if it is more than one,
since picking between them is a guess about whose payments to raise.

The suggestions live in `#creditor_auto_complete_div > ul > li`.

**Typing the name is not enough.** Submitting with the raw text "Tokio" gives
`Creditor Code is invalid` — after the search, as a banner. The field must hold
a resolved `[CODE] Name`, which is what the check now requires. Testing only
that the field "contains tokio" passes the exact value Tramada rejects, which
is how this got through the first time.

Worth confirming with RAA whether production really is `[TOK] Tokio Marine
Insurance`, or whether the guide is describing a different environment.

### Advanced Search takes a FILE of references

Undocumented in the guide, and potentially the answer to step 13's "roughly 50
pages":

```
#form_advancedSearch "Advanced Search"
#form_searchBy        "" | SEGMENT_NO | BOOKING_NO | REFERENCE
#form_fileToUpload    <input type=file>
#form_add "Add"
```

Searching by **Reference** with an uploaded list would return only the policies
the consolidated sheet says are Travel, instead of paging through every Tokio
Marine transaction for the month and ticking a subset.

This is not what the guide describes, so nothing uses it yet. It is worth
putting to RAA before building the 50-page walk.

---

## Step 15 / BR17 — the mail to Travel Accounts

Measured from "Reconciliation Guide - Tokio Marine (2).docx":

> AI Agent emails the consolidated spreadsheet to Travel Accounts, advising
> that the Tokio Marine session is saved and ready for review.
> Email address is: TAccounts@raa.com.au with subject
> **"AI Agent Tokio Marine reconciliation - Session saved, ready for review"**

`tokio-email.js` holds both verbatim as `TRAVEL_ACCOUNTS` and `SUBJECT`.

### A draft, not a send

The default transport writes a `.eml` — a real message, addressed, subject
lined, with the consolidated sheet attached — which a person opens in their
own mail client and sends. `transport: "smtp"` transmits instead, and needs
both the literal `SEND EMAIL` and SMTP credentials in the environment that
this repo does not ship and never logs.

That split is not timidity about mail. The message asserts *session saved,
ready for review* — a claim about work a human is about to be asked to check —
and BR16/BR18 already put the resolving, the rounding and the Issue click in
a human's hands. The person who presses Send is the person who owns the claim.

### What it refuses to say

| guard | why |
|---|---|
| `savedSession !== true` | the subject says a session was saved. If none was, the mail is false. Truthy-but-not-`true` is refused too. |
| no attachment, or an empty one | BR17 *is* the spreadsheet arriving. A mail without it is not step 15. |
| the sheet still has `xCustomer` / `xInsuredName` | step 1 strips the passenger names before the file leaves Finance. This is the moment it leaves. |

The body states plainly that Issue was **not** clicked, and lists what a
person still owes: the exceptions, the rounding (BR14) and the transaction
total (BR18).

### Open with RAA

The guide's subject names **Tokio Marine**. A subject reading *"AI Agent DVC
reconciliation"* has also been quoted in passing — DVC is the Westpac virtual
card flow in the other repo and has no reconciliation, so the two are unlikely
to be the same requirement. `SUBJECT` follows the guide; the API and CLI both
accept an override. Worth one sentence of confirmation before go-live.

---

## FOUND IT: Go opens the results in a NEW WINDOW (24-Sep-2026)

Everything below this section was wrong, and this is why.

Clicking **Go** on `finance-payments-issue.htm` does not navigate that page.
Tramada opens **`finance/finance-creditor-payment.htm`** — "Issue Creditor
Payment" — in a **separate browser window**, carrying `agencyBankAccount`,
`level1Branch` and a `dataContainerId`. The search form is still sitting
there afterwards, completely unchanged.

So code that clicks Go and then reads the same `page` object sees the form it
started with: no grid, no Payment Overview header. It concludes there is
nothing to pay. That is what this module did, and on the strength of it we
told RAA their sandbox had never had a creditor payment. It has pages of
them.

### The results page

```
finance-creditor-payment.htm?isAgencyCreditCardPayment=false
    &agencyBankAccount=1&level1Branch=1&dataContainerId=<n>
```

- **"Segments To Allocate"** is the grid — not a heading this file looked for.
  Columns: `D | R | Seg. Type | Booking No. | Reference | Issue/Conf. Date |
  Creditor Nett | Creditor Paid | Creditor Payable | Allocate | A`.
  The tick is the **A** column.
- The **Payment Overview / Payment Details** header (Transaction Type, Payee
  Name, Date Of Payment, Amount Of Payment, Reference) — step 11 — lives on
  THIS page. It was never missing; we were never on the page that has it.
- `Select All` / `Deselect All` / `Refresh` sit above the grid.

`searchCreditorPayments` now listens for the popup before clicking Go and
returns it as `search.page`; the whole run works against that window.

### The other thing that hid this: a silently refused search

**Creditor Code is mandatory.** Submitting without it paints a red banner —
*"Creditor Code must be entered"* — and changes nothing else on the page. Read
by code looking only for a grid, that is indistinguishable from an empty
result. Every "all creditors" search used to argue the sandbox was empty was
refused this way and never ran. `searchCreditorPayments` now reads the banner
and says the search was refused, which is a different claim from "this
creditor owes nothing".

---

## Superseded — the conclusions the bug above produced

## RAA's own example booking does not appear either (24-Sep-2026)

Megan gave booking **13817** as the one she did it on. Its Tokio segment is
`82457`, and it is set up exactly as ours:

| | booking 13817 (Megan's) | booking 15875 (ours) |
|---|---|---|
| Payment Type | `PRE_PAID` | `PRE_PAID` |
| Creditor | `[TOKIOMARINE] Tokio Marine` | same |
| Invoice | `I.0000010835`, CI Invoice, $250.00 | `I.0000010836`, CI Invoice, $100.00 |
| Client receipt | **none** | `R.0000009958`, $100 allocated |
| On Issue Payments | **no** | **no** |

Searched all creditors, 01-09-2026 → 30-09-2026 (covering her segment's
23-09-2026 creation), branch cleared: no grid, no rows, and `13817` appears
nowhere on the page.

So the booking RAA points to as working does not show on that screen for our
login either. Two readings, and only RAA can tell them apart:

1. there is a step after the invoice that is habitual enough not to have made
   it into the notes; or
2. it is a **permissions / branch difference between logins**. We are signed
   in as `khegde`, whose home branch is `ADL`, and Level 1 Branch
   auto-populates to `[ADL] RAA Adelaide` on that form every time. Clearing
   the dropdown may not clear the underlying entitlement.

The second is worth testing first, because it costs RAA one screenshot: if
Megan opens Issue Payments on her own login, picks Tokio Marine and sees
booking 13817 listed, the difference is us, not the data.

---

## Earlier: nothing is creditor-payable in this sandbox, for anyone

Measured 24-Sep-2026. Three searches, widening from our booking to the whole
environment, and the last one settles it.

| search | criteria | result |
|---|---|---|
| Tokio, wide | `[TOKIOMARINE]`, 01-01-2025 → 31-12-2027, branch cleared | no grid, no rows |
| **every creditor** | creditor blank, 01-01-2020 → 31-12-2030, branch cleared | no grid, no rows |
| **every creditor, Tramada's own defaults** | creditor blank, To date left at its default `24-09-2026` | no grid, no rows |

And the decisive one — Finance → Payments → **Search** (existing payments),
every category, every transaction type, all branches, no date floor:

```
No records found.
```

**No payment of any kind has ever been issued in this sandbox.** Not to Tokio,
not to anyone.

So this was never a Tokio problem, nor an insurance problem, nor a
`PRE_PAID` vs `PRE_PAID_CCCF` problem. The creditor-payment path has simply
never been exercised in `raatravelsandbox`. Megan's steps describe how
production behaves; this environment has never produced a payable creditor
segment for anybody.

That is why booking 15875 does not appear despite having every precondition
anyone has named — see the table below. Nothing was wrong with the booking.

### What this changes

Steps 12-14 cannot be demonstrated here at all, by us or by RAA, until either
the sandbox is configured so creditor segments become payable, or we are given
an environment where they already are. No amount of fixture-building on our
side will produce a row on that screen.

The matching, ticking, BR12 per-row selection and session-saving code is built
and tested against the real grid shape; it has nothing to act on.

---

## Earlier working (superseded by the finding above)

## Why the costings never reached Issue Payments — NOT yet answered

> **Tested 24-Sep-2026 and the answer below is incomplete.** Booking 15875 was
> driven through it by hand, live:
>
> | | |
> |---|---|
> | Tokio insurance costing | present, `#costingpaymentTypeCode` = **`PRE_PAID`** |
> | Payment Narrative | `Pre-Paid` |
> | Client invoice | **issued** — `I.0000010836`, $100.00, the INS segment ticked |
> | Client receipt | **posted and fully allocated** — `R.0000009958`, EFT, $100.00 received, $100.00 allocated |
> | Creditor payment | none (Booking Payments: "No records found") |
> | Issue Payments, `[TOKIOMARINE]`, 01-01-2025 → 31-12-2027, branch cleared | **no grid, no rows** |
>
> Every precondition anyone has named is therefore met — the segment is
> chargeable pre-paid, the client has been invoiced AND receipted in full, and
> RAA has not paid Tokio. There is no missing step on our side left to blame.
>
> So **PRE_PAID plus an invoice is necessary but NOT sufficient.** Something
> else still keeps an insurance costing off Issue Payments in this sandbox.
>
> Worth noting: all three payment-type options an insurance segment offers are
> PRE_PAID variants, and "pre-paid" means the creditor is already settled. It
> is possible that in this configuration an insurance costing can never be
> creditor-payable, and that the Tokio segments RAA pays in production reach
> Issue Payments by some other route. That is a question for RAA, not a guess
> to make here.
>
> **Ask Megan:** on a booking where the Tokio segment DOES appear on the
> creditor payment results screen, what else is set that 15875 does not have?
> A creditor invoice rather than a client one? A different segment type? A
> branch or consultant setting?
>
> The code changes below stand — PRE_PAID is right, and invoicing is a real
> step — they are just not the whole answer.

## What Megan said, 23-Sep-2026

Megan, RAA trainer, gave the two halves:

1. **Payment Type is `Chargeable [PRE_PAID]`** — not the insurance form's own
   default of `PRE_PAID_CCCF`. Her booking 82457 shows Payment Type
   "Chargeable [PRE_PAID]", Payment Narrative "Pre-Paid".
2. **The segment must then be INVOICED**: Invoices → Add/Issue Invoice →
   scroll to *Segments to Invoice* → tick the Tokio insurance → Issue.
   *"Then it will show up in the creditor payment results screen."*

### A conclusion withdrawn

`tools/make-fixtures.js` previously recorded that "every option is a PRE_PAID
variant, so an insurance costing here can never become creditor-payable, and
no amount of invoicing or receipting changes that." That was measured on
booking 15842 — which carried a client invoice **and** the CCCF payment type.
The variants are not equivalent: CCCF means the creditor is already settled.
Invoicing never had a chance against it. Both halves are needed together, and
only one was ever being done at a time.

`makeTokio()` now pins `PRE_PAID` as the default (`--payment-type` still
overrides) and invoices the segment via `runIssueInvoice`.

### The Add/Issue Invoice page, mapped live (24-Sep-2026)

Measured against booking 15875 in `raatravelsandbox`. **All four of the
originally guessed `addLink` selectors were wrong** — the control is a submit
BUTTON, not a link:

```
booking-invoices.htm?mode=edit&id={bookingNo}     the Invoices tab
  #add  "Add / Issue Invoice"        →
booking-client-invoice.htm?mode=add&parentId={bookingNo}
  <h3>Segments To Invoice</h3> + grid
  #selectAll  #deselectAll  #preview  #issue
  #invoiceCategory = CLIENT_INVOICE (the only option)
```

Grid headings, in order: `D | Seg. Type | Creditor Details | Rates ex GST |
Discount Markup ex GST | Tax ex GST | GST | Due inc GST | Receipted inc GST`.

Two traps, both now pinned by tests:

- The heading reads **"Segments To Invoice"** (capital T) and is **not** the
  grid's `previousElementSibling` — it sits further up the document. Checking
  one node found nothing and fell through to the "last grid with checkboxes"
  fallback, which is right by luck on a booking with one grid and wrong on any
  other. The match walks backwards through document order now.
- **Every row's checkbox shares `id="segmentsToAllocate"`** — the same trap as
  the IPSI allocation grid, where `#segmentsToAllocate` ticked the first row
  whatever row was meant. Rows are addressed by a per-row handle.

The run navigates straight to `booking-client-invoice.htm`, because clicking
`#add` did not reliably navigate under CDP and left the run reading the LIST
for a grid that is only on the FORM. Clicking `#add` remains the fallback.

`npm run probe:invoice -- <bookingNo>` re-maps it if Tramada changes.

## Policy numbers: 7 digits seen in the wild

Megan's training booking carries policy **2100044** — seven digits.
`policyKey` accepts `21` + six (eight in total), so it returns `null` for that
value and the row cannot be matched.

`tickMatchingRows` used to skip such a row in silence, and the Travel line was
then reported as *"not found in Tramada"* — which says the segment does not
exist, when it is sitting on the grid unread. It now reports an
`unreadable reference` step naming the value.

That is the symptom handled. The question stands: **is a live Tokio policy
ever not eight digits?** The guide writes the series as nine, every real row
RAA supplied is eight, and a trainer hand-typed seven. Until RAA says which
lengths are real, `policyKey` stays strict and loud rather than lenient.

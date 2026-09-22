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

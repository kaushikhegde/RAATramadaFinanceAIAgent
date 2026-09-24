# Reconciliation: Dynamic Virtual Card (DVC)

Daily reconciliation of all DVC transactions entered in Tramada with the Westpac DVC Report.

---

## Process Steps

| Step | Actions | System | Expected Result | Decision / Rule | Evidence |
|---|---|---|---|---|---|
| 1 | User logs in to the Westpac DVC portal and pulls the DVC report for a specific date, usually previous day's transactions.<br><br>User will remove customer cardholder name from spreadsheet. | Westpac DVC portal | DVC transaction file for the required dates is downloaded as a CSV. | DVC reports are produced for business days only (Monday to Friday).<br><br>Accepted file format: CSV. | |
| 2 | User clicks **Export Results** and drops the CSV into the relevant tab on the DVC spreadsheet.<br><br>In Tramada, user exports DVC transactions out as a spreadsheet. | Tramada | Tramada Agency CC Reimbursement export is downloaded and loaded into the working spreadsheet. | The exported spreadsheet currently includes a client name column. Client names are removed because of a privacy constraint. | |
| 3 | User uploads both CSVs to the AI Agent Dashboard.<br><br>Append a "Remarks" column to the right of the Westpac DVC spreadsheet to log error messages there. | AI Reconciliation Dashboard | Both files are available to the AI Agent for matching. | **Westpac DVC spreadsheet must contain:** Transaction date, Supplier/merchant, Transaction amount, Consultant initials and shop, Supplier reference (where provided), Tramada booking number, Segment type, DVC card number, Remarks.<br><br>**Tramada spreadsheet must contain:** Booking file number, Transaction date, Amount, Supplier name, Segment/costing type.<br><br>Accepted file formats: CSV or Excel. | |
| 4 | AI Agent matches each Westpac DVC transaction line to a Tramada transaction, using Tramada booking number and transaction amount as the primary match keys. | AI Reconciliation Dashboard | Matched, partially matched and unmatched lines are identified. | Primary match: Tramada booking number must match, and the amount must match within the permitted rounding tolerance.<br><br>Rounding of 5 cents on each individual transaction is allowable.<br><br>Supplier reference is only populated on some DVC lines and must not be relied on as a primary match key.<br><br>Passenger/client name is a valid manual match key but is not available to the AI Agent in the current state. | |
| 5 | Agent applies the segment/costing type as a secondary sense check on each candidate match. | AI Reconciliation Dashboard | Confidence in the match is confirmed, or the match is downgraded for human review. | Segment type on the DVC spreadsheet should correspond to the abbreviated costing type in the Tramada spreadsheet — see the Segment Type Abbreviations table below.<br><br>When amounts don't match, calculate if they are out by 3%. If yes, assume they are merchant or foreign exchange fees. If no, add "Amount not matched" in the Remarks column. | |
| 6 | Where one DVC transaction amount relates to more than one Tramada transaction amount, AI Agent identifies the set of Tramada transactions whose amounts sum to the single DVC amount. | AI Reconciliation Dashboard | One-to-many relationship is identified and the component Tramada amounts are recorded. | Typically occurs where a supplier charges a single amount covering several costings (e.g. hotel, second hotel and transfers on one booking).<br><br>The breakdown of the individual Tramada amounts must be shown in the Remarks column.<br><br>Same booking number and same costing type across two or more lines is a strong indicator — confirm by process of elimination.<br><br>When identified, add "Please check: multiple transaction amount found in Tramada" to the Remarks column. | |
| 7 | Where one Tramada transaction amount relates to more than one DVC transaction amount, AI Agent identifies the set of DVC lines whose amounts sum to the single Tramada amount. | AI Reconciliation Dashboard | Many-to-one relationship is identified and the component DVC amounts are recorded. | Typically occurs where an airline charges per passenger (e.g. six seat-selection charges against one seat reservation costing in Tramada).<br><br>The breakdown of the individual DVC amounts must be shown in the Remarks column.<br><br>When identified, add "Please check: multiple transaction amount found in Tramada" to the Remarks column.<br><br>When this happens, save it as a payment session in Tramada and name it `DVC <transaction date>`. | |
| 8 | Where the booking number matches but the amount does not, AI Agent calculates the difference and tests whether it equals 3% of the Tramada amount. | AI Reconciliation Dashboard | Foreign merchant fee variances are distinguished from genuine amount errors. | If the difference is 3% (within the 5 cent rounding allowance), it may relate to a merchant or foreign exchange fee. Record this as "Amount + Merchant Fee" in the Remarks column.<br><br>All other amount errors are noted separately as "Amount does not match", for Travel Accounts to investigate. | |
| 9 | AI Agent identifies refund lines on the DVC report and matches them to the corresponding Tramada entries. | AI Reconciliation Dashboard | Refunds are matched or flagged as exceptions. | Refunds appear as negative amounts on the DVC report and are highlighted in red on the spreadsheet.<br><br>Refund entries in Tramada are made by Travel Accounts on behalf of consultants.<br><br>If a refund appears on the report with no corresponding Tramada entry, flag as an exception. | |
| 10 | Where multiple passengers are travelling on two booking numbers, AI Agent identifies both booking numbers against the single DVC payment amount. | AI Reconciliation Dashboard | The two Tramada bookings making up the one DVC amount are identified, or the line is flagged for human resolution. | The DVC report may reflect two booking numbers that are to be applied to the DVC payment report amount.<br><br>Westpac currently permits only a single numeric Tramada booking number field (10 digits, numeric only), so the second booking is not always captured — in that case the line will present as an amount error. | |
| 11 | Agent flags all lines that cannot be matched, and all matches that require human verification. | AI Reconciliation Dashboard | Dashboard shows what has been reconciled and what requires manual clarification. | Add the reason to the Remarks column, using: "Booking number not found", "Amount not match", "Amount + Merchant Fee", "Please check: multiple costings", "Costing not found".<br><br>Part payment and deposit scenarios must always be flagged for human handling — the AI Agent does not adjust amounts. | |
| 12 | In Tramada, AI Agent navigates: **Finance > Payments > Issue Payment**, then clicks "Continue". | Tramada | Lands on the Issue Payment parameters screen. | | |
| 13 | AI Agent sets the payment parameters, as below:<br><br>Payment Category = Agency CC Reimbursement.<br><br>Bank Account = Trust Account.<br><br>Credit Card = 555003….0457 CA – A – Westpac DVC VCC.<br><br>Level Branch 1 and Level Branch 2 = remain blank.<br><br>From Segment Created Date = 2 days prior to the statement date.<br><br>To Segment Created Date = today's date.<br><br>Sort by = Booking number.<br><br>Sort order = Ascending.<br><br>Then click "GO". | Tramada | Tramada displays all outstanding DVC transactions entered for the selected date range. | The wider date range catches transactions entered late by consultants. The list may still not contain every transaction. | Screenshot: Issue Payments parameter screen |
| 14 | AI Agent matches the transactions based on amount and booking number to the DVC spreadsheet.<br><br>If amount and booking number match exactly, ticks the checkbox against every confirmed match. | Tramada | | Ticking the checkbox auto-fills the full transaction amount into the adjacent amount field.<br><br>Do not tick lines flagged as exceptions — leave these for the Travel Accounts team to resolve. | Screenshot: transaction selection list |
| 15 | AI Agent cross-checks that the total of all selected Tramada transactions equals the DVC spreadsheet total. | Tramada, AI Reconciliation Dashboard | | The DVC spreadsheet amount total must match, with 0.50 cent rounding overall allowable.<br><br>If the selected total does not reconcile to the DVC spreadsheet amount total within that allowance, add an error remark "Total transaction amount does not match" on the AI reconciliation dashboard. | |
| 16 | If any errors are found, AI Agent saves the work as a Payment Session.<br><br>Enter Session label: "DVC" plus the reconciliation date in format DD/MM/YYYY.<br><br>Click "Session" button to save. | Tramada | All selections made to that point are saved. A Travel Accounts team member can reopen the session, complete the outstanding lines and submit the payment. | Save the session even where exceptions remain — do not wait until every line is resolved.<br><br>Payment sessions cannot be separated across days: transactions selected in one session will reappear in any session created the following day. | |
| 17 | If no errors are found, click on the "Round Remaining" checkbox if the difference is less than 0.50 cents.<br><br>Click "Issue" button. | Tramada | | | |
| 18 | Agent emails the reconciliation and exception report to the Travel Accounts team, with the updated spreadsheet attached.<br><br>Email reconciliation report to **TAccounts@raa.com.au**, Subject line: *AI Agent DVC reconciliation*. | AI Agent (email) | Travel Accounts receives the matched lines and the outstanding items requiring manual investigation. | Report must distinguish reconciled lines from lines requiring verification.<br><br>Remarks column must carry the reason for each exception and, where relevant, the breakdown of component amounts. | |
| 19 | Travel Accounts team member reviews the exception report, investigates and resolves the outstanding lines in Tramada, then completes and submits the payment session. | Travel Accounts team, Tramada | All outstanding transactions are either reconciled or escalated further (e.g. to the relevant Travel Consultant). | Resolution of reconciliation mismatches in Tramada is completed by a human — the AI Agent does not attempt to resolve them itself.<br><br>The previous day's exceptions must be resolved and the statement finalised before the next day's reconciliation run begins. | |

**Column definitions (from the source template):**

- **Actions** — user opens this, clicks this, selects, inputs, etc.
- **System** — Tramada, Westpac DVC, SharePoint, spreadsheet.
- **Expected Result** — list of transactions, matched lines.
- **Decision / Rule** — tickbox must be checked, amount must be same.
- **Evidence** — screenshot.

---

## Business Rules & Exceptions

| ID | Rule |
|---|---|
| **BR01** | The Westpac DVC custom report must contain, for each transaction: Transaction date, Supplier/merchant, Transaction amount, Tramada booking number, Segment type, Consultant initials and shop, DVC card number. Supplier reference is populated only on some lines and must not be treated as mandatory. |
| **BR02** | DVC is reconciled daily against the Westpac DVC report (business days only, Monday to Friday). The bank is debited once a month, so each daily reconciled payment must subsequently be applied against the monthly debit on the Travel Trust Bank Statement. |
| **BR03** | Primary match keys are Tramada booking number and transaction amount. Segment/costing type is a secondary sense check. Passenger name is a valid manual match key but is not available to the AI Agent in the current state. |
| **BR04** | Rounding of 5 cents on each individual transaction is allowable. The DVC Report Total must match exactly, with 0.50 cent rounding overall allowable. |
| **BR05** | One DVC entry amount may relate to one or more transaction amounts in Tramada, and one Tramada entry amount may relate to one or more amounts on the DVC report. Where this occurs, the breakdown of the component amounts must be shown in the Remarks column. |
| **BR06** | Where the booking number matches but the amount does not, calculate the difference. If the difference is 3% (within the 5 cent rounding allowance) it may relate to a merchant fee — record as "Amount + Merchant Fee". All other amount errors are noted separately for Travel Accounts to investigate. |
| **BR07** | Refunds appear as negative amounts on the DVC report. A refund with no corresponding Tramada entry is an exception. |
| **BR08** | A transaction on the DVC report with no corresponding entry in Tramada is an exception. |
| **BR09** | Ticking a transaction checkbox in Tramada auto-fills the full transaction amount. The AI Agent must not overtype this amount. Part payment and deposit scenarios are handled by a human. |
| **BR10** | Multiple passengers travelling on two booking numbers: the DVC report may reflect two booking numbers to be applied to the one DVC payment amount. Where the second booking is not captured, the line will present as an amount error and must be flagged for human resolution. Westpac currently permits only a single numeric booking number field (10 digits, numeric only). |
| **BR11** | Segment types in the Tramada Agency CC Reimbursement export are abbreviated — see the Segment Type Abbreviations table. |
| **BR12** | Tramada Issue Payment parameters are fixed for DVC: Payment Category = Agency CC Reimbursement; Bank Account = Trust Account; Credit Card = 555003….0457 CA – A – Westpac DVC VCC; Level Branch 1 and 2 blank. |
| **BR13** | The Tramada date range must run from 2 days prior to the statement date through to today's date, to capture transactions entered late. |
| **BR14** | Save the payment session even where exceptions remain — do not wait until every line is resolved. |
| **BR15** | Resolution of reconciliation mismatches is completed by a human — the AI Agent does not attempt to resolve them itself. |
| **BR16** | Add a "Remarks" column to append on the DVC spreadsheet to capture error messages. |

---

## Segment Type Abbreviations

Segments in the Tramada Agency CC Reimbursement export are abbreviated as follows.

| Segment Type | Abbreviation |
|---|---|
| HOTEL | HTL |
| TRAIN | TRN |
| AIR TICKET | TKT |
| CRUISE | CRU |
| BUS | BUS |
| FERRY | FER |
| TOUR | TUR |
| MISCELLANEOUS | MIS |
| TRANSFER | TFR |
| CAR HIRE | CAR |
| PACKAGE | PKG |
| INSURANCE | INS |

---

---

## Steps 12-18 in code — what is automated, and what is still a guess

Steps 4-11 (the matching) are `recon-core.reconcileDvc` and have been offline
and tested since the report was added. Steps 12-16 (Tramada's Issue Payment
screen, up to Save Session) and step 18 (the email) are:

| file | what it does |
|---|---|
| `tramada-issue-payments.js` | the screen — chooser, search form, results grid, buttons. Shared with the Tokio Marine flow, which drives the same form for a different payment category. |
| `tramada-dvc.js` | `runDvcPayment()` — steps 12 to 16 in order. Pages and clicks only. Never presses Issue. |
| `recon-core.js` | every decision: `dvcTramadaGate` (is Tramada worth opening), `planDvcPayment` (which rows may be ticked), `decideDvcCommit` (Session or nothing), `dvcEmail` / `dvcReportCsv` (step 18's email and attachment), `resolveSelectOption`, `assertCardLabel`. |
| `mailer.js` | step 18's delivery — SMTP via nodemailer, configured from `.env`. |
| `tramada-agency-cc.js`, `tools/make-dvc-bookings.js` | sandbox fixtures: bookings the Issue Payment grid actually lists. `npm run fixtures:dvc:tramada` |
| `test/test-dvc-payment.js` | all of the above, offline. `npm run test:dvc:payment` |
| `tools/probe-dvc-payment.js` | read-only. Opens the screen for this category and prints what is really there. `npm run probe:dvc` |

### The process this implements (RAA, 23-09-2026 — drawn)

```
  Westpac spreadsheet ─┐
                       ├─► Reconciliation Agent (steps 4-11)
  Tramada spreadsheet ─┘            │
                        errors? ────┤
             yes                    │ no
              ▼                     ▼
   email a person: fix the     Tramada: the reimbursement starts (steps 12-16)
   Westpac discrepancies,      tick every line, save Payment Session
   re-upload ──► reconcile     "DVC DD/MM/YYYY" — even if Tramada raises
   again, until no errors      something
                                    │
                                    ▼
                     email the accounts team the state of the session (step 18)
                                    │
                                    ▼
                     a person checks the saved session, makes changes if
                     needed, and physically clicks Issue (step 17)
```

- **Spreadsheet errors keep Tramada shut.** A line not matched or flagged
  (deposit or incorrect amount, merchant fee, one-to-many, segment mismatch), or
  a report total that does not agree, goes to a person by email: *errors found
  — fix and re-upload*. Nothing is entered in Tramada. `dvcTramadaGate` checks
  this before a browser opens.
- **No errors → straight into Tramada**, with no approval click. The Credit Card
  (BR12's masked label) is server configuration, `DVC_CARD`, not a dashboard
  field; it defaults to `555003....0457 CA - A - Westpac DVC VCC`.
- **The session is saved even if Tramada raises something**: a clean line with
  no grid row, a ticked total more than $0.50 out, a tick a reopened session
  holds that no longer matches. The email says *session saved — check before
  issuing* and names each one.
- **The agent never presses Issue.** A person checks the saved session, changes
  what needs changing, and clicks Issue. There is no `issue` in `DVC_COMMIT`,
  and `pressAndCheck` refuses any button whose text says "issue".
- **Every run emails** `DVC_EMAIL_TO`, which has no default, so a sandbox run can
  never mail TAccounts@raa.com.au by accident. The subject is
  `AI Agent DVC reconciliation — DD/MM/YYYY — <status>`, where the status is
  one of *errors found — fix and re-upload*, *ready to issue*, *session saved —
  check before issuing*, or *not entered* (spreadsheets clean, Tramada stopped
  the run, with the reason).

### What each outcome looks like

| | Tramada | email |
|---|---|---|
| a line not matched or flagged, or the report total not agreeing | not opened | **errors found — fix and re-upload**, each line named |
| no spreadsheet errors, Tramada agrees | every row ticked, session saved | **ready to issue** |
| no spreadsheet errors, Tramada raises something | session saved with every tick it could make | **session saved — check before issuing** |
| no spreadsheet errors, Tramada run stopped | nothing saved, page left open | **not entered**, with the reason |
| Tramada costings nothing on the report paid | not counted | listed as expected (BR13), except a costing a flagged line was checked against, which is named with that line |

### Re-running a day: the saved session is re-checked, never duplicated

The process is reconcile → fix → re-upload → re-run, so the same settlement
date arrives many times. Each re-run (RAA, 23-09-2026):

1. looks the day's label up on **Finance → Payment Sessions**, Tramada's own
   list, not the run history. The history once said `DVC 24/09/2026` was saved
   after it had been cancelled in Tramada, and refused a re-run that had work
   to do.
2. **no session** → the normal search, tick, save.
   **one session** → opens it through its row's *View Payment* link (never the
   *Cancel Finance Session* link beside it), ticks every line that is confident
   now, and presses Session again. Tramada answers *"Finance session was
   saved."* and keeps **one** session with every tick in it (measured on
   `DVC 24/09/2026`, which went from the two flights to all four lines).
   **two or more** → touches nothing and says to cancel the extras.
3. afterwards counts the label on the list again. Anything but one is reported
   loudly.
4. emails the state of the session: *ready to issue*, or *session saved — check
   before issuing* with what Tramada raised.

A tick the saved session already had but that is **not** confident any more (a
line re-uploaded at a different amount) is never unticked by the agent. That is
a judgement about money already in a session. It is named in the email, and the
day is not complete while it stands.

To try the loop in the sandbox: upload `csv_uploads/dvc-westpac-live-2026-09-24.csv`
with the 24/09 Tramada file (2 lines do not reconcile: email, nothing in
Tramada), then `dvc-westpac-live-2026-09-24-corrected.csv` with the same Tramada
file (no errors: session saved or re-checked with all 4 ticked, "ready to
issue").

### What changed since the last upload

Every DVC run compares its Westpac file against the most recent earlier run for
the same settlement date and says so on the card:

```
3 lines changed compared with the 09:14 upload: booking 140612 $176.00 (booking number)
```

Keyed on the **card number** — DVC means one virtual card per transaction, so the
card is the line's identity and survives rows being inserted, deleted or
re-sorted. It falls back to position when the cards cannot identify the lines,
and says which it used. Reported, never enforced: a changed line is usually
exactly the fix somebody was asked to make. What matters is that an edit to the
bank's own report is on the record rather than only in somebody's memory.

### BR09 — a wrong amount: deposit, or simply wrong

A card charged **less** than the costing on the same booking may be a deposit,
or may be an incorrect charge, and nothing in either spreadsheet says which
(RAA, 23-09-2026: "only a human can know that"). RAA's own example: $500 taken
against a $2,000 costing. It comes back flagged, never ticked:

```
Please check: deposit or incorrect amount — DVC 500.00 against a 2000.00 costing, 1500.00 short
```

and the reason names both: if it is a deposit, *enter $500.00 against that
segment by hand; do NOT tick the row, because ticking fills in the full
$2,000.00 and BR09 does not allow overtyping it*; if it is wrong, it is chased.
A charge **larger** than the costing with no 3% fee to explain it cannot be a
deposit, and stays BR06's `Amount not match`. Either way it is a spreadsheet
error: the day is emailed back to be fixed in the Westpac report and
re-uploaded, and nothing goes into Tramada until it is.

`npm run fixtures:dvc:tramada` seeds both into the sandbox: a hotel + flight
booking whose hotel was charged a deposit-sized amount, and one whose hotel was
charged more than Tramada holds.

### Where each exception is actually fixed

Almost none of them are fixed in the Westpac report — it is the bank's record of
what the cards were charged.

| Remark | Fixed in |
|---|---|
| Booking number not found | **Tramada** — the costing has not been entered |
| Refund not found in Tramada | **Tramada** — Travel Accounts enters the refund |
| Costing not found | **Tramada** — no costing of that segment type |
| Please check: deposit or incorrect amount | **a person** — a deposit is typed against the segment by hand; a wrong charge is chased with the supplier |
| Amount not match | investigate — could be either side |
| Amount + Merchant Fee | nothing to fix; BR06 says record it |
| multiple transaction amount found in Tramada | nothing to fix; BR05 expects it |
| segment type does not match | nothing to fix; amounts reconcile |
| Total transaction amount does not match | the typed total on the dashboard |

Note the consequence: the middle three are correct outcomes that the gate still
blocks on, and the document expects three to six exceptions a run. On a typical
day the Tramada half will not fire.

### The Issue Payment screen, mapped live (22-09-2026)

Driven end to end against `raatravelsandbox` with `npm run probe:dvc`. **Steps
12 and 13 work**: the screen opens, every BR12 parameter is set, read back and
accepted, and Go submits.

```
#paymentType          "" | CREDITOR_PAYMENT | DEBTOR_REFUND_PAYMENT
                      | AGENCY_CC_DEBTOR_REIMBURSEMENT_PAYMENT   <- "Agency CC Reimbursement"
                      | FINANCE_MERCHANT_REFUND_PAYMENT
                      | FINANCE_COMMISSION_RELEASE_TRANSFER_PAYMENT
                      | FINANCE_TRUST_PAY_DIRECT_COMMISSION_TRANSFER_PAYMENT
#agencyBankAccount    "" | 1 = [TRUST] Trust Account
#creditCard           appears ONLY for the Agency CC category, after the postback.
                      Offers "555003....0457 CA - A - Westpac DVC VCC"
#level1Branch         "" | 14 branches ([ADL] RAA Adelaide … [WLK] RAA West Lakes)
#level2Branch         present but EMPTY while Level 1 is blank — it cascades
#fromTransactionDate  #toTransactionDate    labelled "Segment Created Date"
#sortBy               "" | BOOKING_NUMBER "Booking number" | REFERENCE | …
#sortOrder            ASCENDING "Ascending" | DESCENDING
#goButton  #backButton  #form_clearButton
#form_advancedSearch  #form_searchBy  #form_fileToUpload  #form_add
#form_advancedSearchTextArea
```

The category list has **seven** options, not the six recorded on 18-09-2026, and
two labels are abbreviated differently. It moves; match on the label.

#### Four things that had to be fixed, and are worth not rediscovering

1. **Punctuation is not part of a label.** BR12 names the card
   `555003….0457 CA – A – Westpac DVC VCC` (ellipsis, en dashes, as Word writes
   it). Tramada offers `555003....0457 CA - A - Westpac DVC VCC` (four dots,
   hyphens). Character for character they differ, and the run refused a card
   that was sitting on the screen. `resolveSelectOption` now folds dashes,
   ellipses, dot runs and curly quotes — never digits or letters.
2. **`#level2Branch` is empty, not absent.** It cascades off Level 1, so with
   Level 1 blank — which is what BR12 asks for — it comes back with no options
   at all. An empty select is *already* blank; refusing over it stopped a search
   that was exactly right.
3. **Hidden validation divs are always in the markup.**
   `#advancedSearchTextAreaErrorDiv` permanently reads *"You cannot put more than
   50 values in the Text area"*. Reading the DOM without checking visibility
   reported a perfectly good search as failed, on a text area that was empty.
   A real error is `table.errors > tr.errors > td.errors > a.error`, e.g.
   *"Creditor Code must be entered"* — both cases are now in the test suite.
4. **This portal loads Prototype.js**, which replaces `Array.prototype.filter`
   with a two-argument `findAll`. `.filter((v, i, a) => …)` inside
   `page.evaluate` throws from inside prototype.js and reads as a Tramada bug.
   Single-argument callbacks only.

#### Steps 14-16, mapped live (23-09-2026)

Measured on bookings 15899, 15908, 15911, 15914 and 15917, which
`npm run fixtures:dvc:tramada` created. Each one is a single costed segment,
receipted from the client, then paid on the DVC card through **Issue Agency
Credit Card Transaction** (the booking's Receipts page → `AGENCY_CC_*_RECEIPT`).
The previous "nothing is payable" state was not a sandbox property: there
were simply no agency-card transactions to reimburse. **And Go opens its results
in a new tab**, so the probes that read the search tab found nothing even
after there was something to find.

```
results tab   finance/finance-debtor-refund-payment.htm?isAgencyCreditCardPayment=true&…
              title "Tramada - Issue Agency Credit Card Reimbursement"
grid          D | R | Seg. Type | Booking No. | Reference | Creditor ID | Segment Date |
              Debtor Receipted | Reimbursement Due | Paid Amount | Balance Due | Allocate | A
row           * |  | CRU | 15899 | 785K3G - 785K3G - GRAY/SPIDER MS - Princess Cruises | 89561 |
              23-09-2026 | 799.80 | 799.80 | 0.00 | 799.80
checkbox      input#segmentsToAllocate name=segmentsToAllocate value={segmentId}   ← SAME id on every row
amount        input#allocationAmount_{segmentId}   disabled readonly until the row is ticked
below         #roundRemaining "Round Remaining" · #sessionLabel "Session Label" ·
              #Session "Session" · #issue "Issue" · #preview · #cancel · #printButton "Export Results"
sessions      finance/finance-sessions-payments.htm — Finance → Payment Sessions; label in Info.
```

Three things this changed in the code:

1. **`fillSearch` follows the popup**, and everything after it (grid, ticks,
   session) happens on the results tab. Go also disables itself after one click.
2. **`readResultsGrid` addresses a row by name + value**, and by id only when the
   id is unique. Built from the id, all five rows were `#segmentsToAllocate`.
3. **A saved session is confirmed on the Payment Sessions list**, by its label
   in a cell of its own, not by what the Issue Payment page shows afterwards.

First live save: `DVC 23/09/2026`, 5 transactions, $3,774.45, confirmed on the
list. The agent pressed `#Session`. `#issue` is Travel Accounts'.

## Other Features

- Ability to upload two source files per run — the Westpac DVC spreadsheet and the Tramada Agency CC Reimbursement spreadsheet.
- Excel and CSV to be acceptable formats for upload to the AI Agent.
- Remarks column against every line, carrying the reason for the exception and, where relevant, the breakdown of component amounts for a one-to-many or many-to-one match.
- Ability to export the reconciled spreadsheet out of the AI Agent dashboard as .CSV.
- Ability to attach the updated spreadsheet to an email and send it to RAA Travel Finance.

---

## Other Notes

- Volume is typically 50 to 60 transactions per report. Around 85% match straightforwardly; three to six lines per run usually require manual investigation.
- Both the DVC and Tramada exports currently include a client name column. This is manually deleted today because of a privacy constraint, and that column would otherwise be a significant help to matching.
- Supplier reference is not always available at the time of payment. Instant purchase items (e.g. EasyJet, some Jetstar bookings) do not issue a reference until after payment is made, so the costing may legitimately have no reference.
- **Future state:** the payments and receipts POC is expected to write the supplier reference into the card at creation, which would flow through to the Westpac report and provide an additional match key.
- **Future state:** Westpac is adding a secondary alphanumeric Tramada booking number field and a free-text notes field (approximately 80 to 100 characters) to card creation, which will address the one-card-two-bookings scenario.
- Tramada pages can be slow to refresh when there is a large volume of outstanding transactions, which is a significant part of the manual time cost of this process.

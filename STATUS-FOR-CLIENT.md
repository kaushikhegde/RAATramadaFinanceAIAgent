# Bank Reconciliation Agent — where it stands, and one decision to make

20 August 2026. Covers BPay, MINT and TravelPay.

---

## 1 · Built and working

All three reports run end to end: upload the spreadsheet (Excel or CSV), the agent
opens the day's bank statement in Tramada, sorts, filters, matches every line,
ticks what agrees, writes a remark against what doesn't, and gives the file back
with the remarks in it.

- **BPay** — steps 1–34 and BR01–BR14 of the BPay guide, including the Debtor
  Payment Receipt path, the Consultant and Shop columns pulled from each
  booking's profile, and allocation to the exact segment.
- **MINT** — BR01–BR08 and BR10.
- **TravelPay** — BR01–BR09 and BR11.
- Excel **and** CSV in, Excel **and** CSV out, in whichever format was uploaded.
- Every column of the uploaded file is carried through to the dashboard and the
  export — nothing is dropped or reordered.
- Consultant, Shop and Remarks are editable in the dashboard before export.
- "Dry run" mode runs the whole thing for real but holds back the two
  irreversible clicks: **Done** on the statement page and **Issue** on a receipt.
- 764 automated checks pass on every build.

---

## 2 · Waiting on a decision from RAA

**2.1 · Supplier name matching.** See section 5. This is the one worth reading.

**2.2 · Keeping a history.** The guide's *Other features* says a new upload
replaces the previous spreadsheet — no history. The dashboard does the opposite:
every upload is kept and every run is listed in a past-runs picker, which was
asked for on 11 August. Both are reasonable; they contradict each other. Someone
needs to pick.

**2.3 · Order of operations each day.** BPay BR12 says only the BPay process
creates the bank statement in Tramada. The agent now follows that — MINT and
TravelPay open the day's *existing* page rather than creating one. The
consequence: **if BPay hasn't run yet, a MINT or TravelPay run stops and says
so.** Confirm that BPay always goes first.

**2.4 · Where the statement date comes from (BPay step 25).** Today a person
types it into the dashboard and the agent verifies it on the Tramada form. It is
not derived from the file's own dates. Confirm that's acceptable, or tell us
which column it should be read from.

---

## 3 · Waiting on data from Finance

**3.1 · The supplier name cheat sheets.** One day's MINT file contained 19
distinct suppliers. Two have been confirmed against Tramada so far. The other 17
are sitting blank in `cheat-sheets/mint-supplier-names.csv`, waiting for someone
with Tramada access to fill them in. TravelPay's sheet has one supplier in it,
from the dummy file. Rows whose supplier isn't confirmed will not tick — they get
a remark and go to a human.

**3.2 · A real BPay export.** The parser has been built against the guide's
column names and a screenshot of the real thing, and it handles both. It has
still never seen a genuine BPay export out of Finance. One real file confirms the
headers for good and settles 2.4 above.

---

## 4 · Waiting on a live Tramada scenario

These BPay rules are written and pass their offline tests, but no booking in the
test system has ever triggered them, so they've never been watched running live:

| Rule | What it needs to prove it |
|---|---|
| BR02 · departure date has passed | a booking with a past departure date |
| BR04 · nothing outstanding **and** departure passed | the same booking, fully paid |
| BR09 / BR10 · allocate to one segment vs all of them | a booking with several differently-priced segments |
| BR11 · overpayment | a payment larger than the booking total |

Four test bookings would clear all four in one sitting.

Separately, the **full MINT and TravelPay dry run through the dashboard** hasn't
been completed yet. Every individual Tramada screen it touches has been checked
live — the statement search, the Reconcile link, the sort options, the Reference
column, the creditor names — but the single upload-to-tick pass keeps getting cut
short because the development server drops. That's a session problem, not a code
problem, and it's the next thing to do.

---

## 5 · The supplier name question

> *"Why was the supplier name an issue — can't we just use the reference?"*

### It already does use the reference

The reference **is** the identifier. In yesterday's MINT file all 52 transaction
references were unique, and the agent finds every row by reference alone. The
supplier name doesn't *find* anything. It *confirms* what the reference found.

### It's checked because the guide says to check it

MINT BR05 and TravelPay BR05, word for word:

> Transaction number and amount must match exactly. Supplier/creditor name in
> Tramada must match the supplier on the spreadsheet OR a trading-name variant
> (see Supplier Name Cheat Sheet). If all these 3 fields matches, tick checkbox
> in Tramada.

and BR06 / BR07: if any of the three disagree, **do not tick**, add an error
remark. That's a written business rule. Changing it is RAA's call, not ours —
which is why it's in this document rather than already changed.

### What the third check actually buys you

A tick on a bank statement page is a statement that this money went to this
party. Reference and amount confirm *how much* and *which transaction*. Only the
supplier name confirms *who was paid*.

The specific error it catches: a payment sitting in Tramada against the **wrong
creditor**. The reference matches, the amount matches, but the money is recorded
against a different company. With reference-only matching that line gets ticked
and committed, and nothing anywhere says a word about it.

It's worth noting that the amount check is doing real work too, and costs
nothing. In yesterday's MINT file three payments shared both the same supplier
and the same amount ($900 to RCL Cruises), so amount alone wouldn't identify a
row either — but reference *and* amount together is a strong, zero-maintenance
pair.

### What it costs

The spreadsheet carries the **legal entity name**; Tramada carries the **trading
name**. They rarely match character for character. Of the two MINT suppliers
confirmed against Tramada so far, **both** needed a mapping:

| On the MINT spreadsheet | In Tramada |
|---|---|
| Viva Holidays II Limited T/A Ready Rooms | READY ROOMS |
| Viva Holidays Pty Ltd | Viva Holidays |

The second one is the warning. That isn't an exotic trading name — it's Tramada
simply dropping "Pty Ltd". If that's typical, most of the 19 will need a mapping,
not a handful, and every new or renamed supplier adds another row.

And here is the important part about the risk: **a cheat sheet that falls behind
does not cause a wrong tick. It causes a perfectly good line to be refused and
pushed to a human.** The day-to-day cost of this rule is false alarms and
maintenance, not missed errors.

### Three options — pick one

**A · Leave it exactly as the guide is written.** *(what's built today)* All three
must agree or nothing is ticked. Safest, and matches BR05 to the letter. Cost:
the cheat sheet must be kept current or Finance gets false errors.

**B · Make the supplier a warning instead of a veto.** *(the middle ground)* Tick
on reference + amount. When the supplier name differs, still tick, but write
`Supplier name differs: <spreadsheet name> vs <Tramada name>` into the remarks so
a human sees it on the dashboard and in the exported file. Keeps the visibility,
removes the false alarms, removes the cheat-sheet maintenance entirely. This is a
change to BR05 and BR06 and needs RAA sign-off.

**C · Drop the supplier check.** Reference + amount only, no cheat sheet at all.
Simplest. The risk it accepts: a payment recorded against the wrong creditor gets
ticked and committed, and the run says nothing.

All three keep the amount check.

**If the concern is the cheat sheet being a burden, B gets you almost everything
A does without the maintenance.** If the concern is being able to say the agent
never ticks anything a human wouldn't have, stay on A.

The change itself is small — the matcher is a single function and all three
behaviours are already covered by tests. It's the decision that's holding it up,
not the work.

---

## 6 · Known gap, by instruction

The email step — MINT BR09, TravelPay BR10, and "attach the updated spreadsheet
and send it to RAA Travel Finance" — is **not built**, because we were asked to
leave it out for now. Flagging it here so it reads as a decision rather than an
oversight. The export it would attach already exists, so it's a small piece of
work whenever it's wanted.

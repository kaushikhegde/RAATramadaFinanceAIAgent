# Correctness review — bank-reconciliation-automation

One pass over the whole repo (~7,400 lines), 07-Aug-2026. Baseline: `npm test`
passes clean in a fresh container — 29 + 43 + 151 = 223 assertions, 0 failures.

Everything marked **proved** was reproduced by executing the real module against
real values, not by reading. Style, naming and refactor opportunities are
deliberately not in here.

The codebase is unusually well reasoned — nearly every hazard below is one the
comments already show awareness of somewhere else in the file. The findings are
the places where the rule the project states about itself is not the rule the
code follows.

---

## High

### 1. Issue is clicked a second time mid-submit — a slow Tramada files the receipt twice

`tramada-receipt.js:915-935`

```js
await page.click("#issue");
for (let i = 0; i < 25; i++) {
  await sleep(600);
  if (/booking-receipts\.htm/i.test(page.url())) break;
  …
  if (i === 8) { try { await page.click("#issue", { timeout: 3000 }); } catch {} }
}
```

At `i === 8` — roughly 5.4 s after the first click — Issue is clicked again with
no check that the first submit is still in flight. If the first POST is merely
slow rather than lost, the form is submitted twice and two receipts are created
for the same money. Nothing rolls back.

The duplicate is then invisible: `readLatestReceipt` reads a single row, so one
receipt number comes back, the reconciliation step finds it on the statement,
and the row reports clean. The second receipt is never mentioned anywhere.

**Failure scenario.** Tramada takes >5.4 s to respond to Issue on row 3 of a
12-row BPay file. Two `R.` receipts for $1,056.93 land against booking 13157.
The inbox shows one, reconciled.

**Fix.** Drop the re-click, or make it conditional: before re-clicking, reload
`booking-receipts.htm` and look for a receipt already carrying this reference
and amount. A blind retry on a form that commits money needs an idempotency
check in front of it.

---

### 2. The receipt read-back is never checked against what was just filed

`tramada-receipt.js:750-783, 945-954`

`readLatestReceipt` walks the receipts table and returns **the first row whose
Receipt No. starts with `R.`** — assuming the list is newest-first. That
ordering is not documented anywhere; `docs/tramada-field-map.md` documents sort
order for the *reconcile* screen (§ "SORT FIRST, THEN FILTER"), not for
`booking-receipts.htm`.

It already reads `reference`, `amount` and `dateReceived` off that row and
compares **none** of them to what was submitted. The only check is that the
number looks like `R.`:

```js
if (!issued || !/^R\./i.test(issued.receiptNo || "")) throw …
```

**Failure scenario.** Booking 13157 already has three receipts from last month.
The list renders oldest-first, or the new row has not appeared yet. The run
adopts a pre-existing receipt number as its own, `matchAgainstStatement` finds
that older receipt on the statement page at the same amount, and the row is
reported "Allocated / Reconciled" for a transaction this run did not create.

**Fix.** Assert the read-back row is the one just filed:

```js
if (core.receiptKey(issued.reference) !== core.receiptKey(receipt.reference) ||
    core.cents(issued.amount) !== core.cents(receipt.amount)) throw …
```

---

### 3. The amount typed into Tramada is the raw CSV text, not the parsed value — **proved**

`recon-run.js:576` → `tramada-receipt.js:408`

```js
receipt: { amount: r.amount, … }          // recon-run.js — the raw CSV cell
setFieldWithEvents(page, "#receiptreceiptAmount", String(receipt.amount));
```

`cents()` deliberately accepts `$`, thousands separators and `CR`/`DR` suffixes
(`recon-core.js:29-34`), so a hand-edited row passes validation and then has its
raw text typed into a money field. `parseReconCsv` keeps both `amount` (raw) and
`amountCents` (parsed) — the decision uses the parsed one, the form gets the raw
one.

```
row.amountCents (what the decision uses)      105693
row.amount      (what gets typed)             "$1,056.93"
core.money(amountCents) — what it should type "1056.93"
```

The README states the CSV is hand-editable, so this is reachable by the intended
workflow. Whether Tramada rejects `$1,056.93`, truncates it, or parses it is
unknown — and "unknown" is the problem on a form that commits.

**Fix.** Type `core.money(r.amountCents)`.

---

## Medium-high

### 4. `"ALL"` is decided from the segments that owe, but Select All ticks every segment — **proved**

`recon-core.js:294-297`, applied at `tramada-receipt.js:648-682`

`decideAllocation` filters to `owing` (`due > 0`), then returns `"ALL"` when
`picked.length === owing.length`. `"ALL"` means *click Select All*, which ticks
**every** row on the form, including the ones filtered out.

```
decideAllocation(10000, [100.00, -50.00])
  → {"allocation":"ALL","status":"Allocated",
     "reason":"$100.00 settles 1 segment (all of them) exactly"}

decideAllocation(20000, [100.00, 100.00, 0.00])
  → {"allocation":"ALL","status":"Allocated",
     "reason":"$200.00 settles 2 segments (all of them) exactly"}
```

In the first case Select All also ticks the −$50 segment, so the real Seg Total
is $50 against a $100 receipt, while the run reports it settled exactly. In the
second, a $0 segment is ticked, which Tramada may reject on Issue ("amount must
be…") and fail a row that was correct.

The filter proves the author expected non-positive dues to exist; the `"ALL"`
shortcut is what forgets them.

**Fix.** Return `"ALL"` only when `picked.length === segments.length`; otherwise
return the explicit `[{segId, amount}]` array, which already works.

---

### 5. A segment that moved between probe and commit is silently dropped

`recon-run.js:570-611`, `tramada-receipt.js:686-691`

The run calls `runTramadaReceipt` twice — once with `dryRun: true` to read what
is outstanding, then again to commit. Two separate page loads, two separate
reads of the segment table. The allocation plan is built from the *first* read
and applied to the *second*.

```js
const seg = a.segId != null ? segments.find((s) => s.segId === String(a.segId))
                            : segments[a.index];
if (!seg) continue;              // ← silently skipped
```

Meanwhile `recon-run.js` reports `decision.status` — computed before the commit
— as the outcome.

**Failure scenario.** A consultant allocates against booking 13157 in the two
seconds between the probe and the commit. Segment 4 disappears. The receipt is
filed with nothing allocated, and the inbox reads "Allocated — $500.00 settles 2
segments exactly".

**Fix.** Throw when a planned `segId` is not present on the commit form, and
report the row as failed rather than as its plan.

---

### 6. `normaliseAmount` turns blank-ish values into `"0.00"` — **proved**

`statement-csv.js:70-74`

```js
const n = Number(String(v).replace(/[$,\s]/g, "").replace(/\s*(CR|DR)$/i, ""));
return Number.isFinite(n) ? n.toFixed(2) : "";
```

Stripping `$`, commas and whitespace can empty the string, and `Number("")` is
`0`, not `NaN`.

```
normaliseAmount("   ")  → "0.00"
normaliseAmount("$")    → "0.00"
normaliseAmount("CR")   → "0.00"
normaliseAmount(" DR ") → "0.00"
normaliseAmount("\t")   → "0.00"
normaliseAmount("abc")  → ""      ← the intended behaviour
```

`buildRows` guards with `if (!amount)`, and `"0.00"` is truthy, so the row is
kept and written into the import CSV as a $0.00 receipt instead of being dropped
and counted.

The test suite states the intended invariant in its own assertion name —
`check("junk is blank, never zero", C.normaliseAmount("n/a"), "")`
(`test-statement-csv.js:28`) — and only tests the input that already satisfies
it.

**Fix.** After cleaning, `if (!/\d/.test(cleaned)) return "";`.

---

## Medium

### 7. Debtor Due is read by hard-coded column index

`tramada-receipt.js:333-361`

```js
debtorDue: cells[7] || inp.value || "",
```

Every allocate-or-not decision in the system rests on `cells[7]`. This is the
position-counting the rest of the codebase forbids by name — `recon-core.js`
carries two long comments about it (`mapColumns`, `parseReconCsv`) and
`recon-run.js` a third — and this function's own comment records having already
been wrong once here (`cells[6]`, Debtor Receipted, read as the due). One
inserted column and every decision is made against the wrong number, with every
row still looking plausible.

The fallback compounds it: if `cells[7]` is empty the value becomes
`inp.value`, which on a fresh form is `""` or `"0.00"` → read as "nothing
owed" → nothing allocated.

**Fix.** Read the header row of the segments table and map it through
`core.mapColumns`, same as everywhere else.

---

### 8. The Select All fix-up types the wrong figure for comma-formatted money — **proved**

`tramada-receipt.js:670-679`

```js
const due = cells.filter((c) => /^\d+(\.\d\d)?$/.test(c)).pop();
```

The regex rejects any amount Tramada renders with a thousands separator. Against
the column layout documented three lines above, with a $1,200.00 due:

```
cells  ["","Air","12345","REF","","1,200.00","0.00","1,200.00","",""]
picked "0.00"          ← Debtor Receipted, because both 1,200.00 cells are rejected
```

So the repair path fills `0.00` on a segment that owes $1,200. On a row shape
where the receipted column is absent it would reach further back and pick the
invoice number.

Only reachable when Select All fails to auto-fill — but that is precisely when
this code runs.

**Fix.** Allow separators: `/^[\d,]+(\.\d\d)?$/`, strip them before use — or
better, use the segment's own `debtorDue`, which the caller already has.

---

### 9. Blank lines shift every reported line number — **proved**

`recon-core.js:120` and `recon-core.js:499`

Both parsers filter empty lines out *before* numbering, so `line` counts
non-blank lines rather than file lines.

```
CSV with a blank line 3 and a bad row on line 4
  parseReconCsv problems → [3]
  parseMintRows problems → [3]
```

The UI sends the operator to the wrong row of a file the README tells them to
hand-edit. Off by one per blank line, cumulative.

**Fix.** Keep the index from the unfiltered split and skip blanks in the loop.

---

### 10. `.env.example` says the credentials are unused by the server. They are not.

`recon-run.js:543`, `tramada-receipt.js:125-138`, `CLAUDE.md:103`, `.env.example:22-26`

CLAUDE.md § 5: **"Never type credentials."** The UI banner: *"I'll wait, and I
never type credentials."* `.env.example`: *"Not used by the server."*

But:

```js
// recon-run.js — inside runReconciliation
const auth = { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD };
…
await runTramadaReceipt({ ...auth, … });
```

```js
// tramada-receipt.js — ensureLoggedIn
if (username && password) {
  await page.goto(`${TRAMADA_BASE_URL}/login.htm`, …);
  await page.fill("#username", username);
  await page.fill("#loginForm_password", password);
```

Uncomment those two lines in `.env` — which `.env.example` invites, for
`run-bookings.js` — and the reconciliation run starts typing them into Tramada's
login form while telling the operator it never does. `recon-run.js` has its own
`ensureLoggedIn` that correctly never types; the same run therefore has two
different login policies depending on which module is driving.

**Fix.** Don't forward `auth` from `runReconciliation`, or drop the
credential branch from `tramada-receipt.js` entirely.

---

## Low

### 11. `cents()` strips `DR` without applying its sign — **proved**

`recon-core.js:31`

```
cents("100.00 DR") → 10000
cents("100.00 CR") → 10000
```

A debit and a credit of the same size are indistinguishable. `filterAndRead`
(`recon-run.js:458`) reads `r.credit || r.debit`, so a debit row does arrive at
the comparison as a positive. Not currently exploitable — the BPay filter is
Client Payment Receipt (credits) and Mint's is Creditor Payment (debits, and
compared consistently) — but it is a signed quantity being handled as unsigned.

### 12. `nextPageNumber` throws on a null entry — **proved**

`recon-core.js:377` — `typeof null === "object"`, so `p.pageNo` throws
`Cannot read properties of null`. Only reachable if a caller passes a sparse
array, which today none do.

### 13. An embedded newline survives server.js's quoting but not the parser — **proved**

`server.js:128-133` re-serialises the page's rows to CSV and correctly quotes a
field containing `\n`. `parseReconCsv` then splits on `/\r?\n/` *before*
honouring quotes, so the row is destroyed:

```
1 row in ("REF\nA") → 0 rows out, 2 problems
```

The two halves of the codebase disagree about what CSV is. Also note `server.js`
quotes on `[",\n]` but not `\r`.

### 14. `unescapeXml` double-decodes — **proved**

`xlsx-lite.js:103-108` — named entities are replaced before numeric ones, so
`&amp;#65;` becomes `A` instead of the literal `&#65;`.

### 15. "A run is already going — waiting for it to finish" is not true

`server.js:143-146, 180-183` — nothing queues the request; it is dropped. The
operator is told their run is pending when it will never start.

### 16. `build-recon.js` warns about missing hooks and writes the page anyway

`build-recon.js:101-107` — the header promises it "fails loudly if the anchors
it needs have moved", and the two `anchors` do `die()`. The `HOOKS` list — which
includes `filePicker` and `startRun` — only prints a warning and exits 0. A CI
step or a distracted operator ships a page whose upload button does nothing.

### 17. `--limit 0` is silently ignored

`statement-csv.js:177` and `run-bookings.js:42` — `valueOf` returns the string
`"0"`, which is truthy, so `parseInt` gives `0`, which is falsy, so the limit
never applies. Harmless direction here (it does more, not less) but it is the
opposite of what was asked.

### 18. `receiptKey` unpads leading zeros

`recon-core.js:72-76` — `"0012345"` and `"12345"` are one key (**proved**). The
docstring justifies this for Tramada's own `R.`-prefixed receipt numbers, which
is sound. `matchMintAgainstStatement` then applies the same key to Mint's
third-party transaction reference, where the fixed-shape argument does not
hold.

---

## Not findings — checked and cleared

- The `session.reconRunning` guard in `server.js` is not racy: the path from
  message receipt to setting the flag contains no `await`.
- No missing `await` on any Playwright call across the five browser modules; the
  bare-looking ones are inside `Promise.all` or are synchronous `locator()`.
- `chooseSegments`' exhaustive search is bounded at 2^16 masks — not a hazard.
- `unzip`'s central-directory walk, `columnOf`'s past-Z arithmetic, and
  `firstSheetPath`'s `<sheet\b` (which correctly does not match `<sheets>`) are
  all right.
- `readSheet` places cells by their `r` reference, so sparse rows do not shift —
  the bug the comment describes is genuinely fixed.
- `matchAgainstStatement`'s `cents(t.amount) === row.amountCents` would match
  `null === null`, but both parsers divert null-amount rows into `problems`
  first, so it is unreachable.

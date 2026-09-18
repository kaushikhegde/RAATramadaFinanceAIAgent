"use strict";

/**
 * The date arithmetic behind step 10 and BR09.
 *
 * Both dates decide which Tramada lines the search returns at all. A "from"
 * that lands in the wrong month silently omits transactions; a "to" that is not
 * forward-dated means late costings can never be added to the saved session,
 * which is the whole reason BR09 exists.
 */

const assert = require("assert");
const tk = require("../tramada-tokio");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

check("Tramada dates are dd-mm-yyyy", () => {
  assert.strictEqual(tk.tramadaDate(new Date(2026, 6, 5)), "05-07-2026");
  assert.strictEqual(tk.tramadaDate(new Date(2026, 11, 31)), "31-12-2026");
});

check("single digits are padded, not left bare", () => {
  assert.strictEqual(tk.tramadaDate(new Date(2026, 0, 1)), "01-01-2026");
});

check("a bad date throws rather than searching on NaN", () => {
  assert.throws(() => tk.tramadaDate("not a date"));
});

check("from = the 1st of the previous month", () => {
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2026, 7, 18))), "01-07-2026");
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2026, 7, 1))), "01-07-2026");
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2026, 7, 31))), "01-07-2026");
});

check("January rolls back to December of the year before", () => {
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2027, 0, 9))), "01-12-2026");
});

check("the 31st does not skid into the wrong month", () => {
  // new Date(y, m-1, 1) is safe, but a naive setMonth(-1) on the 31st lands in
  // the month after the one intended. Pin it.
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2026, 2, 31))), "01-02-2026");
  assert.strictEqual(tk.tramadaDate(tk.firstOfPreviousMonth(new Date(2026, 4, 31))), "01-04-2026");
});

check("BR09 — to = today + 28 days, always forward", () => {
  assert.strictEqual(tk.tramadaDate(tk.fourWeeksOut(new Date(2026, 7, 18))), "15-09-2026");
  const now = new Date(2026, 7, 18);
  assert.ok(tk.fourWeeksOut(now) > now, "the to-date was not forward of today");
});

check("four weeks out crosses a month and a year end", () => {
  assert.strictEqual(tk.tramadaDate(tk.fourWeeksOut(new Date(2026, 11, 20))), "17-01-2027");
  assert.strictEqual(tk.tramadaDate(tk.fourWeeksOut(new Date(2028, 1, 10))), "09-03-2028"); // leap year
});

check("the search range always spans the whole reporting month", () => {
  for (const day of [1, 5, 15, 28, 31]) {
    const today = new Date(2026, 6, Math.min(day, 31));
    const from = tk.firstOfPreviousMonth(today);
    const to = tk.fourWeeksOut(today);
    assert.ok(from < today && to > today, `range ${tk.tramadaDate(from)}..${tk.tramadaDate(to)} does not contain ${tk.tramadaDate(today)}`);
    assert.strictEqual(from.getDate(), 1);
  }
});

check("the measured selector ids are pinned", () => {
  // The labels read "Segment Created Date" but the ids say "TransactionDate".
  // Anyone renaming these to match the labels breaks the search silently.
  assert.strictEqual(tk.SEARCH.fromCreated, "#fromTransactionDate");
  assert.strictEqual(tk.SEARCH.toCreated, "#toTransactionDate");
  assert.strictEqual(tk.SEARCH.paymentType, "#paymentType");
  assert.strictEqual(tk.SEARCH.bankAccount, "#agencyBankAccount");
  assert.strictEqual(tk.SEARCH.sortBy, "#sortBy");
  assert.strictEqual(tk.CHOOSER.issueRadio, "#form_selection_issue");
});

console.log("\n" + n + " assertions passed.");

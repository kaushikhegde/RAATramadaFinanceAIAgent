/**
 * make-mint-csv.js — build a Mint daily settlement CSV from real Tramada
 * creditor payments.
 *
 *   node make-mint-csv.js
 *
 * Writes two files:
 *
 *   mint-payments.csv         the three payments, all correct
 *   mint-payments-varied.csv  the same three, deliberately distorted, plus one
 *                             that does not exist — so a run shows every outcome
 *
 * ── The one thing worth understanding ────────────────────────────────────────
 *
 * `Transaction Reference` holds the **payment number** — `P.0000004123` — not
 * the reference typed into the payment form. On the reconciliation page a
 * creditor payment's `Trans. No` IS the payment number; the typed reference
 * (`MNT987`) sits in the Reference column, which this run does not look at.
 *
 * In production Mint issues its own reference (`M00640038` in the sample) and
 * Tramada would not know that number, so a real export would not match Trans. No
 * this way. These files exist to exercise the run against payments that are
 * genuinely on the statement page. The typed references are kept in
 * `Recipient Reference` / `Sender Reference` so nothing is lost.
 *
 * Columns are the sample workbook's sixteen, in order, including the trailing
 * space on "To Company " — the by-name lookup trims, so it does not matter, but
 * the file should look like the thing it is imitating.
 */
const fs = require("fs");
const path = require("path");

const HEADERS = [
  "From Company", "From Company Number", "To Company ", "To Company Number",
  "Transaction Reference", "Amount", "Currency", "Status",
  "Created Time", "Authorised Time", "Updated Time", "Due Time",
  "Recipient Reference", "Sender Reference", "Settlement Amt", "Statement Date",
];

const FROM = "Royal Automobile Association (RAA) of S.A. Incorporated";
const FROM_NO = "M363355";
const PAID = "2026-08-06 00:00:00";
const STATEMENT = "2026-08-07 00:00:00";

/* Read off the three Issue Creditor Payment screens, 06-08-2026.
   `typed` is the Reference on the payment form — carried through as the
   recipient/sender reference, never as the transaction reference.
   To Company Number is left EMPTY: Mint's company numbers for these creditors
   are not known here, and inventing one would be inventing a number. */
const PAYMENTS = [
  { no: "P.0000004123", amount: "400.00", company: "READY ROOMS", typed: "MNT987",  booking: "",      payee: "test" },
  { no: "P.0000004124", amount: "600.00", company: "READY ROOMS", typed: "FGHTGH",  booking: "13151", payee: "Mr demo user" },
  { no: "P.0000004125", amount: "150.00", company: "TEMPO HOLIDAYS", typed: "RTGHYUJ", booking: "13157", payee: "Mr demo user" },
];

const q = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const line = (p) => [
  FROM, FROM_NO, p.company, "", p.no, p.amount, "AUD", "Pending at Bank",
  PAID, PAID, PAID, PAID, p.typed, p.typed, "", STATEMENT,
].map(q).join(",");

const write = (name, payments) => {
  const csv = [HEADERS.map(q).join(",")].concat(payments.map(line)).join("\n") + "\n";
  const out = path.join(__dirname, name);
  fs.writeFileSync(out, csv);
  console.log(`  ${name}  ${payments.length} row${payments.length === 1 ? "" : "s"}`);
  return out;
};

console.log("\nMint daily settlement, from three real creditor payments:\n");
write("mint-payments.csv", PAYMENTS);

/* The varied file. Each distortion is one thing, so a wrong outcome points at
   one cause:
     4123  untouched                        → Reconciled, nothing to note
     4124  amount 650.00 against 600.00     → Reconciled, the difference reported
     4125  company READY ROOMS, not TEMPO   → Reconciled, the difference reported
     9999  does not exist                   → Not reconciled                     */
const VARIED = [
  PAYMENTS[0],
  { ...PAYMENTS[1], amount: "650.00" },
  { ...PAYMENTS[2], company: "READY ROOMS" },
  { no: "P.0000009999", amount: "275.50", company: "INFINITY HOLIDAYS", typed: "MNT000", payee: "nobody" },
];
write("mint-payments-varied.csv", VARIED);
console.log("");

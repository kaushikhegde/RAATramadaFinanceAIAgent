"use strict";

/**
 * BR01-BR07 from "Payments Guide - IPSI.docx", held to by assertion.
 *
 * The one that matters most is BR04. If `assertNotRealCard` ever loosens, a
 * customer's card number reaches Tramada — so it is tested from both sides:
 * real-looking numbers must be refused, and the configured dummies must pass.
 */

const assert = require("assert");
const pc = require("../payments-core");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

// A dummy registry for the tests. Deliberately Luhn-INVALID, which is what a
// sane dummy card looks like — if RAA's real dummies turn out to be Luhn-valid
// the registry still passes them, because it matches by value first.
const DUMMIES = { Mastercard: "5555555555554440", Visa: "4111111111111110" };

const IPSI = {
  bookingNo: "13061",
  txnRef: "1792412290cXt4Z",
  cardholderName: "M GRAY",
  amount: "1289.00",
  cardType: "Mastercard",
};

/* ------------------------------------------------------------ BR03 */

check("BR03 pins the three fixed fields", () => {
  assert.strictEqual(pc.SWIPE_FIXED.transactionType, "Credit Card Swipe");
  assert.strictEqual(pc.SWIPE_FIXED.bankAccount, "[TRUST] Trust Account");
  assert.strictEqual(pc.SWIPE_FIXED.receivedFrom, "RAA of SA Limited (Retail)");
});

check("the fixed values cannot be mutated at runtime", () => {
  assert.throws(() => { "use strict"; pc.SWIPE_FIXED.bankAccount = "[GENERAL] General Account"; });
});

check("card category is Personal", () => {
  assert.strictEqual(pc.SWIPE_FIXED.cardCategory, "Personal");
});

/* ------------------------------------------------------------ Luhn */

check("Luhn accepts a well-formed test PAN", () => {
  assert.ok(pc.passesLuhn("4111111111111111"));
  assert.ok(pc.passesLuhn("5555555555554444"));
});

check("Luhn rejects a number one digit off", () => {
  assert.ok(!pc.passesLuhn("4111111111111112"));
});

check("Luhn ignores spaces and dashes", () => {
  assert.ok(pc.passesLuhn("4111 1111-1111 1111"));
});

check("Luhn rejects anything too short to be a PAN", () => {
  assert.ok(!pc.passesLuhn("41111"));
});

/* ------------------------------------------------------------ BR04 */

check("BR04 refuses a live-looking card number", () => {
  assert.throws(
    () => pc.assertNotRealCard("4111111111111111", DUMMIES),
    (e) => e.code === "LOOKS_LIKE_REAL_CARD" && /§4/.test(e.message)
  );
});

check("BR04 refuses an unrecognised number even when Luhn-invalid", () => {
  assert.throws(
    () => pc.assertNotRealCard("1234567890123", DUMMIES),
    (e) => e.code === "UNKNOWN_CARD"
  );
});

check("BR04 lets the configured dummy through", () => {
  assert.doesNotThrow(() => pc.assertNotRealCard(DUMMIES.Mastercard, DUMMIES));
  assert.doesNotThrow(() => pc.assertNotRealCard(DUMMIES.Visa, DUMMIES));
});

check("BR04 matches the dummy regardless of spacing", () => {
  assert.doesNotThrow(() => pc.assertNotRealCard("5555 5555 5555 4440", DUMMIES));
});

check("BR04 refuses an empty number rather than passing it on", () => {
  assert.throws(() => pc.assertNotRealCard("", DUMMIES), /No card number/);
});

/* -------------------------------------------------- the decision */

const CARDS = require("../fixtures/dummy-cards.json");
const dec = (patch, payer = "Megan Gray", opts) =>
  pc.decideSwipeReceipt({ ...IPSI, ...patch }, payer, opts);

check("BR08 — the four numbers are exactly the guide's", () => {
  assert.deepStrictEqual(pc.BR08_CARDS, {
    "Visa Credit": "4242424242424242",
    "Visa Debit": "4400000000000008",
    "Mastercard Credit": "5454545454545454",
    "Mastercard Debit": "5555555555554444",
  });
});

check("fixtures/dummy-cards.json agrees with BR08", () => {
  for (const [choice, number] of Object.entries(pc.BR08_CARDS)) {
    assert.strictEqual(String(CARDS[choice] || "").replace(/\D/g, ""), number, choice);
  }
});

check("each card type yields its own BR08 number", () => {
  for (const [choice, number] of Object.entries(pc.BR08_CARDS)) {
    const d = dec({ cardType: choice });
    assert.ok(d.ok, d.reason);
    assert.strictEqual(d.receipt.card.number, number, choice);
  }
});

check("a registry pointing a type at the wrong BR08 number is refused", () => {
  // Swapping two valid dummies keeps every number legitimate, so the PAN guard
  // is happy — only the per-type check catches it.
  const swapped = { ...CARDS, "Visa Credit": pc.BR08_CARDS["Mastercard Credit"] };
  const d = dec({ cardType: "Visa Credit" }, "Megan Gray", { cards: swapped });
  assert.ok(!d.ok, "a Mastercard number was accepted as the Visa Credit dummy");
  assert.ok(/BR08/.test(d.reason), d.reason);
});

check("a complete IPSI approval produces the whole receipt", () => {
  const d = dec({ cardType: "Mastercard Credit" });
  assert.ok(d.ok, d.reason);
  assert.strictEqual(d.bookingNo, "13061");
  assert.strictEqual(d.receipt.transactionType, "Credit Card Swipe");
  assert.strictEqual(d.receipt.bankAccount, "[TRUST] Trust Account");
  assert.strictEqual(d.receipt.receivedFrom, "RAA of SA Limited (Retail)");
  assert.strictEqual(d.receipt.amount, "1289.00");
  assert.strictEqual(d.receipt.card.category, "Personal");
});

check("brand and sub-type are derived, not left to the form", () => {
  assert.strictEqual(dec({ cardType: "Visa Debit" }).receipt.card.type, "Visa");
  assert.strictEqual(dec({ cardType: "Visa Debit" }).receipt.card.subType, "Debit");
  assert.strictEqual(dec({ cardType: "Mastercard Credit" }).receipt.card.type, "Mastercard");
  assert.strictEqual(dec({ cardType: "Mastercard Credit" }).receipt.card.subType, "Credit");
});

/* ------------------------------------------------- step 6, the expiry */

check("expiry is December of the current year, in MM/YY", () => {
  assert.strictEqual(pc.expiryForDate(new Date("2026-09-17")), "12/26");
});

check("expiry rolls over on 1 January, not on a fixed string", () => {
  // The guide's own example: "when it's Jan 2027, it should be entered as 12/27".
  assert.strictEqual(pc.expiryForDate(new Date("2026-12-31")), "12/26");
  assert.strictEqual(pc.expiryForDate(new Date("2027-01-01")), "12/27");
  assert.strictEqual(pc.expiryForDate(new Date("2030-06-15")), "12/30");
});

check("the decision uses the run's date for the expiry", () => {
  const d = dec({ cardType: "Visa Credit" }, "Megan Gray", { now: new Date("2028-03-02") });
  assert.strictEqual(d.receipt.card.expiry, "12/28");
});

/* ------------------------------------------------------------- BR02 */

check("BR02 — a bare brand stops and offers the two choices", () => {
  for (const brand of ["Mastercard", "Visa"]) {
    const d = dec({ cardType: brand });
    assert.ok(!d.ok, brand + " alone was accepted");
    assert.ok(/BR02/.test(d.reason), d.reason);
    assert.deepStrictEqual(d.choices, [brand + " Credit", brand + " Debit"]);
  }
});

check("an unrecognised card type is refused with the BR08 set", () => {
  const d = dec({ cardType: "Amex" });
  assert.ok(!d.ok);
  assert.deepStrictEqual(d.choices, Object.keys(pc.BR08_CARDS));
});

check("card choice is normalised from loose input", () => {
  const p = pc.normaliseCardChoice;
  assert.strictEqual(p("  visa   DEBIT "), "Visa Debit");
  assert.strictEqual(p("mastercard credit"), "Mastercard Credit");
  assert.strictEqual(p("MasterCard"), "Mastercard");
});

/* ------------------------------------------------------------- BR05 */

check("BR05 — the payer name overrides both payer and card holder", () => {
  const d = dec({ cardType: "Visa Credit" }, "Someone Else");
  assert.strictEqual(d.receipt.payerName, "Someone Else");
  assert.strictEqual(d.receipt.card.holder, "Someone Else");
});

check("the IPSI reference goes in verbatim, with no RRC prefix", () => {
  const d = dec({ cardType: "Visa Credit" });
  assert.strictEqual(d.receipt.reference, "1792412290cXt4Z");
  assert.ok(!/^RRC/.test(d.receipt.reference));
});

check("the measured selectors are pinned", () => {
  const s = pc.SWIPE_SELECTORS;
  assert.strictEqual(s.transactionType, "#receipttransactionTypeCode");
  assert.strictEqual(s.transactionTypeValue, "CS");
  assert.strictEqual(s.bankAccount, "#receiptagencyBankAccount");
  assert.strictEqual(s.receivedFrom, "#debtor");
  assert.strictEqual(s.creditCard, "#receiptcreditCard");
});

/* ------------------------------------------- stopping, not guessing */

for (const [field, patch] of [
  ["booking number", { bookingNo: "" }],
  ["IPSI transaction reference number", { txnRef: "" }],
  ["amount", { amount: "" }],
  ["card type", { cardType: "" }],
]) {
  check("stops when the " + field + " is missing", () => {
    const d = dec({ cardType: "Visa Credit", ...patch });
    assert.ok(!d.ok, "it went ahead without the " + field);
    assert.ok(d.reason.includes(field.split(" ")[0]), d.reason);
  });
}

check("BR01 — stops when nobody confirmed the payer", () => {
  const d = dec({ cardType: "Visa Credit" }, "   ");
  assert.ok(!d.ok);
  assert.ok(/BR01/.test(d.reason), d.reason);
});

check("an empty registry stops rather than inventing a number", () => {
  const d = dec({ cardType: "Visa Credit" }, "Megan Gray", { cards: {} });
  assert.ok(!d.ok);
  assert.ok(/BR08/.test(d.reason), d.reason);
});

/* ------------------------------------------- public test cards (BR04 edge) */

check("a public test card is recognised by name", () => {
  assert.strictEqual(pc.publicTestCardName("4242424242424242"), "Stripe test Visa");
  assert.strictEqual(pc.publicTestCardName("4242 4242 4242 4242"), "Stripe test Visa");
  assert.strictEqual(pc.publicTestCardName("5555555555554440"), null);
});

check("a public test card is still refused unless it is in the registry", () => {
  // It belongs to nobody, but it is not automatically a dummy card either —
  // it has to be configured deliberately, like any other.
  assert.throws(() => pc.assertNotRealCard("4242424242424242", {}), (e) => e.code === "LOOKS_LIKE_REAL_CARD");
});

/* ------------------------------------------------------- the registry */

check("env overrides the file, per card type", () => {
  // BR08 names four cards, so the env vars are per type too — DUMMY_CARD_VISA
  // alone is now meaningless and must not silently set anything.
  const d = pc.loadDummyCards({ DUMMY_CARD_VISA_CREDIT: "4000000000000010" });
  assert.strictEqual(d["Visa Credit"], "4000000000000010");
  assert.strictEqual(d["Visa Debit"], pc.BR08_CARDS["Visa Debit"], "it clobbered the others");
});

check("with no env set, the registry is exactly the shipped file", () => {
  // It used to be empty. Now it carries public test cards so the sandbox
  // pipeline can run — so assert it MATCHES THE FILE rather than asserting a
  // fixed value, which would have to be edited again the day Heath's cards
  // land.
  const file = require("../fixtures/dummy-cards.json");
  const d = pc.loadDummyCards({});
  for (const [k, v] of Object.entries(file)) {
    if (k.startsWith("_") || !v) continue;
    assert.strictEqual(d[pc.normaliseCardChoice(k)], v, "registry lost " + k);
  }
});

check("the file's _comment never becomes a card", () => {
  const d = pc.loadDummyCards({});
  assert.strictEqual(d._comment, undefined);
  for (const v of Object.values(d)) {
    assert.ok(/^[0-9]+$/.test(v), "a non-numeric value got into the registry: " + v);
  }
});

check("every shipped card is one of BR08's four", () => {
  // A REAL card number must never be committed to this repo. If one ever is,
  // this fails on the next run rather than on the next audit.
  const file = require("../fixtures/dummy-cards.json");
  for (const [k, v] of Object.entries(file)) {
    if (k.startsWith("_") || !v) continue;
    assert.ok(
      Object.values(pc.BR08_CARDS).includes(String(v).replace(/\D/g, "")),
      k + " in fixtures/dummy-cards.json is not one of BR08's four numbers. " +
        "If the guide changed, update BR08_CARDS deliberately. If it is a " +
        "customer's card, remove it now."
    );
  }
});



/* ------------------------------------------------- step 8, the allocation */

const SEGS = [
  { segId: "75584", segType: "PKG", debtorDue: "15090.00" },
  { segId: "75587", segType: "SFE", debtorDue: "50.00" },
];

check("an exact match takes that one segment alone", () => {
  const p = pc.planAllocation(SEGS, "50.00");
  assert.ok(p.ok, p.reason);
  assert.strictEqual(p.exact, true);
  assert.deepStrictEqual(p.allocation, [{ segId: "75587", amount: "50.00" }]);
});

check("a part payment allocates only what was received", () => {
  // The live failure: "ALL" ticked PKG 15090 + SFE 50 for a $100 receipt.
  const p = pc.planAllocation(SEGS, "100.00");
  assert.ok(p.ok, p.reason);
  const total = p.allocation.reduce((a, x) => a + pc.centsOf(x.amount), 0);
  assert.strictEqual(total, 10000, "allocated " + total + " cents for a $100 receipt");
});

check("a payment spanning two segments fills them in order", () => {
  const p = pc.planAllocation([{ segId: "a", debtorDue: "60.00" }, { segId: "b", debtorDue: "90.00" }], "100.00");
  assert.deepStrictEqual(p.allocation, [
    { segId: "a", amount: "60.00" },
    { segId: "b", amount: "40.00" },
  ]);
});

check("it never allocates more than is outstanding", () => {
  const p = pc.planAllocation(SEGS, "99999.00");
  assert.ok(!p.ok);
  assert.ok(/only \$15140\.00/.test(p.reason), p.reason);
});

check("the total never exceeds the receipt, whatever the split", () => {
  for (const amt of ["0.01", "49.99", "50.00", "50.01", "15089.99", "15140.00"]) {
    const p = pc.planAllocation(SEGS, amt);
    assert.ok(p.ok, amt + ": " + p.reason);
    const total = p.allocation.reduce((a, x) => a + pc.centsOf(x.amount), 0);
    assert.strictEqual(total, pc.centsOf(amt), amt + " allocated " + total);
  }
});

check("no segment is ever ticked for 0.00", () => {
  // Checking the TOTAL is not enough: a loop that keeps going after the receipt
  // is used up adds $0.00 rows, which still total correctly but tick segments
  // this payment has nothing to do with. BR06 — the segments selected and the
  // amounts allocated have to match.
  for (const amt of ["0.01", "50.00", "60.00", "15140.00"]) {
    const p = pc.planAllocation(SEGS, amt);
    assert.ok(p.ok, p.reason);
    for (const row of p.allocation) {
      assert.ok(pc.centsOf(row.amount) > 0, `${amt} ticked segment ${row.segId} for ${row.amount}`);
    }
  }
});

check("segments with nothing due are skipped, not ticked at zero", () => {
  const p = pc.planAllocation([{ segId: "z", debtorDue: "0.00" }, { segId: "y", debtorDue: "80.00" }], "80.00");
  assert.deepStrictEqual(p.allocation, [{ segId: "y", amount: "80.00" }]);
});

check("a booking with nothing outstanding refuses rather than returning []", () => {
  const p = pc.planAllocation([{ segId: "z", debtorDue: "0.00" }], "10.00");
  assert.ok(!p.ok);
  assert.ok(/nothing to allocate/i.test(p.reason), p.reason);
});

check("a nonsense amount refuses", () => {
  for (const bad of [null, "", "abc", "0.00", "-5.00"]) {
    assert.ok(!pc.planAllocation(SEGS, bad).ok, JSON.stringify(bad) + " was accepted");
  }
});

check("centsOf copes with the formats Tramada renders", () => {
  assert.strictEqual(pc.centsOf("1,289.00"), 128900);
  assert.strictEqual(pc.centsOf("$100"), 10000);
  assert.strictEqual(pc.centsOf(100), 10000);
  assert.strictEqual(pc.centsOf(""), null);
});



/* ------------------------------------------- the settlement file as input */

const CSV_HEAD =
  "Transaction Reference,Transaction Time stamp,Transaction Type,Transaction Status,Channel," +
  "Card Holder Name,Transaction Amount,Settlement Date,Merchant Reference,Card Type,Custom 5," +
  "Booking Number,Settlement Amount,Tramada Payment Number";

const csv = (...rows) => [CSV_HEAD, ...rows].join("\n");

check("it reads booking, reference, amount, holder and brand off the file", () => {
  const { rows } = pc.parseIpsiCsv(
    csv("IP-T314W-14504,2026-09-01,1,APPROVED,terminal,Spider Gray,145.54,2026-09-01,,VISA,Purchase (1),14504,,")
  );
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(
    { ...rows[0], line: undefined },
    { line: undefined, bookingNo: "14504", txnRef: "IP-T314W-14504", amount: "145.54",
      cardholderName: "Spider Gray", brand: "Visa" }
  );
});

check("a row with no booking number is reported, never silently dropped", () => {
  // An unreceipted payment is money that never reaches a booking. Skipping it
  // quietly is the failure mode that matters here.
  const { rows, problems } = pc.parseIpsiCsv(
    csv("IP-T314W-14507,2026-09-01,1,APPROVED,terminal,Spider Gray,200.00,2026-09-01,,VISA,Purchase (1), ,,")
  );
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(problems.length, 1);
  assert.ok(/IP-T314W-14507/.test(problems[0]) && /no booking number/.test(problems[0]), problems[0]);
});

check("a declined transaction is skipped and named", () => {
  const { rows, problems } = pc.parseIpsiCsv(
    csv("IP-X,2026-09-01,1,DECLINED,terminal,Spider Gray,200.00,2026-09-01,,VISA,Purchase (1),14507,,")
  );
  assert.strictEqual(rows.length, 0);
  assert.ok(/DECLINED/.test(problems[0]), problems[0]);
});

check("a comma inside a quoted card holder name does not shift the columns", () => {
  const { rows } = pc.parseIpsiCsv(
    csv('IP-Y,2026-09-01,1,APPROVED,terminal,"Gray, Spider",145.54,2026-09-01,,VISA,Purchase (1),14504,,')
  );
  assert.strictEqual(rows[0].cardholderName, "Gray, Spider");
  assert.strictEqual(rows[0].amount, "145.54");
  assert.strictEqual(rows[0].bookingNo, "14504");
});

check("a file missing a required column says which", () => {
  const { rows, problems } = pc.parseIpsiCsv("Transaction Reference,Card Type\nIP-Z,VISA");
  assert.strictEqual(rows.length, 0);
  assert.ok(/Booking Number/.test(problems[0]) && /Transaction Amount/.test(problems[0]), problems[0]);
});

check("an empty file is a problem, not an empty success", () => {
  const { rows, problems } = pc.parseIpsiCsv("");
  assert.strictEqual(rows.length, 0);
  assert.ok(problems.length, "no problem reported for an empty file");
});

check("the brand is normalised but never becomes a confirmed card type", () => {
  const { rows } = pc.parseIpsiCsv(
    csv("IP-A,2026-09-01,1,APPROVED,terminal,S G,10.00,2026-09-01,,MASTERCARD,Purchase (1),14504,,")
  );
  assert.strictEqual(rows[0].brand, "Mastercard");
  assert.strictEqual(rows[0].cardType, undefined, "the file's brand was promoted to a card type");
});

check("column order is read from the header, not assumed", () => {
  const text = [
    "Booking Number,Transaction Amount,Transaction Reference",
    "14999,42.00,IP-REORDERED",
  ].join("\n");
  const { rows } = pc.parseIpsiCsv(text);
  assert.deepStrictEqual(
    { b: rows[0].bookingNo, a: rows[0].amount, r: rows[0].txnRef },
    { b: "14999", a: "42.00", r: "IP-REORDERED" }
  );
});



/* ---------------------------------- the duplicate guard vs the surcharge */

const reconCore = require("../recon-core");

check("a re-run does NOT file a second receipt under the same IPSI reference", () => {
  // The live failure: asked 318.20, Tramada filed 320.75 with its surcharge.
  // Matching on reference+amount missed its own receipt and would have taken
  // the money again.
  const filed = [{ receiptNo: "R.0000009927", reference: "IP-T314W-14513", amount: "320.75" }];
  const hit = reconCore.findFiledReceipt(filed, {
    reference: "IP-T314W-14513",
    amount: "318.20",
    matchAmount: false,
  });
  assert.ok(hit, "a re-run would have filed a duplicate");
  assert.strictEqual(hit.receiptNo, "R.0000009927");
});

check("matching on reference alone still needs the reference to match", () => {
  const filed = [{ receiptNo: "R.1", reference: "IP-OTHER", amount: "320.75" }];
  assert.strictEqual(
    reconCore.findFiledReceipt(filed, { reference: "IP-T314W-14513", amount: "318.20", matchAmount: false }),
    null
  );
});

check("the default still requires BOTH reference and amount", () => {
  // BPay and the rest rely on the pair: one reference can carry a correcting
  // receipt for a different figure, and that is not a duplicate.
  const filed = [{ receiptNo: "R.2", reference: "BP-1", amount: "100.00" }];
  assert.ok(reconCore.findFiledReceipt(filed, { reference: "BP-1", amount: "100.00" }));
  assert.strictEqual(reconCore.findFiledReceipt(filed, { reference: "BP-1", amount: "250.00" }), null);
});

check("reference-only mode does not need an amount at all", () => {
  const filed = [{ receiptNo: "R.3", reference: "IP-X", amount: "12.34" }];
  assert.ok(reconCore.findFiledReceipt(filed, { reference: "IP-X", matchAmount: false }));
  assert.strictEqual(reconCore.findFiledReceipt(filed, { reference: "IP-X" }), null, "the pair mode accepted a missing amount");
});

console.log("\n" + n + " assertions passed (rules, allocation, settlement file, duplicates).");

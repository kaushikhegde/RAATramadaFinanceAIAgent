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

// What #receiptcreditCard really offered on 16-Sep-2026, booking 13061.
const CARD_OPTIONS = [
  { value: "749", label: "0000 GC - C - Givex Gift Card" },
  { value: "383", label: "520000....5957 CA - C - Mastercard Credit" },
  { value: "382", label: "518868....0008 CA - C - Mastercard Debit" },
  { value: "472", label: "0000 RV - C - Redemption Voucher" },
  { value: "380", label: "411111....1111 VI - C - Visa Credit" },
  { value: "381", label: "404137....6459 VI - C - Visa Debit" },
];

check("a complete IPSI approval produces the whole receipt", () => {
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Mastercard Credit" }, "Megan Gray", CARD_OPTIONS);
  assert.ok(d.ok, d.reason);
  assert.strictEqual(d.bookingNo, "13061");
  assert.strictEqual(d.receipt.transactionType, "Credit Card Swipe");
  assert.strictEqual(d.receipt.bankAccount, "[TRUST] Trust Account");
  assert.strictEqual(d.receipt.receivedFrom, "RAA of SA Limited (Retail)");
  assert.strictEqual(d.receipt.amount, "1289.00");
});

check("the decision carries NO card number, only a selection", () => {
  // The whole §4 argument rests on this: nothing downstream can type a PAN
  // because nothing upstream ever produced one.
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Debit" }, "Megan Gray", CARD_OPTIONS);
  assert.ok(d.ok);
  assert.strictEqual(d.receipt.card.number, undefined);
  assert.strictEqual(d.receipt.card.optionValue, "381");
  assert.strictEqual(d.receipt.card.choice, "Visa Debit");
  const flat = JSON.stringify(d);
  assert.ok(!/\b\d{13,19}\b/.test(flat), "a long digit run reached the decision: " + flat);
});

check("each card type picks its own row, not merely a matching brand", () => {
  const pick = (t) => pc.decideSwipeReceipt({ ...IPSI, cardType: t }, "Megan Gray", CARD_OPTIONS).receipt.card.optionValue;
  assert.strictEqual(pick("Mastercard Credit"), "383");
  assert.strictEqual(pick("Mastercard Debit"), "382");
  assert.strictEqual(pick("Visa Credit"), "380");
  assert.strictEqual(pick("Visa Debit"), "381");
});

check("BR02 — a bare brand stops and offers the two choices", () => {
  for (const brand of ["Mastercard", "Visa"]) {
    const d = pc.decideSwipeReceipt({ ...IPSI, cardType: brand }, "Megan Gray", CARD_OPTIONS);
    assert.ok(!d.ok, brand + " alone was accepted");
    assert.ok(/BR02/.test(d.reason), d.reason);
    assert.deepStrictEqual(d.choices, [brand + " Credit", brand + " Debit"]);
  }
});

check("a card type Tramada does not offer stops rather than adding one", () => {
  const thin = CARD_OPTIONS.filter((o) => !/Debit/.test(o.label));
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Debit" }, "Megan Gray", thin);
  assert.ok(!d.ok);
  assert.ok(/no "Visa Debit"/.test(d.reason), d.reason);
  assert.ok(/not.*typ/i.test(d.reason), "it did not rule out typing a number: " + d.reason);
});

check("an unrecognised card type is refused with the valid set", () => {
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Amex" }, "Megan Gray", CARD_OPTIONS);
  assert.ok(!d.ok);
  assert.deepStrictEqual(d.choices, ["Mastercard Credit", "Mastercard Debit", "Visa Credit", "Visa Debit"]);
});

check("card choice is normalised from loose input", () => {
  const p = pc.normaliseCardChoice;
  assert.strictEqual(p("  visa   DEBIT "), "Visa Debit");
  assert.strictEqual(p("mastercard credit"), "Mastercard Credit");
  assert.strictEqual(p("MasterCard"), "Mastercard");
  assert.strictEqual(p("Visa"), "Visa");
});

check("the gift card and voucher rows are never matched", () => {
  // They are in the same dropdown and must not be reachable by a card type.
  for (const t of Object.keys(pc.CARD_LABELS)) {
    const o = pc.matchCardOption(t, CARD_OPTIONS);
    assert.ok(o && !/Givex|Voucher/i.test(o.label), t + " matched " + (o && o.label));
  }
});

check("BR05 — the payer name overrides, it is not the card's holder", () => {
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Credit" }, "Someone Else", CARD_OPTIONS);
  assert.strictEqual(d.receipt.payerName, "Someone Else");
});

check("the IPSI reference goes in verbatim, with no RRC prefix", () => {
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Credit" }, "Megan Gray", CARD_OPTIONS);
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
    const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Credit", ...patch }, "Megan Gray", CARD_OPTIONS);
    assert.ok(!d.ok, "it went ahead without the " + field);
    assert.ok(d.reason.includes(field.split(" ")[0]), d.reason);
  });
}

check("BR01 — stops when nobody confirmed the payer", () => {
  const d = pc.decideSwipeReceipt({ ...IPSI, cardType: "Visa Credit" }, "   ", CARD_OPTIONS);
  assert.ok(!d.ok);
  assert.ok(/BR01/.test(d.reason), d.reason);
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

check("env overrides the file", () => {
  const d = pc.loadDummyCards({ DUMMY_CARD_VISA: "4000000000000010" });
  assert.strictEqual(d.Visa, "4000000000000010");
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
    assert.strictEqual(d[pc.normaliseCardType(k)], v, "registry lost " + k);
  }
});

check("the file's _comment never becomes a card", () => {
  const d = pc.loadDummyCards({});
  assert.strictEqual(d._comment, undefined);
  for (const v of Object.values(d)) {
    assert.ok(/^[0-9]+$/.test(v), "a non-numeric value got into the registry: " + v);
  }
});

check("every shipped card is either blank or a known public test card", () => {
  // A REAL card number must never be committed to this repo. If one ever is,
  // this fails on the next run rather than on the next audit.
  const file = require("../fixtures/dummy-cards.json");
  for (const [k, v] of Object.entries(file)) {
    if (k.startsWith("_") || !v) continue;
    assert.ok(
      pc.publicTestCardName(v),
      k + " in fixtures/dummy-cards.json is not a recognised public test card. " +
        "If it is RAA's real dummy from Heath, add it to PUBLIC_TEST_CARDS' " +
        "allowed list deliberately. If it is a customer's card, remove it now."
    );
  }
});

console.log("\n" + n + " assertions passed.");

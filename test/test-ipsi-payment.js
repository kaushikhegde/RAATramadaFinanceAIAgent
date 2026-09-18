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

console.log("\n" + n + " assertions passed.");

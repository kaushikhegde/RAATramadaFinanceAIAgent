"use strict";

/**
 * payments-core.js — the decisions behind Payments: IPSI (Customers).
 *
 * Pure functions. No browser, no network, no Tramada. `tramada-receipt.js`
 * already knows how to drive the Issue Debtor Payment Receipt form; what it
 * does not know is what RAA's rules say may go into it. That is this file.
 *
 * Source: "Payments Guide - IPSI.docx", business rules BR01-BR07.
 *
 * The rule that makes this work at all is BR04: RAA is NEVER permitted to hold
 * or enter a customer's real card number in Tramada. A dummy card matching the
 * customer's confirmed card type is used instead. That is why this flow can be
 * automated while CLAUDE.md §4 still holds — and it is why `assertNotRealCard`
 * below is not decoration.
 */

/* ------------------------------------------------------------------ BR03 */

// Fixed for every IPSI customer payment. Not caller-supplied, not guessable.
const SWIPE_FIXED = Object.freeze({
  transactionType: "Credit Card Swipe", // #receipttransactionTypeCode = "CS"
  bankAccount: "[TRUST] Trust Account", // #receiptagencyBankAccount = "1"
  receivedFrom: "RAA of SA Limited (Retail)", // #debtor
  cardCategory: "Personal",
});

/**
 * MEASURED 16-Sep-2026, booking 13061. Two of BR03's three fields need no
 * action at all on this form:
 *
 *   #receiptagencyBankAccount  offers exactly ONE option, 1=[TRUST] Trust
 *                              Account, and arrives selected.
 *   #debtor                    is READ-ONLY and arrives holding
 *                              "RAA of SA Limited (Retail)".
 *
 * They are still asserted rather than assumed — a form that quietly starts
 * offering a General Account option must fail loudly, not post money into it.
 */
const SWIPE_SELECTORS = Object.freeze({
  transactionType: "#receipttransactionTypeCode",
  transactionTypeValue: "CS",
  bankAccount: "#receiptagencyBankAccount",
  receivedFrom: "#debtor",          // read-only
  creditCard: "#receiptcreditCard", // select, never type
  authNumber: "#receiptcreditCardAuthNumber",
  payerName: "#receiptpayerName",
  dateReceived: "#receiptdateReceived",
  amount: "#receiptreceiptAmount",
  reference: "#receiptreferenceNumber",
});

/* ------------------------------------------------------------------ BR04 */

/**
 * MEASURED 16-Sep-2026 on booking-debtor-payment-receipt.htm, booking 13061.
 *
 * RAA's dummy cards are ALREADY SET UP IN TRAMADA. `#receiptcreditCard` is a
 * dropdown that offers them by masked number and type:
 *
 *   383  520000....5957 CA - C - Mastercard Credit
 *   382  518868....0008 CA - C - Mastercard Debit
 *   380  411111....1111 VI - C - Visa Credit
 *   381  404137....6459 VI - C - Visa Debit
 *   749  0000          GC - C - Givex Gift Card
 *   472  0000          RV - C - Redemption Voucher
 *
 * So the run SELECTS a card; it never types a card number. That is a stronger
 * guarantee than any check on a number we typed ourselves could be, and it is
 * the reason this flow is safe under CLAUDE.md §4: no PAN ever passes through
 * this process at all.
 *
 * Ids are per-environment — match on the option's LABEL, never on 380/381/…,
 * which will differ in production.
 *
 * BR02 is why the brand alone is not enough. "Mastercard" maps to two cards,
 * credit and debit, and picking one for the customer is exactly the guess the
 * rule exists to prevent.
 */
const CARD_LABELS = Object.freeze({
  "Mastercard Credit": /mastercard\s*credit/i,
  "Mastercard Debit": /mastercard\s*debit/i,
  "Visa Credit": /visa\s*credit/i,
  "Visa Debit": /visa\s*debit/i,
});

/**
 * BR08, added 17-Sep-2026. The guide now NAMES the dummy card numbers, and
 * step 6 says to raise each card through the form's "Add" button rather than
 * picking one of the cards already sitting in `#receiptcreditCard`.
 *
 * Those existing entries are NOT these numbers — measured 16-Sep-2026:
 *   #receiptcreditCard offered 520000….5957 / 518868….0008 / 411111….1111 /
 *   404137….6459, none of which is a BR08 value.
 * So the two are different cards, and the guide's instruction wins. Selecting
 * a lookalike from the dropdown would file receipts against a card RAA did not
 * nominate.
 *
 * Source of truth is fixtures/dummy-cards.json; this is the allow-list that
 * says those four numbers are the only ones this repo may ever hold.
 */
const BR08_CARDS = Object.freeze({
  "Visa Credit": "4242424242424242",
  "Visa Debit": "4400000000000008",
  "Mastercard Credit": "5454545454545454",
  "Mastercard Debit": "5555555555554444",
});

/** "Visa Credit" -> "Credit". The form auto-populates this; we assert it. */
function subTypeOf(choice) {
  return /debit/i.test(choice) ? "Debit" : "Credit";
}

/** "Visa Credit" -> "Visa". */
function brandOf(choice) {
  return /^master/i.test(choice) ? "Mastercard" : "Visa";
}

/**
 * Step 6: "Expiry Date to be added is always Dec of the current year. E.g.
 * 12/26 for this year, then when it's Jan 2027, it should be entered as
 * 12/27."
 *
 * So it is not a fixed string and not today+n months — it is December of
 * whatever year it is when the receipt is raised. Hard-coding "12/26" works
 * until 1 January and then quietly files expired cards.
 */
function expiryForDate(when = new Date()) {
  const yy = String(when.getFullYear()).slice(-2);
  return "12/" + yy;
}

/** "  visa  debit " -> "Visa Debit"; "Mastercard" -> "Mastercard" (brand only). */
function normaliseCardChoice(t) {
  const s = String(t || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!s) return "";
  const brand = /^master/.test(s) ? "Mastercard" : /^visa/.test(s) ? "Visa" : null;
  if (!brand) return String(t || "").trim();
  if (/\bdebit\b/.test(s)) return brand + " Debit";
  if (/\bcredit\b/.test(s)) return brand + " Credit";
  return brand; // brand only — BR02 says stop and ask
}

/** The two choices a bare brand leaves open. */
function choicesForBrand(brand) {
  return Object.keys(CARD_LABELS).filter((k) => k.startsWith(brand + " "));
}

/** Find an existing card in `#receiptcreditCard`, for the dropdown path. */
function matchCardOption(choice, options = []) {
  const re = CARD_LABELS[choice];
  if (!re) return null;
  return options.find((o) => re.test(String(o.label || ""))) || null;
}

/* ------------------------------------------- the never-taken path, guarded */

/*
 * Everything below exists for the "Add credit card" button, which this flow
 * does NOT use — RAA's dummies are already in Tramada's dropdown. It is kept
 * because the button is right there on the form, and the day somebody wires it
 * up under deadline, a typed card number should hit a refusal rather than a
 * text field.
 */

/** Publicly documented test card numbers — they belong to no cardholder. */
const PUBLIC_TEST_CARDS = Object.freeze({
  "4242424242424242": "Stripe test Visa",
  "4111111111111111": "classic test Visa",
  "5555555555554444": "classic test Mastercard",
  "5105105105105100": "classic test Mastercard",
  "4000056655665556": "Stripe test Visa debit",
});

function publicTestCardName(number) {
  return PUBLIC_TEST_CARDS[digitsOf(number)] || null;
}

/** Digits only, so "4111 1111-1111 1111" and "4111111111111111" compare equal. */
const digitsOf = (n) => String(n == null ? "" : n).replace(/\D/g, "");

/** Luhn. A live PAN passes; most made-up strings do not. */
function passesLuhn(number) {
  const d = digitsOf(number);
  if (d.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let x = d.charCodeAt(i) - 48;
    if (dbl) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * BR04, enforced rather than trusted.
 *
 * A number that is not one of the configured dummy cards AND passes Luhn is
 * treated as a live PAN and refused. Getting this wrong in the permissive
 * direction means a customer's card number reaches Tramada, so the check errs
 * the other way: an unrecognised number is refused even when it is harmless.
 *
 * `dummies` is the registry; pass the result of loadDummyCards().
 */
/**
 * The optional local registry, for the Add-card path only. Empty by default,
 * and nothing in the IPSI flow reads it.
 */
function loadDummyCards(env = process.env) {
  const out = {};
  let fromFile = {};
  try {
    fromFile = require("./fixtures/dummy-cards.json");
  } catch {
    fromFile = {};
  }
  for (const [type, number] of Object.entries(fromFile)) {
    // Keys beginning with "_" are notes, not card types. Without this the
    // file's own _comment became an entry — and assertNotRealCard compares
    // against every registry VALUE, so a note with digits could have waved a
    // card through.
    if (type.startsWith("_")) continue;
    if (number) out[normaliseCardChoice(type)] = String(number);
  }
  // DUMMY_CARD_VISA_CREDIT, DUMMY_CARD_MASTERCARD_DEBIT, …
  for (const choice of Object.keys(BR08_CARDS)) {
    const v = env["DUMMY_CARD_" + choice.toUpperCase().replace(/ /g, "_")];
    if (v) out[choice] = String(v);
  }
  return out;
}

function normaliseCardType(t) {
  const s = String(t || "").trim().toLowerCase();
  if (s.startsWith("master")) return "Mastercard";
  if (s.startsWith("visa")) return "Visa";
  return String(t || "").trim();
}

function assertNotRealCard(number, dummies) {
  const d = digitsOf(number);
  if (!d) throw new Error("No card number given.");

  const known = Object.values(dummies || {}).map(digitsOf).filter(Boolean);
  if (known.includes(d)) return;

  if (passesLuhn(d)) {
    const e = new Error(
      "Refusing this card number: it is not one of the configured RAA dummy " +
        "cards and it passes a Luhn check, so it may be a live card. " +
        "BR04 — RAA never enters a customer's real card number in Tramada. " +
        "CLAUDE.md §4."
    );
    e.code = "LOOKS_LIKE_REAL_CARD";
    throw e;
  }

  const e = new Error(
    "Refusing this card number: it is not one of the configured RAA dummy cards. " +
      "Add it to fixtures/dummy-cards.json or DUMMY_CARD_<TYPE>."
  );
  e.code = "UNKNOWN_CARD";
  throw e;
}

/* ------------------------------------------------------- the decision */

/**
 * Turn an IPSI "Approved" page plus a confirmed payer name into the exact
 * values the Tramada swipe receipt form needs — or a refusal saying what is
 * missing and who has to supply it.
 *
 * `ipsi` is what the consultant reads off the IPSI Approved screen (step 1):
 *   { bookingNo, txnRef, cardholderName, amount, cardType }
 *
 * `payerName` is BR01/BR05: the person actually paying, confirmed by a human.
 * It is NOT taken from the booking and NOT left as the dummy card's own name.
 */
function decideSwipeReceipt(ipsi = {}, payerName, opts = {}) {
  const { cards = loadDummyCards(), now = new Date() } = opts;

  const missing = [];
  if (!ipsi.bookingNo) missing.push("booking number");
  if (!ipsi.txnRef) missing.push("IPSI transaction reference number");
  if (ipsi.amount == null || ipsi.amount === "") missing.push("amount");
  if (!ipsi.cardType) missing.push("card type (BR02 — confirm with the customer)");
  if (!payerName || !String(payerName).trim()) {
    missing.push("payer name (BR01 — confirm who is actually paying)");
  }

  if (missing.length) {
    return {
      ok: false,
      reason:
        "Stopping before the receipt — missing " +
        missing.join(", ") +
        ". A human supplies these; the run does not guess them.",
      missing,
    };
  }

  const choice = normaliseCardChoice(ipsi.cardType);

  // BR02: a bare brand leaves two cards open. Ask, do not pick.
  if (choice === "Mastercard" || choice === "Visa") {
    const options = choicesForBrand(choice);
    return {
      ok: false,
      reason:
        `"${choice}" alone does not identify a card — BR08 lists a ${options.join(" and a ")}. ` +
        "BR02 says confirm the card type with the customer before populating it.",
      missing: ["credit or debit"],
      choices: options,
    };
  }

  if (!CARD_LABELS[choice]) {
    return {
      ok: false,
      reason:
        `Unrecognised card type "${ipsi.cardType}". BR08 names exactly: ` +
        Object.keys(BR08_CARDS).join(", ") + ".",
      missing: ["a recognised card type"],
      choices: Object.keys(BR08_CARDS),
    };
  }

  const number = cards[choice];
  if (!number) {
    return {
      ok: false,
      reason:
        `No dummy card configured for ${choice}. BR08 names one; ` +
        "add it to fixtures/dummy-cards.json.",
      missing: ["dummy card for " + choice],
    };
  }

  // BR04, enforced rather than trusted: this must be a nominated dummy.
  assertNotRealCard(number, cards);

  // And it must be the RIGHT dummy — a registry edited to point "Visa Credit"
  // at the Mastercard number would otherwise sail through.
  if (BR08_CARDS[choice] && digitsOf(number) !== BR08_CARDS[choice]) {
    return {
      ok: false,
      reason:
        `The configured ${choice} number does not match BR08. ` +
        "fixtures/dummy-cards.json has been edited away from the guide.",
      missing: ["the BR08 number for " + choice],
    };
  }

  return {
    ok: true,
    warning: null,
    bookingNo: String(ipsi.bookingNo),
    receipt: {
      transactionType: SWIPE_FIXED.transactionType,
      bankAccount: SWIPE_FIXED.bankAccount,
      receivedFrom: SWIPE_FIXED.receivedFrom,
      // BR05: the actual payer, never the dummy card's default holder.
      payerName: String(payerName).trim(),
      amount: ipsi.amount,
      // The IPSI reference goes in verbatim. The "RRC - " prefix is a DVC rule
      // (BR11 of the other guide); adding it here breaks reconciliation, which
      // matches on the bare IPSI reference.
      reference: String(ipsi.txnRef).trim(),
      // Step 6 — raised through the form's "Add" button, not chosen from the
      // cards already in #receiptcreditCard. See the note on BR08_CARDS.
      card: {
        category: SWIPE_FIXED.cardCategory, // "Personal"
        number,
        choice,                              // "Visa Credit"
        type: brandOf(choice),               // auto-populates; asserted
        subType: subTypeOf(choice),          // auto-populates; asserted
        holder: String(payerName).trim(),    // BR05
        expiry: expiryForDate(now),          // always December of this year
      },
    },
  };
}

module.exports = {
  SWIPE_FIXED,
  SWIPE_SELECTORS,
  CARD_LABELS,
  BR08_CARDS,
  subTypeOf,
  brandOf,
  expiryForDate,
  normaliseCardChoice,
  choicesForBrand,
  matchCardOption,
  PUBLIC_TEST_CARDS,
  publicTestCardName,
  loadDummyCards,
  normaliseCardType,
  passesLuhn,
  assertNotRealCard,
  decideSwipeReceipt,
};

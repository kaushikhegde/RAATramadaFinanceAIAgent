"use strict";

/**
 * The IPSI payment as a conversation. The guide asks for three behaviours and
 * each is a section below:
 *   - stop when something is missing, rather than continuing regardless
 *   - a human-in-the-loop confirmation before anything is written
 *   - a log of the steps taken, for audit
 */

const assert = require("assert");
const chat = require("../payments-chat");
const core = require("../payments-core");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

// What the IPSI Approved screen looks like when a consultant pastes it.
const APPROVED = `
IPSI Tramada Secure Payment Page
APPROVED
Booking Number: 13061
IPSI Transaction Reference Number: 1792412290cXt4Z
Cardholder Name: Isaac Gates
Amount: $1,289.00
`;

/* ------------------------------------------------------------- parsing */

check("parses all four fields off the Approved screen", () => {
  const p = chat.parseApproval(APPROVED);
  assert.strictEqual(p.bookingNo, "13061");
  assert.strictEqual(p.txnRef, "1792412290cXt4Z");
  assert.strictEqual(p.cardholderName, "Isaac Gates");
  assert.strictEqual(p.amount, "1289.00");
});

check("strips the thousands comma from the amount", () => {
  assert.strictEqual(chat.parseApproval("Amount: $12,345.67").amount, "12345.67");
});

check("survives loose spacing and no colons", () => {
  const p = chat.parseApproval("Booking No 13061\nReference - ABC123XYZ\nAmount 99.50");
  assert.strictEqual(p.bookingNo, "13061");
  assert.strictEqual(p.txnRef, "ABC123XYZ");
  assert.strictEqual(p.amount, "99.50");
});

check("a brand seen in the text is noted but NEVER treated as confirmed", () => {
  // BR02: brand alone does not say credit or debit, and it has to be confirmed
  // with the customer regardless.
  const p = chat.parseApproval(APPROVED + "\nCard: Mastercard");
  assert.strictEqual(p.brandSeen, "Mastercard");
  assert.strictEqual(p.cardType, undefined, "a brand was promoted to a confirmed card type");
});

check("nothing is invented from an empty paste", () => {
  assert.deepStrictEqual(chat.parseApproval(""), {});
});

/* ---------------------------------------------- stopping, not continuing */

check("a blank start asks for the booking number first", () => {
  const r = chat.startIpsiPayment("");
  assert.strictEqual(r.step, chat.STEP.COLLECT);
  assert.strictEqual(r.awaiting, "bookingNo");
});

check("a missing reference is asked for, not skipped", () => {
  const r = chat.startIpsiPayment(APPROVED.replace(/IPSI Transaction Reference Number: \S+/, ""));
  assert.strictEqual(r.awaiting, "txnRef");
  assert.ok(/reference/i.test(r.message), r.message);
});

check("a missing field can be answered with just the value", () => {
  let r = chat.startIpsiPayment("Booking Number: 13061\nAmount: $50.00\nCardholder Name: Isaac Gates");
  assert.strictEqual(r.awaiting, "txnRef");
  r = chat.replyIpsiPayment(r.session, "1792412290cXt4Z");
  assert.strictEqual(r.session.ipsi.txnRef, "1792412290cXt4Z");
  assert.strictEqual(r.step, chat.STEP.CARD);
});

check("a missing field can also be answered by re-pasting the screen", () => {
  let r = chat.startIpsiPayment("Booking Number: 13061");
  r = chat.replyIpsiPayment(r.session, APPROVED);
  assert.strictEqual(r.session.ipsi.txnRef, "1792412290cXt4Z");
  assert.strictEqual(r.session.ipsi.amount, "1289.00");
});

/* ------------------------------------------------------------- BR02 */

check("it always asks which card, even when the brand was on screen", () => {
  const r = chat.startIpsiPayment(APPROVED + "\nCard: Visa");
  assert.strictEqual(r.step, chat.STEP.CARD);
  assert.ok(/Visa Credit or Visa Debit/i.test(r.message), r.message);
  assert.deepStrictEqual(r.choices, Object.keys(core.BR08_CARDS));
});

check("answering with a bare brand asks again rather than picking", () => {
  let r = chat.startIpsiPayment(APPROVED);
  r = chat.replyIpsiPayment(r.session, "Visa");
  assert.strictEqual(r.step, chat.STEP.CARD, "a bare brand was accepted");
  assert.ok(/credit or debit/i.test(r.message), r.message);
});

check("an unusable answer lists the four valid cards", () => {
  let r = chat.startIpsiPayment(APPROVED);
  r = chat.replyIpsiPayment(r.session, "amex");
  assert.strictEqual(r.step, chat.STEP.CARD);
  assert.ok(/Visa Credit/.test(r.message) && /Mastercard Debit/.test(r.message), r.message);
});

/* --------------------------------------------------------- BR01 / BR05 */

check("it asks who is actually paying, offering the cardholder", () => {
  let r = chat.startIpsiPayment(APPROVED);
  r = chat.replyIpsiPayment(r.session, "Visa Credit");
  assert.strictEqual(r.step, chat.STEP.PAYER);
  assert.strictEqual(r.suggestion, "Isaac Gates");
});

check('"yes" means the cardholder is the payer', () => {
  let r = chat.startIpsiPayment(APPROVED);
  r = chat.replyIpsiPayment(r.session, "Visa Credit");
  r = chat.replyIpsiPayment(r.session, "yes");
  assert.strictEqual(r.decision.receipt.payerName, "Isaac Gates");
});

check("a different name replaces the cardholder everywhere", () => {
  let r = chat.startIpsiPayment(APPROVED);
  r = chat.replyIpsiPayment(r.session, "Mastercard Debit");
  r = chat.replyIpsiPayment(r.session, "Megan Gray");
  assert.strictEqual(r.decision.receipt.payerName, "Megan Gray");
  assert.strictEqual(r.decision.receipt.card.holder, "Megan Gray", "BR05 — the card holder was left as the cardholder");
});

/* ------------------------------------------- human-in-the-loop, and only then */

const runToConfirm = () => {
  let r = chat.startIpsiPayment(APPROVED, { now: new Date("2026-09-17") });
  r = chat.replyIpsiPayment(r.session, "Visa Credit");
  r = chat.replyIpsiPayment(r.session, "yes");
  return r;
};

check("it stops at a confirmation and is NOT ready", () => {
  const r = runToConfirm();
  assert.strictEqual(r.step, chat.STEP.CONFIRM);
  assert.ok(!r.ready, "it went ready without a human saying so");
});

check("the summary shows every value that will be written", () => {
  const m = runToConfirm().message;
  for (const bit of [
    "13061", "Credit Card Swipe", "[TRUST] Trust Account",
    "RAA of SA Limited (Retail)", "Visa Credit", "4242424242424242",
    "12/26", "Isaac Gates", "1289.00", "1792412290cXt4Z",
  ]) {
    assert.ok(m.includes(bit), "the confirmation never showed " + bit + "\n" + m);
  }
});

check("only an explicit yes makes it ready", () => {
  const r = chat.replyIpsiPayment(runToConfirm().session, "yes");
  assert.strictEqual(r.step, chat.STEP.READY);
  assert.strictEqual(r.ready, true);
  assert.ok(r.decision.ok);
});

check("an ambiguous answer at the confirmation issues nothing", () => {
  const r = chat.replyIpsiPayment(runToConfirm().session, "maybe");
  assert.strictEqual(r.step, chat.STEP.CONFIRM);
  assert.ok(!r.ready);
});

check("no cancels, and says nothing was written", () => {
  const r = chat.replyIpsiPayment(runToConfirm().session, "no");
  assert.strictEqual(r.step, chat.STEP.CANCELLED);
  assert.ok(!r.ready);
  assert.ok(/nothing was written/i.test(r.message), r.message);
});

check("a finished session cannot be re-confirmed into a second receipt", () => {
  // `!ready` alone does not prove this: without the terminal-state guard the
  // session falls back to CONFIRM and sits there offering to issue again,
  // which is a second receipt one "yes" away. So pin the STEP too.
  const done = chat.replyIpsiPayment(runToConfirm().session, "yes");
  assert.strictEqual(done.step, chat.STEP.READY);
  const again = chat.replyIpsiPayment(done.session, "yes");
  assert.ok(!again.ready, "it went ready a second time");
  assert.strictEqual(again.step, chat.STEP.READY, "a finished session reopened at " + again.step);
});

check("a cancelled session cannot be revived by saying yes", () => {
  const cancelled = chat.replyIpsiPayment(runToConfirm().session, "no");
  assert.strictEqual(cancelled.step, chat.STEP.CANCELLED);
  const again = chat.replyIpsiPayment(cancelled.session, "yes");
  assert.ok(!again.ready, "a cancelled receipt was issued after all");
  assert.strictEqual(again.step, chat.STEP.CANCELLED, "a cancelled session reopened at " + again.step);
});

/* --------------------------------------------------------------- audit */

check("every step is logged, including what was parsed", () => {
  const r = runToConfirm();
  assert.ok(r.session.log.length >= 4, "log is too short: " + r.session.log.length);
  assert.ok(r.session.log[0].parsed, "the parse was not logged");
  assert.ok(r.session.log.every((e) => e.at), "a log entry has no timestamp");
});

check("the user's own answers are in the log", () => {
  const r = runToConfirm();
  const theirs = r.session.log.filter((e) => e.from === "user").map((e) => e.text);
  assert.deepStrictEqual(theirs, ["Visa Credit", "yes"]);
});

/* ------------------------------------------- the whole thing, end to end */

check("a full conversation produces the same decision as the core", () => {
  const r = chat.replyIpsiPayment(runToConfirm().session, "yes");
  const direct = core.decideSwipeReceipt(
    { bookingNo: "13061", txnRef: "1792412290cXt4Z", amount: "1289.00", cardType: "Visa Credit" },
    "Isaac Gates",
    { now: new Date("2026-09-17") }
  );
  assert.deepStrictEqual(r.decision.receipt, direct.receipt);
});

console.log("\n" + n + " assertions passed.");

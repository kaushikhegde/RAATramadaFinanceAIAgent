"use strict";

/**
 * payments-chat.js — the IPSI customer payment, as a conversation.
 *
 * Pure. No browser, no network, no Tramada. Give it what the consultant pasted
 * and it says what it still needs; give it their answer and it says what it
 * needs next. When it has everything it hands back the same decision
 * `payments-core.decideSwipeReceipt` would have made, and the caller drives
 * Tramada with it.
 *
 * This shape comes straight out of the guide's "Other features":
 *
 *   "Ability for the AI Agent to flag/stop when required information (e.g.
 *    reference number) is missing, rather than letting the process continue
 *    regardless."
 *   "AI Agent needs to stop for human-in-the-loop check to confirm Tramada
 *    receipt details, add in customer name before receipting."
 *   "Ability to log and show the steps the AI Agent has taken to prepare the
 *    receipt, for auditing purposes."
 *
 * So: it never guesses a missing field, it always ends on a confirmation the
 * human has to give, and every step is appended to `session.log`.
 */

const core = require("./payments-core");

/* ------------------------------------------------------------- parsing */

/*
 * The IPSI "Approved" screen carries four things (step 1): booking number,
 * IPSI transaction reference number, cardholder name, amount. Consultants
 * paste it, retype it, or send a photo's OCR — so match on the LABEL and
 * accept loose spacing, colons and newlines, rather than fixed line numbers.
 *
 * Nothing here infers a value it cannot see. A field that does not match is
 * left undefined and becomes a question.
 */
const PATTERNS = {
  bookingNo: [
    /booking\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{4,10})\b/i,
    /\bbooking\b[^\d]{0,20}(\d{4,10})\b/i,
  ],
  txnRef: [
    /(?:ipsi\s*)?(?:transaction|txn)\s*(?:reference|ref)(?:erence)?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9\-_]{6,40})/i,
    /\bref(?:erence)?\s*[:\-]\s*([A-Za-z0-9\-_]{6,40})/i,
  ],
  cardholderName: [
    /card\s*holder(?:\s*name)?\s*[:\-]?\s*([A-Za-z][A-Za-z '\-\.]{1,60}?)\s*(?:\n|$|amount|booking)/i,
  ],
  amount: [
    /amount\s*(?:received|paid)?\s*[:\-]?\s*(?:AUD?\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /\$\s*([\d,]+\.\d{2})/,
  ],
};

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

/** Pull what the Approved screen shows. Anything absent stays absent. */
function parseApproval(text = "") {
  const t = String(text);
  const out = {};
  for (const [field, pats] of Object.entries(PATTERNS)) {
    const v = firstMatch(t, pats);
    if (v !== undefined) out[field] = v;
  }
  if (out.amount) out.amount = out.amount.replace(/,/g, "");

  // A card BRAND may be mentioned in passing. Note it, but never promote it to
  // a confirmed card type — BR02 wants that confirmed with the customer, and
  // brand alone does not say credit or debit anyway.
  const brand = /\bmaster\s*card\b|\bmastercard\b/i.test(t)
    ? "Mastercard"
    : /\bvisa\b/i.test(t)
    ? "Visa"
    : null;
  if (brand) out.brandSeen = brand;

  return out;
}

/* ------------------------------------------------------- the conversation */

const STEP = Object.freeze({
  COLLECT: "collect",   // still missing something from the Approved screen
  CARD: "card",         // BR02 — credit or debit
  PAYER: "payer",       // BR01/BR05 — who is actually paying
  CONFIRM: "confirm",   // human-in-the-loop, before anything is written
  READY: "ready",       // confirmed; the caller may now drive Tramada
  CANCELLED: "cancelled",
});

const FIELD_PROMPTS = {
  bookingNo: "What is the booking number?",
  txnRef: "What is the IPSI transaction reference number?",
  amount: "What amount was approved? (e.g. 1289.00)",
  cardholderName: "What name is on the card?",
};

const say = (session, text, meta) => {
  session.log.push({ at: new Date().toISOString(), text, ...(meta || {}) });
  return text;
};

function startIpsiPayment(pastedText = "", opts = {}) {
  const session = {
    step: STEP.COLLECT,
    ipsi: parseApproval(pastedText),
    payerName: null,
    log: [],
    opts: { now: opts.now || new Date() },
  };
  session.log.push({
    at: new Date().toISOString(),
    text: "Read the IPSI approval.",
    parsed: { ...session.ipsi },
  });
  return advance(session);
}

/** What is still unknown, in the order the guide asks for it. */
function stillMissing(session) {
  return ["bookingNo", "txnRef", "amount", "cardholderName"].filter(
    (f) => !session.ipsi[f]
  );
}

function advance(session) {
  const missing = stillMissing(session);
  if (missing.length) {
    session.step = STEP.COLLECT;
    session.awaiting = missing[0];
    return {
      session,
      step: session.step,
      awaiting: session.awaiting,
      message: say(
        session,
        "I could not read " +
          missing.map((f) => FIELD_PROMPTS[f].replace(/^What (is|amount) /, "").replace(/\?$/, "")).join(", ") +
          " from that. " +
          FIELD_PROMPTS[missing[0]]
      ),
    };
  }

  if (!session.ipsi.cardType) {
    session.step = STEP.CARD;
    session.awaiting = "cardType";
    const hint = session.ipsi.brandSeen
      ? ` It looks like a ${session.ipsi.brandSeen} — is it ${session.ipsi.brandSeen} Credit or ${session.ipsi.brandSeen} Debit?`
      : "";
    return {
      session,
      step: session.step,
      awaiting: "cardType",
      choices: Object.keys(core.BR08_CARDS),
      message: say(
        session,
        "Which card did the customer pay with?" + hint +
          " (BR02 — this needs confirming with them, I can't infer it.)"
      ),
    };
  }

  if (!session.payerName) {
    session.step = STEP.PAYER;
    session.awaiting = "payerName";
    return {
      session,
      step: session.step,
      awaiting: "payerName",
      suggestion: session.ipsi.cardholderName || null,
      message: say(
        session,
        `Who is actually paying? The card shows "${session.ipsi.cardholderName}". ` +
          "If that is the payer, say yes; if someone else paid, give their first and last name. " +
          "(BR01)"
      ),
    };
  }

  // Everything known — build the decision and show it for confirmation.
  const decision = core.decideSwipeReceipt(session.ipsi, session.payerName, {
    now: session.opts.now,
  });

  if (!decision.ok) {
    session.step = STEP.COLLECT;
    session.awaiting = null;
    return {
      session,
      step: session.step,
      blocked: true,
      message: say(session, decision.reason, { decision }),
    };
  }

  session.decision = decision;
  session.step = STEP.CONFIRM;
  session.awaiting = "confirm";
  return {
    session,
    step: session.step,
    awaiting: "confirm",
    decision,
    message: say(session, summarise(decision), { decision }),
  };
}

/** The human-in-the-loop check. Everything that will be written, in one block. */
function summarise(d) {
  const r = d.receipt;
  return [
    `Booking ${d.bookingNo} — ready to issue:`,
    `  Transaction type   ${r.transactionType}`,
    `  Bank account       ${r.bankAccount}`,
    `  Received from      ${r.receivedFrom}`,
    `  Card               ${r.card.choice} (dummy ${r.card.number}, exp ${r.card.expiry})`,
    `  Card holder        ${r.card.holder}`,
    `  Payer name         ${r.payerName}`,
    `  Amount received    ${r.amount}`,
    `  Reference          ${r.reference}`,
    "",
    "Issue this receipt? (yes / no)",
  ].join("\n");
}

const YES = /^(y|yes|yep|yeah|ok|okay|correct|confirm|go|do it|issue)\b/i;
const NO = /^(n|no|nope|cancel|stop|abort|wait)\b/i;

function replyIpsiPayment(session, userText = "") {
  const text = String(userText).trim();
  session.log.push({ at: new Date().toISOString(), from: "user", text });

  if (session.step === STEP.READY || session.step === STEP.CANCELLED) {
    return { session, step: session.step, message: say(session, "This one is already finished.") };
  }

  if (NO.test(text) && session.step === STEP.CONFIRM) {
    session.step = STEP.CANCELLED;
    session.awaiting = null;
    return {
      session,
      step: session.step,
      message: say(session, "Cancelled. Nothing was written to Tramada."),
    };
  }

  switch (session.step) {
    case STEP.COLLECT: {
      const field = session.awaiting;
      if (!text) break;
      // Let a consultant paste the whole screen again instead of one value.
      const reparsed = parseApproval(text);
      let took = false;
      for (const [k, v] of Object.entries(reparsed)) {
        if (!session.ipsi[k] && v) {
          session.ipsi[k] = v;
          took = true;
        }
      }
      if (!took && field) session.ipsi[field] = field === "amount" ? text.replace(/[^\d.]/g, "") : text;
      break;
    }

    case STEP.CARD: {
      const choice = core.normaliseCardChoice(text);
      if (!core.BR08_CARDS[choice]) {
        return {
          session,
          step: session.step,
          awaiting: "cardType",
          choices: Object.keys(core.BR08_CARDS),
          message: say(
            session,
            choice === "Mastercard" || choice === "Visa"
              ? `${choice} — credit or debit?`
              : "I need one of: " + Object.keys(core.BR08_CARDS).join(", ") + "."
          ),
        };
      }
      session.ipsi.cardType = choice;
      break;
    }

    case STEP.PAYER: {
      // "yes" means the cardholder is the payer. Anything else is the payer.
      session.payerName = YES.test(text) ? session.ipsi.cardholderName : text;
      if (!session.payerName || !String(session.payerName).trim()) session.payerName = null;
      break;
    }

    case STEP.CONFIRM: {
      if (!YES.test(text)) {
        return {
          session,
          step: session.step,
          awaiting: "confirm",
          decision: session.decision,
          message: say(session, "Say yes to issue it, or no to cancel."),
        };
      }
      session.step = STEP.READY;
      session.awaiting = null;
      return {
        session,
        step: session.step,
        decision: session.decision,
        ready: true,
        message: say(session, "Confirmed. Issuing the receipt in Tramada."),
      };
    }
  }

  return advance(session);
}

module.exports = {
  STEP,
  parseApproval,
  startIpsiPayment,
  replyIpsiPayment,
  summarise,
};

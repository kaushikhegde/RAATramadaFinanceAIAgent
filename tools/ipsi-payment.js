#!/usr/bin/env node
/**
 * ipsi-payment.js — raise one IPSI customer-payment receipt from the command
 * line, without the chat UI.
 *
 * "Payments Guide - IPSI.docx" steps 2-9. Step 1 (charging the card in IPSI)
 * is a human's job and always will be — BR07.
 *
 *   node tools/ipsi-payment.js \
 *     --booking 13061 \
 *     --ref 1792412290cXt4Z \
 *     --amount 100.00 \
 *     --card "Visa Credit" \
 *     --payer "Isaac Gates"
 *
 * Or do a whole settlement file in one command — no typing, the booking
 * numbers come from the file:
 *
 *   npm run ipsi:pay -- --from csv_uploads/ipsi-payments.csv --card "Visa Credit" --issue
 *
 * With no flags it just asks:
 *
 *   npm run ipsi:pay
 *
 *   --dry            work out what would be entered and stop
 *   --issue          skip the final confirmation and raise it
 *   --yes            same as --issue
 *   --paste FILE     read the IPSI Approved screen from a file instead of
 *                    passing --booking/--ref/--amount by hand
 *
 * It refuses rather than guesses. No card type, no payer name, no reference —
 * it stops and says which, exactly as the chat flow does, because both go
 * through the same payments-core decision.
 *
 * Needs a Chrome on CDP 9222 signed into Tramada (npm run start:chrome) only
 * when --issue is given. A dry run touches nothing.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("../payments-core");
const chat = require("../payments-chat");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

if (has("--help") || has("-h")) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
  process.exit(0);
}

const ISSUE = has("--issue") || has("--yes");
const DRY = has("--dry");
/* --dry means "do not write to Tramada", not "do not talk to me": it should
   still ask for what it needs, then stop before issuing. Tying the two together
   made `--dry` at a terminal refuse for missing fields it could simply have
   asked for. */
const INTERACTIVE = !!process.stdin.isTTY;

/* ------------------------------------------------------------- prompting */

/*
 * readline would do, but it owns stdin for the life of the process and this
 * one later hands stdin to nothing at all — so a plain /dev/tty read keeps the
 * prompts independent of anything Playwright does afterwards. Same approach as
 * tools/mastercard-ping.js.
 */
function askLine(question) {
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null; // no terminal — caller falls back to the flag-missing error
  }
  fs.writeSync(fd, question);
  let out = "";
  const buf = Buffer.alloc(1);
  try {
    while (fs.readSync(fd, buf, 0, 1, null) === 1) {
      const c = buf.toString("utf8");
      if (c === "\n" || c === "\r") break;
      if (c === "\u0003") { fs.writeSync(fd, "\n"); process.exit(130); }
      if (c === "\u007f" || c === "\b") { out = out.slice(0, -1); continue; }
      out += c;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out.trim();
}

/** A numbered menu. Returns the chosen option, or null with no terminal. */
function askChoice(question, options) {
  if (!process.stdin.isTTY) return null;
  console.log("\n" + question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const a = askLine("Choose 1-" + options.length + ": ");
    if (a === null) return null;
    const n = parseInt(a, 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
    // Typing the name works too — nobody should have to count.
    const byName = options.find((o) => o.toLowerCase() === a.toLowerCase());
    if (byName) return byName;
    console.log("  Not one of those.");
  }
}

/* ------------------------------------------------- driving Tramada once */

const { runTramadaReceipt } = require("../tramada-receipt");

/*
 * WHICH RECEIPT CATEGORY.
 *
 * The guide says "Issue Debtor Payment Receipt". Tramada only offers that on a
 * booking whose ACCOUNT TYPE is corporate; a RETAIL booking offers the Client
 * variants instead and has no debtor to receipt against. Measured 18-Sep-2026:
 * bookings 14504, 14510 and 14516 all came back
 *
 *   Booking 14504 does not offer "DEBTOR_PAYMENT_RECEIPT" — no receipt raised.
 *
 * and the batch reported them as OK, which they were not.
 *
 * A customer paying their own retail booking is exactly what a Client Payment
 * Receipt is for, so falling back is right — but it is a change of document
 * type, so it is announced every time rather than done quietly.
 */
const CATEGORY_ORDER = ["DEBTOR_PAYMENT_RECEIPT", "CLIENT_PAYMENT_RECEIPT"];

/** Steps 2-9, trying each category the guide allows in order. */
async function issueWithCategory(decision, quiet = false) {
  let last = null;
  for (const category of CATEGORY_ORDER) {
    const out = await issueOne(decision, quiet, category);
    if (out && out.receipt && out.receipt.receiptNo) {
      // Only say a different receipt type was RAISED when one actually was;
      // on an already-filed booking nothing was raised at all.
      if (category !== CATEGORY_ORDER[0] && out.committed === true) {
        console.log(
          `        note: this booking does not offer a Debtor Payment Receipt, ` +
            `so a ${category.replace(/_/g, " ").toLowerCase()} was raised instead.`
        );
      }
      return out;
    }
    last = out;
    // Only a category problem is worth retrying — anything else stands.
    if (!out || !out.skipped || out.reason !== "receipt category unavailable") return out;
  }
  return last;
}

/** Steps 2-9 for one decided receipt. Returns runTramadaReceipt's result. */
function issueOne(decision, quiet = false, receiptCategory = "DEBTOR_PAYMENT_RECEIPT") {
  const r = decision.receipt;
  const log = quiet ? () => {} : (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`);
  return runTramadaReceipt({
    bookingNo: decision.bookingNo,
    receiptCategory, // step 3 — see CATEGORY_ORDER
    receipt: {
      transactionType: r.transactionType, // "Credit Card Swipe" → CS
      /* An IPSI transaction reference is one payment. A second receipt under it
         is always wrong — and matching on reference+amount misses, because
         Tramada's surcharge changes the amount after filing. */
      duplicateOn: "reference",
      /* Step 8 / BR06 — allocate exactly what was received, to the rows the
         form offers. "ALL" would tick every segment at its full due, which on a
         part payment is an allocation Tramada rejects. */
      allocation: (segments, amount) => {
        const plan = core.planAllocation(segments, amount);
        if (!plan.ok) throw new Error(plan.reason);
        log(70, "Allocating " +
          plan.allocation.map((a) => `$${a.amount} to segment ${a.segId}`).join(", ") +
          (plan.exact ? " (exact match)" : ""));
        return plan.allocation;
      },
      payerName: r.payerName,
      amount: r.amount,
      reference: r.reference,
      // Step 6 — added through the form's "Add" button, per BR08.
      card: {
        category: r.card.category,
        number: r.card.number,
        type: r.card.type,
        subType: r.card.subType,
        holder: r.card.holder,
        expiry: r.card.expiry,
        choice: r.card.choice,
        // --add-card forces the guide's "Add" popup; by default a dummy card
        // already in Tramada is used, which needs no popup at all.
        useExistingCard: !has("--add-card"),
      },
    },
    callbacks: {
      onProgress: log,
      onError: (m) => console.error("  ERROR: " + m),
      onNeedLogin: () =>
        console.log("  Sign into Tramada in the Chrome on port 9222 — waiting."),
    },
  });
}

/* ------------------------------------------------------------- batch mode */

/**
 * With no --from and no --booking, find the settlement file itself.
 *
 * "npm run ipsi" is meant to be the whole job in one word: a consultant should
 * not have to know where the file lives or what today's one is called. Newest
 * wins, and the name is printed so nobody is left guessing which file was used.
 */
function findSettlementFile() {
  const dirs = [
    path.join(__dirname, "..", "uploads"),
    path.join(__dirname, "..", "csv_uploads"),
  ];
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const nm of names) {
      if (!/ipsi/i.test(nm) || !/\.csv$/i.test(nm)) continue;
      if (/demo/i.test(nm)) continue; // the demo fixtures are not today's file
      const full = path.join(dir, nm);
      try {
        found.push({ full, mtime: fs.statSync(full).mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].full : null;
}

let fromFile = val("--from");
if (!fromFile && !val("--booking") && !val("--paste")) {
  fromFile = findSettlementFile();
  if (fromFile) {
    console.log("Settlement file: " + path.relative(path.join(__dirname, ".."), fromFile) + "\n");
  }
}

if (fromFile) {
  let text;
  try {
    text = fs.readFileSync(fromFile, "utf8");
  } catch (err) {
    console.error(
      err.code === "ENOENT"
        ? `No such file: ${fromFile}`
        : `Could not read ${fromFile}: ${err.message}`
    );
    process.exit(2);
  }

  const { rows, problems } = core.parseIpsiCsv(text);
  problems.forEach((p) => console.log("  ! " + p));

  if (!rows.length) {
    console.error("\nNothing to receipt in " + fromFile + ".");
    process.exit(2);
  }

  /* BR02 again. The file says "VISA", never credit or debit, so the caller
     states it once for the run — and a row whose brand disagrees is refused
     rather than quietly receipted against the wrong dummy card. */
  let runCard = core.normaliseCardChoice(val("--card", ""));
  if (!core.BR08_CARDS[runCard] && process.stdin.isTTY) {
    /* The file records the BRAND ("VISA"), never credit or debit, and BR02 says
       that is confirmed with the customer. It is the one thing the file cannot
       tell us — so ask once for the whole run rather than refusing outright. */
    const brands = [...new Set(rows.map((r) => r.brand).filter(Boolean))];
    const offer = brands.length === 1 ? core.choicesForBrand(brands[0]) : Object.keys(core.BR08_CARDS);
    runCard = askChoice(
      `The file says ${brands.join(" and ") || "no brand"} but not credit or debit.\n` +
        "Which card did these customers pay with?  (BR02 — confirmed with them)",
      offer
    );
  }
  if (!core.BR08_CARDS[runCard]) {
    console.error(
      "\nThis run needs --card: the settlement file records the brand " +
        '("VISA"), never credit or debit, and BR02 says that is confirmed with ' +
        "the customer.\n  One of: " + Object.keys(core.BR08_CARDS).join(" | ")
    );
    process.exit(2);
  }

  console.log(`\n${rows.length} payment(s) to receipt, all as ${runCard}.\n`);
  rows.forEach((r) =>
    console.log(`    ${r.bookingNo.padEnd(8)} ${r.txnRef.padEnd(18)} $${r.amount.padStart(9)}  ${r.cardholderName}`)
  );

  let goBatch = ISSUE;
  if (!goBatch && !DRY && process.stdin.isTTY) {
    // The guide's human-in-the-loop check, once for the batch.
    const a = askLine(`\nIssue all ${rows.length} receipts in Tramada? (yes / no): `);
    goBatch = /^(y|yes)$/i.test(String(a || ""));
    if (!goBatch) {
      console.log("Cancelled. Nothing was written to Tramada.");
      process.exit(0);
    }
  }
  console.log("");

  (async () => {
    const results = [];
    for (const row of rows) {
      const label = `${row.bookingNo} / ${row.txnRef} / $${row.amount}`;

      if (row.brand && !runCard.startsWith(row.brand)) {
        console.log(`  SKIP  ${label} — the file says ${row.brand}, the run is ${runCard}.`);
        results.push({ row, skipped: "brand mismatch" });
        continue;
      }

      const d = core.decideSwipeReceipt(
        { ...row, cardType: runCard },
        row.cardholderName,
        {}
      );
      if (!d.ok) {
        console.log(`  SKIP  ${label} — ${d.reason}`);
        results.push({ row, skipped: d.reason });
        continue;
      }

      if (!goBatch) {
        console.log(`  DRY   ${label} → ${d.receipt.card.choice}, payer ${d.receipt.payerName}`);
        results.push({ row, dry: true });
        continue;
      }

      console.log(`\n  ── ${label} ──`);
      try {
        const out = await issueWithCategory(d);
        const got = (out && out.receipt) || {};

        /* A run that raised nothing is NOT an OK. runTramadaReceipt returns
           {skipped:true} for a booking whose account type does not offer this
           receipt category, and for one that already has this receipt — both
           came back as "OK issued amount undefined" here, which is the worst
           possible line to print about money that was never receipted. */
        if (!got.receiptNo) {
          const why = out && out.skipped ? out.reason : "no receipt number came back";
          console.log(`  SKIP  ${label} — ${why}` + (out && out.offered ? ` (offered: ${out.offered.join(", ")})` : ""));
          results.push({ row, skipped: why, offered: out && out.offered });
          continue;
        }

        /* "issued" has to mean issued. A receipt that was ALREADY on the
           booking is the duplicate guard working, not this run's work — and
           counting it under "4 issued" is a claim that will not survive being
           checked against Tramada. */
        const isNew = out && out.committed === true;
        console.log(`  ${isNew ? "OK   " : "KEPT "} ${got.receiptNo}  amount ${got.amount}` +
          (isNew ? "" : "  (already on the booking — nothing filed)"));
        const asked = core.centsOf(row.amount);
        const gotC = core.centsOf(got.amount);
        if (asked != null && gotC != null && asked !== gotC) {
          console.log(
            `        \u26a0 asked ${(asked / 100).toFixed(2)}, Tramada recorded ` +
              `${(gotC / 100).toFixed(2)} — card surcharge ${((gotC - asked) / 100).toFixed(2)}`
          );
        }
        results.push({ row, receiptNo: got.receiptNo, amount: got.amount, isNew });
      } catch (err) {
        console.log("  FAIL  " + (err && err.message ? err.message : err));
        results.push({ row, error: String(err && err.message ? err.message : err) });
      }
    }

    const ok = results.filter((r) => r.isNew).length;
    const kept = results.filter((r) => r.receiptNo && !r.isNew).length;
    const failed = results.filter((r) => r.error).length;
    const skipped = results.filter((r) => r.skipped).length;
    console.log(
      `\n${ok} issued, ${kept} already filed, ${failed} failed, ${skipped} skipped, of ${rows.length}.`
    );
    if (skipped) {
      console.log("Skipped rows raised NO receipt — that money is still unreceipted.");
    }
    process.exit(failed || skipped ? 1 : 0);
  })();
} else {

// Either paste the Approved screen, or pass the four values.
let ipsi = {};
const pasteFile = val("--paste");
if (pasteFile) {
  let pasted;
  try {
    pasted = fs.readFileSync(pasteFile, "utf8");
  } catch (err) {
    // A stack trace for "that file isn't there" helps nobody.
    console.error(
      err.code === "ENOENT"
        ? `No such file: ${pasteFile}\n\n` +
          "  --paste wants a file holding the IPSI \u201cApproved\u201d screen. Save it first:\n" +
          "    pbpaste > approved.txt      (macOS, after copying the screen)\n\n" +
          "  Or skip the file and pass the values directly:\n" +
          "    node tools/ipsi-payment.js --booking 13061 --ref <ref> --amount 100.00 \\\n" +
          "      --card \"Visa Credit\" --payer \"Isaac Gates\""
        : `Could not read ${pasteFile}: ${err.message}`
    );
    process.exit(2);
  }
  ipsi = chat.parseApproval(pasted);
  const found = Object.keys(ipsi).filter((k) => k !== "brandSeen");
  if (!found.length) {
    console.error(
      `Read ${pasteFile} but found none of the four fields in it.\n\n` +
        "  Expected lines like:\n" +
        "    Booking Number: 13061\n" +
        "    IPSI Transaction Reference Number: 1792412290cXt4Z\n" +
        "    Cardholder Name: Isaac Gates\n" +
        "    Amount: $100.00"
    );
    process.exit(2);
  }
  console.log("Read from " + pasteFile + ":");
  for (const [k, v] of Object.entries(ipsi)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log("");
}
ipsi = {
  bookingNo: val("--booking", ipsi.bookingNo),
  txnRef: val("--ref", ipsi.txnRef),
  amount: val("--amount", ipsi.amount),
  cardType: val("--card", ipsi.cardType),
  cardholderName: val("--cardholder", ipsi.cardholderName),
};
let payerName = val("--payer", ipsi.cardholderName);

if (INTERACTIVE) {
  if (!ipsi.bookingNo) ipsi.bookingNo = askLine("Booking number: ");
  if (!ipsi.txnRef) ipsi.txnRef = askLine("IPSI transaction reference: ");
  if (!ipsi.amount) ipsi.amount = askLine("Amount approved (e.g. 100.00): ");

  // BR02 — always a deliberate choice, never inferred from a brand.
  if (!ipsi.cardType) {
    ipsi.cardType = askChoice(
      "Which card did the customer pay with?  (BR02 — confirm this with them)",
      Object.keys(core.BR08_CARDS)
    );
  }

  if (!payerName) {
    const who = askLine(
      ipsi.cardholderName
        ? `Who is actually paying? [Enter for "${ipsi.cardholderName}"]: `
        : "Who is actually paying (first and last name)? "
    );
    payerName = who || ipsi.cardholderName;
  }
}

const decision = core.decideSwipeReceipt(ipsi, payerName);

if (!decision.ok) {
  console.error("Not raising this receipt.\n");
  console.error("  " + decision.reason);
  if (decision.choices) console.error("\n  Valid: " + decision.choices.join(" | "));
  console.error("");
  process.exit(2);
}

console.log(chat.summarise(decision).replace(/\nIssue this receipt\?.*$/s, ""));

let go = ISSUE;
if (!go && !DRY && process.stdin.isTTY) {
  // The guide's human-in-the-loop check, on the command line.
  const a = askLine("\nIssue this receipt in Tramada? (yes / no): ");
  go = /^(y|yes)$/i.test(String(a || ""));
  if (!go) {
    console.log("Cancelled. Nothing was written to Tramada.");
    process.exit(0);
  }
}

if (!go) {
  console.log("\nDry run — nothing was written. Add --issue to raise it for real.");
  process.exit(0);
}

/* ---------------------------------------------------------------- issue */

(async () => {
  const r = decision.receipt;
  try {
    const out = await issueWithCategory(decision);
    /* runTramadaReceipt returns the WHOLE run — booking details, itinerary,
       every segment, the staged values and the receipt. The receipt number is
       at `out.receipt.receiptNo`, NOT `out.receiptNo`; reading the wrong key
       meant the fallback fired every time and printed a screenful of JSON with
       the one line anyone wants buried in it. */
    const issued = (out && out.receipt) || {};

    console.log("\n  Receipt        " + (issued.receiptNo || "(no receipt number returned)"));
    console.log("  Type           " + (issued.transType || r.transactionType));
    console.log("  Received from  " + (issued.receivedFrom || r.receivedFrom));
    console.log("  Reference      " + (issued.reference || r.reference));
    console.log("  Date           " + (issued.dateReceived || ""));
    console.log("  Amount         " + (issued.amount != null ? issued.amount : r.amount));
    console.log("  Allocated      " + (issued.allocated != null ? issued.allocated : ""));

    /* Tramada adds a card surcharge without asking (measured 16 and
       18-Sep-2026: 100.00 asked, 100.80 recorded). Say so rather than reporting
       a clean success — IPSI reconciliation matches on amount and will not find
       100.80 for a 100.00 settlement line.

       This read `out.amount`, which does not exist on the returned object, so
       the warning never fired on the very runs it was written for. */
    const asked = Number(String(r.amount).replace(/[^\d.]/g, ""));
    const got = Number(String(issued.amount == null ? "" : issued.amount).replace(/[^\d.]/g, ""));
    if (Number.isFinite(asked) && Number.isFinite(got) && Math.abs(asked - got) > 0.005) {
      console.log(
        `\n  \u26a0 Tramada recorded ${got.toFixed(2)}, not the ${asked.toFixed(2)} asked for ` +
          `\u2014 a card surcharge of ${(got - asked).toFixed(2)} was added.\n` +
          "    Reconciliation matches on amount, so this receipt will not match the\n" +
          "    IPSI settlement line until RAA says which figure is right."
      );
    }

    if (has("--json")) console.log("\n" + JSON.stringify(out, null, 2));
    else console.log("\n  (--json for the full run detail)");

  } catch (err) {
    console.error("\nFailed: " + (err && err.message ? err.message : err));
    process.exit(1);
  }
})();

}


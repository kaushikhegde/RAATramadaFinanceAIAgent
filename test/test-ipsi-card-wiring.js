"use strict";

/**
 * The IPSI card's "raise the receipts" controls, checked in the BUILT page.
 *
 * They were wired only from syncIpsiTotal(), which runs when the NUVEI field
 * changes — so on a fresh load the card-type dropdown did nothing and the
 * button stayed disabled. "Check receipts" looked broken until you happened to
 * retype the NUVEI amount.
 *
 * This reads public/index.html because that is what the browser runs. Checking
 * the source wire file would pass while the built page was stale.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

check("the built page has the raise-receipts block", () => {
  assert.ok(html.includes("Raise the receipts first"), "the block is not in the built page");
  assert.ok(html.includes("ipsiPayCard"), "no card-type dropdown");
  assert.ok(html.includes("ipsiPayPlan"), "no Check receipts button");
});

check("its handlers are attached where the card is BUILT", () => {
  /* Not only from syncIpsiTotal, which runs on a NUVEI keystroke. The controls
     live inside #tileGrid, so they are destroyed and rebuilt on every render
     and have to be re-attached in renderSource — right next to the other
     handlers that are rebuilt the same way.

     Anchor on the NUVEI field's own wiring, which is unmistakably inside
     renderSource, and require wireIpsiPay() near it. */
  const anchor = html.indexOf("nuveiField.oninput");
  assert.ok(anchor > 0, "could not find renderSource's own handler block");
  const near = html.slice(anchor, anchor + 900);
  assert.ok(/wireIpsiPay\(\)/.test(near),
    "wireIpsiPay() is not called in renderSource — the controls will be dead until a NUVEI keystroke");
});

check("the cardholder is read by the name the parser really uses", () => {
  // parseIpsiRows calls it `cardHolder`. Reading `cardHolderName` alone made
  // every row skip with "missing payer name (BR01)".
  assert.ok(/r\.cardHolder \|\|/.test(html),
    "the page does not read r.cardHolder — every row will skip on BR01");
});

check("the chat bubble is gone and stays gone", () => {
  assert.ok(!html.includes("mountPaymentsChat"), "the payments chat is still mounted");
  assert.ok(/askFab[\s\S]{0,200}display = 'none'/.test(html), "the launcher is not hidden");
});

check("Tokio stayed out of the daily SOURCES", () => {
  const m = html.match(/const SOURCES = \{([\s\S]*?)\n  \};/);
  assert.ok(m, "could not find SOURCES in the built page");
  assert.ok(!/tokio/i.test(m[1]),
    "Tokio was added to SOURCES — it would join RUN_ORDER and the BPay-first rule");
});

check("the Tokio card is in the built page", () => {
  for (const bit of ["mountTokio", "/api/tokio/parse", "Reporting month", "tokioMonth"]) {
    assert.ok(html.includes(bit), "missing from the built page: " + bit);
  }
});

console.log("\n" + n + " assertions passed.");

"use strict";

/**
 * chooseReceiptCreditor, without a browser.
 *
 * It threw "This credit-card receipt needs a creditor." on an IPSI receipt that
 * needs no creditor at all — a Debtor Payment Receipt is a customer paying US,
 * and a creditor is who WE pay. The form offers a blank option precisely
 * because none is required; refusing there was stricter than Tramada.
 *
 * The rule now: a blank option means "leave it alone". No blank option means
 * the form really does require one, and that still throws.
 */

const assert = require("assert");
const { chooseReceiptCreditor } = require("../tramada-receipt");

let n = 0;
const acheck = async (what, fn) => { await fn(); n++; console.log("  ok  " + what); };

// What #creditor offered on booking 13061, 18-Sep-2026.
const LIVE = [
  { value: "", label: "" },
  { value: "3", label: "RAA- Fees (RAAFEES)" },
  { value: "89573", label: "Journey Beyond (JBRE) / Great Southern Rail (GSR)" },
];

function fakePage(options, current = "", visible = true) {
  const page = {
    picked: null,
    value: current,
    locator(sel) {
      const api = {
        async evaluateAll(fn) {
          return fn(options.map((o) => ({ value: o.value, textContent: o.label })));
        },
        async inputValue() { return page.value; },
        async count() { return sel === "#creditor" ? 1 : 0; },
        async isVisible() { return visible; },
        first() { return api; },
      };
      return api;
    },
    async selectOption(sel, v) { this.picked = v; },
  };
  return page;
}

(async () => {
  await acheck("a blank option means no creditor is needed", async () => {
    const page = fakePage(LIVE);
    await chooseReceiptCreditor(page, undefined);
    assert.strictEqual(page.picked, null, "it picked " + page.picked + " when none was required");
  });

  await acheck("with no blank option it still refuses, and names the choices", async () => {
    const page = fakePage(LIVE.filter((o) => o.value));
    let threw = null;
    try { await chooseReceiptCreditor(page, undefined); } catch (e) { threw = e; }
    assert.ok(threw, "it went ahead with no creditor on a form that requires one");
    assert.ok(/RAA- Fees/.test(threw.message), threw.message);
    assert.ok(threw.needsCreditor, "the error carries no options for the caller to offer");
  });

  await acheck("a single real option is chosen without asking", async () => {
    const page = fakePage([{ value: "3", label: "RAA- Fees (RAAFEES)" }]);
    await chooseReceiptCreditor(page, undefined);
    assert.strictEqual(page.picked, "3");
  });

  await acheck("a creditor already set is left alone", async () => {
    const page = fakePage(LIVE.filter((o) => o.value), "89573");
    await chooseReceiptCreditor(page, undefined);
    assert.strictEqual(page.picked, null);
  });

  await acheck("a named creditor is matched on its label", async () => {
    const page = fakePage(LIVE);
    await chooseReceiptCreditor(page, "Journey Beyond");
    assert.strictEqual(page.picked, "89573");
  });

  await acheck("a creditor this booking does not have is refused", async () => {
    const page = fakePage(LIVE);
    let threw = null;
    try { await chooseReceiptCreditor(page, "Qantas"); } catch (e) { threw = e; }
    assert.ok(threw && /isn't one of this booking's creditors/.test(threw.message), String(threw));
    assert.strictEqual(page.picked, null);
  });

  await acheck("a hidden creditor field is left alone entirely", async () => {
    // The Client Payment Receipt form carries #creditor but never shows it.
    // Playwright's selectOption waits for visibility, so touching it cost 30
    // seconds per booking and then failed — on a field nobody can see.
    const page = fakePage([{ value: "3", label: "RAA- Fees (RAAFEES)" }], "", false);
    await chooseReceiptCreditor(page, undefined);
    assert.strictEqual(page.picked, null, "it tried to set a hidden field");
  });

  await acheck("a hidden field is not set even when a creditor was named", async () => {
    const page = fakePage(LIVE, "", false);
    await chooseReceiptCreditor(page, "Journey Beyond");
    assert.strictEqual(page.picked, null, "it tried to set a hidden field");
  });

  console.log("\n" + n + " assertions passed.");
})().catch((e) => { console.error(e); process.exit(1); });

"use strict";

/**
 * selectExistingCard, without a browser.
 *
 * It takes a Playwright page, so it is tested against a stand-in that answers
 * the same three calls: $$eval over the option list, selectOption, and nothing
 * else. What is being checked is the CHOICE — that it picks the row matching
 * both brand and sub-type, and picks nothing at all when it cannot.
 *
 * The failure this guards against is specific: matching on brand alone hands a
 * debit customer a credit card. That is the guess BR02 exists to prevent, and
 * it would be invisible on the receipt.
 */

const assert = require("assert");
const { selectExistingCard } = require("../tramada-receipt");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };
const acheck = async (what, fn) => { await fn(); n++; console.log("  ok  " + what); };

// Exactly what #receiptcreditCard held on 16-Sep-2026, booking 13061.
const LIVE_OPTIONS = [
  { value: "", label: "" },
  { value: "749", label: "0000 GC - C - Givex Gift Card" },
  { value: "383", label: "520000....5957 CA - C - Mastercard Credit" },
  { value: "382", label: "518868....0008 CA - C - Mastercard Debit" },
  { value: "472", label: "0000 RV - C - Redemption Voucher" },
  { value: "380", label: "411111....1111 VI - C - Visa Credit" },
  { value: "381", label: "404137....6459 VI - C - Visa Debit" },
];

function fakePage(options = LIVE_OPTIONS) {
  return {
    picked: null,
    async $$eval(selector, fn) {
      assert.strictEqual(selector, "#receiptcreditCard option", "it read the wrong select");
      return fn(options.map((o) => ({ value: o.value, text: o.label })));
    },
    async selectOption(selector, value) {
      assert.strictEqual(selector, "#receiptcreditCard");
      this.picked = value;
    },
  };
}

(async () => {
  for (const [choice, expected] of [
    ["Visa Credit", "380"],
    ["Visa Debit", "381"],
    ["Mastercard Credit", "383"],
    ["Mastercard Debit", "382"],
  ]) {
    await acheck(`picks the right row for ${choice}`, async () => {
      const page = fakePage();
      const label = await selectExistingCard(page, { choice });
      assert.ok(label, "it found nothing for " + choice);
      assert.strictEqual(page.picked, expected, choice + " picked " + page.picked);
    });
  }

  await acheck("a debit customer is never given a credit card", async () => {
    const page = fakePage();
    await selectExistingCard(page, { choice: "Visa Debit" });
    assert.strictEqual(page.picked, "381", "picked " + page.picked + " for a debit card");
  });

  await acheck("the gift card and voucher rows are never reachable", async () => {
    for (const choice of ["Visa Credit", "Visa Debit", "Mastercard Credit", "Mastercard Debit"]) {
      const page = fakePage();
      await selectExistingCard(page, { choice });
      assert.ok(!["749", "472"].includes(page.picked), choice + " landed on " + page.picked);
    }
  });

  await acheck("with no matching row it selects NOTHING and says so", async () => {
    // The caller falls back to the Add form on null. Selecting a near-miss here
    // would file the receipt against the wrong card and report success.
    const page = fakePage(LIVE_OPTIONS.filter((o) => !/Visa Debit/.test(o.label)));
    const label = await selectExistingCard(page, { choice: "Visa Debit" });
    assert.strictEqual(label, null);
    assert.strictEqual(page.picked, null, "it picked " + page.picked + " anyway");
  });

  await acheck("an empty dropdown is null, not a crash", async () => {
    const page = fakePage([]);
    assert.strictEqual(await selectExistingCard(page, { choice: "Visa Credit" }), null);
  });

  await acheck("an unknown brand is null, not a guess", async () => {
    const page = fakePage();
    assert.strictEqual(await selectExistingCard(page, { choice: "Amex Credit" }), null);
    assert.strictEqual(page.picked, null);
  });

  await acheck("no card choice at all is null", async () => {
    const page = fakePage();
    assert.strictEqual(await selectExistingCard(page, {}), null);
    assert.strictEqual(await selectExistingCard(page, { choice: "" }), null);
  });

  await acheck("a bare brand matches only if one sub-type is present", async () => {
    // "Visa" with both rows present is ambiguous — it takes the first, which is
    // why payments-core refuses a bare brand long before this is reached.
    const page = fakePage();
    const label = await selectExistingCard(page, { choice: "Visa" });
    assert.ok(label, "a bare brand found nothing at all");
  });

  await acheck("it reports the label it used, for the run log", async () => {
    const page = fakePage();
    let said = null;
    const label = await selectExistingCard(page, { choice: "Mastercard Debit" }, (m) => (said = m));
    assert.strictEqual(label, "518868....0008 CA - C - Mastercard Debit");
    assert.ok(said && said.includes("518868"), "the run log never named the card: " + said);
  });

  console.log("\n" + n + " assertions passed.");
})().catch((e) => { console.error(e); process.exit(1); });

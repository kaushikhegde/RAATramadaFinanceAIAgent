"use strict";

/**
 * tramada-tokio.js — steps 9 to 14 of the Tokio Marine reconciliation.
 *
 * Finance → Payments → Issue Payment, search for the month's Tokio Marine
 * creditor lines, tick the ones the consolidated sheet says are Travel and
 * whose amount matches, and SAVE A SESSION.
 *
 * BR16 and BR18: it never clicks Issue. That is Travel Accounts' to do, after
 * they have resolved the exceptions and entered the payment total.
 *
 * THE SCREEN ITSELF IS `tramada-issue-payments.js`. DVC drives the same form
 * for a different payment category (docs/dvc.md steps 12-17), and the selectors
 * were measured once — 18-09-2026, written up in docs/tokio-marine.md — so they
 * live in one file rather than two that drift. What stays here is the part that
 * is about Tokio: which creditor, which dates, which sort order. The decisions
 * are tokio-core.js, which is pure and tested.
 */

require("dotenv").config();
const core = require("./tokio-core");
const screen = require("./tramada-issue-payments");

const {
  TRAMADA_BASE_URL, SEARCH, CHOOSER, sleep, tramadaDate,
  openBrowser, assertSignedIn, openIssuePayments, optionsOf, pick,
} = screen;

/** Step 10 — "From Segment Created Date to be 1st of the previous month". */
function firstOfPreviousMonth(today = new Date()) {
  return new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

/** Step 10 / BR09 — "today's date + another 4 weeks", forward-dated. */
function fourWeeksOut(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() + 28);
  return d;
}

/**
 * Step 10. Fill the search and press Go.
 *
 * Every value is read back before Go. A search that quietly ran with the wrong
 * creditor, or unsorted, produces a list that looks right and is not — and
 * BR10 exists precisely so the Tramada list and the consolidated sheet run in
 * the same order.
 */
async function searchCreditorPayments(page, opts = {}, onProgress = () => {}) {
  const {
    creditor = "Tokio",
    fromCreated = firstOfPreviousMonth(),
    toCreated = fourWeeksOut(),
  } = opts;

  onProgress(25, "Filling the Issue Payments search...");

  await pick(page, SEARCH.paymentType, "CREDITOR_PAYMENT", "Payment Category");
  await pick(page, SEARCH.bankAccount, "1", "Bank Account"); // [TRUST] Trust Account
  await pick(page, SEARCH.level1Branch, "", "Level 1 Branch"); // step 10: none
  await pick(page, SEARCH.sortBy, "REFERENCE", "Sort by"); // BR10
  await pick(page, SEARCH.sortOrder, "ASCENDING", "Sort order");

  /* CREDITOR CODE IS AN AUTOCOMPLETE, AND THE TYPED TEXT IS NOT A CODE.
   *
   * Measured 18-09-2026: typing "Tokio" and pressing Go returns
   * "Creditor Code is invalid" — the field has to hold the resolved entry the
   * dropdown offers, not what was typed. The suggestion list lives in
   *
   *     #creditor_auto_complete_div  >  ul > li
   *
   * and for "Toki" it offers exactly one: "[TOKIOMARINE] Tokio Marine".
   *
   * NOTE the code is NOT what the guide says. Step 10 says to expect
   * "[TOK] Tokio Marine Insurance"; this sandbox has "[TOKIOMARINE] Tokio
   * Marine". So the code is never hard-coded here — whatever the dropdown
   * offers for the typed text is what gets used, and it is checked afterwards.
   */
  await page.fill(SEARCH.creditor, "");
  await page.type(SEARCH.creditor, String(creditor), { delay: 60 });

  const SUGGESTIONS = "#creditor_auto_complete_div li";
  await page.waitForSelector(SUGGESTIONS, { timeout: 8000 }).catch(() => {});
  const offered = await page
    .$$eval(SUGGESTIONS, (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()))
    .catch(() => []);

  const tokioOptions = offered.filter((o) => /tokio/i.test(o));
  if (!tokioOptions.length) {
    throw new Error(
      `Typing "${creditor}" into Creditor Code offered ` +
        (offered.length ? offered.join(" | ") : "nothing") +
        ". Tramada rejects a code it did not offer, so this stops here rather " +
        "than searching on text it will call invalid."
    );
  }
  if (tokioOptions.length > 1) {
    throw new Error(
      `"${creditor}" matches more than one creditor: ${tokioOptions.join(" | ")}. ` +
        "Narrow it — picking one here would be a guess about whose payments to raise."
    );
  }

  await page.locator(SUGGESTIONS).filter({ hasText: /tokio/i }).first().click();
  await sleep(600);

  /* The field must now hold a RESOLVED code, "[SOMETHING] Name". Checking only
     that it contains "tokio" passes the raw typed word, which is exactly the
     value Tramada refused. */
  const creditorNow = await page.inputValue(SEARCH.creditor).catch(() => "");
  if (!/^\s*\[[A-Z0-9]+\]/i.test(creditorNow)) {
    throw new Error(
      `Creditor Code did not resolve to a code — the field reads "${creditorNow}". ` +
        `The dropdown offered: ${offered.join(" | ")}. Tramada answers an ` +
        `unresolved code with "Creditor Code is invalid" after the search is submitted.`
    );
  }
  if (!/tokio/i.test(creditorNow)) {
    throw new Error(
      `Creditor Code resolved to "${creditorNow}", which is not Tokio Marine. ` +
        "Refusing to search: the wrong creditor returns a full, plausible list " +
        "of somebody else's payments."
    );
  }

  await page.fill(SEARCH.fromCreated, tramadaDate(fromCreated));
  await page.fill(SEARCH.toCreated, tramadaDate(toCreated));

  // Read everything back before pressing Go.
  const settled = {
    paymentType: await page.inputValue(SEARCH.paymentType),
    bankAccount: await page.inputValue(SEARCH.bankAccount),
    sortBy: await page.inputValue(SEARCH.sortBy),
    from: await page.inputValue(SEARCH.fromCreated),
    to: await page.inputValue(SEARCH.toCreated),
    creditor: creditorNow,
  };
  const wanted = {
    paymentType: "CREDITOR_PAYMENT",
    bankAccount: "1",
    sortBy: "REFERENCE",
    from: tramadaDate(fromCreated),
    to: tramadaDate(toCreated),
  };
  for (const [k, v] of Object.entries(wanted)) {
    if (settled[k] !== v) {
      throw new Error(`${k} did not stick: wanted "${v}", the form reads "${settled[k]}".`);
    }
  }

  onProgress(35, `Searching ${settled.from} → ${settled.to}, sorted by reference...`);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click(SEARCH.go),
  ]);
  await sleep(1500);

  return settled;
}

module.exports = {
  // The screen, re-exported so a caller (and test/test-tokio-dates.js) still
  // has one place to reach for it.
  TRAMADA_BASE_URL,
  SEARCH,
  CHOOSER,
  tramadaDate,
  openBrowser,
  assertSignedIn,
  openIssuePayments,
  optionsOf,
  // Tokio's own.
  firstOfPreviousMonth,
  fourWeeksOut,
  searchCreditorPayments,
  core,
};

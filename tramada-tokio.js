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
 * Every selector here was measured on 18-Sep-2026 and is written down in
 * docs/tokio-marine.md. The decisions — which line matches, what the labels
 * read — are tokio-core.js, which is pure and tested.
 */

require("dotenv").config();
const { chromium } = require("playwright");
const core = require("./tokio-core");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Measured 18-Sep-2026 — finance/finance-payments-issue.htm. The two date
   fields are named "…TransactionDate" although their labels read "Segment
   Created Date"; going by the label finds nothing. */
const SEARCH = Object.freeze({
  paymentType: "#paymentType",
  bankAccount: "#agencyBankAccount",
  creditor: "#creditor",
  level1Branch: "#level1Branch",
  fromCreated: "#fromTransactionDate",
  toCreated: "#toTransactionDate",
  sortBy: "#sortBy",
  sortOrder: "#sortOrder",
  go: "#goButton",
});

const CHOOSER = Object.freeze({
  issueRadio: "#form_selection_issue",
  continue: "#form_continueButton",
});

/** dd-mm-yyyy, the format every other Tramada date field in this project uses. */
function tramadaDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) throw new Error("tramadaDate needs a date");
  const p = (n) => String(n).padStart(2, "0");
  return `${p(x.getDate())}-${p(x.getMonth() + 1)}-${x.getFullYear()}`;
}

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

/* ------------------------------------------------------------- the browser */

async function openBrowser(onProgress = () => {}) {
  onProgress(5, `Connecting to CDP Chrome at ${CDP_HOST}:${CDP_PORT}...`);
  try {
    return await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
  } catch (err) {
    throw new Error(
      `Could not reach the browser on ${CDP_HOST}:${CDP_PORT}. Start it with ` +
        `"npm run start:chrome" and sign into Tramada there. (${err.message})`
    );
  }
}

async function assertSignedIn(page) {
  if (/login/i.test(await page.title())) {
    throw new Error(
      "That browser is signed out of Tramada. Sign in there and run again — " +
        "this run never types a credential (CLAUDE.md §5)."
    );
  }
}

/* ----------------------------------------------------------- steps 9 and 10 */

/**
 * Step 9. The chooser is two radios and a Continue.
 *
 * The radio needs a REAL click: setting `.checked` from script did not stick,
 * and Continue with it unset returns the same chooser page looking like
 * nothing happened.
 */
async function openIssuePayments(page, onProgress = () => {}) {
  onProgress(15, "Finance → Payments → Issue Payment...");
  await page.goto(`${TRAMADA_BASE_URL}/finance/finance-payments.htm`, {
    waitUntil: "domcontentloaded",
  });
  await assertSignedIn(page);

  await page.waitForSelector(CHOOSER.issueRadio, { timeout: 15000 });
  await page.click(CHOOSER.issueRadio);

  const picked = await page.isChecked(CHOOSER.issueRadio).catch(() => false);
  if (!picked) {
    throw new Error(
      'Could not select "Issue Payment" on the Finance Payments chooser. ' +
        "Continuing from here would silently search instead of issuing."
    );
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click(CHOOSER.continue),
  ]);
  await page.waitForSelector(SEARCH.paymentType, { timeout: 20000 });

  if (!/finance-payments-issue/i.test(page.url())) {
    throw new Error(`Expected the Issue Payments screen, landed on ${page.url()}`);
  }
}

/** Set a select by option VALUE, and say what was on offer when it will not take. */
async function pick(page, selector, value, label) {
  const ok = await page
    .selectOption(selector, value)
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const offered = await page
      .$$eval(selector + " option", (os) => os.map((o) => `${o.value}=${o.text.trim()}`))
      .catch(() => []);
    throw new Error(
      `Could not set ${label} (${selector}) to "${value}". Offered: ${offered.join(" | ")}`
    );
  }
  await sleep(200);
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
   * Measured 18-Sep-2026: typing "Tokio" and pressing Go returns
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
  TRAMADA_BASE_URL,
  SEARCH,
  CHOOSER,
  tramadaDate,
  firstOfPreviousMonth,
  fourWeeksOut,
  openBrowser,
  assertSignedIn,
  openIssuePayments,
  searchCreditorPayments,
  core,
};

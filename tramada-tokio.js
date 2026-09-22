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
    // Which creditor the resolved code must actually BE. Defaults to Tokio,
    // because reconciling the wrong creditor returns a full and entirely
    // plausible list of somebody else's payments.
    //
    // Parameterised for one reason: the results grid's shape is not
    // Tokio-specific, and readTransactionPage() has to be measured against a
    // creditor that has costed segments. With the check hardcoded, the probe
    // resolved "[GSR] Journey Beyond" correctly and was then refused for not
    // being Tokio — a guard stopping a read-only measurement.
    expect = /tokio/i,
  } = opts;

  onProgress(25, "Filling the Issue Payments search...");

  await pick(page, SEARCH.paymentType, "CREDITOR_PAYMENT", "Payment Category");
  await pick(page, SEARCH.bankAccount, "1", "Bank Account"); // [TRUST] Trust Account
  await pick(page, SEARCH.sortBy, "REFERENCE", "Sort by"); // BR10
  await pick(page, SEARCH.sortOrder, "ASCENDING", "Sort order");

  /* LEVEL 1 BRANCH IS SET *AFTER* THE CREDITOR, NOT BEFORE.
   *
   * Measured 22-Sep-2026: picking a creditor from the autocomplete makes
   * Tramada populate Level 1 Branch itself — it came back as "1" ([ADL] RAA
   * Adelaide) every time. Step 10 says the branch must be NONE, so setting it
   * first and then choosing the creditor quietly undoes it, and every search
   * is filtered to one branch with nothing on screen to say so.
   *
   * There is no way to see that in the results: a branch-filtered list looks
   * exactly like a short month. So the branch is cleared after the creditor,
   * and read back below. */

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

  const tokioOptions = offered.filter((o) => expect.test(o));
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

  await page.locator(SUGGESTIONS).filter({ hasText: expect }).first().click();
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
  if (!expect.test(creditorNow)) {
    throw new Error(
      `Creditor Code resolved to "${creditorNow}", which does not match ${expect}. ` +
        "Refusing to search: the wrong creditor returns a full, plausible list " +
        "of somebody else's payments."
    );
  }

  // Now the creditor is settled, take the branch back off (step 10: none).
  await pick(page, SEARCH.level1Branch, "", "Level 1 Branch");
  await sleep(300);
  const branchNow = await page.inputValue(SEARCH.level1Branch).catch(() => "");
  if (branchNow) {
    throw new Error(
      `Level 1 Branch would not clear — it reads "${branchNow}". Step 10 requires none; a branch left ` +
        `in place silently limits the search to that branch and the results give no hint of it.`
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
    level1Branch: branchNow,
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

  /* GO DISABLES ITSELF AFTER ONE CLICK.
   *
   * Measured: #goButton.disabled becomes true on submit and is only re-enabled
   * by a fresh page load. A second search on the same page therefore does
   * nothing at all — no error, no reload, just the previous results still on
   * screen looking like a fresh answer. So every search comes through
   * openIssuePayments(), and this asserts the button is actually live. */
  const goLive = await page.isEnabled(SEARCH.go).catch(() => true);
  if (!goLive) {
    throw new Error(
      "Go is disabled — this page has already been submitted once. Tramada only re-enables it on a fresh " +
        "load, so re-open Issue Payments rather than searching again here; clicking it now would leave the " +
        "previous results on screen as though they were new."
    );
  }

  onProgress(35, `Searching ${settled.from} → ${settled.to}, sorted by reference...`);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.click(SEARCH.go),
  ]);
  await sleep(1500);

  return settled;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * Steps 11 to 14 — Issue Creditor Payment
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING BELOW HAS BEEN MEASURED AGAINST A LIVE TRAMADA YET.
 *
 * Every selector here is a candidate list, every column is found by its
 * heading, and every failure prints what the page actually contains. That is
 * not defensive habit — it is what the IPSI flow cost to learn. There, an id
 * borrowed from a neighbouring form (#cardNumberDisplay, which does not exist
 * on the receipt popup) produced a 15-second timeout naming a field that was
 * simply absent, and finding the real one took a separate probe run.
 *
 * So: run `node tools/probe-tokio-payments.js` once, paste its output, and
 * replace the candidate lists below with what it reports. Until then this code
 * will either work or tell you exactly why it did not.
 */

/** Wait for whichever of several selectors this page actually renders. */
async function firstPresent(page, selectors, { timeout = 10000, what = "field" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await page
      .evaluate((sels) => {
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el || el.disabled) continue;
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden") continue;
          return sel;
        }
        return null;
      }, selectors)
      .catch(() => null);
    if (hit) return hit;
    await sleep(250);
  }

  const present = await page
    .evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("input, select, textarea, button"))
        .filter((el) => el.type !== "hidden")
        .map((el) => {
          const td = el.closest("td");
          const prev = td && td.previousElementSibling;
          const name = el.id ? "#" + el.id : el.name ? `[name=${el.name}]` : el.tagName.toLowerCase();
          return `${name}${prev ? ` ("${norm(prev.textContent).slice(0, 24)}")` : ""}`;
        })
        .slice(0, 30);
    })
    .catch(() => []);

  throw new Error(
    `Could not find the ${what}. Looked for ${selectors.join(", ")}. ` +
      (present.length
        ? `The page has: ${present.join(", ")}. Run \`node tools/probe-tokio-payments.js\` and update PAYMENT.`
        : "The page appears empty or still loading.")
  );
}

/* Candidates, most-likely first. Replace with the probe's output. */
const PAYMENT = Object.freeze({
  transactionType: ["#transactionTypeCode", "#paymenttransactionTypeCode", "#transactionType"],
  payeeName: ["#payeeName", "#paymentpayeeName", "#payee"],
  reference: ["#referenceNumber", "#paymentreferenceNumber", "#reference"],
  sessionLabel: ["#sessionLabel", "#paymentsessionLabel", "#sessionName", "#label"],
  saveSession: ["#saveSession", "#saveSessionButton", 'input[value="Save Session"]', 'input[value="Save"]'],
  nextPage: ["#nextPage", 'a[title="Next"]', 'input[value="Next"]', "a.next"],
});

/**
 * Step 11 — Payment Overview and Payment Details.
 *
 * Transaction Type "EFT", Payee Name "Tokio", Reference "TOKIO_MMM YYYY".
 * Each one is read back: a select that silently refused its value is the
 * difference between a session Travel Accounts can issue and one they cannot.
 */
async function fillPaymentHeader(page, { reference, payeeName = "Tokio" }, onProgress = () => {}) {
  if (!reference) throw new Error("A payment reference is required — step 11 / BR16.");
  onProgress(45, "Setting Transaction Type, Payee Name and Reference...");

  /* THE HEADER DOES NOT EXIST UNTIL THE SEARCH FOUND SOMETHING.
     Payment Overview sits BELOW the transaction grid, so on a search that
     came back empty the page is still nothing but the search form and
     hunting for #transactionTypeCode reports a selector problem that is not
     one. runTokioReconciliation checks for the grid before calling this, but
     the check belongs here too — this is exported and the CLI calls it. */
  const stillSearching = await page
    .evaluate(() => {
      const grid = Array.from(document.querySelectorAll("table")).some(
        (t) =>
          Array.from(t.querySelectorAll("th, thead td")).some((h) =>
            /^\s*reference\s*$/i.test((h.textContent || "").replace(/\s+/g, " ").trim())
          ) && t.querySelector('input[type="checkbox"]')
      );
      return !grid && !!document.querySelector("#goButton, #form_clearButton");
    })
    .catch(() => false);
  if (stillSearching) {
    throw new Error(
      "The search returned no segments, so Tramada never drew the Payment Overview header — " +
        "there is nothing to pay. This is an empty result, not a selector problem: check the " +
        "creditor, the Segment Created Date range, and whether those costings are already Paid."
    );
  }

  const txnSel = await firstPresent(page, PAYMENT.transactionType, { what: "Transaction Type select" });
  const txn = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || !el.options) return null;
    const opt = Array.from(el.options).find((o) => /^\s*eft\s*$/i.test(o.text) || o.value === "ET");
    if (!opt) return { failed: Array.from(el.options).map((o) => o.text.trim()) };
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: opt.text.trim() };
  }, txnSel);
  if (!txn || txn.failed) {
    throw new Error(
      `Transaction Type has no "EFT" option — it offers ${(txn && txn.failed || []).join(" | ") || "nothing"}.`
    );
  }
  await sleep(500);

  const payeeSel = await firstPresent(page, PAYMENT.payeeName, { what: "Payee Name field" });
  await page.fill(payeeSel, String(payeeName));

  const refSel = await firstPresent(page, PAYMENT.reference, { what: "Reference field" });
  await page.fill(refSel, String(reference));
  await sleep(300);

  const settled = {
    transactionType: txn.text,
    payeeName: await page.inputValue(payeeSel).catch(() => null),
    reference: await page.inputValue(refSel).catch(() => null),
  };
  if (settled.payeeName !== String(payeeName) || settled.reference !== String(reference)) {
    throw new Error(
      `The payment header did not keep its values: Payee Name reads "${settled.payeeName}" ` +
        `(wanted "${payeeName}"), Reference reads "${settled.reference}" (wanted "${reference}").`
    );
  }
  return settled;
}

/**
 * The transaction rows on the page currently shown.
 *
 * Columns are found by HEADING, never by index — the same bug that made the
 * IPSI allocation grid report "nothing outstanding" against a booking plainly
 * showing money due was a hard-coded cells[6].
 */
async function readTransactionPage(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const money = (s) => {
      const t = norm(s);
      if (!t || !/\d/.test(t)) return null;
      const neg = /^\(.*\)$/.test(t);
      const n = Number(t.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };

    // The grid is the table whose headings carry a Reference column and whose
    // rows carry checkboxes — the shape of every allocation grid in Tramada.
    let table = null;
    for (const t of document.querySelectorAll("table")) {
      const heads = Array.from(t.querySelectorAll("th, thead td")).map((h) => norm(h.textContent));
      if (heads.some((h) => /^reference$/i.test(h)) && t.querySelector('input[type="checkbox"]')) {
        table = t;
        break;
      }
    }
    if (!table) return { found: false, headers: [], rows: [] };

    const headers = Array.from(table.querySelectorAll("th, thead td")).map((h) => norm(h.textContent));
    const col = (re) => headers.findIndex((h) => re.test(h));
    const iRef = col(/^reference$/i);
    const iAmount = col(/creditor\s*payable|amount|payable/i);
    const iBooking = col(/booking/i);

    const rows = [];
    Array.from(table.querySelectorAll("tr")).forEach((tr, index) => {
      const box = tr.querySelector('input[type="checkbox"]');
      if (!box) return;
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => norm(td.textContent));
      if (cells.length <= iRef) return;
      const reference = iRef >= 0 ? cells[iRef] : null;
      if (!reference) return;

      // Tag the row so it can be addressed later without ambiguity.
      //
      // BR12 exists because one policy can appear MORE THAN ONCE with
      // different amounts. Finding the row again by its reference text
      // therefore returns the first line carrying that policy — the very one
      // BR12 says not to pick. A per-row handle is the only way to tick the
      // line the amount actually chose.
      const handle = "tokio-row-" + index;
      tr.setAttribute("data-tokio-row", handle);

      rows.push({
        index,
        handle,
        reference,
        amount: iAmount >= 0 ? money(cells[iAmount]) : null,
        bookingNo: iBooking >= 0 ? cells[iBooking] : null,
        ticked: !!box.checked,
        checkboxId: box.id || null,
      });
    });
    return { found: true, headers, rows };
  });
}

/**
 * Steps 12-13 — match, then tick.
 *
 * Matching is tokio-core's job (BR11 reference + amount, BR13 ±1%, BR12 the
 * closest amount when a policy repeats). This only drives the page, and only
 * ticks a row core has already said matches.
 *
 * The tick is a REAL click. Setting .checked and dispatching a synthetic event
 * leaves Tramada's own onclick unrun — which on the IPSI receipt form meant a
 * row that looked ticked and was never allocated.
 */
async function tickMatchingRows(page, travelRows, { onStep = () => {} } = {}) {
  const grid = await readTransactionPage(page);
  if (!grid.found) {
    /* NO GRID IS NOT A CRASH.
       Tramada renders no table at all when a search matches nothing, so "no
       grid" is the shape of an empty result as well as the shape of a wrong
       page. Throwing treated a true answer — this creditor has nothing
       outstanding — as a failure, and the run died instead of reporting it.
       The two are told apart by the URL: on the Issue Payments screen an
       empty grid means no rows; anywhere else means something navigated. */
    const onIssuePage = /finance-payments-issue/i.test(page.url());
    if (!onIssuePage) {
      throw new Error(
        `Expected the Issue Payments screen and found ${page.url()}. No transaction grid to read — ` +
          "run `node tools/probe-tokio-payments.js` to see what is actually there."
      );
    }
    return { headers: [], rows: [], results: [], empty: true };
  }

  // BR11: match on the Reference field (the 210 policy number) and the amount.
  // The booking number is not used, so it is not indexed.
  //
  // Tramada lines are grouped by policy FIRST, because BR12 is about choosing
  // between several lines carrying the same policy: "select the line that
  // matches the amount, not simply the first line with that policy number."
  // Walking the grid row by row asking "does this one match?" cannot make that
  // choice — it has to see the whole group.
  const byPolicy = new Map();
  for (const row of grid.rows) {
    const key = core.policyKey(row.reference);
    if (!key) continue;
    if (!byPolicy.has(key)) byPolicy.set(key, []);
    byPolicy.get(key).push(row);
  }

  // buildConsolidated() rows are { line, row, policy, appended, outcome }.
  // A plain { policy, totalNett } is accepted too, so this can be driven from
  // a test or a resumed run without rebuilding the whole sheet.
  const netOf = (t) =>
    t.totalNett != null ? t.totalNett : t.appended ? t.appended["RAA Total Nett"] : null;

  const results = [];
  for (const travel of travelRows) {
    // Step 8 and BR18: "Do not reconcile any transactions that has an
    // exception flagged." Retail rows are gone by now; an exception row is not.
    if (travel.outcome && travel.outcome !== core.OUTCOME.TRAVEL) continue;

    const key = core.policyKey(travel.policy != null ? travel.policy : travel.reference);
    if (!key) continue;

    const candidates = byPolicy.get(key);
    // Not on THIS page. Fifty pages means saying "not found" fifty times over
    // if that is reported here, so the absent ones are settled once at the end.
    if (!candidates || !candidates.length) continue;

    const verdict = core.matchTramadaLine(candidates, netOf(travel));
    if (!verdict.ok) {
      results.push({
        policy: key,
        reference: (verdict.closest && verdict.closest.reference) || key,
        ticked: false,
        remark: verdict.remark, // BR15's wording, straight from tokio-core
        expected: netOf(travel),
        closest: verdict.closest ? verdict.closest.amount : null,
      });
      onStep({ step: "not ticked", detail: `${key} — ${verdict.remark}` });
      continue;
    }

    const line = verdict.line;
    const box = page.locator(`[data-tokio-row="${line.handle}"] input[type="checkbox"]`).first();
    if (!(await box.count())) {
      results.push({ policy: key, reference: line.reference, ticked: false, remark: "checkbox not found on the row" });
      continue;
    }

    // A REAL click. Setting .checked and dispatching a synthetic event leaves
    // Tramada's own onclick unrun — on the IPSI receipt form that meant a row
    // that looked ticked and was never allocated.
    await box.check().catch(async () => {
      await box.click({ force: true }).catch(() => {});
    });
    await sleep(120);

    results.push({
      policy: key,
      reference: line.reference,
      handle: line.handle,
      ticked: true,
      amount: line.amount,
      expected: netOf(travel),
      differenceCents: verdict.differenceCents,
    });
    onStep({ step: "ticked", detail: `${line.reference} @ ${line.amount} (wanted ${netOf(travel)})` });
  }

  // Read the page back: a tick that did not stay is not a tick. By HANDLE, for
  // the same reason the tick was — two lines can share a reference, and
  // checking the wrong one would report success either way.
  const after = await readTransactionPage(page);
  for (const r of results.filter((x) => x.ticked)) {
    const now = after.rows.find((x) => x.handle === r.handle);
    if (!now || !now.ticked) {
      throw new Error(
        `The A column did not stay ticked for reference ${r.reference}. Tramada will not include an ` +
          `unticked row in the session — nothing was saved.`
      );
    }
  }

  return { headers: grid.headers, rows: grid.rows, results };
}

/**
 * Step 13's note: "The list paginates at 20 items per page and runs to roughly
 * 50 pages at typical monthly volume. The AI agent must work through all pages."
 *
 * Bounded, and the bound is explained: 200 pages at 20 a page is 4,000
 * transactions, several times a heavy month. A loop with no bound against a
 * pager that stops advancing is a run that never ends.
 */
const MAX_PAGES = Number(process.env.TOKIO_MAX_PAGES || 200);

async function walkAllPages(page, travelRows, { onProgress = () => {}, onStep = () => {} } = {}) {
  const all = [];
  const seen = new Set();

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    onProgress(50 + Math.min(35, pageNo), `Matching page ${pageNo}...`);
    const { results, empty } = await tickMatchingRows(page, travelRows, { onStep });
    if (empty) {
      onStep({
        step: "No rows",
        detail:
          pageNo === 1
            ? "the search returned nothing — this creditor has no outstanding segments in the window"
            : `page ${pageNo} is empty`,
      });
      break;
    }
    all.push(...results.map((r) => ({ ...r, page: pageNo })));

    // A page whose references are all ones already seen means the pager did
    // not actually advance — stop rather than tick the same rows again.
    const refs = results.map((r) => r.reference).join("|");
    if (refs && seen.has(refs)) {
      onStep({ step: "pagination", detail: `page ${pageNo} repeated page ${pageNo - 1} — stopping` });
      break;
    }
    seen.add(refs);

    let next = null;
    try {
      next = await firstPresent(page, PAYMENT.nextPage, { timeout: 1500, what: "Next page control" });
    } catch {
      next = null; // no pager, or the last page
    }
    if (!next) break;

    const disabled = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      return el.disabled || /disabled/i.test(el.className || "") || el.getAttribute("aria-disabled") === "true";
    }, next);
    if (disabled) break;

    await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), page.click(next)]);
    await sleep(1200);
  }

  return all;
}

/**
 * Step 14 — save the session. NOT Issue.
 *
 * BR16: "The AI Agent saves the reconciliation as a session in Tramada. It does
 * NOT click Issue." The Issue control is deliberately never located here — a
 * selector that is not in this file cannot be clicked by accident, and BR18
 * puts issuing, rounding and the payment total in a human's hands.
 */
async function saveSession(page, label, onProgress = () => {}) {
  if (!label) throw new Error("A session label is required — step 14.");
  onProgress(90, `Saving the session as ${label}...`);

  const labelSel = await firstPresent(page, PAYMENT.sessionLabel, { what: "Session Label field" });
  await page.fill(labelSel, String(label));
  await sleep(200);

  const readBack = await page.inputValue(labelSel).catch(() => null);
  if (readBack !== String(label)) {
    throw new Error(`Session Label reads "${readBack}", expected "${label}".`);
  }

  const saveSel = await firstPresent(page, PAYMENT.saveSession, { what: "Save Session button" });
  await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), page.click(saveSel)]);
  await sleep(1500);

  const errors = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("span, div, li, font").forEach((n) => {
      if (n.children.length) return;
      const t = (n.textContent || "").trim();
      if (t && t.length < 200 && /must be|is required|is invalid|cannot be/i.test(t)) out.push(t);
    });
    return [...new Set(out)].slice(0, 6);
  });
  if (errors.length) throw new Error(`Tramada refused the session: ${errors.join("; ")}`);

  onProgress(100, `Session ${label} saved.`);
  return { label };
}


/* ═══════════════════════════════════════════════════════════════════════════
 * Steps 9 to 14, in one run
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The whole Tramada half of the reconciliation.
 *
 * Takes the consolidated sheet steps 4-8 produced — buildConsolidated()'s
 * output, or just its Travel rows — and drives Tramada from the Issue Payments
 * chooser to a saved session.
 *
 * Two things it will not do, both by the guide:
 *
 *   BR16/BR18 — it never clicks Issue. The session is saved and left for
 *   Travel Accounts, who resolve the exceptions, apply rounding up to $50
 *   (BR14) and enter the payment total.
 *
 *   BR15 — it never invents a remark. Anything unmatched comes back with
 *   tokio-core's own wording, for the Remarks column and the dashboard.
 *
 * `dryRun` is the default. Saving a session is a write, so it takes the exact
 * literal "SAVE SESSION" — the same shape as the IPSI receipt flow's
 * "ISSUE RECEIPT" and dvc-card-issuer's "CREATE CARD".
 */
const SAVE_LITERAL = "SAVE SESSION";

async function runTokioReconciliation({
  consolidated,
  month,
  confirm,
  dryRun = true,
  creditor = "Tokio",
  fromCreated,
  toCreated,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const steps = [];
  const step = (name, detail) => {
    steps.push({ at: new Date().toISOString(), step: name, detail: detail == null ? null : String(detail) });
    if (callbacks.onStep) callbacks.onStep(steps[steps.length - 1]);
  };

  // Accept either buildConsolidated()'s whole result or a bare row array.
  const rows = Array.isArray(consolidated) ? consolidated : (consolidated && consolidated.rows) || [];
  const travelRows = Array.isArray(consolidated)
    ? rows.filter((r) => !r.outcome || r.outcome === core.OUTCOME.TRAVEL)
    : (consolidated && consolidated.travel) || [];

  if (!travelRows.length) {
    throw new Error(
      "No Travel transactions to reconcile. Steps 7-8 excluded every row as Retail or flagged it as an " +
        "exception, so there is nothing to tick and no session worth saving."
    );
  }

  const when = month instanceof Date ? month : month ? core.monthKeyToDate(month) : new Date();
  const reference = core.paymentReference(when);
  const label = core.sessionLabel(when);
  const willSave = !dryRun;
  if (willSave && confirm !== SAVE_LITERAL) {
    throw new Error(`Saving the session requires the exact confirmation "${SAVE_LITERAL}" — refusing to proceed.`);
  }

  const browser = await openBrowser(onProgress);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  let keepTabOpen = false;

  try {
    await assertSignedIn(page);

    // Steps 9-10.
    await openIssuePayments(page, onProgress);
    step("Steps 9-10 — Issue Payments", "Creditor Payment, Trust account, sorted by reference (BR10)");
    const search = await searchCreditorPayments(page, { creditor, fromCreated, toCreated }, onProgress);
    step("Step 10 — searched", `${search.creditor} · ${search.from} → ${search.to}`);

    /* STEP 11 ONLY EXISTS ONCE THE SEARCH RETURNED SEGMENTS.
       Tramada renders Payment Overview / Payment Details — Transaction Type,
       Payee Name, Reference — underneath the transaction grid, and the grid
       is only drawn when the search found something. Filling the header
       first therefore hunts for #transactionTypeCode on a page that is still
       the search form, and reports "Could not find the Transaction Type
       select" when the truth is simply that this creditor has nothing
       outstanding. Measured 22-Sep-2026 against [TOKIOMARINE] Tokio Marine
       over 01-08-2026 → 20-10-2026.

       So: look for the grid first. No grid is an ANSWER, not a fault — the
       same distinction tickMatchingRows now draws. */
    const firstPage = await readTransactionPage(page);
    if (!firstPage.found) {
      step(
        "No rows",
        `${search.creditor} has no outstanding segments between ${search.from} and ${search.to}. ` +
          "Nothing to tick, so no payment header and no session."
      );
      onProgress(100, "Nothing outstanding for this creditor — nothing ticked.");
      keepTabOpen = true;
      try { await page.bringToFront(); } catch { /* not fatal */ }
      return {
        reference,
        label,
        search,
        header: null,
        ticked: [],
        mismatched: travelRows
          .map((t) => core.policyKey(t.policy != null ? t.policy : t.reference))
          .filter(Boolean)
          .map((policy) => ({ policy, ticked: false, remark: "Policy number not found in Tramada" })),
        steps,
        savedSession: false,
        empty: true,
      };
    }

    // Step 11.
    const header = await fillPaymentHeader(page, { reference }, onProgress);
    step("Step 11 — payment header", `${header.transactionType} · ${header.payeeName} · ${header.reference}`);

    // Steps 12-13, every page.
    const matched = await walkAllPages(page, travelRows, {
      onProgress,
      onStep: (s) => step(s.step, s.detail),
    });

    const ticked = matched.filter((m) => m.ticked);
    const mismatched = matched.filter((m) => !m.ticked);

    // BR15 — a Travel row that never appeared on ANY page. Reported once, at
    // the end, rather than on each of fifty pages.
    const seen = new Set(matched.map((m) => m.policy));
    const notFound = travelRows
      .filter((t) => (!t.outcome || t.outcome === core.OUTCOME.TRAVEL))
      .map((t) => core.policyKey(t.policy != null ? t.policy : t.reference))
      .filter((k) => k && !seen.has(k))
      .map((policy) => ({ policy, ticked: false, remark: "Policy number not found in Tramada" }));

    step(
      "Steps 12-13 — matched",
      `${ticked.length} ticked, ${mismatched.length} mismatched, ${notFound.length} not found in Tramada`
    );

    const outcome = {
      reference,
      label,
      search,
      header,
      ticked,
      mismatched: [...mismatched, ...notFound],
      steps,
      savedSession: false,
    };

    if (dryRun) {
      // Left on screen deliberately: the point of stopping here is that a
      // human looks at what was ticked before it becomes a session.
      keepTabOpen = true;
      try { await page.bringToFront(); } catch { /* not fatal */ }
      step("Stopped before saving", `reply "${SAVE_LITERAL}" to save the session as ${label}`);
      onProgress(100, `${ticked.length} lines ticked — not saved.`);
      return outcome;
    }

    // Step 14.
    await saveSession(page, label, onProgress);
    step("Step 14 — session saved", `${label} — Issue was NOT clicked (BR16)`);
    keepTabOpen = true;
    try { await page.bringToFront(); } catch { /* not fatal */ }
    return { ...outcome, savedSession: true };
  } catch (err) {
    step("Failed", err.message);
    err.steps = steps;
    throw err;
  } finally {
    if (!keepTabOpen) {
      try { await page.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
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
  // Steps 11-14
  PAYMENT,
  MAX_PAGES,
  firstPresent,
  fillPaymentHeader,
  readTransactionPage,
  tickMatchingRows,
  walkAllPages,
  saveSession,
  runTokioReconciliation,
  SAVE_LITERAL,
  core,
};

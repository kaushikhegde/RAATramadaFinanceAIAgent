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

  /* GO OPENS THE RESULTS IN A NEW WINDOW — and this is what made every
     search look empty.
     Measured 24-Sep-2026: clicking Go does not navigate this page. It opens
     `finance/finance-creditor-payment.htm` in a SEPARATE tab, carrying
     `agencyBankAccount`, `level1Branch` and a `dataContainerId`. The search
     form is still sitting there afterwards, unchanged, so code that clicks
     Go and then reads the same `page` sees the form it started with — no
     grid, no header — and concludes there is nothing to pay.
     That is exactly what this module did, and why it reported an empty
     result against a creditor with pages of outstanding segments.
     So: listen for the popup BEFORE clicking, and hand the caller the page
     the results are actually on. */
  onProgress(35, `Searching ${settled.from} → ${settled.to}, sorted by reference...`);
  const ctx = page.context();
  const popupPromise = ctx
    .waitForEvent("page", { timeout: 20000 })
    .catch(() => null);
  await page.click(SEARCH.go);
  const results = await popupPromise;

  if (results) {
    await results.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1200);
    try { await results.bringToFront(); } catch { /* not fatal */ }
    return { ...settled, page: results, openedInNewWindow: true };
  }

  /* No popup. Either Tramada navigated in place (a configuration we have not
     seen), or the search was refused. A refusal is a red banner on the form
     — "Creditor Code must be entered" is the one that cost us a day, because
     nothing else on the page changes and it reads exactly like an empty
     result. Look for it rather than reporting "nothing outstanding". */
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);
  const refusal = await page
    .evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const hit = Array.from(document.querySelectorAll("div, span, td, p, li"))
        .map((e) => norm(e.textContent))
        .filter((t) => t && t.length < 160)
        .find((t) => /must be entered|is invalid|is required|not valid/i.test(t));
      return hit || null;
    })
    .catch(() => null);
  if (refusal) {
    throw new Error(
      `Tramada refused the search: "${refusal}". Nothing was searched, so this is not an empty result.`
    );
  }

  return { ...settled, page, openedInNewWindow: false };
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
/** firstPresent without the throw — null when no candidate is present. */
async function firstPresentOrNull(page, selectors) {
  for (const sel of selectors) {
    if (await page.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

/**
 * Find a control by the LABEL a person reads, when its id is unknown.
 *
 * The Payment Overview header was only ever seen in a screenshot: the labels
 * are certain ("Transaction Type", "Payee Name", "Reference"), the ids are
 * guesses. Tramada lays these out as <td>Label</td><td><control></td>, so the
 * label is the sounder handle. Tags the control and returns a selector for it.
 */
async function controlByLabel(page, labelText, kinds = "input,select,textarea") {
  return await page
    .evaluate(
      (arg) => {
        const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
        const esc = arg.labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const want = new RegExp("^\\s*" + esc + "\\s*:?\\s*$", "i");
        const tag = (el) => {
          el.setAttribute("data-tokio-field", arg.labelText);
          return '[data-tokio-field="' + arg.labelText + '"]';
        };
        for (const lab of document.querySelectorAll("label")) {
          if (!want.test(norm(lab.textContent))) continue;
          const id = lab.getAttribute("for");
          const el = id ? document.getElementById(id) : lab.querySelector(arg.kinds);
          if (el) return tag(el);
        }
        for (const td of document.querySelectorAll("td, th")) {
          if (!want.test(norm(td.textContent))) continue;
          let sib = td.nextElementSibling;
          while (sib) {
            const el = sib.matches && sib.matches(arg.kinds) ? sib
              : (sib.querySelector ? sib.querySelector(arg.kinds) : null);
            if (el) return tag(el);
            sib = sib.nextElementSibling;
          }
        }
        return null;
      },
      { labelText, kinds }
    )
    .catch(() => null);
}

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

  /* ID FIRST, THEN THE LABEL. These ids were never measured — the Payment
     Overview header was only seen in a screenshot — so a miss falls back to
     the label a person reads, and only then to the reporting throw. */
  const txnSel =
    (await firstPresentOrNull(page, PAYMENT.transactionType)) ||
    (await controlByLabel(page, "Transaction Type", "select")) ||
    (await firstPresent(page, PAYMENT.transactionType, { what: "Transaction Type select" }));
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

  const payeeSel =
    (await firstPresentOrNull(page, PAYMENT.payeeName)) ||
    (await controlByLabel(page, "Payee Name", "input")) ||
    (await firstPresent(page, PAYMENT.payeeName, { what: "Payee Name field" }));
  await page.fill(payeeSel, String(payeeName));

  const refSel =
    (await firstPresentOrNull(page, PAYMENT.reference)) ||
    (await controlByLabel(page, "Reference", "input")) ||
    (await firstPresent(page, PAYMENT.reference, { what: "Reference field" }));
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
    /* The Allocate column sits beside the A tick. Ticking A is what fills it,
       so its value is the clearest evidence of whether Tramada accepted the
       tick or quietly dropped it. Captured only to be REPORTED. */
    const iAllocate = col(/^allocate$/i);

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
        allocate: (() => {
          if (iAllocate < 0) return null;
          const td = tr.querySelectorAll("td")[iAllocate];
          if (!td) return null;
          const inp = td.querySelector("input, textarea");
          return norm(inp ? inp.value : td.textContent);
        })(),
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
  /* A GRID ROW WHOSE REFERENCE WE CANNOT READ IS NOT NOTHING.
     This used to `continue` in silence. The Travel row it belonged to then
     came back as "Policy number not found in Tramada" — which reads as "the
     segment does not exist" when the truth is "it is right there and we
     could not parse its reference". Those need different actions from a
     person, so they get different words.
     Live example, 23-Sep-2026: a training booking was raised with policy
     2100044 — seven digits, when policyKey still demanded 21 + six. That
     rule is gone (see tokio-core), but the reporting stays: a reference we
     cannot read is a different thing from a segment that is not there. */
  const unreadable = [];
  for (const row of grid.rows) {
    const key = core.policyKey(row.reference);
    if (!key) {
      unreadable.push(row.reference == null ? "" : String(row.reference));
      continue;
    }
    if (!byPolicy.has(key)) byPolicy.set(key, []);
    byPolicy.get(key).push(row);
  }
  if (unreadable.length) {
    onStep({
      step: "unreadable reference",
      detail:
        `${unreadable.length} row(s) on this page carry a reference with no readable policy number in it ` +
        `and were left alone: ${unreadable.slice(0, 5).map((u) => JSON.stringify(u.slice(0, 40))).join(", ")}` +
        (unreadable.length > 5 ? ` and ${unreadable.length - 5} more` : ""),
    });
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

    /* A REAL click, THEN CHECK IT SURVIVED — per row, not at the end.
       Setting .checked and dispatching a synthetic event leaves Tramada's own
       onclick unrun; on the IPSI receipt form that meant a row that looked
       ticked and was never allocated.
       And the A column does not settle instantly. Ticking it runs Tramada's
       handler, which fills the Allocate cell beside it and re-renders the
       row — measured 24-Sep-2026, where a read 120ms later found the tick
       gone and the run stopped on a row it had in fact ticked correctly. So
       each row is given time, re-read, and clicked a second time before it
       is called a refusal. */
    /* RE-RESOLVE THE CHECKBOX EVERY ATTEMPT.
       Ticking A makes Tramada re-render the row, which detaches the element
       the locator was pointing at AND strips the data-tokio-row attribute we
       tagged it with. A retry against the old locator therefore clicks
       nothing at all and fails silently — which is what the second attempt
       was doing. readTransactionPage re-tags by row index, so re-reading
       first is what makes a fresh, attached locator possible. */
    const tickOnce = async (fillAllocate) => {
      await readTransactionPage(page); // re-tag after any re-render
      const cell = page.locator(`[data-tokio-row="${line.handle}"]`);
      if (!(await cell.count().catch(() => 0))) return null;

      /* "Segments To Allocate" — the tick allocates a payment ACROSS
         segments, and Tramada was leaving Allocate empty and dropping the
         tick. Where the amount has to be stated, state it: the figure is
         Creditor Payable, the row's own number, never one of ours. */
      if (fillAllocate) {
        const amountBox = cell.locator("input[type='text'], input:not([type])").first();
        if (await amountBox.count().catch(() => 0)) {
          await amountBox.fill(String(line.amount)).catch(() => {});
          await sleep(200);
        }
      }

      const fresh = cell.locator("input[type='checkbox']").first();
      if (!(await fresh.count().catch(() => 0))) return null;
      await fresh.check().catch(async () => {
        await fresh.click({ force: true }).catch(() => {});
      });
      await sleep(700);
      const seen = await readTransactionPage(page);
      return seen.rows.find((x) => x.handle === line.handle) || null;
    };

    let now = await tickOnce(false);
    if (!now || !now.ticked) {
      onStep({
        step: "re-ticking",
        detail: `${line.reference} did not hold on the first click` +
          (now && now.allocate != null ? ` (Allocate reads ${JSON.stringify(now.allocate)})` : "") +
          " — retrying, and stating the amount this time",
      });
      // Second attempt states the Allocate amount; third is a plain retry in
      // case the row simply needed longer.
      now = await tickOnce(true);
      if (!now || !now.ticked) now = await tickOnce(false);
    }
    if (!now || !now.ticked) {
      results.push({
        policy: key,
        reference: line.reference,
        handle: line.handle,
        ticked: false,
        remark:
          "Tramada would not keep this row ticked" +
          (now && now.allocate != null ? ` — Allocate reads ${JSON.stringify(now.allocate)}` : "") +
          ". The rest of the page was still ticked and nothing was saved.",
      });
      onStep({ step: "not ticked", detail: `${key} — Tramada would not keep it ticked` });
      continue;
    }

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
        `The A column was ticked for reference ${r.reference} and had come undone by the end of the ` +
        `page — something later in the run untick it. Tramada will not include an ` +
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
    /* THE RESULTS ARE ON ANOTHER PAGE. Go opens finance-creditor-payment.htm
       in a new window; `search.page` is that window, and every step from here
       reads and ticks THERE. Using `page` instead reads the search form and
       reports "nothing outstanding" against a full grid. */
    const work = search.page || page;
    step(
      "Step 10 — searched",
      `${search.creditor} · ${search.from} → ${search.to}` +
        (search.openedInNewWindow ? " — results opened in a new window" : "")
    );

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
    const firstPage = await readTransactionPage(work);
    if (!firstPage.found) {
      step(
        "No rows",
        `${search.creditor} has no outstanding segments between ${search.from} and ${search.to}. ` +
          "Nothing to tick, so no payment header and no session."
      );
      onProgress(100, "Nothing outstanding for this creditor — nothing ticked.");
      keepTabOpen = true;
      try { await work.bringToFront(); } catch { /* not fatal */ }
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
    const header = await fillPaymentHeader(work, { reference }, onProgress);
    step("Step 11 — payment header", `${header.transactionType} · ${header.payeeName} · ${header.reference}`);

    // Steps 12-13, every page.
    const matched = await walkAllPages(work, travelRows, {
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
      try { await work.bringToFront(); } catch { /* not fatal */ }
      step("Stopped before saving", `reply "${SAVE_LITERAL}" to save the session as ${label}`);
      onProgress(100, `${ticked.length} lines ticked — not saved.`);
      return outcome;
    }

    // Step 14.
    await saveSession(work, label, onProgress);
    step("Step 14 — session saved", `${label} — Issue was NOT clicked (BR16)`);
    keepTabOpen = true;
    try { await work.bringToFront(); } catch { /* not fatal */ }
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
  // The screen, re-exported so a caller (and test/test-tokio-dates.js) still
  // has one place to reach for it.
  TRAMADA_BASE_URL,
  controlByLabel,
  firstPresentOrNull,
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

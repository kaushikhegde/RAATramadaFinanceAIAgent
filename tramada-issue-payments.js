"use strict";

/**
 * tramada-issue-payments.js — Finance → Payments → Issue Payment, the screen.
 *
 * Two reconciliations drive this screen for two different payment categories:
 * Tokio Marine's creditor payments (`tramada-tokio.js`, steps 9-14 of its
 * guide) and DVC's Agency CC Reimbursement (`tramada-dvc.js`, steps 12-17 of
 * docs/dvc.md). What they share is the SCREEN — the chooser, the search form's
 * measured ids, the results grid, the buttons — and what they do not share is
 * which category they search and which rows they tick.
 *
 * SO THE SCREEN IS DESCRIBED ONCE, HERE. It was measured twice into one file
 * before this existed, and a second copy of a selector map is how a
 * re-measurement lands in one flow and not the other — the same drift CLAUDE.md
 * §0 describes for the tests that were at the root and in `test/` at once.
 *
 * Measured 18-09-2026 on `finance/finance-payments-issue.htm` and written up in
 * docs/tokio-marine.md. THE RESULTS GRID BELOW THAT FORM IS NOT MEASURED: no
 * run has pressed Go and written down what came back. Everything here that
 * touches the grid therefore DISCOVERS it — the header row names the columns,
 * the checkbox names the row, the buttons are found by what they say — and
 * fails loudly with what it actually saw rather than counting from a position
 * (§6). `tools/probe-dvc-payment.js` is how that guess becomes a measurement.
 *
 * No decision is taken in this file. Which rows to tick and whether to press
 * Session or Issue are `recon-core.js` (§2).
 *
 * ── THIS PORTAL LOADS PROTOTYPE.JS. DO NOT USE filter's INDEX ARGUMENT ──────
 *
 * `click/prototype/prototype.js` replaces `Array.prototype.filter` with its own
 * `findAll`, which calls the iterator as `(value, index)` — there is no third
 * array parameter. Measured 22-09-2026: a `.filter((v, i, a) => a.indexOf(v) === i)`
 * inside `page.evaluate` on this screen throws
 *
 *     TypeError: Cannot read properties of undefined (reading 'indexOf')
 *
 * from inside prototype.js, which reads as a bug in Tramada rather than in the
 * one line that caused it. Every closure below sticks to single-argument
 * callbacks. The same goes for anything added later.
 */

require("dotenv").config();

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/* Measured 18-09-2026 — finance/finance-payments-issue.htm. The two date
   fields are NAMED "…TransactionDate" although their labels read "Segment
   Created Date"; going by the label finds nothing. */
const SEARCH = Object.freeze({
  paymentType: "#paymentType",
  bankAccount: "#agencyBankAccount",
  creditor: "#creditor",
  level1Branch: "#level1Branch",
  level2Branch: "#level2Branch",
  fromCreated: "#fromTransactionDate",
  toCreated: "#toTransactionDate",
  transferDate: "#transferDate",
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

/* ------------------------------------------------------------- the browser */

async function openBrowser(onProgress = () => {}) {
  /* PLAYWRIGHT IS REQUIRED HERE, NOT AT THE TOP OF THE FILE. Everything else in
     this module is either a constant or a pure DOM function that runs inside
     `page.evaluate`, and those are what the offline suite checks against jsdom
     (§7 — no Playwright in the tests, and no mocks of it either). A top-level
     require would drag the whole browser package into a test that never opens
     one, and would fail the suite outright on a Node too old for it. */
  const { chromium } = require("playwright");
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

/* ------------------------------------------------------ getting to the form */

/**
 * The chooser is two radios and a Continue.
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

/* --------------------------------------------------------- filling the form */

/** Every `<option>` a select is holding, as `[{ value, text }]`. */
async function optionsOf(page, selector) {
  return await page
    .$$eval(selector + " option", (os) => os.map((o) => ({ value: o.value, text: o.textContent })))
    .catch(() => []);
}

/** Set a select by option VALUE, and say what was on offer when it will not take. */
async function pick(page, selector, value, label) {
  const ok = await page
    .selectOption(selector, value)
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const offered = await optionsOf(page, selector);
    throw new Error(
      `Could not set ${label} (${selector}) to "${value}". Offered: ` +
        offered.map((o) => `${o.value}=${clean(o.text)}`).join(" | ")
    );
  }
  await sleep(200);
}

/**
 * Set a select by the LABEL a person reads off the screen.
 *
 * `core.resolveSelectOption` does the choosing — label first, measured value
 * as a fallback — so which option is right stays a tested decision and this
 * function only types it in and reads it back (§2).
 *
 * The read-back is not ceremony. A select that refuses a value leaves the form
 * on whatever it had, and on this screen "whatever it had" is a blank Payment
 * Category, which searches every category there is.
 */
async function setByLabel(page, selector, wantedLabel, expectedValue, field, core) {
  const offered = await optionsOf(page, selector);
  if (!offered.length) {
    throw new Error(`${field} (${selector}) is not on this screen, or holds no options.`);
  }
  const chosen = core.resolveSelectOption(offered, wantedLabel, expectedValue);
  if (chosen.value == null) {
    throw new Error(
      `Could not find "${wantedLabel}" on ${field} (${selector})` +
        (chosen.ambiguous ? " — more than one option matched, and picking between them is a guess" : "") +
        `. It offered: ${offered.map((o) => clean(o.text) || "(blank)").join(" | ")}`
    );
  }
  await pick(page, selector, chosen.value, field);

  const got = await page.inputValue(selector).catch(() => "");
  if (got !== chosen.value) {
    throw new Error(`${field} did not stick: set "${chosen.value}", the form reads "${got}".`);
  }
  return { ...chosen, field, selector };
}

/**
 * A control this screen has never been measured holding.
 *
 * BR12 names a Credit Card field on the Issue Payment parameters, and the
 * 18-09-2026 capture of this form has no such control — it was taken with
 * Payment Category set to Creditor Payment, and this screen posts itself back
 * when the category changes. So the field is looked for three ways and the
 * failure names all three, rather than a hard-coded id that would silently
 * select nothing.
 *
 *   1. a `<label for>` or an adjacent cell reading `Credit Card`
 *   2. a select or input whose id/name contains "card"
 *   3. a select holding an option that reads like the card we were given
 *
 * Returns `{ selector, how, labels }` or `{ selector: null, ... }` with
 * everything it did see, which is what the caller needs to say something
 * useful.
 */
async function findControl(page, { label, idHint, optionText, tag = "select" }) {
  return await page.evaluate(
    ({ label, idHint, optionText, tag }) => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const want = norm(label);
      const sel = (el) => (el.id ? `#${el.id}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : null);
      const seen = [];

      for (const el of document.querySelectorAll(tag)) {
        seen.push({
          selector: sel(el) || "(no id or name)",
          options: tag === "select"
            ? [...el.options].slice(0, 12).map((o) => norm(o.textContent)).filter(Boolean)
            : [],
        });
      }

      // 1 — the label, by <label for> or by the cell beside it.
      if (want) {
        for (const l of document.querySelectorAll("label")) {
          if (norm(l.textContent) !== want) continue;
          const t = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector(tag);
          if (t && t.tagName.toLowerCase() === tag && sel(t)) return { selector: sel(t), how: "label", seen };
        }
        for (const cell of document.querySelectorAll("td, th, div")) {
          if (norm(cell.textContent) !== want) continue;
          let sib = cell.nextElementSibling;
          for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
            const t = sib.matches(tag) ? sib : sib.querySelector(tag);
            if (t && sel(t)) return { selector: sel(t), how: "adjacent label cell", seen };
          }
        }
      }

      // 2 — an id or name that says what it is.
      if (idHint) {
        for (const el of document.querySelectorAll(tag)) {
          const id = norm(el.id) + " " + norm(el.name);
          if (id.includes(norm(idHint)) && sel(el)) return { selector: sel(el), how: "id", seen };
        }
      }

      // 3 — a select already holding the thing we mean to choose. Last,
      // because it is the only one of the three that could match the right
      // text on the wrong control.
      if (optionText && tag === "select") {
        const wantOpt = norm(optionText);
        for (const el of document.querySelectorAll("select")) {
          const hit = [...el.options].some((o) => norm(o.textContent).includes(wantOpt));
          if (hit && sel(el)) return { selector: sel(el), how: "an option matching the card", seen };
        }
      }
      return { selector: null, how: "", seen };
    },
    { label, idHint, optionText, tag }
  );
}

/* ------------------------------------------------------------- the results */

/**
 * The results grid, read off the page.
 *
 * NOT MEASURED, SO DISCOVERED. The grid is the table that has a header row, at
 * least three named columns, and a checkbox on its body rows — a payment
 * screen's results table is the only thing on the page that is all three.
 *
 * Every row is returned with the SELECTOR FOR ITS OWN CHECKBOX, built from the
 * box's name and value. Not its index: ticking a row on Tramada's reconcile
 * screen reorders the table under you (§6), and there is no reason to assume
 * this screen is kinder. A row whose checkbox has neither a name nor an id
 * comes back with an empty `selectId` and is never ticked, because there would
 * be nothing to address it by afterwards to prove the tick landed.
 */
async function readResultsGrid(page) {
  return await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const cssEscape = (s) => String(s).replace(/["\\]/g, "\\$&");

    let best = null;
    for (const table of document.querySelectorAll("table")) {
      const trs = [...table.querySelectorAll("tr")];
      if (trs.length < 2) continue;
      const headers = [...trs[0].cells].map((c) => clean(c.textContent));
      if (headers.filter(Boolean).length < 3) continue;
      const boxes = table.querySelectorAll('input[type="checkbox"]');
      if (!boxes.length) continue;
      // The biggest such table wins — a screen can carry a small one for its
      // own controls, and the results are the long one.
      if (!best || trs.length > best.trs.length) best = { table, trs, headers };
    }
    if (!best) {
      return {
        found: false,
        headers: [],
        rows: [],
        tables: [...document.querySelectorAll("table")].map((t) => {
          const h = t.querySelector("tr");
          return h ? [...h.cells].map((c) => clean(c.textContent)).filter(Boolean).join(" | ") : "";
        }).filter(Boolean).slice(0, 8),
      };
    }

    const rows = [];
    for (const tr of best.trs.slice(1)) {
      const box = tr.querySelector('input[type="checkbox"]');
      if (!box) continue;
      const cells = [...tr.cells].map((c) => clean(c.textContent));
      if (!cells.filter(Boolean).length) continue;
      /* NAME + VALUE FIRST, AN ID ONLY WHEN IT IS UNIQUE. Measured 23-09-2026 on
         the Agency CC Reimbursement grid: every row's checkbox is
         `id="segmentsToAllocate"`, told apart only by `value={segmentId}`.
         Preferring the id gave every row the selector `#segmentsToAllocate`,
         so ticking "row 3" would have ticked row 1 and the read-back would
         have agreed with it. */
      let selector = "";
      const uniqueId = box.id && document.querySelectorAll(`[id="${cssEscape(box.id)}"]`).length === 1;
      if (box.name && box.value) {
        selector = `input[type="checkbox"][name="${cssEscape(box.name)}"][value="${cssEscape(box.value)}"]`;
      } else if (uniqueId) selector = `#${box.id}`;
      rows.push({
        cells,
        selectId: selector,
        boxName: box.name || "",
        boxValue: box.value || "",
        alreadyTicked: !!box.checked,
        disabled: !!box.disabled,
      });
    }
    return { found: true, headers: best.headers, rows, tables: [] };
  });
}

/**
 * Tick one row. A real click, then poll for it.
 *
 * `checked = true` is not ticking a box on this portal — both the receipt
 * form's segments and the reconcile screen's transactions hang their arithmetic
 * off a bound click handler, and step 14 says ticking a row here "auto-fills the
 * full transaction amount into the adjacent amount field", which is that same
 * handler. Setting the property would leave the amount box empty and the row
 * looking ticked.
 *
 * Polled rather than slept: a single fixed wait caught the reconcile screen
 * mid-settle and reported a click that had genuinely landed as a failure.
 */
async function tickRow(page, selector) {
  const box = page.locator(selector).first();
  if (!(await box.count())) return { ticked: false, why: "the row's checkbox is no longer on the page" };
  if (await box.isChecked().catch(() => false)) return { ticked: true, already: true };

  for (let attempt = 0; attempt < 2; attempt++) {
    await box.click().catch(() => {});
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      if (await box.isChecked().catch(() => false)) return { ticked: true };
    }
  }
  return { ticked: false, why: "the click did not register" };
}

/**
 * Whatever the page is complaining about, if anything.
 *
 * ONLY WHAT IS ACTUALLY ON SCREEN. Measured 22-09-2026: this form ships its
 * validation messages as divs that are always in the markup and hidden until
 * they apply — `#advancedSearchTextAreaErrorDiv` sits there permanently reading
 * "You cannot put more than 50 values in the Text area. Please use file upload
 * option." Reading the DOM without asking whether the element is visible
 * reported that as the reason a perfectly good search had failed, on a form
 * whose Advanced Search text area was empty and had never been touched.
 *
 * So an element is a complaint only if it is rendered: `offsetParent` covers
 * `display:none` on it or any ancestor, and the explicit checks cover the
 * `visibility:hidden` and zero-size cases `offsetParent` misses. Anything
 * still standing is something a person would see.
 */
async function errorBanner(page) {
  return await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    /* Walked up the ancestors rather than read off the element, because
       `display:none` on a wrapper hides everything inside it while the child's
       own computed display reads perfectly normal — which is exactly how this
       form hides its validation divs.

       The size check is applied ONLY where there is a layout engine to ask.
       jsdom reports every rect as zero, so requiring one would make this
       function answer "nothing is visible" in the offline tests while
       answering correctly in Chrome — a check that passes for the wrong
       reason. */
    const hasLayout = document.body.getBoundingClientRect().height > 0;
    const shown = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      }
      if (!hasLayout) return true;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const boxes = [...document.querySelectorAll('.error, .errors, .errorMessage, [class*="error" i], [id*="error" i]')]
      .filter(shown)
      .map((b) => clean(b.textContent))
      .filter((t) => t && t.length < 300);
    return boxes[0] || "";
  }).catch(() => "");
}

/**
 * A button found by what it SAYS, not by an id nobody has measured.
 *
 * Returns the selector, or null plus every button it did see — which is the
 * only useful thing to print when Tramada renames one.
 */
async function findButton(page, wantText) {
  return await page.evaluate((wantText) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const want = new RegExp(wantText, "i");
    const all = [...document.querySelectorAll('input[type="button"], input[type="submit"], button, a.button')];
    const seen = all.map((b) => `${b.id ? "#" + b.id : "(no id)"} "${norm(b.value || b.textContent).slice(0, 40)}"`);
    for (const b of all) {
      const text = norm(b.value || b.textContent);
      if (!want.test(text)) continue;
      if (b.id) return { selector: `#${b.id}`, text, seen };
      if (b.name) return { selector: `[name="${b.name}"]`, text, seen };
    }
    return { selector: null, text: "", seen };
  }, wantText);
}

/**
 * READ-ONLY. What a labelled field on the page actually is — selector, tag,
 * current value, readonly/disabled, and its options if it is a select.
 *
 * For a block of the screen nothing has measured yet (a "Payment Overview" /
 * "Credit Card Details" / "Document Details" section, say): give it the labels
 * as printed on screen and get back what each one really is, rather than
 * guessing an id and finding out from a validation banner that it was wrong.
 * Same label-then-adjacent-cell strategy `findControl` uses, generalised across
 * every tag a labelled field might be (`findControl` only ever searches one).
 * Ticks nothing, types nothing, saves nothing.
 */
async function describeFields(page, labels) {
  return await page.evaluate((labels) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const low = (s) => norm(s).toLowerCase();
    const sel = (el) => (el.id ? `#${el.id}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : null);
    const FIELD_TAGS = "input, select, textarea";

    const describe = (el, how) => {
      const tag = el.tagName.toLowerCase();
      return {
        selector: sel(el) || "(no id or name)",
        how,
        tag,
        type: tag === "input" ? (el.type || "text") : "",
        value: tag === "select" ? (el.options[el.selectedIndex] || {}).text || "" : el.value || "",
        readOnly: !!el.readOnly,
        disabled: !!el.disabled,
        options: tag === "select" ? [...el.options].slice(0, 12).map((o) => norm(o.textContent)).filter(Boolean) : [],
      };
    };

    const findFor = (label) => {
      const want = low(label);
      for (const l of document.querySelectorAll("label")) {
        if (low(l.textContent) !== want) continue;
        const t = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector(FIELD_TAGS);
        if (t) return describe(t, "label");
      }
      for (const cell of document.querySelectorAll("td, th, div, span")) {
        if (low(cell.textContent) !== want) continue;
        let sib = cell.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
          const t = sib.matches(FIELD_TAGS) ? sib : sib.querySelector(FIELD_TAGS);
          if (t) return describe(t, "adjacent cell");
        }
      }
      return { selector: null, how: "not found by label or adjacent cell", tag: "", value: "", readOnly: false, disabled: false, options: [] };
    };

    return labels.map((label) => ({ label, ...findFor(label) }));
  }, labels);
}

module.exports = {
  TRAMADA_BASE_URL,
  SEARCH,
  CHOOSER,
  sleep,
  clean,
  tramadaDate,
  openBrowser,
  assertSignedIn,
  openIssuePayments,
  describeFields,
  optionsOf,
  pick,
  setByLabel,
  findControl,
  readResultsGrid,
  tickRow,
  errorBanner,
  findButton,
};

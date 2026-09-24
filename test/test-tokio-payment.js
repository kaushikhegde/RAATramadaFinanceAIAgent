"use strict";

/**
 * Steps 11 to 14 — Issue Creditor Payment, without a browser.
 *
 * tramada-tokio.js's page work happens inside `page.evaluate(fn, arg)` and
 * `page.locator(...)`. That is the seam: a small stub running those same
 * functions against a jsdom document exercises the REAL code — the column
 * lookup, the BR12 choice between two lines carrying one policy, the read-back
 * after ticking — with no Tramada and no login.
 *
 * What this cannot test is whether the SELECTORS match the live page. Nothing
 * in PAYMENT has been measured yet; `node tools/probe-tokio-payments.js`
 * settles that, and firstPresent() is written to report what a page actually
 * contains when none of its candidates are found.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");
const tk = require("../tramada-tokio");
const core = require("../tokio-core");

let n = 0;
const failures = [];
const check = async (what, fn) => {
  try { await fn(); n++; console.log("  ok  " + what); }
  catch (err) { failures.push(what); console.log("  NOT OK  " + what + "\n      " + err.message); }
};

/** A Playwright-ish page backed by jsdom. */
function fakePage(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const { window } = dom;
  const page = {
    window,
    document: window.document,
    // What Playwright-level actions the code performed. jsdom has no trusted
    // events, so "was this a REAL click?" cannot be seen in the DOM — only in
    // whether check() was used at all.
    calls: [],
    async evaluate(fn, arg) {
      const globals = { document: window.document, window, HTMLInputElement: window.HTMLInputElement, Event: window.Event };
      const saved = {};
      for (const k of Object.keys(globals)) { saved[k] = global[k]; global[k] = globals[k]; }
      try { return await fn(arg); } finally { Object.assign(global, saved); }
    },
    async fill(sel, v) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error("fill: no " + sel);
      el.value = v;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    async inputValue(sel) {
      const el = window.document.querySelector(sel);
      return el ? String(el.value) : null;
    },
    async click(sel) { page.calls.push({ action: "click", sel }); },
    async waitForLoadState() {},
    // Which page we are on decides whether "no grid" means no rows or a
    // navigation that went wrong, so the stub has to answer it.
    url() { return page._url || 'https://asp.tramada.com.au/ttms/x/finance/finance-payments-issue.htm'; },
    /* Go opens the results in a NEW WINDOW. The stub models that the way
       Playwright surfaces it: context().waitForEvent("page"). `page._popup`
       is what that call resolves to; leaving it unset models a click that
       opens nothing, which is how a refused search behaves. */
    context() {
      return {
        async waitForEvent(name) {
          if (name !== "page") throw new Error("unexpected event " + name);
          if (!page._popup) { await new Promise((r) => setTimeout(r, 5)); throw new Error("timeout"); }
          return page._popup;
        },
      };
    },
    async isEnabled() { return page._goDisabled !== true; },
    async bringToFront() { page.calls.push({ action: "bringToFront" }); },
    async selectOption(sel, value) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error("selectOption: no " + sel);
      el.value = typeof value === "object" && value ? (value.value != null ? value.value : value.label) : value;
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
      return [el.value];
    },
    async inputValue(sel) {
      const el = window.document.querySelector(sel);
      return el ? String(el.value) : null;
    },
    async waitForSelector() {},
    async type(sel, text) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error("type: no " + sel);
      el.value = (el.value || "") + text;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    async waitForTimeout() {},
    async $$eval(sel, fn) {
      return fn(Array.from(window.document.querySelectorAll(sel)));
    },
    locator(sel) {
      const els = Array.from(window.document.querySelectorAll(sel));
      const wrap = (list) => ({
        async count() { return list.length; },
        first() { return wrap(list.slice(0, 1)); },
        nth(i) { return wrap(list.slice(i, i + 1)); },
        last() { return wrap(list.slice(-1)); },
        // Playwright's locator.filter({ hasText }) — the creditor picker uses it.
        filter(opts) {
          const t = opts && (opts.hasText != null ? opts.hasText : opts.has_text);
          if (t == null) return wrap(list);
          const re = t instanceof RegExp ? t : new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          return wrap(list.filter((el) => re.test((el.textContent || "").replace(/\s+/g, " ").trim())));
        },
        async allTextContents() {
          return list.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
        },
        /* Playwright locators nest: page.locator(a).locator(b) scopes b
           inside a. tickMatchingRows relies on it to re-resolve a row's
           checkbox after Tramada re-renders the row. */
        locator(inner) {
          const found = [];
          for (const el of list) for (const m of el.querySelectorAll(inner)) found.push(m);
          return wrap(found);
        },
        async fill(v) {
          const el = list[0];
          if (!el) throw new Error("fill: nothing matches " + sel);
          el.value = v;
          el.dispatchEvent(new window.Event("input", { bubbles: true }));
          el.dispatchEvent(new window.Event("change", { bubbles: true }));
        },
        async textContent() { return list[0] ? list[0].textContent : null; },
        async check() {
          page.calls.push({ action: "check", sel });
          const el = list[0];
          if (!el) throw new Error("check: nothing matches " + sel);
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new window.Event("click", { bubbles: true }));
            el.dispatchEvent(new window.Event("change", { bubbles: true }));
          }
        },
        async click() {
          page.calls.push({ action: "click", sel });
          /* Tramada fills the Creditor Code field from the suggestion you
             click. The stub does the same, so the read-back that insists on
             a resolved "[CODE] Name" is exercised rather than bypassed. */
          const el = list[0];
          if (el && el.closest && el.closest("#creditor_auto_complete_div")) {
            const inp = window.document.querySelector("#creditor");
            if (inp) {
              inp.value = (el.textContent || "").replace(/\s+/g, " ").trim();
              inp.dispatchEvent(new window.Event("change", { bubbles: true }));
            }
          }
        },
        async evaluate(fn, v) {
          const saved = { HTMLInputElement: global.HTMLInputElement, Event: global.Event };
          global.HTMLInputElement = window.HTMLInputElement;
          global.Event = window.Event;
          try { return fn(list[0], v); } finally { Object.assign(global, saved); }
        },
      });
      return wrap(els);
    },
  };
  return page;
}

/** The results grid, shaped the way step 10 leaves it: sorted by Reference. */
function grid(rows) {
  /* THE REAL ROW, measured off finance-creditor-payment.htm 24-Sep-2026.
     Column order and the hidden cells are reproduced because both matter:
     the tick a person makes is the LAST input in the row, and the FIRST
     checkbox is a hidden BSP one. The old stub had a single checkbox, so
     code that grabbed the first passed every offline test and failed on
     every live run. A stub simpler than the page it stands for tests
     nothing. */
  return `<table>
    <tr>
      <th>D</th><th>R</th><th>Seg. Type</th><th>Booking No.</th><th>Reference</th>
      <th>Issue/Conf. Date</th><th class="hidden">id</th><th class="hidden">bsp</th>
      <th>Creditor Nett</th><th>Creditor Paid</th><th>Creditor Payable</th>
      <th>Allocate</th><th>A</th>
    </tr>
    ${rows.map((r, i) => {
      const seg = 82400 + i;
      return `<tr>
      <td><a href="#" title="${seg}">*</a></td>
      <td><a href="#">R</a></td>
      <td>INS</td>
      <td>${r.booking || ""}</td>
      <td class="col-wrap">${r.reference}</td>
      <td>23-09-2026</td>
      <td class="hidden">${89400 + i}</td>
      <td class="hidden"><input type="checkbox" name="isForAutoBspPayment_${seg}" id="isForAutoBspPayment_${seg}"></td>
      <td>${r.amount}</td>
      <td>0.00</td>
      <td>${r.amount}</td>
      <td><input type="text" name="allocationAmount_${seg}" id="allocationAmount_${seg}" disabled readonly></td>
      <td><input type="checkbox" name="segmentsToAllocate" id="segmentsToAllocate" value="${seg}"></td>
    </tr>`;
    }).join("")}
  </table>`;
}

// EIGHT digits, not nine. The guide writes the series as "210XXXXXX", but
// every policy in RAA's own data is 21 followed by six — 21087245 — and
// tokio-core's policyKey refuses nine on purpose, with a test saying so.
// Real data wins over the wording.

/** A consolidated Travel row, as buildConsolidated() emits them. */
const travel = (policy, nett) => ({
  policy,
  outcome: core.OUTCOME.TRAVEL,
  appended: { "RAA Total Nett": nett },
});

(async () => {
  console.log("\nreading the grid");

  await check("columns are found by heading, not by index", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00", booking: "13061" }]));
    const out = await tk.readTransactionPage(page);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.rows.length, 1);
    assert.strictEqual(out.rows[0].reference, "21087245");
    assert.strictEqual(out.rows[0].amount, 700);
    assert.strictEqual(out.rows[0].bookingNo, "13061");
  });

  await check("a reordered grid still reads correctly", async () => {
    const page = fakePage(`<table>
      <tr><th>Creditor Payable</th><th>Reference</th><th>A</th></tr>
      <tr><td>250.50</td><td>21099988</td><td><input type="checkbox"></td></tr>
    </table>`);
    const out = await tk.readTransactionPage(page);
    assert.strictEqual(out.rows[0].reference, "21099988");
    assert.strictEqual(out.rows[0].amount, 250.5);
  });

  await check("a page with no grid says so rather than reporting zero rows", async () => {
    const out = await tk.readTransactionPage(fakePage(`<p>No transactions found.</p>`));
    assert.strictEqual(out.found, false);
  });

  await check("every row gets its own handle", async () => {
    const page = fakePage(grid([
      { reference: "21087245", amount: "150.00" },
      { reference: "21087245", amount: "700.00" },
    ]));
    const out = await tk.readTransactionPage(page);
    assert.strictEqual(new Set(out.rows.map((r) => r.handle)).size, 2,
      "two rows sharing a reference must still be separately addressable");
  });

  await check("a grid row whose reference has no policy number is REPORTED, not skipped", async () => {
    /* A row whose reference genuinely carries no policy number — a quote
       that was never replaced, which RCC really does contain. It sat on the
       grid and was passed over without a word, and the Travel line was then
       reported as "not found in Tramada" — a different claim from "found,
       but its reference could not be read".
       (This test used to use 2100044, seven digits, back when policyKey
       demanded 21 + six. That rule was wrong and is gone; the reporting it
       exposed is what still matters.) */
    const page = fakePage(grid([
      { reference: "RAAQ-846157711 - QUOTE NEVER CONVERTED", amount: "70.00" },
      { reference: "21087245", amount: "700.00" },
    ]));
    const steps = [];
    await tk.tickMatchingRows(page, [travel("21087245", 700)], { onStep: (s) => steps.push(s) });
    const note = steps.find((s) => s.step === "unreadable reference");
    assert.ok(note, `no step reported the unreadable row; got ${JSON.stringify(steps.map((s) => s.step))}`);
    assert.match(note.detail, /RAAQ/, "the unreadable reference must be quoted back");
  });

  await check("a fully readable grid does not cry wolf", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const steps = [];
    await tk.tickMatchingRows(page, [travel("21087245", 700)], { onStep: (s) => steps.push(s) });
    assert.ok(!steps.some((s) => s.step === "unreadable reference"));
  });

  console.log("\nstep 10 — Go opens the results in a NEW WINDOW");

  /* THE BUG THIS PAIR EXISTS FOR — 24-Sep-2026, and it cost the most.
     Clicking Go does not navigate the search form. Tramada opens
     finance-creditor-payment.htm in a SEPARATE window and leaves the form
     exactly as it was. Code that clicks Go and then reads the same `page`
     sees the form it started with — no grid, no header — and reports
     "nothing outstanding" against a creditor with pages of segments. We
     told RAA their sandbox was broken on the strength of it. */
  const SEARCH_FORM = `
    <table>
      <tr><td>Payment Category</td><td><select id="paymentType"><option value=""></option><option value="CREDITOR_PAYMENT">Creditor Payment</option></select></td></tr>
      <tr><td>Bank Account</td><td><select id="agencyBankAccount"><option value=""></option><option value="1">[TRUST] Trust Account</option></select></td></tr>
      <tr><td>Creditor Code</td><td><input id="creditor" value="[TOKIOMARINE] Tokio Marine"></td></tr>
      <tr><td>Level 1 Branch</td><td><select id="level1Branch"><option value=""></option><option value="1" selected>[ADL] RAA Adelaide</option></select></td></tr>
      <tr><td>From</td><td><input id="fromTransactionDate" value="01-08-2026"></td></tr>
      <tr><td>To</td><td><input id="toTransactionDate" value="22-10-2026"></td></tr>
      <tr><td>Sort by</td><td><select id="sortBy"><option value=""></option><option value="REFERENCE">Reference</option></select></td></tr>
      <tr><td>Sort order</td><td><select id="sortOrder"><option value="ASCENDING">Ascending</option></select></td></tr>
    </table>
    <div id="creditor_auto_complete_div"><ul><li>[TOKIOMARINE] Tokio Marine</li></ul></div>
    <input type="button" id="goButton" value="Go">
    <input type="button" id="form_clearButton" value="Clear">`;

  await check("the results window is followed, not the form left behind", async () => {
    const form = fakePage(SEARCH_FORM);
    const results = fakePage(
      '<h3>Segments To Allocate</h3>' + grid([{ reference: "21087245", amount: "700.00", booking: "13817" }]),
      // Playwright would give us the popup's own url.
    );
    results._url = "https://asp.tramada.com.au/ttms/x/finance/finance-creditor-payment.htm?dataContainerId=854";
    form._popup = results;

    const out = await tk.searchCreditorPayments(form, { creditor: "Tokio" });
    assert.strictEqual(out.openedInNewWindow, true, "the popup was not detected");
    assert.strictEqual(out.page, results, "the caller must be handed the RESULTS page, not the form");

    // And the grid really is readable on it, which the form would never give.
    const read = await tk.readTransactionPage(out.page);
    assert.strictEqual(read.found, true);
    assert.strictEqual(read.rows[0].reference, "21087245");
  });

  await check('a refused search says so instead of reporting "nothing outstanding"', async () => {
    /* "Creditor Code must be entered" is a red banner on the form and
       NOTHING else changes — no popup, no navigation. Read as an empty
       result it says the creditor owes nothing, which is a different and
       much more damaging claim than "you did not fill the form in". */
    const form = fakePage(SEARCH_FORM + '<div class="err">Creditor Code must be entered</div>');
    // no _popup — the click opens nothing
    await assert.rejects(
      () => tk.searchCreditorPayments(form, { creditor: "Tokio" }),
      (err) => {
        assert.match(err.message, /must be entered/i, err.message);
        assert.match(err.message, /not an empty result/i,
          "the message has to rule out the reading that misled us");
        return true;
      }
    );
  });

  await check("the header is found by LABEL when the ids are not what we guessed", async () => {
    /* The Payment Overview header was only ever seen in a screenshot, so
       PAYMENT's ids are guesses while the labels are certain. This is the
       real page's layout with DIFFERENT ids — if only the guesses worked,
       step 11 would fail on the live page and take 12-14 with it. */
    const page = fakePage(`
      <h3>Payment Overview</h3>
      <table>
        <tr><td>Transaction Type</td><td><select id="wibble"><option></option><option value="ET">EFT</option></select></td></tr>
        <tr><td>Payee Name</td><td><input type="text" id="wobble"></td></tr>
        <tr><td>Reference</td><td><input type="text" id="wubble"></td></tr>
      </table>` + grid([{ reference: "21087245", amount: "700.00" }]));

    const out = await tk.fillPaymentHeader(page, { reference: "TOKIO_AUG 2026" });
    assert.strictEqual(out.transactionType, "EFT");
    assert.strictEqual(out.payeeName, "Tokio");
    assert.strictEqual(out.reference, "TOKIO_AUG 2026");
    assert.strictEqual(page.window.document.querySelector("#wibble").value, "ET",
      "the select found by label must actually be the one set");
  });

  await check("a label that matches nothing still reports what the page has", async () => {
    // The fallback must not swallow a genuinely wrong page.
    const page = fakePage('<h3>Payment Overview</h3><input id="nothingUseful">' +
      grid([{ reference: "21087245", amount: "700.00" }]));
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_AUG 2026" }),
      (err) => { assert.match(err.message, /nothingUseful|Could not find/i, err.message); return true; }
    );
  });

  console.log("\nstep 11 — refusing to hunt for a header that is not there");

  /* The live failure this pair exists for: the dashboard reported "Could not
     find the Transaction Type select … Run probe-tokio-payments.js and update
     PAYMENT" against [TOKIOMARINE] Tokio Marine over 01-08-2026 → 20-10-2026.
     Nothing was wrong with PAYMENT. The search had returned nothing, so the
     page was still the search form and the header had never been drawn. */
  const SEARCH_FORM_ONLY = `
    <table>
      <tr><td>Creditor Code</td><td><input id="creditor"></td></tr>
      <tr><td>Level 1 Branch</td><td><select id="level1Branch"></select></td></tr>
    </table>
    <input type="button" id="goButton" value="Go">
    <input type="button" id="form_clearButton" value="Clear">`;

  await check("an empty search is reported as empty, not as a missing selector", async () => {
    await assert.rejects(
      () => tk.fillPaymentHeader(fakePage(SEARCH_FORM_ONLY), { reference: "TOKIO_Aug 2026" }),
      (err) => {
        assert.ok(
          /returned no segments/i.test(err.message),
          `wanted an empty-result message, got: ${err.message}`
        );
        assert.ok(
          !/update PAYMENT/i.test(err.message),
          "an empty search must not send anyone off to re-probe the selectors"
        );
        return true;
      }
    );
  });

  await check("a genuinely missing selector still says so, with the grid present", async () => {
    // Grid drawn (so the search DID find something) but no Transaction Type
    // anywhere: that is a real selector problem and must read like one.
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]) +
      `<input type="button" id="goButton" value="Go">`);
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_Aug 2026" }),
      (err) => {
        assert.ok(/update PAYMENT/i.test(err.message), `wanted the probe hint, got: ${err.message}`);
        return true;
      }
    );
  });

  await check("step 11 is never attempted before the grid is known to exist", () => {
    // Ordering is the actual fix; a source check is the only seam for it
    // short of a live Tramada, and it bites if anyone moves the call back.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    const body = src.slice(src.indexOf("async function runTokioReconciliation"));
    const guard = body.indexOf("firstPage.found");
    const header = body.indexOf("await fillPaymentHeader");
    assert.ok(guard > -1, "runTokioReconciliation no longer checks for a grid first");
    assert.ok(header > -1 && guard < header,
      "fillPaymentHeader must come AFTER the empty-grid guard");
  });

  console.log("\nsteps 12-13 — matching and ticking");

  await check("a policy that matches on reference and amount is ticked", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const { results } = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ticked, true);

    /* THE A COLUMN, and only it. The first checkbox in the row is a HIDDEN
       isForAutoBspPayment_<segId>; ticking that instead is what made every
       live run report a correct match as a row Tramada "would not keep
       ticked". Asserting on the named box is what makes that impossible to
       reintroduce. */
    const a = page.document.querySelector('input[name="segmentsToAllocate"]');
    assert.strictEqual(a.checked, true, "column A must be ticked");
    const hidden = page.document.querySelector('input[name^="isForAutoBspPayment"]');
    assert.strictEqual(hidden.checked, false, "the hidden BSP checkbox must be left alone");
  });

  await check("BR13 — a cent of rounding is inside tolerance", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.01" }]));
    const { results } = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(results[0].ticked, true);
  });

  await check("BR13 — beyond ±1% is not ticked, and says why", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "800.00" }]));
    const { results } = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(results[0].ticked, false);
    assert.match(results[0].remark, /Amount does not match in Tramada/);
    assert.strictEqual(page.document.querySelector('input[type="checkbox"]').checked, false);
  });

  await check("BR12 — the line matching the AMOUNT is ticked, not the first with that policy", async () => {
    // The guide's own case: an extension added in a later month puts the same
    // policy on the list twice with different amounts.
    const page = fakePage(grid([
      { reference: "21087245", amount: "150.00" },
      { reference: "21087245", amount: "700.00" },
    ]));
    const { results } = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(results[0].ticked, true);
    assert.strictEqual(results[0].amount, 700);

    // Column A on each row — not the hidden BSP boxes that also match
    // input[type=checkbox] and come first.
    const a = Array.from(page.document.querySelectorAll('input[name="segmentsToAllocate"]'));
    assert.strictEqual(a.length, 2);
    assert.strictEqual(a[0].checked, false, "the 150.00 line must be left alone");
    assert.strictEqual(a[1].checked, true);
    assert.ok(
      Array.from(page.document.querySelectorAll('input[name^="isForAutoBspPayment"]')).every((b) => !b.checked),
      "no hidden BSP checkbox should have been touched"
    );
  });

  await check("BR15 — a policy absent from this page is left for a later page", async () => {
    const page = fakePage(grid([{ reference: "21011111", amount: "700.00" }]));
    const { results } = await tk.tickMatchingRows(page, [travel("21099999", 700)]);
    assert.strictEqual(results.length, 0, "silence here, not a 'not found' on each of fifty pages");
  });

  await check("step 8 — an exception row is never ticked", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const flagged = { policy: "21087245", outcome: core.OUTCOME.EXCEPTION, appended: { "RAA Total Nett": 700 } };
    const { results } = await tk.tickMatchingRows(page, [flagged]);
    assert.strictEqual(results.length, 0);
    assert.strictEqual(page.document.querySelector('input[type="checkbox"]').checked, false);
  });

  await check("a Retail row is never ticked either", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const retail = { policy: "21087245", outcome: core.OUTCOME.RETAIL, appended: { "RAA Total Nett": 700 } };
    const { results } = await tk.tickMatchingRows(page, [retail]);
    assert.strictEqual(results.length, 0);
  });

  await check("the tick goes through a real check(), addressed by handle", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    const checks = page.calls.filter((c) => c.action === "check");
    assert.strictEqual(checks.length, 1, JSON.stringify(page.calls));
    assert.match(checks[0].sel, /data-tokio-row/,
      "by the row's own handle — BR12 means one reference can name two rows");
  });

  await check("a tick survives Tramada re-ORDERING the grid", async () => {
    /* THE BUG THAT KEPT REPORTING A CORRECT TICK AS A REFUSAL.
       Rows are tagged tokio-row-<index>, which is only stable while the DOM
       is. Ticking A makes Tramada redraw the grid; if the redraw re-orders
       it, index 0 afterwards is a DIFFERENT LINE. The old check read that
       other row's state and called a good tick a refusal — live, 220044
       ticked at 175 and was then reported as one "Tramada would not keep
       ticked". Identity is reference + amount, not position. */
    const page = fakePage(grid([
      { reference: "21087245", amount: "700.00" },
      { reference: "21099988", amount: "250.50" },
    ]));
    const doc = page.document;
    const rows = () => Array.from(doc.querySelectorAll("tr")).filter((r) => r.querySelector("input"));
    // Ticking anything flips the two rows around, as a redraw may.
    for (const box of doc.querySelectorAll('input[type="checkbox"]')) {
      box.addEventListener("click", () => {
        const [a, b] = rows();
        if (a && b && b.parentNode) b.parentNode.insertBefore(b, a);
      });
    }

    const out = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].ticked, true,
      "the row moved, it did not come untick");
    assert.strictEqual(out.results[0].policy, "21087245");
  });

  await check("BR12 — the right sibling is verified when a reference repeats", () => {
    // Two lines, one policy, different amounts. Re-finding by reference alone
    // would answer about whichever came first.
    const rows = [
      { handle: "tokio-row-0", reference: "21087245", amount: 150, ticked: false },
      { handle: "tokio-row-1", reference: "21087245", amount: 700, ticked: true },
    ];
    const found = tk.findSameLine(rows, { reference: "21087245", amount: 700, handle: "tokio-row-9" });
    assert.ok(found, "the line should still be found after a redraw");
    assert.strictEqual(found.amount, 700, "it must be the line the AMOUNT chose");
    assert.strictEqual(found.ticked, true);
  });

  await check("a stale handle pointing at another reference is not trusted", () => {
    const rows = [{ handle: "tokio-row-0", reference: "21099988", amount: 250.5, ticked: true }];
    // The handle matches, the reference does not — the row at that index changed.
    const found = tk.findSameLine(rows, { reference: "21087245", amount: 700, handle: "tokio-row-0" });
    assert.strictEqual(found, null, "it must not answer about a different policy");
  });

  await check("a tick that will not stay is reported, and the page carries on", async () => {
    /* Live 24-Sep-2026: 220044 matched and was ticked correctly, then the
       read-back 120ms later found it unticked and the whole run stopped —
       on a row it had got RIGHT. The A column does not settle instantly;
       Tramada's handler fills the Allocate cell and re-renders the row.
       So a row is now retried, and a genuine refusal is recorded against
       THAT ROW while the rest of the page still gets ticked. Nothing is
       saved either way — saving takes the literal. */
    const page = fakePage(grid([
      { reference: "21087245", amount: "700.00" },
      { reference: "21099988", amount: "250.50" },
    ]));
    // Column A on each row — the hidden BSP boxes also match
    // input[type=checkbox] and come first in the row.
    const boxes = Array.from(page.document.querySelectorAll('input[name="segmentsToAllocate"]'));
    // The first row refuses to hold its tick, however often it is clicked.
    Object.defineProperty(boxes[0], "checked", { get: () => false, set: () => {}, configurable: true });

    const out = await tk.tickMatchingRows(page, [
      travel("21087245", 700),
      travel("21099988", 250.5),
    ]);

    const stubborn = out.results.find((r) => r.policy === "21087245");
    assert.ok(stubborn, "the refusing row must still be reported");
    assert.strictEqual(stubborn.ticked, false);
    assert.match(stubborn.remark, /would not keep this row ticked/i);

    const other = out.results.find((r) => r.policy === "21099988");
    assert.ok(other && other.ticked, "one stubborn row must not stop the rest of the page");
  });

  await check("a tick that needs a second click is retried, not abandoned", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const box = page.document.querySelector('input[name="segmentsToAllocate"]');
    let clicks = 0;
    let held = false;
    Object.defineProperty(box, "checked", {
      get: () => held,
      // First click is dropped, as Tramada's re-render does; the second holds.
      set: () => { clicks += 1; if (clicks >= 2) held = true; },
      configurable: true,
    });
    const out = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(out.results[0].ticked, true, "the retry must rescue it");
    assert.ok(clicks >= 2, "it should have clicked more than once");
  });

  // An empty search and a wrong page look identical in the DOM — Tramada
  // renders no table either way. The URL is what tells them apart, and
  // getting it wrong cost a run: a creditor with nothing outstanding was
  // reported as a crash instead of as the true answer.
  await check("no rows on the Issue Payments screen is an answer, not a crash", async () => {
    const page = fakePage("<p>nothing here</p>");
    const out = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(out.empty, true);
    assert.deepStrictEqual(out.results, []);
  });

  await check("no rows ANYWHERE ELSE is still a crash", async () => {
    const page = fakePage("<p>nothing here</p>");
    page._url = "https://asp.tramada.com.au/ttms/x/home/notice-board.htm";
    await assert.rejects(
      () => tk.tickMatchingRows(page, [travel("21087245", 700)]),
      /Expected the Issue Payments screen and found .*notice-board/
    );
  });

  console.log("\nstep 11 — the payment header");

  const HEADER = `
    <table>
      <tr><td>Transaction Type</td><td><select id="transactionTypeCode"><option></option><option value="ET">EFT</option><option value="CQ">Cheque</option></select></td></tr>
      <tr><td>Payee Name</td><td><input type="text" id="payeeName"></td></tr>
      <tr><td>Reference</td><td><input type="text" id="referenceNumber"></td></tr>
    </table>`;

  await check("EFT, Tokio and the TOKIO_MMM YYYY reference are set and read back", async () => {
    const out = await tk.fillPaymentHeader(fakePage(HEADER), { reference: "TOKIO_JUL 2026" });
    assert.strictEqual(out.transactionType, "EFT");
    assert.strictEqual(out.payeeName, "Tokio");
    assert.strictEqual(out.reference, "TOKIO_JUL 2026");
  });

  await check("the reference is the one tokio-core builds, not a hand-typed guess", async () => {
    const ref = core.paymentReference(new Date(2026, 6, 15));
    const out = await tk.fillPaymentHeader(fakePage(HEADER), { reference: ref });
    assert.strictEqual(out.reference, ref);
    assert.match(out.reference, /^TOKIO_[A-Z]{3} \d{4}$/);
  });

  await check("a form with no EFT option stops and lists what it does offer", async () => {
    const page = fakePage(HEADER.replace('<option value="ET">EFT</option>', ""));
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_JUL 2026" }),
      /no "EFT" option — it offers .*Cheque/
    );
  });

  await check("a missing field names what the page actually has", async () => {
    const page = fakePage(`<input type="text" id="somethingElse">`);
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_JUL 2026" }),
      (err) => {
        assert.match(err.message, /Could not find the Transaction Type select/);
        assert.match(err.message, /#somethingElse/, "it must say what IS there");
        assert.match(err.message, /probe-tokio-payments\.js/, "and how to settle it");
        return true;
      }
    );
  });

  await check("a header that drops its values is refused", async () => {
    const page = fakePage(HEADER);
    const ref = page.document.getElementById("referenceNumber");
    Object.defineProperty(ref, "value", { get: () => "", set: () => {}, configurable: true });
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_JUL 2026" }),
      /did not keep its values/
    );
  });

  await check("no reference is refused before anything is typed", async () => {
    const page = fakePage(HEADER);
    await assert.rejects(() => tk.fillPaymentHeader(page, {}), /payment reference is required/i);
  });

  await check("a missing BUTTON is reported by listing the buttons, not the form", async () => {
    /* Live 24-Sep-2026: step 14 could not find Save Session, and the message
       listed the first 30 controls — a form and a TinyMCE toolbar — so the
       one control it existed to reveal was the one it cut off. When a button
       is missing, buttons come first. */
    const page = fakePage(`
      <table><tr><td>Payee Name</td><td><input id="paymentpayeeName"></td></tr></table>
      ${Array.from({ length: 40 }).map((_, i) => `<input id="filler${i}">`).join("")}
      <div id="mceu_0-open"></div>
      <input type="button" id="paymentsaveTheThing" value="Save Payment Session">
      <input type="button" id="form_cancel" value="Cancel">`);
    await assert.rejects(
      () => tk.fillPaymentHeader(page, { reference: "TOKIO_SEP 2026" }),
      () => true
    ).catch(() => {});

    // The diagnostic itself is what is under test.
    let msg = "";
    try {
      await tk.firstPresent(page, ["#nothingLikeThis"], { what: "Save Session button", timeout: 50 });
    } catch (err) { msg = err.message; }
    assert.match(msg, /paymentsaveTheThing/, `the button should be listed; got: ${msg}`);
    assert.match(msg, /Save Payment Session/, "its label should be shown too");
    assert.ok(!/mceu_0/.test(msg), "the editor toolbar should not crowd it out");
  });

  console.log("\nstep 14 — save the session, never Issue");

  const SAVE = `
    <table><tr><td>Session Label</td><td><input type="text" id="sessionLabel"></td></tr></table>
    <input type="submit" id="saveSession" value="Save Session">
    <input type="submit" id="issue" value="Issue">`;

  await check("the session is saved under the guide's label", async () => {
    const page = fakePage(SAVE);
    const out = await tk.saveSession(page, "TOKIO_JUL 26");
    assert.strictEqual(out.label, "TOKIO_JUL 26");
    assert.strictEqual(page.document.getElementById("sessionLabel").value, "TOKIO_JUL 26");
  });

  await check("BR16 — Issue is never clicked, even though it is right there", async () => {
    const page = fakePage(SAVE);
    await tk.saveSession(page, core.sessionLabel(new Date(2026, 6, 15)));
    const clicked = page.calls.filter((c) => c.action === "click").map((c) => c.sel);
    assert.ok(clicked.includes("#saveSession"), "the session must be saved");
    assert.ok(!clicked.some((s) => /issue/i.test(s)), `Issue was clicked: ${clicked.join(", ")}`);
  });

  await check("BR16 — #issue is named only to be REFUSED, never to be clicked", () => {
    /* This used to assert the module could not name #issue at all, which was
       the right guard while nothing referenced it. It now does, on purpose:
       measured 24-Sep-2026, #issue sits two controls from the save button on
       the same page, so the run has to be able to RECOGNISE it in order to
       refuse it. The property that matters is therefore not "never named"
       but "never clicked", which is what this checks. */
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Every mention of #issue must be in the forbid-list or the guard.
    const lines = code.split("\n").filter((l) => /#issue/i.test(l));
    assert.ok(lines.length, "the guard needs to be able to name it");
    for (const l of lines) {
      assert.ok(
        /issueForbidden|looksLikeIssue|Refusing to click/.test(l),
        `#issue appears outside the guard: ${l.trim()}`
      );
    }
    // And nothing anywhere clicks it.
    assert.ok(!/click\([^)]*#issue/i.test(code), "something clicks #issue");
    assert.ok(!/value=\\?["']Issue\\?["']/.test(code), "an Issue button selector is present");
  });

  await check("BR16 — a save selector that resolves to Issue is refused", async () => {
    /* The selector list is a static promise. This is the last point it can
       be held to: if the control about to be clicked turns out to be Issue,
       by id or by the label a person reads, the run stops. An issued payment
       cannot be undone. */
    const page = fakePage(`
      <table><tr><td>Session Label</td><td><input id="paymentsessionLabel"></td></tr></table>
      <input type="button" id="issue" value="Issue">`);
    // Point the save lookup straight at Issue, as a bad edit would.
    const real = tk.PAYMENT.saveSession.slice();
    try {
      tk.PAYMENT.saveSession.length = 0;
      tk.PAYMENT.saveSession.push("#issue");
      await assert.rejects(
        () => tk.saveSession(page, "TOKIO_SEP 26"),
        (err) => {
          assert.match(err.message, /that is Issue, not Save Session/i, err.message);
          assert.match(err.message, /Nothing was saved/i);
          return true;
        }
      );
      assert.ok(!page.calls.some((c) => c.action === "click"), "it must not have clicked anything");
    } finally {
      tk.PAYMENT.saveSession.length = 0;
      real.forEach((x) => tk.PAYMENT.saveSession.push(x));
    }
  });

  await check("Tramada refusing the session is reported, not swallowed", async () => {
    const page = fakePage(SAVE + `<span>Session Label is required</span>`);
    await assert.rejects(() => tk.saveSession(page, "TOKIO_JUL 26"), /Tramada refused the session/);
  });

  await check("a label that will not stick is refused", async () => {
    const page = fakePage(SAVE);
    const el = page.document.getElementById("sessionLabel");
    Object.defineProperty(el, "value", { get: () => "", set: () => {}, configurable: true });
    await assert.rejects(() => tk.saveSession(page, "TOKIO_JUL 26"), /Session Label reads ""/);
  });

  await check("no label is refused before anything is clicked", async () => {
    const page = fakePage(SAVE);
    await assert.rejects(() => tk.saveSession(page, ""), /session label is required/i);
    assert.strictEqual(page.calls.length, 0);
  });

  console.log("\nthe creditor guard");

  // The guard exists because the wrong creditor returns a full and entirely
  // plausible list of somebody else's payments. It is parameterised, not
  // removed: the results grid's shape is not Tokio-specific, so measuring
  // readTransactionPage() needs a creditor that actually has segments — and
  // with /tokio/i hardcoded the probe resolved "[GSR] Journey Beyond"
  // correctly and was then refused for not being Tokio.
  await check("the guard defaults to Tokio and is a real regex, not a string", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    assert.match(src, /expect = \/tokio\/i/, "the default must still be Tokio");
    // Nothing may re-hardcode it further down.
    const afterDefault = src.slice(src.indexOf("expect = /tokio/i"));
    const hardcoded = afterDefault.match(/\/tokio\/i/g) || [];
    assert.strictEqual(hardcoded.length, 1,
      `/tokio/i appears ${hardcoded.length} times after the default — the guard is hardcoded again somewhere`);
  });

  console.log("\nthe search form's two live traps");

  // Measured 22-Sep-2026 in a signed-in Tramada. Both of these are invisible
  // in the results: a branch-filtered list and a search that never ran both
  // look exactly like a quiet month.
  await check("Level 1 Branch is cleared AFTER the creditor, not before", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    const creditorAt = src.indexOf('await page.type(SEARCH.creditor');
    const branchAt = src.indexOf('pick(page, SEARCH.level1Branch');
    assert.ok(creditorAt > -1 && branchAt > -1, "both steps must be present");
    assert.ok(
      branchAt > creditorAt,
      "picking a creditor makes Tramada populate Level 1 Branch itself ([ADL] RAA Adelaide), so clearing " +
        "the branch first is silently undone and the search is filtered to one branch"
    );
  });

  await check("the cleared branch is read back, not assumed", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    assert.match(src, /Level 1 Branch would not clear/, "a branch that refuses to clear must stop the search");
    assert.match(src, /level1Branch: branchNow/, "and the settled value must be reported");
  });

  await check("a disabled Go is refused rather than clicked into silence", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    assert.match(src, /isEnabled\(SEARCH\.go\)/, "Go must be checked before it is clicked");
    assert.match(src, /already been submitted once/, "and the reason said plainly");
  });

  console.log("\nsteps 9-14 in one run");

  await check("nothing to reconcile is refused before a browser is opened", async () => {
    await assert.rejects(
      () => tk.runTokioReconciliation({ consolidated: { rows: [], travel: [] } }),
      /No Travel transactions to reconcile/
    );
  });

  await check("saving takes the exact literal, and dry-run is the default", async () => {
    const sheet = { rows: [travel("21087245", 700)], travel: [travel("21087245", 700)] };
    // Wrong literal: refused before anything opens.
    await assert.rejects(
      () => tk.runTokioReconciliation({ consolidated: sheet, dryRun: false, confirm: "yes" }),
      /exact confirmation "SAVE SESSION"/
    );
    // Default: reaches the browser, which is not here — proof it did not
    // demand a literal the consultant has not given yet.
    await assert.rejects(
      () => tk.runTokioReconciliation({ consolidated: sheet }),
      (err) => !/exact confirmation/.test(err.message)
    );
  });

  await check("a bare row array is accepted as well as buildConsolidated()'s result", async () => {
    // Refused for having no Travel rows, not for the wrong shape.
    await assert.rejects(
      () => tk.runTokioReconciliation({ consolidated: [] }),
      /No Travel transactions/
    );
    const only = [{ policy: "21087245", outcome: core.OUTCOME.EXCEPTION, appended: { "RAA Total Nett": 700 } }];
    await assert.rejects(
      () => tk.runTokioReconciliation({ consolidated: only }),
      /No Travel transactions/
    );
  });

  await check("BR16 — the runner has no way to Issue", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tools", "tokio-recon.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/click\(.{0,20}issue/i.test(code), "the CLI can click Issue");
  });

  console.log(`\n${failures.length ? "NOT OK" : "ok"} — ${n} assertions passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();

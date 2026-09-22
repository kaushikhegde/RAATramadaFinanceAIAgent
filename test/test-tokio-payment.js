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
    locator(sel) {
      const els = Array.from(window.document.querySelectorAll(sel));
      const wrap = (list) => ({
        async count() { return list.length; },
        first() { return wrap(list.slice(0, 1)); },
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
        async click() { page.calls.push({ action: "click", sel }); },
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
  return `<table>
    <tr><th>A</th><th>Booking No.</th><th>Reference</th><th>Seg. Type</th><th>Creditor Payable</th></tr>
    ${rows.map((r) => `<tr>
      <td><input type="checkbox" id="selected"></td>
      <td>${r.booking || ""}</td><td>${r.reference}</td><td>INS</td><td>${r.amount}</td>
    </tr>`).join("")}
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

  console.log("\nsteps 12-13 — matching and ticking");

  await check("a policy that matches on reference and amount is ticked", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const { results } = await tk.tickMatchingRows(page, [travel("21087245", 700)]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ticked, true);
    assert.strictEqual(page.document.querySelector('input[type="checkbox"]').checked, true);
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

    const boxes = Array.from(page.document.querySelectorAll('input[type="checkbox"]'));
    assert.strictEqual(boxes[0].checked, false, "the 150.00 line must be left alone");
    assert.strictEqual(boxes[1].checked, true);
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

  await check("a tick that does not stay is a refusal, not a silent pass", async () => {
    const page = fakePage(grid([{ reference: "21087245", amount: "700.00" }]));
    const box = page.document.querySelector('input[type="checkbox"]');
    Object.defineProperty(box, "checked", { get: () => false, set: () => {}, configurable: true });
    await assert.rejects(
      () => tk.tickMatchingRows(page, [travel("21087245", 700)]),
      /A column did not stay ticked for reference 21087245/
    );
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

  await check("BR16 — no Issue selector exists in the module at all", () => {
    // Stronger than checking what one run clicked: a control this file cannot
    // name is one it cannot click by accident, now or after an edit.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "tramada-tokio.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/["'`]#issue["'`]/.test(code), "an #issue selector is present");
    assert.ok(!/value=\\?["']Issue\\?["']/.test(code), "an Issue button selector is present");
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

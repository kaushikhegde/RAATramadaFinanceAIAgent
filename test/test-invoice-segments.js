"use strict";

/**
 * Add / Issue Invoice — the step Megan named on 23-Sep-2026 as the one that
 * makes a Tokio insurance costing reach the creditor payment results screen.
 *
 * The selectors on that page have NOT been measured. What can be tested
 * without Tramada is everything that decides WHICH row gets ticked and what
 * happens when the answer is "none" or "more than one" — which is where the
 * damage would be, since ticking the wrong segment invoices the wrong money.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");
const seg = require("../tramada-segments");

let n = 0;
const failures = [];
const check = async (what, fn) => {
  try { await fn(); n++; console.log("  ok  " + what); }
  catch (err) { failures.push(what); console.log("  NOT OK  " + what + "\n      " + err.message); }
};

function fakePage(html, url = "https://asp.tramada.com.au/ttms/x/booking/booking-invoice.htm") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const { window } = dom;
  const page = {
    window,
    calls: [],
    async evaluate(fn, arg) {
      const g = { document: window.document, window, Event: window.Event, RegExp };
      const saved = {};
      for (const k of Object.keys(g)) { saved[k] = global[k]; global[k] = g[k]; }
      try { return await fn(arg); } finally { Object.assign(global, saved); }
    },
    url() { return page._url || url; },
    async waitForLoadState() {},
    async goto(u) { page._url = u; page.calls.push({ action: "goto", url: u }); },
    locator(sel) {
      const els = Array.from(window.document.querySelectorAll(sel));
      const wrap = (list) => ({
        async count() { return list.length; },
        first() { return wrap(list.slice(0, 1)); },
        async check() {
          page.calls.push({ action: "check", sel });
          const el = list[0];
          if (!el) throw new Error("check: nothing matches " + sel);
          if (el.dataset && el.dataset.refuses === "true") return; // simulates Tramada rejecting it
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new window.Event("click", { bubbles: true }));
            el.dispatchEvent(new window.Event("change", { bubbles: true }));
          }
        },
        async click() { page.calls.push({ action: "click", sel }); },
      });
      return wrap(els);
    },
  };
  return page;
}

const gridHtml = (rows, { heading = "Segments to Invoice" } = {}) =>
  `<h3>${heading}</h3><table>
    <tr><th></th><th>Type</th><th>Creditor</th><th>Reference</th><th>Amount</th></tr>
    ${rows.map((r) => `<tr>
      <td><input type="checkbox"${r.checked ? " checked" : ""}${r.disabled ? " disabled" : ""}${r.refuses ? ' data-refuses="true"' : ""}></td>
      <td>${r.type || "INS"}</td><td>${r.creditor || ""}</td>
      <td>${r.reference || ""}</td><td>${r.amount || ""}</td></tr>`).join("")}
  </table>`;

(async () => {
  console.log("\nfinding the grid");

  await check("the grid is found by its heading", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine", reference: "21990677", amount: "100.00" }]));
    const out = await seg.readSegmentsToInvoice(page);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.how, "heading");
    assert.strictEqual(out.rows.length, 1);
  });

  await check("with no heading it falls back to the LAST grid, and says so", async () => {
    // Megan's instruction is literally "scroll to the bottom", so the
    // fallback matches the human procedure rather than guessing.
    const page = fakePage(
      `<table><tr><td><input type="checkbox"></td><td>Passenger</td></tr></table>` +
      gridHtml([{ creditor: "Tokio Marine" }], { heading: "Something Else" })
    );
    const out = await seg.readSegmentsToInvoice(page);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.how, "last grid with checkboxes");
  });

  await check("every row gets its own handle", async () => {
    const page = fakePage(gridHtml([
      { creditor: "Tokio Marine", reference: "21990677", amount: "100.00" },
      { creditor: "Tokio Marine", reference: "21990677", amount: "700.00" },
    ]));
    const out = await seg.readSegmentsToInvoice(page);
    assert.strictEqual(new Set(out.rows.map((r) => r.handle)).size, 2,
      "two rows sharing a creditor and policy must still be separately addressable");
  });

  await check("the REAL page shape: heading far above the grid, one shared checkbox id", async () => {
    /* Measured live 24-Sep-2026, booking 15875. Two things this pins:
         - <h3>Segments To Invoice</h3> (capital T) is NOT the grid's
           previousElementSibling, it sits further up the document;
         - every row's checkbox shares id="segmentsToAllocate", the same trap
           as the IPSI allocation grid.
       The old previousElementSibling check found nothing here and fell
       through to "last grid with checkboxes", which is right by luck on a
       booking with one grid and wrong on any other. */
    const page = fakePage(`
      <div class="pane">
        <h3>Segments To Invoice</h3>
        <p>Select the segments to include on this invoice.</p>
        <table>
          <tr><th>D</th><th>Seg. Type</th><th>Creditor Details</th><th>Due inc GST</th></tr>
          <tr><td><input type="checkbox" id="segmentsToAllocate" name="segmentsToAllocate"></td>
              <td>INS</td><td>Tokio Marine 21404023</td><td>100.00</td></tr>
          <tr><td><input type="checkbox" id="segmentsToAllocate" name="segmentsToAllocate"></td>
              <td>AIR</td><td>Qantas QF123</td><td>500.00</td></tr>
        </table>
      </div>`);
    const out = await seg.readSegmentsToInvoice(page);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.how, "heading", "the heading must be found even when it is not adjacent");
    assert.strictEqual(out.rows.length, 2);

    const ticked = await seg.tickSegmentsToInvoice(page, /tokio/i);
    assert.strictEqual(ticked.ticked.length, 1);
    const boxes = Array.from(page.window.document.querySelectorAll('input[type="checkbox"]'));
    assert.deepStrictEqual(boxes.map((b) => b.checked), [true, false],
      "a shared id must not make the run tick the wrong segment");
  });

  await check("the measured selectors are the ones the module holds", () => {
    assert.strictEqual(seg.INVOICE.addLink[0], "#add", "measured: a submit button, not a link");
    assert.strictEqual(seg.INVOICE.issueButton[0], "#issue");
    assert.match(seg.INVOICE.formUrl("15875"), /booking-client-invoice\.htm\?mode=add&parentId=15875$/);
    assert.strictEqual(seg.INVOICE.rowCheckboxId, "segmentsToAllocate");
    // Preview renders, Select All is somebody else's decision.
    assert.ok(!seg.INVOICE.issueButton.some((s) => /preview|selectAll/i.test(s)));
  });

  console.log("\nchoosing what to tick");

  await check("only the matching segment is ticked, not its neighbours", async () => {
    const page = fakePage(gridHtml([
      { creditor: "Qantas", reference: "QF123", amount: "500.00" },
      { creditor: "Tokio Marine", reference: "21990677", amount: "100.00" },
      { creditor: "Hertz", reference: "H99", amount: "80.00" },
    ]));
    const out = await seg.tickSegmentsToInvoice(page, /tokio/i);
    assert.strictEqual(out.ticked.length, 1);
    assert.match(out.ticked[0], /Tokio Marine/);
    const boxes = Array.from(page.window.document.querySelectorAll('input[type="checkbox"]'));
    assert.deepStrictEqual(boxes.map((b) => b.checked), [false, true, false],
      "invoicing the wrong segment bills the wrong money");
  });

  await check("it is a REAL check(), never a scripted .checked", async () => {
    // Tramada recalculates in its own onclick; a synthetic tick leaves the
    // handler unrun. This is the bug that cost two live runs on the IPSI
    // allocation grid, so it is pinned here too.
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine" }]));
    await seg.tickSegmentsToInvoice(page, /tokio/i);
    assert.ok(page.calls.some((c) => c.action === "check"), "no Playwright check() was issued");
  });

  await check("a plain string matches literally, not as a regex", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine", reference: "21990677" }]));
    const out = await seg.tickSegmentsToInvoice(page, "Tokio Marine");
    assert.strictEqual(out.ticked.length, 1);
  });

  await check("nothing matching is an error naming what WAS there", async () => {
    const page = fakePage(gridHtml([{ creditor: "Qantas", reference: "QF123" }]));
    await assert.rejects(() => seg.tickSegmentsToInvoice(page, /tokio/i), (err) => {
      assert.match(err.message, /Qantas/, `the error must show the real grid; got: ${err.message}`);
      return true;
    });
  });

  await check("an already-invoiced (disabled) segment stops, rather than being skipped", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine", disabled: true }]));
    await assert.rejects(() => seg.tickSegmentsToInvoice(page, /tokio/i), /already invoiced|cannot be ticked/i);
  });

  await check("an already-ticked segment is accepted without re-clicking", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine", checked: true }]));
    const out = await seg.tickSegmentsToInvoice(page, /tokio/i);
    assert.strictEqual(out.ticked.length, 1);
    assert.ok(!page.calls.some((c) => c.action === "check"), "it re-ticked a box that was already ticked");
  });

  await check("a tick Tramada refuses is reported, not assumed", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine", refuses: true }]));
    await assert.rejects(() => seg.tickSegmentsToInvoice(page, /tokio/i), /did not stay ticked/i);
  });

  await check("no grid at all reads as a wrong page, with the page described", async () => {
    const page = fakePage(`<p>Nothing here.</p><input id="somethingElse">`);
    await assert.rejects(() => seg.tickSegmentsToInvoice(page, /tokio/i), (err) => {
      assert.match(err.message, /Segments to Invoice/i);
      assert.match(err.message, /somethingElse/, "the error should say what the page really has");
      return true;
    });
  });

  console.log("\nthe run");

  await check("dryRun is the default and never clicks Issue", async () => {
    // It now goes straight to booking-client-invoice.htm, the URL measured
    // from clicking #add, so the stub starts there.
    const page = fakePage(
      gridHtml([{ creditor: "Tokio Marine" }]) + '<input type="button" id="issue" value="Issue">',
      "https://asp.tramada.com.au/ttms/x/booking/booking-client-invoice.htm?mode=add&parentId=15875"
    );
    const out = await seg.issueInvoiceForSegments(page, "15875", { match: /tokio/i });
    assert.strictEqual(out.issued, false);
    assert.ok(!page.calls.some((c) => c.action === "click" && /issue/i.test(c.sel || "")),
      "Issue was clicked on a dry run");
  });

  await check("it refuses without a match rather than invoicing everything", async () => {
    const page = fakePage(gridHtml([{ creditor: "Tokio Marine" }]));
    await assert.rejects(() => seg.issueInvoiceForSegments(page, "15875", {}), /Which segment/i);
  });

  console.log(`\n${failures.length ? "NOT OK" : "ok"} — ${n} assertions passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();

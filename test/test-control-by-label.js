"use strict";

/**
 * controlByLabel, against the Add Credit Card window's real markup.
 *
 * The id list missed Category entirely: the form came back "Category must be
 * selected" with Card Number, Card Type, Card Holder and Expiry all correctly
 * filled — the failure looked like a save that had worked. A label is what the
 * guide names and what survives a Tramada version change, so it is matched on
 * that instead.
 *
 * jsdom stands in for the browser; the function is pure DOM work.
 */

const assert = require("assert");
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("  -- jsdom not installed, skipping (npm i -D jsdom to run these)");
  process.exit(0);
}

const { controlByLabel } = require("../tramada-receipt");

let n = 0;
const acheck = async (what, fn) => { await fn(); n++; console.log("  ok  " + what); };

/** A ctx with just the one method controlByLabel uses. */
function ctxFor(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  return {
    async evaluate(fn, arg) {
      const g = global;
      const prevDoc = g.document;
      g.document = dom.window.document;
      try { return fn(arg); } finally { g.document = prevDoc; }
    },
  };
}

// The layout in the screenshot: a label cell, then the control's cell.
const TABLE_FORM = `
<table>
  <tr><td>Category</td><td><select id="weirdCatId"><option value=""></option><option value="P">Personal</option></select></td></tr>
  <tr><td>Card Number</td><td><input id="cardNumberDisplay"></td></tr>
  <tr><td>Card Type</td><td><select id="cardType"><option value="VI">Visa</option></select></td></tr>
  <tr><td>Card Holder</td><td><input id="cardHolder"></td></tr>
  <tr><td>Expiry Date</td><td><input id="expiryDate"></td></tr>
  <tr><td>Card Sub Type</td><td><select id="cardSubType"><option value="C">Credit</option></select></td></tr>
</table>`;

(async () => {
  await acheck("finds Category whatever its id is", async () => {
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "Category", "select"), "weirdCatId");
  });

  await acheck("does not confuse Category with Card Sub Type", async () => {
    // Both contain the word "Type"/"Cat"; the match has to be the whole label.
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "Card Sub Type", "select"), "cardSubType");
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "Card Type", "select"), "cardType");
  });

  await acheck("is case- and whitespace-insensitive", async () => {
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "  category  ", "select"), "weirdCatId");
  });

  await acheck("honours <label for=…> too", async () => {
    const html = `<label for="catX">Category</label><select id="catX"><option value="P">Personal</option></select>`;
    assert.strictEqual(await controlByLabel(ctxFor(html), "Category", "select"), "catX");
  });

  await acheck("returns the name when there is no id", async () => {
    const html = `<table><tr><td>Category</td><td><select name="card.category"></select></td></tr></table>`;
    assert.strictEqual(await controlByLabel(ctxFor(html), "Category", "select"), "card.category");
  });

  await acheck("returns null rather than the wrong control", async () => {
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "Nothing Like This", "select"), null);
  });

  await acheck("will not return an input when a select was asked for", async () => {
    const html = `<table><tr><td>Category</td><td><input id="notASelect"></td></tr></table>`;
    assert.strictEqual(await controlByLabel(ctxFor(html), "Category", "select"), null);
  });

  await acheck("the error banner is not mistaken for the field", async () => {
    // The real page carries "Category must be selected" in red above the form.
    // A substring match would find that div and return whatever sits next to
    // it — so the label has to match WHOLE, not merely contain.
    // Card Type is listed BEFORE Category on purpose: a substring match finds
    // the banner first, then takes the first select after it — which is Card
    // Type, not Category. The receipt would then be saved with the category
    // still empty and the card type quietly changed.
    const html = `<div>Category must be selected</div>
      <table>
        <tr><td>Card Type</td><td><select id="cardType"><option value="VI">Visa</option></select></td></tr>
        <tr><td>Category</td><td><select id="realCat"><option value="P">Personal</option></select></td></tr>
      </table>`;
    assert.strictEqual(await controlByLabel(ctxFor(html), "Category", "select"), "realCat");
  });

  await acheck("a <label for=…> pointing at the wrong kind is refused", async () => {
    const html = `<label for="notASelect">Category</label><input id="notASelect">`;
    assert.strictEqual(await controlByLabel(ctxFor(html), "Category", "select"), null);
  });

  await acheck("finds an input when one is asked for", async () => {
    assert.strictEqual(await controlByLabel(ctxFor(TABLE_FORM), "Card Holder", "input"), "cardHolder");
  });

  console.log("\n" + n + " assertions passed.");
})().catch((e) => { console.error(e); process.exit(1); });

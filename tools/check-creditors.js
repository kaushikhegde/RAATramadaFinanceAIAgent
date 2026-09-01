/**
 * check-creditors.js — which of the cheat sheet's creditors does Tramada know?
 *
 *   node tools/check-creditors.js <bookingNo>
 *   node tools/check-creditors.js 14450 --limit 5
 *
 * Types each cheat-sheet creditor into the ticket-costing creditor field on a
 * real booking and records whether Tramada offers it. Writes the verdict to
 * `tools/tramada-creditors.json`, which `make-fixtures.js` then draws from, so
 * fixtures only ever name a creditor that exists.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 * The supplier cheat sheet is RAA's PRODUCTION mapping. This sandbox is not
 * production, and there is no reason every one of its 29 trading names exists
 * here. Picking one at random and finding out at the costing form means a
 * half-created booking and a confusing failure.
 *
 * The field is `#costingcreditor` — an autocomplete, not a select, so the only
 * way to know is to type and look.
 *
 * NOTHING IS SAVED. The form is opened, text is typed into one field, the
 * suggestions are read, and the tab is closed. Save is never clicked.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const HOST = process.env.CDP_HOST || "127.0.0.1";
const OUT = path.join(__dirname, "tramada-creditors.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const bookingNo = args.find((a) => !a.startsWith("--"));
const li = args.indexOf("--limit");
const LIMIT = li >= 0 && args[li + 1] ? parseInt(args[li + 1], 10) : null;

if (!bookingNo) {
  console.error("\n  usage: node tools/check-creditors.js <bookingNo> [--limit N]");
  console.error("  Any real booking will do — nothing is saved to it.\n");
  process.exit(1);
}

function oneCreditor(pair) {
  const single = (pair.try || []).find((t) => t && !/[\/,]/.test(t));
  return single || pair.to;
}

let pairs = [];
try {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cheat-sheets.json"), "utf8"));
  pairs = (j.suppliers && j.suppliers.pairs) || [];
} catch (e) { /* none */ }
if (!pairs.length) { console.error("\n  No supplier cheat sheet to check.\n"); process.exit(1); }

const WANT = pairs.map((p) => ({ from: p.from, cell: p.to, creditor: oneCreditor(p) }));
const LIST = LIMIT ? WANT.slice(0, LIMIT) : WANT;

/* What the autocomplete offers under the field, using the same geometry the
   real code uses so what this sees is what a run would see. */
function suggestionsUnder(sel) {
  const input = document.querySelector(sel);
  if (!input) return { missing: true };
  const ir = input.getBoundingClientRect();
  const vis = Array.from(document.querySelectorAll("li, div, td, a")).filter((n) => {
    if (n.offsetParent === null) return false;
    const t = (n.textContent || "").trim();
    if (!t || t.length > 90) return false;
    const r = n.getBoundingClientRect();
    return r.width && r.height && r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340 &&
           r.left < ir.right + 80 && r.right > ir.left - 80;
  });
  return { value: input.value, suggestions: vis.map((n) => (n.textContent || "").trim()).slice(0, 8) };
}

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://${HOST}:${PORT}`);
  } catch (e) {
    console.error(`\n  Could not reach the browser on ${HOST}:${PORT}.`);
    console.error(`  Run "npm run start:edge" (or start:chrome) and sign into Tramada there.\n`);
    process.exit(1);
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  const known = [];
  const unknown = [];

  try {
    await page.goto(
      `${BASE}/booking/booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
      { waitUntil: "domcontentloaded", timeout: 60000 });
    if (page.url().includes("login.htm")) {
      console.log("\n  That browser is not signed into Tramada. Sign in and re-run.\n");
      return;
    }
    if (!(await page.locator("#costingcreditor").count())) {
      console.log(`\n  No #costingcreditor on booking ${bookingNo}'s costing form.`);
      console.log(`  ${page.url()}\n`);
      return;
    }

    console.log(`\n  Asking Tramada about ${LIST.length} creditor(s) from the cheat sheet.\n`);
    const f = page.locator("#costingcreditor").first();

    for (const w of LIST) {
      /* WAIT FOR THE OLD DROPDOWN TO GO BEFORE TYPING THE NEXT NAME.

         After a match the list stays open. Typing the next creditor and
         polling immediately reads the PREVIOUS row's suggestions, so a
         creditor Tramada has never heard of comes back "offered: [GSR]
         Journey Beyond…". Seen on a real run: rows 4 and 5 both reported the
         row-3 match. Every verdict after the first hit was noise.

         So: clear, wait for the list to empty, then type. */
      await f.click();
      await f.fill("");
      await page.keyboard.press("Escape").catch(() => {});
      for (let i = 0; i < 12; i++) {
        const s = await page.evaluate(suggestionsUnder, "#costingcreditor").catch(() => null);
        if (!s || !s.suggestions || !s.suggestions.length) break;
        await sleep(200);
      }
      await f.type(w.creditor, { delay: 35 });

      /* And only accept a list that could plausibly be a response to what was
         just typed — Tramada matches on a prefix, so at least one entry should
         contain the opening of the name. A list that shares nothing with it is
         the previous one, still on screen. */
      const head = w.creditor.trim().slice(0, 4).toLowerCase();
      let seen = null;
      for (let i = 0; i < 12 && !seen; i++) {
        await sleep(280);
        const s = await page.evaluate(suggestionsUnder, "#costingcreditor").catch(() => null);
        if (!s || !s.suggestions || !s.suggestions.length) continue;
        if (s.suggestions.some((t) => t.toLowerCase().includes(head))) seen = s.suggestions;
      }
      const want = w.creditor.toLowerCase();
      const hit = (seen || []).find((t) => t.toLowerCase().includes(want));
      if (hit) {
        known.push({ ...w, offeredAs: hit });
        console.log(`  \x1b[32m✓\x1b[0m ${w.creditor.padEnd(34).slice(0, 34)} ${hit}`);
      } else {
        unknown.push(w);
        console.log(`  \x1b[31m✗\x1b[0m ${w.creditor.padEnd(34).slice(0, 34)} ` +
          (seen ? `offered: ${seen.slice(0, 2).join(" · ").slice(0, 44)}` : "nothing offered"));
      }
    }

    fs.writeFileSync(OUT, JSON.stringify({
      checkedAt: new Date().toISOString(),
      againstBooking: bookingNo,
      known, unknown,
    }, null, 2) + "\n");

    console.log(`\n  ${known.length} of ${LIST.length} exist in this Tramada.`);
    console.log(`  Written to ${path.relative(process.cwd(), OUT)} — make-fixtures.js will now`);
    console.log(`  pick only from the ones that do.`);
    if (!known.length) {
      console.log(`\n  \x1b[33mNone matched.\x1b[0m Either this sandbox carries none of RAA's suppliers,`);
      console.log(`  or the field behaved differently — try one by hand before trusting this.`);
    }
    console.log("");
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error(`\n  failed: ${e.message}\n`); process.exit(1); });

/**
 * probe-autocomplete.js — why did "MEL" not take?
 *
 *   node tools/probe-autocomplete.js 13700
 *
 * Connects to the SAME Chrome the fixture run uses (CDP 9222, already signed
 * into Tramada), opens a flight-segment form, types a city code, and reports
 * what the widget actually does. It answers one question:
 *
 *   Is the suggestion list appearing and the code just failing to "register",
 *   or is no list appearing at all?
 *
 * `pickAutocomplete` cannot tell those apart — both end in "no click registered
 * after 2 attempts" — and the fix is different for each.
 *
 * NOTHING IS SAVED. It opens an `mode=add` form, types in one field, reads the
 * DOM, and closes the tab. Save is never clicked, so nothing reaches the
 * booking.
 */
const { chromium } = require("playwright");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const HOST = process.env.CDP_HOST || "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bookingNo = process.argv[2];
const CODE = (process.argv[3] || "MEL").toUpperCase();
if (!bookingNo) {
  console.error("usage: node tools/probe-autocomplete.js <bookingNo> [CITYCODE]");
  process.exit(1);
}

/* The same geometry test tramada-segments.js uses, so what this sees is what
   the real code sees. Copied rather than imported: this must keep working even
   if that file is mid-edit. */
function listUnder(sel) {
  const input = document.querySelector(sel);
  if (!input) return { error: "field not found" };
  const ir = input.getBoundingClientRect();
  const inZone = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340 &&
           r.left < ir.right + 80 && r.right > ir.left - 80;
  };
  const vis = Array.from(document.querySelectorAll("li, div, td, a")).filter(
    (n) => n.offsetParent !== null && (n.textContent || "").trim() &&
           (n.textContent || "").length < 80 && inZone(n)
  );
  return {
    value: input.value,
    className: input.className,
    suggestions: vis.map((n) => (n.textContent || "").trim()).slice(0, 12),
  };
}

(async () => {
  const browser = await chromium.connectOverCDP(`http://${HOST}:${PORT}`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  let ok = false;
  try {
    const url = `${BASE}/booking/booking-flight-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (page.url().includes("login.htm")) {
      console.log("\n  Chrome on 9222 is NOT signed into Tramada — sign in there, then re-run.\n");
      return;
    }
    if (!(await page.locator("#departureCityCode").count())) {
      console.log(`\n  No #departureCityCode on that page. Is ${bookingNo} a real booking?`);
      console.log(`  ${page.url()}\n`);
      return;
    }

    console.log(`\n  booking ${bookingNo} · typing "${CODE}" into #departureCityCode\n`);

    const f = page.locator("#departureCityCode").first();
    await f.click();
    await f.fill("");
    await f.type(CODE, { delay: 60 });

    // Poll the way pickAutocomplete does, and SHOW each poll rather than only
    // the verdict — a list that appears and then vanishes looks identical to
    // one that never appeared, if you only look at the end.
    let seen = null;
    for (let i = 1; i <= 12; i++) {
      await sleep(300);
      const snap = await page.evaluate(listUnder, "#departureCityCode").catch(() => null);
      if (snap && snap.suggestions.length) {
        seen = snap;
        console.log(`  poll ${String(i).padStart(2)}  value="${snap.value}"  ${snap.suggestions.length} item(s): ${JSON.stringify(snap.suggestions.slice(0, 4))}`);
      } else {
        console.log(`  poll ${String(i).padStart(2)}  value="${(snap && snap.value) || "?"}"  (no list)`);
      }
    }

    console.log("");
    if (!seen) {
      console.log("  ── NO SUGGESTION LIST EVER APPEARED ─────────────────────────");
      console.log("  The widget is not offering anything, so no click could land.");
      console.log("  This is a Tramada-side change, not the success check.");
      console.log(`  field class: ${(await page.evaluate(listUnder, "#departureCityCode")).className}`);
      ok = true;
      return;
    }

    // Click the best match the real code would click, then report the two
    // things that decide whether pickAutocomplete calls it a success.
    const before = await f.inputValue();
    const clicked = await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      const ir = input.getBoundingClientRect();
      const inZone = (n) => {
        const r = n.getBoundingClientRect();
        return r.width && r.height && r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340 &&
               r.left < ir.right + 80 && r.right > ir.left - 80;
      };
      const vis = Array.from(document.querySelectorAll("li, div, td, a"))
        .filter((n) => n.offsetParent !== null && (n.textContent || "").trim() &&
                       (n.textContent || "").length < 80 && inZone(n));
      if (!vis.length) return null;
      const t = (vis[0].textContent || "").trim();
      vis[0].click();
      return t;
    }, "#departureCityCode");
    await sleep(800);

    const after = await f.inputValue();
    const stillListed = await page.evaluate(listUnder, "#departureCityCode");

    console.log("  ── A LIST DID APPEAR ────────────────────────────────────────");
    console.log(`  clicked          ${JSON.stringify(clicked)}`);
    console.log(`  value before     ${JSON.stringify(before)}`);
    console.log(`  value after      ${JSON.stringify(after)}`);
    console.log(`  list still open  ${stillListed.suggestions.length > 0}`);
    console.log("");
    if (after.toUpperCase() === CODE) {
      console.log("  → The field still reads exactly what was typed.");
      console.log("    pickAutocomplete calls that a FAILURE, because its only test is");
      console.log("    'has the value changed?'. For a code field it never will.");
      console.log("    THE PICK WORKED. The success check is what is wrong.");
    } else {
      console.log("  → The value expanded, so the check would have passed here.");
      console.log("    Something else is failing — send this output over.");
    }
    ok = true;
  } finally {
    console.log("");
    if (ok) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error("\n  probe failed:", e.message, "\n");
  process.exit(1);
});

/**
 * probe-segment-sequence.js — the REAL order, not one field in isolation.
 *
 *   node tools/probe-segment-sequence.js 13730
 *
 * Probe 1 typed MEL into a fresh form and it worked perfectly: the list
 * appeared, the click landed, the value expanded to "(MEL) MELBOURNE,
 * AUSTRALIA, AU". So pickAutocomplete is fine on its own.
 *
 * The real code does not do it on its own. `addFlightSegment` picks #airline
 * FIRST and #departureCityCode immediately after:
 *
 *     await pickAutocomplete(page, "#airline", seg.airline);            // "QF"
 *     await pickAutocomplete(page, "#departureCityCode", seg.fromCity); // "MEL"
 *
 * This runs that pair and watches what the airline pick does to the page.
 *
 * THE NONCE IS THE POINT. `window.__probeNonce` is set before the airline pick.
 * If it is gone afterwards, the page reloaded — Tramada posted the form back —
 * and everything the next pick reaches for belongs to a document that no longer
 * exists. That is invisible from inside pickAutocomplete, which would simply
 * find no dropdown and blame the click.
 *
 * NOTHING IS SAVED. Save is never clicked.
 */
const { chromium } = require("playwright");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const HOST = process.env.CDP_HOST || "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bookingNo = process.argv[2];
const AIRLINE = process.argv[3] || "QF";
const CITY = (process.argv[4] || "MEL").toUpperCase();
if (!bookingNo) {
  console.error("usage: node tools/probe-segment-sequence.js <bookingNo> [AIRLINE] [CITY]");
  process.exit(1);
}

function snap(sel) {
  const input = document.querySelector(sel);
  if (!input) return { missing: true, nonce: window.__probeNonce || null };
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
    disabled: input.disabled,
    readOnly: input.readOnly,
    nonce: window.__probeNonce || null,
    suggestions: vis.map((n) => (n.textContent || "").trim()).slice(0, 6),
  };
}

function clickBest(arg) {
  const input = document.querySelector(arg.sel);
  if (!input) return { missing: true };
  const ir = input.getBoundingClientRect();
  const val = String(arg.raw).trim().toUpperCase();
  const esc = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inZone = (n) => {
    const r = n.getBoundingClientRect();
    return r.width && r.height && r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340 &&
           r.left < ir.right + 80 && r.right > ir.left - 80;
  };
  const vis = Array.from(document.querySelectorAll("li, div, td, a")).filter(
    (n) => n.offsetParent !== null && (n.textContent || "").trim() &&
           (n.textContent || "").length < 80 && inZone(n));
  // Same two-step match tramada-segments.js uses.
  let hit = vis.find((n) => new RegExp("^\\s*[\\(\\[]" + esc + "[\\)\\]]").test(n.textContent || ""));
  if (!hit) hit = vis.find((n) => {
    const t = (n.textContent || "").trim().toUpperCase();
    return t.includes(val) && t !== val;
  });
  if (!hit) return { none: true, saw: vis.length };
  const t = (hit.textContent || "").trim();
  hit.click();
  return { clicked: t };
}

async function pick(page, sel, value, label) {
  console.log(`\n  ── ${label}: "${value}" into ${sel} ─────────────────────`);
  const f = page.locator(sel).first();
  if (!(await f.count())) { console.log("  FIELD IS NOT ON THE PAGE"); return false; }

  await f.click();
  await f.fill("");
  await f.type(String(value), { delay: 60 });

  let saw = null;
  for (let i = 1; i <= 14; i++) {
    await sleep(300);
    const s = await page.evaluate(snap, sel).catch(() => null);
    if (!s) { console.log(`  poll ${i}  <evaluate failed — page navigating?>`); continue; }
    if (s.missing) { console.log(`  poll ${i}  FIELD GONE  nonce=${s.nonce}`); continue; }
    if (s.suggestions.length) {
      saw = s;
      console.log(`  poll ${String(i).padStart(2)}  value="${s.value}" nonce=${s.nonce} · ${s.suggestions.length} item(s): ${JSON.stringify(s.suggestions.slice(0, 3))}`);
    } else {
      console.log(`  poll ${String(i).padStart(2)}  value="${s.value}" nonce=${s.nonce} · (no list)`);
    }
    if (saw && i >= 5) break;
  }

  if (!saw) {
    console.log(`  → NO LIST for "${value}".`);
    const s = await page.evaluate(snap, sel).catch(() => null);
    console.log(`     final: ${JSON.stringify(s)}`);
    return false;
  }

  const res = await page.evaluate(clickBest, { sel, raw: String(value) }).catch((e) => ({ err: e.message }));
  await sleep(900);
  const after = await page.evaluate(snap, sel).catch(() => null);
  console.log(`  clicked: ${JSON.stringify(res)}`);
  console.log(`  after:   value="${after && after.value}" nonce=${after && after.nonce} listOpen=${!!(after && after.suggestions.length)}`);
  return true;
}

(async () => {
  const browser = await chromium.connectOverCDP(`http://${HOST}:${PORT}`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  try {
    await page.goto(
      `${BASE}/booking/booking-flight-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`,
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    if (page.url().includes("login.htm")) {
      console.log("\n  Chrome on 9222 is not signed into Tramada.\n"); return;
    }
    await page.waitForSelector("#airline", { timeout: 20000 });

    // Stamp the document. If this is gone later, the page reloaded under us.
    await page.evaluate(() => { window.__probeNonce = "A1"; });
    console.log(`\n  booking ${bookingNo} · nonce A1 stamped on the document`);

    await pick(page, "#airline", AIRLINE, "STEP 1 airline");

    const mid = await page.evaluate(() => ({
      nonce: window.__probeNonce || null,
      url: location.pathname + location.search,
    }));
    console.log(`\n  ── after the airline pick ────────────────────────────`);
    console.log(`  nonce now: ${mid.nonce}   ${mid.nonce ? "(same document)" : "*** PAGE RELOADED — the form posted back ***"}`);

    await pick(page, "#departureCityCode", CITY, "STEP 2 departure city");

    console.log("\n  ── verdict ───────────────────────────────────────────");
    if (!mid.nonce) {
      console.log("  The airline pick RELOADED the page. Everything pickAutocomplete");
      console.log("  does next runs against a document that was replaced — which is");
      console.log("  why MEL works alone and fails in sequence.");
    } else {
      console.log("  No reload. If step 2 still showed no list, the airline pick is");
      console.log("  leaving the city field in some other state — see its polls above.");
    }
    console.log("");
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error("\n  probe failed:", e.message, "\n"); process.exit(1); });

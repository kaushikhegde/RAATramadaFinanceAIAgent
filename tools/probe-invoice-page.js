#!/usr/bin/env node
"use strict";

/**
 * READ-ONLY map of the Add / Issue Invoice page.
 *
 * tramada-segments.js INVOICE holds CANDIDATE selectors — nothing on this
 * page has been measured. This prints what is really there so those lists
 * can be corrected in one pass instead of guessed at across live runs.
 *
 * It clicks the Add/Issue Invoice link (which only opens a form) and ticks
 * NOTHING. No invoice is issued.
 *
 *   node tools/probe-invoice-page.js 15875
 */

const { chromium } = require("playwright");
const seg = require("../tramada-segments");

const BASE = process.env.TRAMADA_BASE_URL ||
  "https://asp.tramada.com.au/ttms/raatravelsandbox";
const PORT = parseInt(process.env.CDP_PORT || "9222", 10);

const bookingNo = process.argv[2];
if (!bookingNo) {
  console.error("Which booking? e.g. node tools/probe-invoice-page.js 15875");
  process.exit(2);
}

const line = (s = "") => console.log(s);

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  try {
    const url = `${BASE}/booking/booking-invoices.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
    line(`\n→ ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (/login|signin/i.test(page.url())) {
      line("\nNot signed in. Sign into Tramada in that Chrome yourself — this never types credentials.");
      return;
    }

    const controls = async () =>
      await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        return Array.from(document.querySelectorAll("input, select, textarea, button, a"))
          .filter((el) => el.type !== "hidden")
          .map((el) => {
            const t = norm(el.textContent);
            return (el.id ? "#" + el.id : el.name ? `[name=${el.name}]` : el.tagName.toLowerCase()) +
              (t ? ` ("${t.slice(0, 30)}")` : "") +
              (el.href ? ` → ${String(el.href).split("/").pop().slice(0, 50)}` : "");
          })
          .slice(0, 60);
      });

    line("\n=== Invoices tab — every named control ===");
    for (const c of await controls()) line("  " + c);

    line("\n=== which INVOICE.addLink candidate is present? ===");
    for (const sel of seg.INVOICE.addLink) {
      line(`  ${(await page.locator(sel).count().catch(() => 0)) ? "FOUND  " : "absent "}${sel}`);
    }

    // Opening the form writes nothing.
    for (const sel of seg.INVOICE.addLink) {
      if (await page.locator(sel).count().catch(() => 0)) {
        line(`\n→ clicking ${sel}`);
        await page.locator(sel).first().click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await new Promise((r) => setTimeout(r, 900));
        break;
      }
    }
    line(`   landed on ${page.url()}`);

    line("\n=== Add/Issue Invoice — every named control ===");
    for (const c of await controls()) line("  " + c);

    line("\n=== tables carrying checkboxes (the grid is one of these) ===");
    const tables = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("table"))
        .map((t, i) => ({
          i,
          boxes: t.querySelectorAll('input[type="checkbox"]').length,
          heads: Array.from(t.querySelectorAll("th, thead td")).map((h) => norm(h.textContent)).slice(0, 10),
          above: t.previousElementSibling ? norm(t.previousElementSibling.textContent).slice(0, 60) : "",
          first: norm((t.querySelector("tbody tr") || t.querySelector("tr") || {}).textContent || "").slice(0, 90),
        }))
        .filter((t) => t.boxes);
    });
    if (!tables.length) line("  none — the form may need a client or date picked first.");
    for (const t of tables) {
      line(`\n  table #${t.i} — ${t.boxes} checkbox(es)`);
      line(`    above:   ${JSON.stringify(t.above)}`);
      line(`    headers: ${JSON.stringify(t.heads)}`);
      line(`    row 1:   ${JSON.stringify(t.first)}`);
    }

    line("\n=== what readSegmentsToInvoice() makes of it ===");
    try {
      const grid = await seg.readSegmentsToInvoice(page);
      line(`  found=${grid.found} via ${grid.how}, ${grid.rows.length} tickable row(s)`);
      for (const r of grid.rows.slice(0, 10)) {
        line(`    ${r.checked ? "[x]" : "[ ]"}${r.disabled ? " (disabled)" : ""} ${r.text.slice(0, 80)}`);
      }
    } catch (err) {
      line("  " + err.message);
    }

    line("\n=== which INVOICE.issueButton candidate is present? ===");
    for (const sel of seg.INVOICE.issueButton) {
      line(`  ${(await page.locator(sel).count().catch(() => 0)) ? "FOUND  " : "absent "}${sel}`);
    }

    line("\nNothing was ticked and no invoice was issued. Correct INVOICE in tramada-segments.js from the above.\n");
  } catch (err) {
    console.error("\nFAILED: " + err.message);
    process.exitCode = 1;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }
})();

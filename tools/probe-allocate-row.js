#!/usr/bin/env node
"use strict";

/**
 * WHY WILL THE A COLUMN NOT STAY TICKED?
 *
 * Three theories have now been wrong — a too-short settle, a detached
 * locator, a re-ordering grid — because each was reasoned from one line of
 * run output rather than from the page. This looks at the page.
 *
 * READ-ONLY apart from ONE click on ONE checkbox, which is the thing being
 * measured. It never saves, never issues, and never touches another row.
 *
 *   node tools/probe-allocate-row.js 220044
 */

const tk = require("../tramada-tokio");

const wanted = process.argv[2] || "220044";
const line = (s = "") => console.log(s);

(async () => {
  const browser = await tk.openBrowser(() => {});
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  let results = null;

  try {
    await tk.assertSignedIn(page);
    await tk.openIssuePayments(page, () => {});
    const search = await tk.searchCreditorPayments(
      page,
      {
        creditor: "Tokio",
        // Date objects, not "dd-mm-yyyy" strings: tramadaDate() does the
        // formatting, and new Date("01-08-2026") is Invalid Date in Node.
        fromCreated: new Date(2026, 7, 1),   // 01-08-2026
        toCreated: new Date(2026, 9, 22),    // 22-10-2026
      },
      () => {}
    );
    results = search.page || page;
    line(`\n→ results on ${results.url()}\n`);

    // Console + dialogs, in case Tramada is objecting somewhere we never look.
    const noise = [];
    results.on("console", (m) => noise.push(`console.${m.type()}: ${m.text().slice(0, 160)}`));
    results.on("dialog", async (d) => {
      noise.push(`DIALOG (${d.type()}): ${d.message().slice(0, 200)}`);
      await d.dismiss().catch(() => {});
    });

    const grid = await tk.readTransactionPage(results);
    const row = grid.rows.find((r) => String(r.reference).includes(wanted));
    if (!row) {
      line(`No row whose reference contains ${wanted}. The page holds:`);
      for (const r of grid.rows.slice(0, 12)) line(`   ${String(r.reference).slice(0, 70)}  @ ${r.amount}`);
      return;
    }
    line(`row handle ${row.handle} · amount ${row.amount} · ticked ${row.ticked} · allocate ${JSON.stringify(row.allocate)}\n`);

    const dump = async (when) => {
      const d = await results.evaluate((handle) => {
        const tr = document.querySelector(`[data-tokio-row="${handle}"]`);
        if (!tr) return { gone: true };
        const attrs = (el) =>
          el ? Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, String(a.value).slice(0, 90)])) : null;
        const box = tr.querySelector('input[type="checkbox"]');
        const texts = Array.from(tr.querySelectorAll("input, select, textarea")).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type,
          name: el.name || null,
          id: el.id || null,
          value: String(el.value).slice(0, 40),
          disabled: !!el.disabled,
          readOnly: !!el.readOnly,
        }));
        return {
          checkbox: {
            attrs: attrs(box),
            checked: box ? box.checked : null,
            disabled: box ? box.disabled : null,
          },
          fields: texts,
          rowHtml: tr.outerHTML.replace(/\s+/g, " ").slice(0, 700),
        };
      }, row.handle);
      line(`--- ${when} ---`);
      line(JSON.stringify(d, null, 1).slice(0, 2200));
      line("");
    };

    await dump("BEFORE the click");

    // The page's own header, in case allocation needs a payment amount first.
    const header = await results.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const out = {};
      for (const td of document.querySelectorAll("td, th")) {
        const label = norm(td.textContent);
        if (!/^(Transaction Type|Payee Name|Date Of Payment|Amount Of Payment|Reference)$/i.test(label)) continue;
        let sib = td.nextElementSibling;
        while (sib) {
          const el = sib.matches && sib.matches("input,select") ? sib : sib.querySelector && sib.querySelector("input,select");
          if (el) { out[label] = { id: el.id || null, value: String(el.value).slice(0, 40) }; break; }
          sib = sib.nextElementSibling;
        }
      }
      return out;
    });
    line("--- Payment Details header ---");
    line(JSON.stringify(header, null, 1));
    line("");

    line(`>>> clicking the A checkbox on ${wanted} — the only write this makes\n`);
    await results.locator(`[data-tokio-row="${row.handle}"] input[type="checkbox"]`).first().check().catch(async (e) => {
      line(`  check() threw: ${e.message.slice(0, 160)}`);
      await results.locator(`[data-tokio-row="${row.handle}"] input[type="checkbox"]`).first().click({ force: true }).catch(() => {});
    });

    await results.waitForTimeout(400);
    await dump("400ms AFTER the click");
    await results.waitForTimeout(2500);

    // The row may have been re-tagged by a redraw; re-read and find it again.
    const after = await tk.readTransactionPage(results);
    const same = after.rows.find((r) => String(r.reference).includes(wanted));
    line("--- 3s after, found again by reference ---");
    line(same
      ? `handle ${same.handle} · ticked ${same.ticked} · allocate ${JSON.stringify(same.allocate)} · amount ${same.amount}`
      : "the row is no longer on the page at all");
    line("");
    line(`rows on page now: ${after.rows.length} (was ${grid.rows.length})`);
    line(`ticked anywhere on the page: ${after.rows.filter((r) => r.ticked).length}`);
    line("");
    line("--- console / dialogs ---");
    line(noise.length ? noise.slice(0, 12).join("\n") : "(nothing)");
    line("\nNothing was saved and no payment was issued.\n");
  } catch (err) {
    console.error("\nFAILED: " + err.message);
    process.exitCode = 1;
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
})();

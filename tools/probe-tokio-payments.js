/**
 * probe-tokio-payments.js — READ-ONLY. Runs step 9 and step 10 for real, then
 * describes the results list: its columns, its checkboxes, its pagination, and
 * whatever buttons offer to save a session.
 *
 *   node tools/probe-tokio-payments.js
 *   node tools/probe-tokio-payments.js --creditor "Tokio" --from 01-08-2026
 *
 * It never ticks anything, never saves, and never issues.
 *
 * Why: steps 12-14 need to know what a result row looks like — where the
 * reference is, where the amount is, which checkbox belongs to which row — and
 * how the ~50 pages are paged. Guessing that produces a run that ticks
 * plausible-looking rows and saves a session nobody can trust.
 */
require("dotenv").config();
const tk = require("../tramada-tokio");

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const line = (m) => console.log(m);

(async () => {
  const browser = await tk.openBrowser((p, m) => line(`  [${String(p).padStart(3)}%] ${m}`));
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  try {
    await tk.openIssuePayments(page, (p, m) => line(`  [${String(p).padStart(3)}%] ${m}`));

    const settled = await tk.searchCreditorPayments(
      page,
      {
        creditor: val("--creditor", "Tokio"),
        fromCreated: val("--from") ? parseDmy(val("--from")) : undefined,
        toCreated: val("--to") ? parseDmy(val("--to")) : undefined,
      },
      (p, m) => line(`  [${String(p).padStart(3)}%] ${m}`)
    );

    line("\nSearched with:");
    for (const [k, v] of Object.entries(settled)) line(`  ${k.padEnd(14)} ${v}`);
    line("\nLanded on: " + page.url().split("/").pop().split("?")[0]);

    /* ---- the results list ------------------------------------------- */

    const shape = await page.evaluate(() => {
      const out = { tables: [], checkboxes: 0, checkboxNames: [], pager: [], buttons: [] };

      document.querySelectorAll("table").forEach((t, i) => {
        const head = t.querySelector("tr");
        if (!head) return;
        const headers = [...head.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim());
        if (headers.filter(Boolean).length < 3) return;
        const body = [...t.querySelectorAll("tr")].slice(1, 3).map((r) =>
          [...r.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim().slice(0, 30))
        );
        out.tables.push({ i, rows: t.querySelectorAll("tr").length, headers, body });
      });

      const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
      out.checkboxes = boxes.length;
      out.checkboxNames = [...new Set(boxes.map((b) => (b.id || b.name || "").replace(/\d+$/, "<n>")))].slice(0, 10);

      // Anything that looks like paging.
      out.pager = [...document.querySelectorAll("a, input[type=button], input[type=submit], select")]
        .map((n) => {
          const txt = (n.value || n.textContent || "").replace(/\s+/g, " ").trim();
          const id = n.id || n.name || "";
          return { id, txt: txt.slice(0, 24), tag: n.tagName.toLowerCase() };
        })
        .filter((x) => /next|prev|page|of \d|»|«|^\d+$/i.test(x.txt) || /page/i.test(x.id))
        .slice(0, 20);

      out.buttons = [...document.querySelectorAll("input[type=button], input[type=submit], button")]
        .map((b) => `#${b.id || b.name || ""} "${(b.value || b.textContent || "").trim().slice(0, 30)}"`)
        .slice(0, 30);

      return out;
    });

    line(`\n=== result tables (${shape.tables.length}) ===`);
    shape.tables.forEach((t) => {
      line(`  table ${t.i}: ${t.rows} rows`);
      line("    headers: " + t.headers.join(" | "));
      t.body.forEach((r, j) => line(`    row ${j + 1}: ` + r.join(" | ")));
    });

    line(`\n=== checkboxes: ${shape.checkboxes} ===`);
    shape.checkboxNames.forEach((c) => line("  " + c));

    line("\n=== paging controls ===");
    if (!shape.pager.length) line("  (none found — the list may not paginate at this volume)");
    shape.pager.forEach((p) => line(`  ${p.tag} #${p.id} "${p.txt}"`));

    line("\n=== buttons on this page ===");
    shape.buttons.forEach((b) => line("  " + b));

    line("\nRead-only probe finished. Nothing ticked, nothing saved, nothing issued.");
  } catch (err) {
    console.error("\nProbe failed: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();

/** "01-08-2026" -> Date. */
function parseDmy(s) {
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) throw new Error(`--from/--to want dd-mm-yyyy, got "${s}"`);
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

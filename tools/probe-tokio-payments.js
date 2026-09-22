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

    /* WHY ARE THERE NO ROWS?
     *
     * A search that lands on the right page and returns nothing looks
     * identical to a search that failed, and the difference decides whether
     * there is a bug to fix or simply no Tokio data in the window. So ask the
     * page: does it SAY there are no records, and what does it say about the
     * total? Then, if the window was the problem, widen it and count again. */
    if (!shape.checkboxNames.length) {
      line("\n=== why no rows? ===");

      const said = await page.evaluate(() => {
        const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
        const out = [];
        document.querySelectorAll("td, div, span, font, p, li, b").forEach((n) => {
          if (n.children.length) return;
          const t = norm(n.textContent);
          if (!t || t.length > 160) return;
          if (/no\s+(records?|results?|transactions?|data|rows?)|not\s+found|nothing\s+to\s+display|0\s+records?|no\s+match/i.test(t)) {
            out.push(t);
          }
        });
        return [...new Set(out)].slice(0, 6);
      });
      if (said.length) said.forEach((t) => line(`  page says: "${t}"`));
      else line("  the page says nothing about an empty result — it simply has no grid");

      // Is the search form still sitting there unsubmitted, or did it run?
      const stillForm = await page.evaluate(() => !!document.querySelector("#goButton"));
      line(`  the search form is ${stillForm ? "still on the page (results render below it)" : "gone"}`);

      // Widen to two years and count again. If rows appear, it is a date
      // window question; if not, this creditor has nothing costed at all.
      line("\n  widening to 01-01-2025 → 31-12-2027 and counting again...");
      const wideFrom = new Date(2025, 0, 1);
      const wideTo = new Date(2027, 11, 31);
      await tk.openIssuePayments(page, () => {});
      await tk.searchCreditorPayments(page, {
        creditor: val("--creditor", "Tokio"),
        fromCreated: wideFrom,
        toCreated: wideTo,
      }, () => {});

      const wide = await page.evaluate(() => ({
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
        allocationInputs: document.querySelectorAll('input[id^="allocationAmount_"]').length,
        tables: document.querySelectorAll("table").length,
      }));
      line(`  over two years: ${wide.checkboxes} checkbox(es), ${wide.allocationInputs} allocation input(s)`);
      line(
        wide.checkboxes
          ? "  => the DATE WINDOW was the problem. Re-run with --from/--to around the real data."
          : "  => this creditor has no costed, invoiced segments in the sandbox at all.\n" +
            "     Steps 12-14 cannot be reconciled until Tokio Marine transactions exist —\n" +
            "     the guide's step 2 note applies: a costing must be INVOICED before it is\n" +
            "     picked up in reconciliation."
      );

      /* THE GRID'S SHAPE IS NOT TOKIO-SPECIFIC.
       *
       * readTransactionPage() finds its columns by heading and its checkbox by
       * row, so the shape can be measured from ANY creditor that has costed
       * segments. That is worth doing even when Tokio has none: it turns the
       * step 12-13 column names from a guess into a measurement, which is the
       * one thing still missing.
       *
       * Read-only, and it reconciles nothing — it only prints headings. */
      if (!wide.checkboxes) {
        line("\n=== measuring the grid shape from a creditor that HAS data ===");
        line("  (shape only — nothing is matched, ticked or saved)");

        // Creditors seen carrying segments on booking 13061's receipt form.
        // Typed text, and what the resolved code must match. Both are needed:
        // "Journey Beyond" resolves to "[GSR] Journey Beyond (JBRE) / Great
        // Southern Rail", so the check cannot be the typed word either.
        const others = val("--shape-from")
          ? [{ type: val("--shape-from"), expect: new RegExp(val("--shape-from").split(/\s+/)[0], "i") }]
          : [
              { type: "Journey Beyond", expect: /journey beyond/i },
              { type: "Great Southern", expect: /great southern/i },
              { type: "RAA- Fees", expect: /raa-\s*fees/i },
            ];
        let measured = false;

        for (const who of others) {
          let searched;
          try {
            await tk.openIssuePayments(page, () => {});
            searched = await tk.searchCreditorPayments(page, {
              creditor: who.type,
              expect: who.expect,
              fromCreated: wideFrom,
              toCreated: wideTo,
            }, () => {});
          } catch (err) {
            line(`  "${who.type}": ${err.message.split("\n")[0]}`);
            continue;
          }

          const grid = await tk.readTransactionPage(page);
          if (!grid.found || !grid.rows.length) {
            line(`  "${who.type}" (${searched.creditor}): no rows either`);
            continue;
          }

          line(`\n  ${searched.creditor} — ${grid.rows.length} row(s)`);
          line(`  HEADINGS: ${grid.headers.filter(Boolean).join(" | ")}`);
          line("  as readTransactionPage() sees the first three rows:");
          grid.rows.slice(0, 3).forEach((r) => {
            line(`    reference="${r.reference}" amount=${r.amount} booking="${r.bookingNo}" handle=${r.handle}`);
          });

          const boxes = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input[type="checkbox"]'))
              .slice(0, 4)
              .map((b) => `${b.id ? "#" + b.id : "(no id)"}${b.name ? " name=" + b.name : ""}`)
          );
          line(`  checkbox ids: ${boxes.join(", ")}`);
          line(
            grid.rows.every((r) => r.amount != null)
              ? "  every row carried a readable amount — the amount column was found"
              : "  SOME ROWS HAD NO AMOUNT — the amount column heading needs adding to readTransactionPage()"
          );
          measured = true;
          break;
        }

        if (!measured) {
          line("  no creditor tried had rows either. Pass --shape-from \"<creditor>\" with one you know has data.");
        }
      }
    }

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

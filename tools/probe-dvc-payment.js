/**
 * probe-dvc-payment.js — READ-ONLY. Opens the Issue Payment screen for DVC's
 * payment category and describes everything about it that has never been
 * measured.
 *
 *   npm run probe:dvc
 *   npm run probe:dvc -- --card "Westpac DVC" --date 2026-09-04
 *
 * IT TICKS NOTHING, SAVES NOTHING AND ISSUES NOTHING. It stops immediately
 * after the search and prints what came back.
 *
 * Why this exists: the search form on `finance-payments-issue.htm` was measured
 * on 18-09-2026 (docs/tokio-marine.md) with Payment Category set to Creditor
 * Payment. Everything DVC needs BELOW that — the Credit Card field that only
 * appears for Agency CC Reimbursement, the results grid's columns, the row
 * checkboxes, the session box, Round Remaining, Issue — has not been. The code
 * in `tramada-dvc.js` discovers all of it at runtime and refuses loudly when it
 * cannot, which is correct but is not the same as knowing. This turns the guess
 * into a measurement that can go in docs/dvc.md.
 *
 * It drives the REAL functions — `fillSearch`, `readGrid` — rather than a copy
 * of them. A probe that reimplements what it is probing succeeds exactly where
 * the real path fails, which is worse than having no probe.
 */
require("dotenv").config();
const core = require("../recon-core");
const dvc = require("../tramada-dvc");
const screen = require("../tramada-issue-payments");

const argv = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const line = (m) => console.log(m);
const say = (m, ok) => line(`  ${ok === false ? "!" : "·"} ${m}`);

(async () => {
  const card = val("--card", process.env.DVC_CARD || "Westpac DVC");
  const statementDate = val("--date", new Date().toISOString().slice(0, 10));
  // §4 before anything opens, same gate the run uses.
  core.assertCardLabel(card, "Credit Card");

  const browser = await screen.openBrowser((p, m) => line(`  [${String(p).padStart(3)}%] ${m}`));
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  try {
    await screen.openIssuePayments(page, (p, m) => line(`  [${String(p).padStart(3)}%] ${m}`));

    /* ---- what the search form offers, BEFORE anything is set ------------- */
    line("\n=== the search form's dropdowns, as they load ===");
    for (const [name, sel] of Object.entries(screen.SEARCH)) {
      const opts = await screen.optionsOf(page, sel);
      if (!opts.length) {
        const there = await page.locator(sel).count();
        line(`  ${name.padEnd(16)} ${sel}  ${there ? "(not a select)" : "NOT ON THE PAGE"}`);
        continue;
      }
      line(`  ${name.padEnd(16)} ${sel}`);
      opts.forEach((o) => line(`      ${String(o.value || '""').padEnd(46)} ${screen.clean(o.text)}`));
    }

    /* ---- and once the category is DVC's, which posts the form back ------- */
    line("\n=== setting BR12's parameters (this posts the form back) ===");
    const settled = await dvc.fillSearch(page, { statementDate, creditCard: card }, say);
    line(`  Credit Card found at ${settled.creditCard.selector} by ${settled.creditCard.how}`);
    line(`  segments created ${settled.from} → ${settled.to}`);

    /* ---- the results grid ------------------------------------------------ */
    line("\n=== the results grid ===");
    const raw = await screen.readResultsGrid(page);
    if (!raw.found) {
      line("  NO GRID FOUND. Tables on the page:");
      raw.tables.forEach((t) => line(`      ${t}`));
    } else {
      line("  headers: " + raw.headers.join(" | "));
      line(`  ${raw.rows.length} row(s) with a checkbox`);
      raw.rows.slice(0, 5).forEach((r, i) => {
        line(`    row ${i + 1}: ${r.cells.join(" | ")}`);
        line(`            box ${r.selectId || "(NO id and NO name — unaddressable)"}` +
          (r.alreadyTicked ? " [already ticked]" : "") + (r.disabled ? " [disabled]" : ""));
      });

      /* Does the guessed column map actually fit what came back? This is the
         single most useful line the probe prints. */
      line("\n=== ISSUE_PAYMENT_COLUMNS against those headers ===");
      const parsed = core.parseIssuePaymentRows(raw.headers, raw.rows);
      if (parsed.missingColumns.length) {
        line(`  MISSING: ${parsed.missingColumns.join(", ")}  <- add these header names to ` +
          "recon-core.ISSUE_PAYMENT_COLUMNS");
      } else {
        line("  every required column was found.");
      }
      const first = parsed.rows[0];
      if (first) {
        for (const k of ["bookingNo", "reference", "segType", "passenger", "issued", "amount"]) {
          line(`  ${k.padEnd(11)} ${first[k] === "" ? "(not found)" : first[k]}`);
        }
      }
    }

    /* ---- the buttons and boxes steps 16 and 17 need --------------------- */
    line("\n=== what steps 16 and 17 will reach for ===");
    for (const [what, pattern] of [["Session", "session"], ["Issue", "^issue$"], ["Go", "^go$"]]) {
      const b = await screen.findButton(page, pattern);
      line(`  ${what.padEnd(8)} ${b.selector ? `${b.selector} "${b.text}"` : "NOT FOUND"}`);
    }
    const sessionBox = await screen.findControl(page, { label: "Session", idHint: "session", tag: "input" });
    line(`  session label field  ${sessionBox.selector || "NOT FOUND"}` +
      (sessionBox.how ? ` (by ${sessionBox.how})` : ""));
    const round = await page.locator("#roundRemaining").count()
      ? "#roundRemaining"
      : (await screen.findControl(page, { label: "Round Remaining", idHint: "round", tag: "input" })).selector;
    line(`  Round Remaining      ${round || "NOT FOUND"}`);

    line("\n=== every button on the page ===");
    const all = await screen.findButton(page, "\\u0000never matches");
    all.seen.forEach((b) => line("  " + b));

    line("\nRead-only probe finished. Nothing ticked, nothing saved, nothing issued.");
    line("Put what it printed into docs/dvc.md and replace the candidates in");
    line("recon-core.ISSUE_PAYMENT_COLUMNS with the real header names.");
  } catch (err) {
    console.error("\nProbe failed: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    // The page is LEFT OPEN on purpose: what the probe could not describe is
    // exactly what somebody now needs to look at.
    await browser.close().catch(() => {});
  }
})();

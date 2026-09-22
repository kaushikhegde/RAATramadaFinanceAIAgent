/**
 * tokio-recon.js — steps 9 to 14 of the Tokio Marine reconciliation.
 *
 *   node tools/tokio-recon.js --sheet consolidated.json
 *   node tools/tokio-recon.js --sheet consolidated.json --save
 *
 * The consolidated sheet is what steps 1-8 produce: POST the four spreadsheets
 * to /api/tokio/parse and save the response, or pass buildConsolidated()'s own
 * output. Steps 1-8 are pure and tested; this only drives Tramada.
 *
 * Without --save it ticks the matching lines and STOPS, leaving the page on
 * screen. With --save it also saves the session under TOKIO_MMM YY. It never
 * clicks Issue, which is BR16 and BR18's whole point: Travel Accounts resolve
 * the exceptions, apply rounding and enter the total.
 */
require("dotenv").config();
const fs = require("fs");
const tk = require("../tramada-tokio");

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const sheetPath = val("--sheet");
if (!sheetPath) {
  console.error("Which consolidated sheet? --sheet <file.json>");
  process.exit(2);
}

(async () => {
  const parsed = JSON.parse(fs.readFileSync(sheetPath, "utf8"));
  // Accept the API's response shape or buildConsolidated()'s own.
  const consolidated = parsed.rows || parsed.consolidated || parsed;
  const month = val("--month", (parsed.month && parsed.month.key) || undefined);

  try {
    const out = await tk.runTokioReconciliation({
      consolidated,
      month,
      dryRun: !flag("--save"),
      confirm: flag("--save") ? tk.SAVE_LITERAL : null,
      creditor: val("--creditor", "Tokio"),
      callbacks: {
        onProgress: (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
        onStep: (s) => console.log(`       · ${s.step}${s.detail ? " — " + s.detail : ""}`),
      },
    });

    console.log(`\nReference     ${out.reference}`);
    console.log(`Session label ${out.label}`);
    console.log(`Ticked        ${out.ticked.length}`);
    console.log(`Not ticked    ${out.mismatched.length}`);
    for (const m of out.mismatched.slice(0, 20)) {
      console.log(`  ${m.policy}  ${m.remark}${m.closest != null ? `  (closest ${m.closest}, wanted ${m.expected})` : ""}`);
    }
    if (out.mismatched.length > 20) console.log(`  ... and ${out.mismatched.length - 20} more`);
    console.log(
      out.savedSession
        ? `\nSession ${out.label} saved. Issue was NOT clicked — that is Travel Accounts' step (BR16/BR18).`
        : `\nNothing saved. Re-run with --save to save the session as ${out.label}.`
    );

    // The Remarks column the guide asks for, as data rather than console text.
    const remarks = out.mismatched.map((m) => ({ policy: m.policy, remark: m.remark }));
    fs.writeFileSync("tokio-remarks.json", JSON.stringify(remarks, null, 2));
    console.log(`Remarks for ${remarks.length} rows written to tokio-remarks.json.`);
  } catch (err) {
    console.error("\nFAILED: " + err.message);
    if (err.steps) for (const s of err.steps) console.error(`       · ${s.step}${s.detail ? " — " + s.detail : ""}`);
    process.exitCode = 1;
  }
})();

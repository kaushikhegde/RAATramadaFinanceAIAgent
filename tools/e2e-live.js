/**
 * ALL FOUR PAYMENT TYPES, AGAINST THE REAL TRAMADA SANDBOX, AS A DRY RUN.
 *
 *   node tools/e2e-live.js                 all four, one after another
 *   node tools/e2e-live.js bpay mint       just those
 *   node tools/e2e-live.js --wet           actually press Issue and Done
 *
 * Needs a Chrome on CDP 9222 already signed into Tramada — the same one
 * `npm run start:chrome` opens. Nothing here ever types a credential
 * (CLAUDE.md §5); if that Chrome is signed out this stops and says so.
 *
 * ── DRY RUN IS THE DEFAULT AND YOU SHOULD LEAVE IT THERE ──────────────────
 * A dry run does everything the real one does — creates the statement page,
 * fills the receipt forms, works out and types the allocation, ticks the
 * matched lines — and stops one click short of the two that make it permanent:
 * Issue on a receipt and Done on the statement page. So it exercises the same
 * code and the same guards, and leaves Tramada as it found it.
 *
 * `--wet` files real receipts against real bookings in the sandbox. That is a
 * deliberate, separate decision, which is why it is a flag and not a default.
 *
 * ── WHAT A FAILURE HERE MEANS ────────────────────────────────────────────
 * `tools/check-all-sources.js` already proved the file-reading and the
 * decisions offline. Anything that fails HERE and passes THERE is the browser
 * half: a Tramada screen that changed, a field that moved, a login that
 * lapsed. That is the whole point of splitting them.
 */
const fs = require("fs");
const path = require("path");
const C = require("../recon-core");
const XL = require("../xlsx-lite");
const { runReconciliation, runMintReconciliation } = require("../recon-run");
const { runIpsiReconciliation } = require("../tramada-ipsi");

const root = path.join(__dirname, "..");
const R = (...p) => path.join(root, ...p);

const argv = process.argv.slice(2);
const WET = argv.includes("--wet");
const want = argv.filter((a) => !a.startsWith("--"));
const PICK = want.length ? want : ["bpay", "mint", "travelpay", "ipsi"];

/* Today, in Tramada's own format. Overridable, because a sandbox with no
   bookings departing today needs a date that has some. */
const DATE = process.env.RECON_DATE || C.toTramadaDate(new Date().toISOString().slice(0, 10));

const FILES = {
  bpay:      R("uploads", "20260827-045004-bpay.csv"),
  mint:      R("fixtures", "mint-payments.csv"),
  travelpay: R("fixtures", "travelpay-payments.csv"),
  ipsi:      R("csv_uploads", "ipsi-payments.csv"),
};

function readGrid(file) {
  if (/\.xlsx$/i.test(file)) {
    const sheet = XL.readSheet(fs.readFileSync(file));
    return { headers: sheet.headers, rows: sheet.rows };
  }
  const g = C.csvGrid(fs.readFileSync(file, "utf8"));
  return { headers: g.headers, rows: g.rows };
}

function parse(kind, file) {
  const { headers, rows } = readGrid(file);
  if (kind === "bpay") return C.parseReconRows(headers, rows);
  if (kind === "mint") return C.parseMintRows(headers, rows);
  if (kind === "travelpay") return C.parseTravelPayRows(headers, rows);
  return C.parseIpsiRows(headers, rows);
}

const bar = (t) => console.log(`\n\x1b[1m\x1b[7m ${t} \x1b[0m`);
const money = (c) => (c == null ? "—" : "$" + (c / 100).toFixed(2));

/* Every line the run emits, prefixed, so a run that hangs shows WHERE. A silent
   spinner is the reason "it just stopped" was ever a bug report. */
function callbacks(kind) {
  return {
    onProgress: (m) => console.log(`   ${kind} · ${m}`),
    /* onRow(n, patch) — TWO arguments, not one row object. The first version
       of this took (r) and printed "row undefined" against every line, which
       looked like the run losing track of its rows rather than the harness
       reading the callback wrong. */
    onRow: (n, patch = {}) => {
      const bits = [patch.allocation, patch.reconciliation].filter(Boolean).join(" / ");
      if (!bits && !patch.why && !patch.receiptNo) return;   // nothing worth a line
      console.log(`   ${kind} · row ${n} ${String(patch.receiptNo || "").padEnd(14)} ${bits}` +
        (patch.why ? `  — ${patch.why}` : ""));
    },
  };
}

/* The bank statement has to exist before Mint/TravelPay can reconcile against
   it, and BPay is what creates it — so the order here is RUN_ORDER's, not the
   order the arguments were typed in. Same rule as a combined run in the app. */
const order = C.RUN_ORDER.filter((k) => PICK.includes(k));
const results = [];

async function one(kind) {
  bar(`${kind.toUpperCase()}  ·  ${path.basename(FILES[kind])}  ·  ${DATE}  ·  ${WET ? "WET — WILL WRITE" : "dry run"}`);
  const p = parse(kind, FILES[kind]);
  if (p.problems && p.problems.length) {
    p.problems.forEach((x) => console.log(`   ✗ line ${x.line}: ${x.why}`));
    return { kind, ok: false, why: "the file would not parse" };
  }
  console.log(`   ${p.rows.length} row(s), ${money(p.rows.reduce((a, r) => a + (r.amountCents || 0), 0))}`);

  const total = (p.rows.reduce((a, r) => a + (r.amountCents || 0), 0) / 100).toFixed(2);
  const common = { rows: p.rows, dryRun: !WET, callbacks: callbacks(kind) };

  const started = Date.now();
  try {
    let out;
    if (kind === "bpay") {
      out = await runReconciliation({
        ...common, statementDate: DATE,
        // The balances a person reads off the bank statement. In a dry run they
        // are typed into the page like any other run and never committed.
        openingBalance: process.env.RECON_OPENING || "0.00",
        closingBalance: process.env.RECON_CLOSING || total,
      });
    } else if (kind === "ipsi") {
      out = await runIpsiReconciliation({
        ...common, payerName: "IPSI", toDate: DATE, dateReceived: DATE,
        transactionTotal: total,          // BR01 — the NUVEI figure, made to agree
      });
    } else {
      out = await runMintReconciliation({
        ...common, source: kind, recPayType: C.REPORTS[kind].recPayType,
        statementDate: DATE,
        openingBalance: process.env.RECON_OPENING || "0.00",
        closingBalance: process.env.RECON_CLOSING || total,
        transactionTotal: total,          // BR02
      });
    }
    const s = out.summary || {};
    console.log(`   \x1b[32m✓\x1b[0m finished in ${Math.round((Date.now() - started) / 1000)}s · ` +
      Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", "));
    return { kind, ok: true, summary: s, page: out.pageNumber };
  } catch (e) {
    const why = C.tidyError ? C.tidyError(e.message || String(e)) : (e.message || String(e));
    console.log(`   \x1b[31m✗\x1b[0m ${why}`);
    return { kind, ok: false, why };
  }
}

(async () => {
  console.log(`\n  run order: ${order.join(" → ")}   (BPay first — it creates the statement the others reconcile against)`);
  if (WET) console.log(`  \x1b[33mWET RUN — receipts will be issued and the statement committed.\x1b[0m`);

  for (const k of order) {
    results.push(await one(k));
    /* STOP AT THE FIRST FAILURE, rather than running the rest against a
       statement page that was never created. Three more failures caused by the
       first one is noise, and it hides which one actually broke. */
    if (!results[results.length - 1].ok && k === "bpay" && order.length > 1) {
      console.log(`\n   BPay failed, so the rest would only fail for the same reason. Stopping.`);
      break;
    }
  }

  bar("RESULT");
  for (const r of results) {
    console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.kind.padEnd(10)} ` +
      (r.ok ? Object.entries(r.summary || {}).map(([k, v]) => `${k} ${v}`).join(", ") : r.why));
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = order.length - results.length;
  console.log(`\n  ${results.filter((r) => r.ok).length} ran, ${failed} failed` +
    (skipped ? `, ${skipped} not attempted` : "") + (WET ? "" : " · nothing was committed") + "\n");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`\n  the driver itself failed: ${e.message}\n`); process.exit(1); });

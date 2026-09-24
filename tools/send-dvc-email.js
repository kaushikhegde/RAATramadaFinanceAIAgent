/**
 * send-dvc-email.js — send step 18's email for real, without a Tramada run.
 *
 *   npm run email:dvc                                   # the fixtures, 04/09/2026
 *   npm run email:dvc -- --westpac csv_uploads/dvc-westpac-live.csv \
 *                        --tramada csv_uploads/dvc-tramada-live.csv --date 2026-09-23
 *   npm run email:dvc -- --dry                          # print it, send nothing
 *
 * It reconciles the two files with the same `reconcileDvc` a run uses, builds
 * the email with the same `dvcEmail`, and sends it with the same mailer — so a
 * message that arrives here is the message a run would send, byte for byte,
 * apart from the Tramada half, which it did not do and says so.
 *
 * Why it exists: the first real test of a mail setting should not be the end
 * of a run that has just saved a Payment Session. A relay that refuses the
 * key or the login is found here, in two seconds, with nothing else riding on it.
 *
 * Sends to DVC_EMAIL_TO only — there is no default recipient (see mailer.js),
 * through Graph or Resend, whichever .env configures (docs/email.md).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const core = require("../recon-core");
const xlsxLite = require("../xlsx-lite");
const mailer = require("../mailer");

const args = process.argv.slice(2);
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = args.includes("--dry");
const ROOT = path.join(__dirname, "..");
const WESTPAC = path.resolve(ROOT, valueOf("--westpac", "fixtures/dvc-westpac.csv"));
const TRAMADA = path.resolve(ROOT, valueOf("--tramada", "fixtures/dvc-tramada.csv"));
const DATE = valueOf("--date", "2026-09-04");

/** A .csv or .xlsx into headers + rows, the way the upload path reads them. */
function grid(file) {
  const buf = fs.readFileSync(file);
  // The ZIP magic, not the extension — the same test the upload path uses.
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
  return isZip ? xlsxLite.readSheet(buf) : core.csvGrid(buf.toString("utf8"));
}

(async () => {
  const w = grid(WESTPAC);
  const t = grid(TRAMADA);
  const report = core.parseDvcRows(w.headers, w.rows);
  const costings = core.parseTramadaCcRows(t.headers, t.rows);
  const { rows } = core.filterDvcSettlementDate(report.rows, DATE);
  if (!rows.length) {
    console.error(`\n  None of ${path.basename(WESTPAC)}'s lines settled on ${DATE}. Pass --date.\n`);
    process.exit(1);
  }
  const out = core.reconcileDvc(rows, costings.rows);
  const total = core.checkDvcTotal(rows, "");
  const message = core.dvcEmail({
    statementDate: DATE,
    summary: out.summary,
    rows: out.rows,
    unmatchedTramada: out.unmatchedTramada,
    totalCheck: total,
    // Said plainly in the email itself: this tool reconciles and mails, it
    // never opened Tramada, so no session exists for it to report.
    payment: { skipped: true, why: "this was a test email from tools/send-dvc-email.js — Tramada was not opened" },
    columns: report.columns,
    runId: "email-test",
  });

  console.log(`\n  ${out.summary.matched} of ${out.summary.total} lines clean on ${DATE}.`);
  console.log(`  Subject: ${message.subject}`);
  console.log(`  Attachment: ${message.attachment.filename} (${message.attachment.content.length} chars)\n`);
  if (DRY) {
    console.log(message.text);
    return;
  }
  const c = mailer.config();
  if (!c.ready) {
    console.error(`  Not sent — set ${c.missing.join(", ")} in .env (see .env.example).\n`);
    process.exit(1);
  }
  const res = await mailer.send(message);
  if (!res.sent) {
    console.error(`  Not sent — ${res.why}\n`);
    process.exit(1);
  }
  console.log(`  ✓ Sent to ${res.to.join(", ")}` + (res.from ? ` from ${res.from}` : "") +
    ` via ${res.via === "graph" ? "Microsoft Graph" : "Resend"}.\n`);
})().catch((err) => { console.error(`\n  ${err.message}\n`); process.exit(1); });

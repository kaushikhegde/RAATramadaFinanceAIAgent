/**
 * `reconEmail` — the shared email for BPay, Mint, TravelPay and IPSI. It sits
 * beside `dvcEmail` rather than replacing it: those four reports never save a
 * Tramada Payment Session, so there is no "saved / not saved / Tramada raised
 * something" branch to test here, only "what happened" plus the attachment.
 */
const C = require("../recon-core");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
}

console.log("\nreconEmail — the shared step-18 email for the other four reports\n");

const CLEAN_ROWS = [
  { n: 1, remark: "", why: "", cells: { "Booking No": "140221", Amount: "612.40" } },
  { n: 2, remark: "", why: "", cells: { "Booking No": "140255", Amount: "288.55" } },
];
const FLAGGED_ROWS = [
  ...CLEAN_ROWS,
  { n: 3, remark: "Please review", why: "amount does not match", cells: { "Booking No": "140310", Amount: "455.00" } },
];

{
  const msg = C.reconEmail({
    source: "bpay", title: "BPay receipts", statementDate: "2026-09-24",
    headline: "2 of 2 allocated, 2 reconciled.",
    rows: CLEAN_ROWS, columns: ["Booking No", "Amount"], runId: "run-1",
  });
  ok("the subject names the report and the day",
    msg.subject === "AI Agent BPay receipts reconciliation — 2026-09-24",
    msg.subject);
  ok("a clean run says nothing needs the attachment", !/flagged for a person/.test(msg.text));
  ok("the run id is on the record", msg.text.includes("Run run-1"));
  ok("the attachment is a CSV with a BOM", msg.attachment.content.startsWith("﻿"));
  check("the attachment file name carries the source and the day",
    msg.attachment.filename, "bpay-reconciliation-2026-09-24.csv");
}

{
  const msg = C.reconEmail({
    source: "ipsi", title: "IPSI merchant settlement", statementDate: "2026-09-24",
    headline: "IPSI 2026-09-24: 2 of 3 matched and ticked, receipt issued for $900.95.",
    rows: FLAGGED_ROWS, columns: ["Booking No", "Amount"], runId: "run-2",
  });
  ok("a flagged row is counted, not silently dropped",
    /See the attachment for the 1 line flagged for a person/.test(msg.text), msg.text);
  ok("the headline the caller worked out is what the email opens with",
    msg.text.startsWith("IPSI 2026-09-24: 2 of 3 matched and ticked"));
  ok("the flagged row's own Remarks reach the attachment",
    msg.attachment.content.includes("Please review") && msg.attachment.content.includes("amount does not match"));
  ok("a clean row's Remarks cell stays blank, not the closed vocabulary's other end",
    /140221,612\.40,,,,/.test(msg.attachment.content));
}

{
  // No statement date at all — a report with none entered should not crash,
  // and should say so rather than printing "undefined".
  const msg = C.reconEmail({ source: "mint", title: "Mint daily settlement", headline: "0 of 0.", rows: [] });
  ok("no statement date reads as none given, not undefined", msg.text.includes("(none given)"), msg.text);
  ok("the attachment still gets a filename", /^mint-reconciliation-undated\.csv$/.test(msg.attachment.filename));
}

{
  const msg = C.reconEmail({
    source: "travelpay", title: "TravelPay merchant settlement", statementDate: "2026-09-24",
    headline: "1 of 1 found.", rows: CLEAN_ROWS, dryRun: true,
  });
  ok("a dry run says so in the subject", msg.subject.includes("[DRY RUN]"), msg.subject);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

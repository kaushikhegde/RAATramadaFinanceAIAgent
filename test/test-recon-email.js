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
  /* Booking No, Amount, then Remarks, Reconciled and Why. Consultant, Shop,
     Receipt No and Allocation are blank on every row here, so they are left off
     rather than sent as four empty columns (see `reportSheetCsv`). */
  ok("a clean row's Remarks cell stays blank, not the closed vocabulary's other end",
    /\n140221,612\.40,,,\n/.test(msg.attachment.content), msg.attachment.content);
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

console.log("\nthe attachment is THEIR spreadsheet, not just the Remarks\n");

/* What it used to do: a Mint (or TravelPay, or IPSI) row carried only the three
   or four fields the matcher reads, so the attached sheet was the run's own
   columns over blank rows — Remarks the only thing Travel Accounts could read.
   A combined run was worse: the page sends no `columns` for it at all. */
const MINT_HEAD = ["From Company", "To Company ", "Transaction Reference", "Amount", "Currency", "Status"];
const mint = C.parseMintRows(MINT_HEAD, [
  ["RAA", "Viva Holidays Pty Ltd", "M00640038", "594", "AUD", "Pending at Bank"],
  ["RAA", "Ready Rooms", "M00641007", "3684.84", "AUD", "Pending at Bank"],
]);
const mintRun = mint.rows.map((r, i) => ({
  ...r, src: "mint",
  reconciliation: i ? "Not reconciled" : "Reconciled",
  remark: i ? "Supplier does not match" : "",
  why: i ? "the page pays \"X\", the file says \"Ready Rooms\"" : "found",
}));

{
  const msg = C.reconEmail({
    source: "mint", title: "Mint daily settlement", statementDate: "2026-09-24",
    headline: "1 of 2.", rows: mintRun, columns: mint.columns,
  });
  const csv = msg.attachment.content.replace(/^\uFEFF/, "");
  const [head, first, second] = csv.trim().split("\n");
  check("every one of the file's columns, then the run's verdict",
    head, "From Company,To Company,Transaction Reference,Amount,Currency,Status,Remarks,Reconciled,Why");
  check("a clean row carries its whole line, not just a blank Remarks",
    first, "RAA,Viva Holidays Pty Ltd,M00640038,594,AUD,Pending at Bank,,Reconciled,found");
  ok("a flagged row carries its line AND its remark",
    second.startsWith("RAA,Ready Rooms,M00641007,3684.84,AUD,Pending at Bank,Supplier does not match,Not reconciled,"),
    second);
  ok("BPay's Consultant/Shop/Receipt No/Allocation are not sent as empty columns",
    !/Consultant|Shop|Receipt No|Allocation/.test(head), head);
}

{
  // The page sends NO columns on a single-report run it reopened, or on any
  // combined run — the rows' own cells are the headings then.
  const msg = C.reconEmail({
    source: "mint", title: "Mint daily settlement", statementDate: "2026-09-24",
    headline: "1 of 2.", rows: mintRun, columns: [],
  });
  ok("with no columns sent, the headings are read off the rows' own cells",
    msg.attachment.content.includes("From Company,To Company,Transaction Reference,Amount,Currency,Status,Remarks"),
    msg.attachment.content.split("\n")[0]);
}

{
  const TP_HEAD = ["Payment Reference", "Processed Amount", "MerchantCompanyName", "Status", "Customer Email"];
  const tp = C.parseTravelPayRows(TP_HEAD, [["TP-AB12C-140221", "612.40", "Viva Holidays", "Successful", "a@b.c"]]);
  check("TravelPay rows keep their cells too", tp.rows[0].cells["Customer Email"], "a@b.c");
  const rows = mintRun.concat(tp.rows.map((r) => ({ ...r, src: "travelpay", reconciliation: "Reconciled", remark: "", why: "found" })));
  const msg = C.reconEmail({
    source: "combined", title: "Mint + TravelPay", statementDate: "2026-09-24",
    headline: "2 of 3.", rows, columns: [],
  });
  check("a combined run attaches one sheet per report, in run order",
    msg.attachments.map((a) => a.filename),
    ["mint-reconciliation-2026-09-24.csv", "travelpay-reconciliation-2026-09-24.csv"]);
  const tpCsv = msg.attachments[1].content;
  ok("each in its own report's columns — no Mint headings on the TravelPay sheet",
    tpCsv.includes("Payment Reference,Processed Amount,MerchantCompanyName,Status,Customer Email,Remarks") &&
      !tpCsv.includes("From Company"), tpCsv.split("\n")[0]);
  check("`attachment` is still the first, for callers that know only one",
    msg.attachment.filename, msg.attachments[0].filename);

  // And both files actually leave: the mailer used to read `attachment` alone.
  const mailer = require("../mailer");
  check("Graph carries every attachment",
    mailer.graphMessage(msg, ["x@y.z"]).message.attachments.map((a) => a.name), msg.attachments.map((a) => a.filename));
  check("so does Resend",
    mailer.resendMessage(msg, ["x@y.z"], "a@b.c").attachments.map((a) => a.filename), msg.attachments.map((a) => a.filename));
}

{
  const IPSI_HEAD = ["Transaction Reference", "Booking Number", "Transaction Amount", "Card Type", "Terminal"];
  const ip = C.parseIpsiRows(IPSI_HEAD, [["R82EQ6F8", "140221", "612.40", "Visa", "T-7"]]);
  check("IPSI rows keep their cells too", ip.rows.concat(ip.problems.map((p) => p.row))[0].cells.Terminal, "T-7");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * MINT and TravelPay: BR05, BR06, BR07 and the totals check, offline.
 *
 * Both guides ask the same three-way question of every row — reference, amount,
 * supplier — and BOTH say do not tick unless all three agree. That is stricter
 * than this code used to be: it ticked on the reference alone and wrote the
 * disagreement into a column nobody had to act on. On a run that commits a bank
 * statement, that is a tick against a payment whose amount nobody confirmed.
 *
 * The remark strings are asserted character for character. MINT and TravelPay
 * do NOT use the same words for the same failure and must not be merged.
 */
const C = require("../recon-core");

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("\nthe two vocabularies, and that they are two");
check("MINT, a reference that is not there", C.MINT_REMARKS.reference, "Transaction ID does not match or not found");
check("MINT, a wrong amount", C.MINT_REMARKS.amount, "Transaction totals do not match");
check("MINT, a wrong supplier", C.MINT_REMARKS.supplier, "Supplier does not match");
check("MINT, the file's total", C.MINT_REMARKS.total, "Transaction Total does not match.");
check("TravelPay, a wrong amount", C.TRAVELPAY_REMARKS.amount, "Transaction amount does not match");
check("TravelPay, a negative one", C.TRAVELPAY_REMARKS.negative, "Not entered, transaction amount is negative");
// The one a tidy-up would break. MINT says "totals", TravelPay says "amount",
// for the same failure, and Finance filters on this column.
ok("and the amount wording differs between the two guides",
  C.MINT_REMARKS.amount !== C.TRAVELPAY_REMARKS.amount,
  `both read ${C.MINT_REMARKS.amount}`);
ok("while the reference wording is shared",
  C.MINT_REMARKS.reference === C.TRAVELPAY_REMARKS.reference);

console.log("\nBR05 — all three, or no tick");
/* A statement page as `readStatementRows` builds it. Measured on page 13,
   17-Aug-2026: Trans. No is Tramada's own R./P. number and Reference is the id
   the payment was made under — and it is the SECOND one a MINT or TravelPay
   file carries. Both are here so a matcher that reads the wrong column fails. */
const PAGE = [
  { transNo: "P.0000001111", reference: "M00640038", amount: "594.00", payee: "Viva Holidays Pty Ltd" },
  { transNo: "P.0000002222", reference: "M00641007", amount: "3,684.84", payee: "Australia New Zealand Central Reservations Office Pty Ltd" },
  { transNo: "P.0000003333", reference: "M00641453", amount: "510.00", payee: "READY ROOMS" },
];
const row = (o) => ({ transNo: "M00640038", amountCents: 59400, toCompany: "Viva Holidays Pty Ltd", ...o });

{
  const m = C.matchCreditorRow(row(), PAGE);
  check("all three agree — reconciled", [m.reconciled, m.status], [true, "Reconciled"]);
  check("and nothing to remark on", m.remark, "");
  // Both guides name the Reference column. Trans. No is Tramada's own number
  // and a MINT file has never heard of it.
  ok("matched in the Reference column", /Reference column/.test(m.reason), m.reason);
  check("and it ticks by the page's transaction number", m.transNo, "P.0000001111");
}
{
  const m = C.matchCreditorRow(row({ transNo: "M00000000" }), PAGE);
  check("a reference that is not on the page", m.remark, "Transaction ID does not match or not found");
  check("is not ticked", m.reconciled, false);
}
{
  const m = C.matchCreditorRow(row({ amountCents: 59401 }), PAGE);
  check("one cent out is not a match", m.remark, "Transaction totals do not match");
  check("and is not ticked", m.reconciled, false);
  ok("with both figures named", /\$594\.00.*\$594\.01|\$594\.01/.test(m.reason), m.reason);
}
{
  const m = C.matchCreditorRow(row({ toCompany: "Somebody Else Pty Ltd" }), PAGE);
  check("a supplier that does not agree", m.remark, "Supplier does not match");
  check("and is not ticked", m.reconciled, false);
}
{
  // The reference is checked first, because a row that is not on the page has
  // no amount to be wrong about. One failure, one remark.
  const m = C.matchCreditorRow(row({ transNo: "NOPE", amountCents: 1, toCompany: "Nobody" }), PAGE);
  check("the first gate to fail is the one reported", m.remark, "Transaction ID does not match or not found");
}

console.log("\nBR06 — TravelPay does not enter a negative amount");
{
  const m = C.matchCreditorRow(
    { transNo: "31282716", amountCents: -148088, toCompany: "Monarto Resort Pty Ltd" },
    [{ transNo: "P.9", reference: "31282716", amount: "-1480.88", payee: "Monarto Resort Pty Ltd" }],
    { remarks: C.TRAVELPAY_REMARKS });
  check("a refund is not entered", m.remark, "Not entered, transaction amount is negative");
  check("and never ticked, even though the page agrees", m.reconciled, false);
}
{
  // MINT has no negative rule, so a negative there falls through to the normal
  // gates rather than being invented one.
  const m = C.matchCreditorRow(
    { transNo: "M1", amountCents: -100, toCompany: "X" },
    [{ transNo: "P.1", reference: "M1", amount: "-1.00", payee: "X" }]);
  check("MINT has no such rule, so it reconciles", m.reconciled, true);
}

console.log("\nthe supplier cheat sheet");
{
  /* RAA's own dummy file, verbatim. "T/A" is the file saying the two names
     differ; Tramada calls this creditor READY ROOMS. */
  const sheet = C.parseCheatSheet([
    "Spreadsheet Name,Tramada Creditor",
    "Viva Holidays II Limited T/A Ready Rooms,READY ROOMS",
    "DAH Holdings Pty Limited,AVIS",
  ].join("\n"));
  check("both mappings read", sheet.pairs.length, 2);
  const index = C.cheatSheetIndex(sheet.pairs);

  const m = C.matchCreditorRow(
    { transNo: "M00641453", amountCents: 51000, toCompany: "Viva Holidays II Limited T/A Ready Rooms" },
    PAGE, { cheatSheet: index });
  check("a trading name maps through and reconciles", m.reconciled, true);
  ok("and the reason says it was a mapping",
    /cheat sheet/.test(m.reason), m.reason);

  // Without the sheet the same row is a supplier mismatch — which is the whole
  // point of the sheet existing.
  const without = C.matchCreditorRow(
    { transNo: "M00641453", amountCents: 51000, toCompany: "Viva Holidays II Limited T/A Ready Rooms" },
    PAGE);
  check("without the sheet it does not match", without.remark, "Supplier does not match");
  ok("and says it is not in the cheat sheet", /not in the cheat sheet/.test(without.reason), without.reason);
}
{
  // A mapping that points somewhere else is not a licence to tick.
  const index = C.cheatSheetIndex([{ from: "Viva Holidays II Limited T/A Ready Rooms", to: "SOMEWHERE ELSE" }]);
  const m = C.matchCreditorRow(
    { transNo: "M00641453", amountCents: 51000, toCompany: "Viva Holidays II Limited T/A Ready Rooms" },
    PAGE, { cheatSheet: index });
  check("a mapping to the wrong creditor still fails", m.reconciled, false);
  ok("and says the sheet disagrees", /cheat sheet disagrees/.test(m.reason), m.reason);
}
{
  // Exact, then the sheet. NOT clever: two creditors can differ by one word and
  // be different companies, and a tick commits money on a bank statement.
  check("case and spacing are not a difference",
    C.supplierMatches("  Viva   Holidays Pty Ltd ", "viva holidays pty ltd", null).ok, true);
  check("but Pty Ltd vs Pty Limited IS, until the sheet says otherwise",
    C.supplierMatches("Scenic Tours Pty Ltd", "Scenic Tours Pty Limited", null).ok, false);
  check("and a blank name never matches", C.supplierMatches("", "READY ROOMS", null).ok, false);
}
{
  /* A file with no heading loses its first line to the header, because the
     first line of a CSV is a heading. Rather than guess whether it looked like
     data, the parser says what it did — the alternative is silently dropping or
     inventing a supplier mapping, and both are worse than a sentence. */
  const two = C.parseCheatSheet("Viva Holidays II Limited T/A Ready Rooms,READY ROOMS");
  check("a headerless file yields no mapping", two.pairs.length, 0);
  ok("but says exactly what it read as the heading",
    /read as the heading row/.test(two.problems[0].why) &&
    /Ready Rooms/.test(two.problems[0].why), JSON.stringify(two.problems));
  const positional = C.parseCheatSheet("Name,Maps To\nViva Holidays II Limited T/A Ready Rooms,READY ROOMS");
  check("unrecognised headings are still used positionally", positional.pairs.length, 1);
  check("mapping the two columns in order", positional.pairs[0].to, "READY ROOMS");
  const half = C.parseCheatSheet("Spreadsheet Name,Tramada Creditor\nOnly One Side,");
  check("half a mapping is a problem, not a mapping", half.pairs.length, 0);
  ok("and it is named", /half a mapping/.test(half.problems[0].why), half.problems[0].why);
  const blank = C.parseCheatSheet("Spreadsheet Name,Tramada Creditor\n,\nA,B");
  check("a spacer line is skipped rather than mapping nothing to nothing", blank.pairs.length, 1);
}

console.log("\nRAA's own cheat sheet — one sheet, both reports, .xlsx");
{
  /* The real file, read the way the server reads it. Asserted against the
     actual workbook rather than a fixture because the headings, the separators
     and the plural in "TRY THESE" are all facts about THAT file. */
  const fs = require("fs");
  const X = require("../xlsx-lite");
  const sheet = X.readSheet(fs.readFileSync("./cheat-sheets/supplier-names.xlsx"));
  check("its headings are the two the sheet actually uses",
    sheet.headers, ["SUPPLIER NAME IN MINT / TRAVELPAY", "IN TRAMADA - TRY THESE"]);

  const parsed = C.parseCheatSheet(sheet);
  ok("a workbook parses without being turned into text first", parsed.pairs.length === 28,
    `${parsed.pairs.length} pairs`);
  check("and nothing in it is a problem", parsed.problems, []);
  // The heading names both reports. There is one sheet, not one per report.
  ok("the heading names MINT and TravelPay together",
    /mint\s*\/\s*travelpay/i.test(sheet.headers[0]), sheet.headers[0]);

  const ix = C.cheatSheetIndex(parsed.pairs);
  const via = (file, tramada) => C.supplierMatches(file, tramada, ix);

  // "TRY THESE" is plural and the sheet means it.
  check("one row, several creditors — the first", via("RCL CRUISES LTD", "Royal Caribbean").ok, true);
  check("and the second", via("RCL CRUISES LTD", "Celebrity Cruises").ok, true);
  check("commas separate too", via("Circuit Travel Pty Ltd", "Globus").ok, true);
  check("all three of them", via("Circuit Travel Pty Ltd", "Avalon Waterways").ok, true);
  // The whole cell stays a candidate, so splitting can only ever ADD a name.
  check("and the cell as written still matches",
    via("RCL CRUISES LTD", "Royal Caribbean / Celebrity Cruises").ok, true);
  check("a row with no separator is one name",
    C.cheatSheetCandidates("Journey Beyond"), ["Journey Beyond"]);
  /* The two separators both appear INSIDE real company names — "Broome,
     Kimberley & Beyond Pty Ltd" and "Viva Holidays II Limited T/A Ready Rooms".
     Keeping the whole cell is what stops a split from losing either. */
  ok("a name containing a comma survives being split",
    C.cheatSheetCandidates("Broome, Kimberley & Beyond Pty Ltd")[0] === "Broome, Kimberley & Beyond Pty Ltd");
  check("and T/A is not a separator — only a spaced slash is",
    C.cheatSheetCandidates("Viva Holidays II Limited T/A Ready Rooms"),
    ["Viva Holidays II Limited T/A Ready Rooms"]);
  check("nor is a hyphen", C.cheatSheetCandidates("Rail On-line"), ["Rail On-line"]);
}

console.log("\nthe sheet survives a restart");
{
  /* The candidates are worked out when the file is READ and used when a run
     matches — with a save and a process restart in between. Writing only the
     cell would leave "Royal Caribbean" un-matchable tomorrow morning, and
     nothing on screen would say so. */
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cheat-"));
  process.env.RECON_STORE_DIR = dir;
  delete require.cache[require.resolve("../run-store")];
  const store = require("../run-store");

  const parsed = C.parseCheatSheet([
    "SUPPLIER NAME IN MINT / TRAVELPAY,IN TRAMADA - TRY THESE",
    "RCL CRUISES LTD,Royal Caribbean / Celebrity Cruises",
  ].join("\n"));
  store.saveCheatSheet("suppliers", { name: "Supplier Cheat Sheet.xlsx", pairs: parsed.pairs });

  // Off disk, as a fresh process would see it.
  const back = JSON.parse(fs.readFileSync(path.join(dir, "cheat-sheets.json"), "utf8")).suppliers;
  check("the file name is kept whatever its format", back.name, "Supplier Cheat Sheet.xlsx");
  const reloaded = C.cheatSheetIndex(back.pairs);
  check("and both creditors still match after a restart",
    [C.supplierMatches("RCL CRUISES LTD", "Royal Caribbean", reloaded).ok,
     C.supplierMatches("RCL CRUISES LTD", "Celebrity Cruises", reloaded).ok],
    [true, true]);

  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.RECON_STORE_DIR;
  delete require.cache[require.resolve("../run-store")];
}

console.log("\na near miss is named, never acted on");
{
  /* RAA's file says "Trafalgar Tours (Aust) Pty Ltd"; the sheet's row is
     "Trafalgar Tours". Those are probably the same company — and probably is
     not good enough to tick money onto a committed bank statement. So the row
     STOPS, and says which line to add. */
  const ix = C.cheatSheetIndex(C.parseCheatSheet([
    "SUPPLIER NAME IN MINT / TRAVELPAY,IN TRAMADA - TRY THESE",
    "Trafalgar Tours,Costsaver / Luxury Gold",
  ].join("\n")).pairs);

  const m = C.supplierMatches("Trafalgar Tours (Aust) Pty Ltd", "Costsaver", ix);
  check("a near miss does NOT match", m.ok, false);
  check("and names the row it nearly hit", m.near, "Trafalgar Tours");

  const row = C.matchCreditorRow(
    { transNo: "M1", amountCents: 1000, toCompany: "Trafalgar Tours (Aust) Pty Ltd" },
    [{ transNo: "P.1", reference: "M1", amount: "10.00", payee: "Costsaver" }],
    { cheatSheet: ix });
  check("the row is not ticked", row.reconciled, false);
  check("with the guide's words", row.remark, "Supplier does not match");
  ok("and a reason that says exactly what to fix",
    /Trafalgar Tours/.test(row.reason) && /add this exact name/.test(row.reason), row.reason);

  // The loose key is for the hint ONLY. It must never turn into a match.
  check("the exact name in the sheet does match", C.supplierMatches("Trafalgar Tours", "Luxury Gold", ix).ok, true);
  ok("and relaxedKey is not reachable as a matcher",
    C.relaxedKey("Trafalgar Tours (Aust) Pty Ltd") === C.relaxedKey("Trafalgar Tours"),
    "the two names DO collapse together — which is why only the hint may use it");

  // When the sheet has the supplier but points elsewhere, say where it pointed.
  const wrong = C.matchCreditorRow(
    { transNo: "M1", amountCents: 1000, toCompany: "Trafalgar Tours" },
    [{ transNo: "P.1", reference: "M1", amount: "10.00", payee: "Somebody Else" }],
    { cheatSheet: ix });
  ok("a sheet that disagrees lists what it said to try",
    /Costsaver/.test(wrong.reason) && /Luxury Gold/.test(wrong.reason), wrong.reason);
}

console.log("\nBR08 / BR09 — the file against the Transaction Total a human typed");
{
  const rows = [{ amountCents: 59400 }, { amountCents: 368484 }, { amountCents: 51000 }];
  const good = C.checkTransactionTotal(rows, "4788.84");
  check("a total that agrees", [good.checked, good.ok, good.remark], [true, true, ""]);

  const bad = C.checkTransactionTotal(rows, "4788.85");
  check("one cent out does not agree", bad.ok, false);
  check("and carries the guide's words", bad.remark, "Transaction Total does not match.");
  ok("naming both figures and the difference",
    /\$4,?788\.84/.test(bad.reason) && /\$4,?788\.85/.test(bad.reason) && /\$0\.01/.test(bad.reason),
    bad.reason);

  // Not entered at all is not a failure — it is a check that did not run.
  const none = C.checkTransactionTotal(rows, "");
  check("no total entered is not a mismatch", [none.checked, none.remark], [false, ""]);
  // An unreadable row makes the sum a guess, and a guess must not accuse anyone.
  const unreadable = C.checkTransactionTotal([{ amountCents: 100 }, { amountCents: null }], "1.00");
  check("an unreadable amount stops the check rather than failing it",
    [unreadable.checked, unreadable.remark], [false, ""]);
  check("no rows at all totals nothing", C.checkTransactionTotal([], "0.00").ok, true);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

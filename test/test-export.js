/**
 * The working file: Finance's own spreadsheet, handed back with columns filled.
 *
 * Two things are being defended here, and both are the kind of bug that
 * produces a file which opens perfectly and is quietly wrong:
 *
 *   · a column of theirs going missing, or being written over. The guide calls
 *     the reference column "Receipt No", so a careless match writes Tramada's
 *     receipt number over the reference the row was found by.
 *   · a workbook that Excel calls damaged. There is no library here — the ZIP
 *     and the XML are written by hand — so the container is checked as a
 *     container, not just as a string.
 */
const C = require("../recon-core");
const W = require("../xlsx-write");
const R = require("../xlsx-lite");

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

const FILE = [
  "B/PAY FILE DATE,Receipt No,Amount,Tramada Bkg No,Customer",
  "09-08-2026,CBA0001,145.54,13127,Nguyen/T",
  "09-08-2026,CBA0002,200.00,13128,O'Brien/S",
].join("\n");

console.log("\nevery column of the uploaded file survives");
{
  const p = C.parseReconCsv(FILE);
  check("the headings come back in the file's own order",
    p.columns, ["B/PAY FILE DATE", "Receipt No", "Amount", "Tramada Bkg No", "Customer"]);
  check("and a column this code has no opinion about is still carried",
    p.rows[0].cells["Customer"], "Nguyen/T");
  check("the run still finds the five it acts on",
    [p.rows[0].reference, p.rows[0].bookingNo, p.rows[0].amountCents], ["CBA0001", "13127", 14554]);
}
{
  // Two columns with the same name would silently lose one.
  const p = C.parseReconCsv("Date,Amount,Reference,Booking No,Amount\n1,2,3,4,5");
  check("a repeated heading is kept, suffixed", p.columns.slice(-1), ["Amount (2)"]);
  check("and both values survive", [p.rows[0].cells["Amount"], p.rows[0].cells["Amount (2)"]], ["2", "5"]);
}
{
  const p = C.parseReconCsv("Date,Reference,Amount,Booking No,\n1,r,2,3,x");
  check("a blank heading is dropped rather than becoming a column called ''",
    p.columns, ["Date", "Reference", "Amount", "Booking No"]);
}

console.log("\nthe file already having Consultant / Shop / Remarks");
{
  const p = C.parseReconCsv([
    "Date,Reference,Amount,Booking No,Consultant,Shop,Remarks",
    "09-08-2026,CBA1,145.54,13127,Priya Nair,WEST,check this",
  ].join("\n"));
  check("what was already in them is the starting value",
    [p.rows[0].consultant, p.rows[0].shop, p.rows[0].remark], ["Priya Nair", "WEST", "check this"]);

  const grid = C.buildExportGrid(p.rows, p.columns, { inputColumns: C.inputColumnsOf(p.columns) });
  check("and no second column of the same name is appended", grid.headings, [
    "Date", "Reference", "Amount", "Booking No", "Consultant", "Shop", "Remarks",
    "Receipt No", "Allocation", "Reconciled", "Why",
  ]);
}
{
  // Case and spacing are a person's business, not a matching rule.
  const p = C.parseReconCsv("Date,Reference,Amount,Booking No,CONSULTANT, shop \n1,r,2,3,Zoe,ADL");
  check("headings match however they were typed", [p.rows[0].consultant, p.rows[0].shop], ["Zoe", "ADL"]);
  const grid = C.buildExportGrid(p.rows, p.columns, { inputColumns: C.inputColumnsOf(p.columns) });
  ok("and the file's own spelling is what appears in the export",
    grid.headings.includes("CONSULTANT") && !grid.headings.includes("Consultant"),
    grid.headings.join(" | "));
}

console.log("\nthe input columns are never written over");
{
  /* THE ONE THAT DESTROYS DATA. The guide heads the reference column
     "Receipt No"; an unqualified match would put Tramada's receipt number in
     it and the reference the row was found by would be gone. */
  const p = C.parseReconCsv(FILE);
  const rows = p.rows.map((r, i) => ({
    ...r, receiptNo: `R.000000940${i + 1}`, allocation: "Allocated",
    reconciliation: "Reconciled", consultant: "Priya Nair", shop: "WEST", remark: "", why: "ok",
  }));
  const grid = C.buildExportGrid(rows, p.columns, { inputColumns: C.inputColumnsOf(p.columns) });

  const at = (h) => grid.headings.indexOf(h);
  ok("the file's Receipt No column is left alone", at("Receipt No") === 1, grid.headings.join(" | "));
  check("and still holds the reference the row was found by",
    grid.rows[0][at("Receipt No")], "CBA0001");
  ok("Tramada's own number appears beside it, named", at("Tramada Receipt No") > 0,
    grid.headings.join(" | "));
  check("carrying the receipt", grid.rows[0][at("Tramada Receipt No")], "R.0000009401");
  check("and the untouched columns are untouched",
    [grid.rows[1][at("Customer")], grid.rows[1][at("Amount")]], ["O'Brien/S", "200.00"]);
}

console.log("\nan export fed back in does not grow a new column each time");
{
  /* The loop a person actually does: export, open it in Excel, fix a
     consultant's name, upload it again, export again. If the column mapping is
     not idempotent this grows a "Tramada Receipt No" column per round, and by
     Friday the file has five of them. */
  const round = (text) => {
    const p = C.parseReconCsv(text);
    const rows = p.rows.map((r, i) => ({
      ...r, receiptNo: `R.000000940${i + 1}`, allocation: "Allocated",
      reconciliation: "Reconciled", why: "ok",
    }));
    const grid = C.buildExportGrid(rows, p.columns, { inputColumns: C.inputColumnsOf(p.columns) });
    return { csv: C.gridToCsv(grid), headings: grid.headings };
  };

  const one = round(FILE);
  const two = round(one.csv);
  const three = round(two.csv);
  check("the second time round has the same columns as the first", two.headings, one.headings);
  check("and so does the third", three.headings, one.headings);
  ok("with exactly one column for Tramada's receipt number",
    one.headings.filter((h) => h === "Tramada Receipt No").length === 1, one.headings.join(" | "));
  check("and the file's own Receipt No still holds the reference",
    C.csvGrid(three.csv).rows[0][1], "CBA0001");
  // An edit made in Excel between rounds is not undone by the next export.
  const edited = one.csv.replace("Consultant", "Consultant").split("\n");
  ok("a value edited between rounds survives the next export",
    round(one.csv).csv.includes("R.0000009401"), edited[1]);
}

console.log("\nthe CSV a spreadsheet can open");
{
  const grid = {
    headings: ["Reference", "Note"],
    rows: [["0041", 'He said "no", then left'], ["=SUM(A1)", "a, comma"]],
  };
  const csv = C.gridToCsv(grid);
  const back = C.csvGrid(csv);
  check("a leading zero survives the round trip", back.rows[0][0], "0041");
  check("so do quotes", back.rows[0][1], 'He said "no", then left');
  check("and commas", back.rows[1][1], "a, comma");
  ok("a formula-looking cell is quoted, so the spreadsheet does not evaluate it",
    /"=SUM\(A1\)"/.test(csv), csv);
}

console.log("\nthe workbook is a workbook");
{
  const grid = {
    headings: ["Date", "Receipt No", "Amount", "Customer"],
    rows: [
      ["09-08-2026", "0041", "145.54", "O'Brien & Sons <Pty>"],
      ["09-08-2026", "CBA2", "1,056.93", 'He said "no"'],
    ],
  };
  const buf = W.writeSheet(grid, "Reconciliation", { moneyColumns: [2] });

  ok("it starts PK, like every zip", buf[0] === 0x50 && buf[1] === 0x4b);
  // Read back by the parser the RUN uses, so a file this writes can be
  // re-uploaded — which is exactly what happens when somebody corrects a cell
  // in Excel and hands it back.
  const back = R.readSheet(buf);
  check("the headings survive", back.headers, grid.headings);
  check("and so does every cell, including the awkward ones", back.rows, grid.rows);

  const p = C.parseReconRows(back.headers, back.rows);
  check("and the result parses as a report again", p.rows.length, 0);   // no Booking No column
  ok("with the reason named rather than a crash",
    /booking/i.test(p.problems[0].why), JSON.stringify(p.problems[0]));
}
{
  // The characters XML 1.0 cannot hold. Left in, the whole workbook is
  // unopenable — and the error names a line number, not a cell.
  const grid = { headings: ["Ref"], rows: [["ABC"]] };
  const back = R.readSheet(W.writeSheet(grid));
  check("control characters are dropped rather than breaking the file", back.rows[0][0], "ABC");
}
{
  const grid = { headings: ["A"], rows: [] };
  const buf = W.writeSheet(grid);
  ok("a header-only sheet is still a valid workbook", buf.length > 500);
  check("and reads back as no rows", R.readSheet(buf).rows.length, 0);
}

console.log("\nnumbers stay numbers, and references stay references");
check("a plain amount is a number", W.isPlainNumber("145.54"), true);
check("a negative one too", W.isPlainNumber("-20"), true);
// Each of these would be mangled by Excel if written as a number.
check("a thousands separator is not", W.isPlainNumber("1,056.93"), false);
check("a leading zero is not — 0041 must not become 41", W.isPlainNumber("0041"), false);
check("a dollar sign is not", W.isPlainNumber("$145.54"), false);
check("a date is not", W.isPlainNumber("09-08-2026"), false);
check("blank is not", W.isPlainNumber(""), false);
check("column 0 is A", W.colName(0), "A");
check("column 25 is Z", W.colName(25), "Z");
check("column 26 is AA, not BA", W.colName(26), "AA");
check("column 701 is ZZ", W.colName(701), "ZZ");

console.log("\nmoney columns are found by heading");
check("the Amount column", C.moneyColumnsOf(["Date", "Amount", "Booking No"]), [1]);
check("and nothing else — Rate is Finance's business",
  C.moneyColumnsOf(["Date", "Rate", "Qty"]), []);


/* ── ONE FILE PER PAYMENT METHOD ─────────────────────────────────────────
   RAA, 29-Aug: "Export button exports out the spreadsheet as per payment
   method." A combined BPay + Mint run used to export ONE file, in whichever
   card was active, with the other report's rows forced into columns that were
   never theirs.

   The grouping happens in the browser (the file is assembled there), so this
   reads it out of recon-wire.html and checks the parts that make it correct
   rather than trusting that the function still exists. */
{
  const fs = require("fs");
  const path = require("path");
  const wire = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
  const fn = (wire.match(/async function exportCsv\(\)[\s\S]*?\n  \}\n/) || [""])[0];

  ok("exportCsv groups the rows by report", /for \(const kind of RUN_ORDER\)/.test(fn),
    "the export is back to one combined file");
  ok("...in run order, so BPay's file comes first", /RUN_ORDER/.test(fn));
  ok("rows with an unrecognised source are still exported, not dropped",
    /const stray = all\.filter/.test(fn),
    "a row whose src is not one of the four would vanish from the export entirely");
  ok("each file keeps the columns ITS report arrived in",
    /src && src\.columns/.test(fn),
    "one report's rows would be forced into another's columns");
  ok("each file keeps its own container (csv vs xlsx)",
    /src && src\.format/.test(fn));
  ok("IPSI's file is sorted by booking number (step 19)",
    /kind === 'ipsi'\) return sortIpsiForExport/.test(fn));
  ok("BPay's file is sorted Shop then Consultant (BR14)",
    /kind === 'bpay'\) return sortForFinance/.test(fn));
  ok("back-to-back downloads are spaced so the browser does not drop one",
    /setTimeout\(r, 400\)/.test(fn),
    "browsers silently drop a second download fired immediately after the first");
  ok("a file that fails to build is reported rather than swallowed",
    /failed\.push/.test(fn) && /Could not build/.test(fn));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

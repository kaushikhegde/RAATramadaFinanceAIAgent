/**
 * xlsx-lite.js, against the real Mint export.
 *
 * The fixture is `mint.xlsx` — the sample the client sent, unmodified. A
 * hand-written fixture would have been written by the same person who wrote the
 * parser, and would therefore have agreed with it. This one did not: it caught
 * the self-closing-cell bug that shifted every row's last column.
 */
const fs = require("fs");
const path = require("path");
const X = require("../xlsx-lite");

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
function throws(name, fn, re) {
  try { fn(); fail++; console.log(`  ✗ ${name}\n      it did not throw`); }
  catch (e) {
    if (!re || re.test(e.message)) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}\n      threw: ${e.message}`); }
  }
}

const FIXTURE = path.join(__dirname, "..", "fixtures", "mint.xlsx");
const haveFixture = fs.existsSync(FIXTURE);

console.log("\ncolumn references");
check("A is the first column", X.columnOf("A1"), 0);
check("B is the second", X.columnOf("B7"), 1);
check("Z then AA", [X.columnOf("Z1"), X.columnOf("AA1"), X.columnOf("AB1")], [25, 26, 27]);
check("junk is -1", X.columnOf("??"), -1);

console.log("\nXML entities");
check("the five named ones",
  X.unescapeXml("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"), `a & b <c> "d" 'e'`);
check("numeric and hex", X.unescapeXml("&#65;&#x42;"), "AB");
check("an ampersand that isn't an entity is left alone", X.unescapeXml("Fish & Chips"), "Fish & Chips");

console.log("\nshared strings");
check("plain <si>", X.readSharedStrings("<sst><si><t>Hello</t></si></sst>"), ["Hello"]);
// A styled fragment splits one value across runs. Taking the first <t> would
// silently truncate "Viva Holidays Pty Ltd" to "Viva Holidays".
check("runs are joined, not truncated",
  X.readSharedStrings("<sst><si><r><t>Viva Holidays</t></r><r><t> Pty Ltd</t></r></si></sst>"),
  ["Viva Holidays Pty Ltd"]);
check("an empty <si/> is still an entry",
  X.readSharedStrings("<sst><si/><si><t>x</t></si></sst>"), ["", "x"]);

console.log("\nnot a workbook");
throws("a short file", () => X.unzip(Buffer.from("no")), /too small/);
throws("a file with no zip directory", () => X.unzip(Buffer.alloc(200)), /end-of-directory/);

if (!haveFixture) {
  console.log("\n⚠ mint.xlsx is not here — the parts that need it were skipped.\n");
} else {
  const buf = fs.readFileSync(FIXTURE);

  console.log("\nthe archive");
  const zip = X.unzip(buf);
  ok("it holds a workbook", zip.has("xl/workbook.xml"), zip.names().join(", "));
  ok("and a shared string table", zip.has("xl/sharedStrings.xml"));
  check("a member that isn't there reads as null", zip.read("nope.xml"), null);

  console.log("\nthe Mint sheet");
  const sheet = X.readSheet(buf);
  check("the first sheet was found", sheet.sheetPath, "xl/worksheets/sheet1.xml");
  check("sixteen headers", sheet.headers.length, 16);
  check("the three columns the run needs",
    [sheet.headers[4], sheet.headers[5], sheet.headers[2]],
    ["Transaction Reference", "Amount", "To Company"]);
  // The sample's header is "To Company " with a trailing space. Left in, the
  // by-name column lookup would miss it.
  ok("headers are trimmed", sheet.headers.every((h) => h === h.trim()), JSON.stringify(sheet.headers));
  check("fifty-two data rows", sheet.rows.length, 52);

  // THE ONE THAT MATTERS. Row 1's Settlement Amt cell is `<c r="O2" s="12"/>` —
  // self-closing and empty. Read carelessly it swallows the Statement Date cell
  // that follows, and every value from there on sits one column to the left.
  ok("every row is sixteen wide, empty cells included",
    sheet.rows.every((r) => r.length === 16),
    "widths: " + [...new Set(sheet.rows.map((r) => r.length))].join(", "));
  check("the empty Settlement Amt is preserved in place", sheet.rows[0][14], "");
  check("so the Statement Date stays in its own column", sheet.rows[0][15], "46204");

  console.log("\nvalues");
  check("a shared string", sheet.rows[0][2], "Viva Holidays Pty Ltd");
  check("a transaction reference", sheet.rows[0][4], "M00640038");
  check("a whole-number amount", sheet.rows[0][5], "594");
  check("a fractional amount", sheet.rows[1][5], "3684.84");
  ok("every row carries a reference", sheet.rows.every((r) => /^M\d+$/.test(r[4])),
    "first bad: " + JSON.stringify(sheet.rows.find((r) => !/^M\d+$/.test(r[4]))));
  ok("every amount is a number", sheet.rows.every((r) => /^\d+(\.\d+)?$/.test(r[5])));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

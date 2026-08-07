/**
 * statement-csv.js — the parts that run without a browser.
 *
 * The scrape itself can't be tested offline (there is no browser here, and no
 * mocks of Playwright — CLAUDE.md §7). Everything AFTER the scrape can be, and
 * it is the part that decides what a finance system imports, so it is.
 */
const C = require("./statement-csv");

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

console.log("\namounts");
check("Tramada's thousands separator", C.normaliseAmount("1,056.93"), "1056.93");
check("a dollar sign", C.normaliseAmount("$780.00"), "780.00");
check("a CR suffix", C.normaliseAmount("110.00 CR"), "110.00");
check("whole dollars gain their cents", C.normaliseAmount("55"), "55.00");
// An unreadable amount must not become 0.00 — a zero imports happily and is
// wrong, where a blank is caught.
check("junk is blank, never zero", C.normaliseAmount("n/a"), "");
check("nothing is blank", C.normaliseAmount(""), "");

console.log("\ndates");
check("Tramada's dd-mm-yyyy", C.normaliseDate("31-07-2026"), "2026-07-31");
check("slashes too", C.normaliseDate("05/08/2026"), "2026-08-05");
check("d-Mon-yyyy", C.normaliseDate("06-Aug-2026"), "2026-08-06");
check("already ISO", C.normaliseDate("2026-08-06"), "2026-08-06");
// Day-first, always. 05/08 is 5 August here, and reading it as 8 May would put
// a receipt in the wrong month without anything looking wrong.
check("never month-first", C.normaliseDate("05/08/2026"), "2026-08-05");
check("unrecognised is returned untouched, not reshaped", C.normaliseDate("last Tuesday"), "last Tuesday");

console.log("\ncsv fields");
check("a plain value is bare", C.csvField("VIX122334"), "VIX122334");
check("a comma forces quotes", C.csvField("Deposit - Jill Shields, part"), '"Deposit - Jill Shields, part"');
check("a quote is doubled", C.csvField('say "hi"'), '"say ""hi"""');
// Excel eats a leading zero and turns +61… into a formula. Both are real
// reference shapes, and a reference silently rewritten by the spreadsheet
// imports fine and then matches the wrong thing.
check("a leading zero is protected", C.csvField("0012"), '"0012"');
check("a leading + is protected", C.csvField("+REF9"), '"+REF9"');
check("a leading = is protected", C.csvField("=SUM(A1)"), '"=SUM(A1)"');
check("nothing is empty, not the word null", C.csvField(null), "");

console.log("\nbuilding rows");
{
  // Verbatim shapes from CONTEXT.md §4 — the references really are this
  // inconsistent: a person's name, a trip-file note, a code, a bare word.
  const raw = [
    { date: "31-07-2026", reference: "Deposit - Jill Shields", recPayType: "Debtor Payment Receipt", amount: "1,056.93" },
    { date: "31-07-2026", reference: "Trip File Tsfr 1105", recPayType: "Debtor Payment Receipt", amount: "420.00" },
    { date: "01-08-2026", reference: "VIX122334", recPayType: "Debtor Payment Receipt", amount: "$95.50" },
    { date: "01-08-2026", reference: "NW", recPayType: "Debtor Payment Receipt", amount: "212.00" },
    { date: "02-08-2026", reference: "PROMO", recPayType: "Debtor Payment Receipt", amount: "60.00" },
    { date: "02-08-2026", reference: "RR788851", recPayType: "Debtor Payment Receipt", amount: "780.00" },
  ];
  const { rows, dropped } = C.buildRows(raw);
  check("all six survive", rows.length, 6);
  check("nothing dropped", dropped.length, 0);
  check("dates are ISO", rows[0].Date, "2026-07-31");
  check("amounts are plain numbers", rows[0].Amount, "1056.93");
  check("the type rides along", rows[0]["Rec/Pay Type"], "Debtor Payment Receipt");
  check("Booking No starts empty", rows[0]["Booking No"], "");

  // A line with no reference cannot be matched to anything, and the payee is
  // nearly useless here — only two payees ever appear on this type.
  const { rows: r2, dropped: d2 } = C.buildRows([...raw, { date: "02-08-2026", reference: "  ", amount: "10.00" }]);
  check("a reference-less line is dropped", r2.length, 6);
  check("and the reason is kept", d2[0].why, "no reference");

  const { rows: r3, dropped: d3 } = C.buildRows([{ date: "02-08-2026", reference: "X1", amount: "n/a" }]);
  check("an unreadable amount is dropped, not zeroed", r3.length, 0);
  ok("and says so", /unreadable amount/.test(d3[0].why), d3[0].why);

  check("--limit stops early", C.buildRows(raw, { limit: 5 }).rows.length, 5);
}

console.log("\nassigning booking numbers");
{
  const rows = C.buildRows([
    { date: "31-07-2026", reference: "A", amount: "1.00" },
    { date: "31-07-2026", reference: "B", amount: "2.00" },
    { date: "31-07-2026", reference: "C", amount: "3.00" },
    { date: "31-07-2026", reference: "D", amount: "4.00" },
    { date: "31-07-2026", reference: "E", amount: "5.00" },
    { date: "31-07-2026", reference: "F", amount: "6.00" },
  ]).rows;

  const a = C.assignBookings(rows, ["13201", "13202", "13203"], 1);
  check("every row gets one", a.filter((r) => r["Booking No"]).length, 6);
  // Round-robin over a shuffled pool: which booking lands where is random,
  // but a booking never being used at all is not a thing that can happen.
  check("every booking is used", new Set(a.map((r) => r["Booking No"])).size, 3);

  // Seeded, so the same inputs give the same file. An import you can't re-run
  // and diff is one you can't debug.
  check("the same seed gives the same answer",
    C.assignBookings(rows, ["13201", "13202", "13203"], 7).map((r) => r["Booking No"]),
    C.assignBookings(rows, ["13201", "13202", "13203"], 7).map((r) => r["Booking No"]));
  ok("a different seed generally differs",
    C.assignBookings(rows, ["13201", "13202", "13203"], 1).map((r) => r["Booking No"]).join() !==
    C.assignBookings(rows, ["13201", "13202", "13203"], 4).map((r) => r["Booking No"]).join());

  // No bookings is a blank column, not a crash and not a made-up number.
  check("no bookings leaves the column blank", C.assignBookings(rows, []).every((r) => r["Booking No"] === ""), true);

  // More bookings than rows: the extras simply go unused.
  check("more bookings than rows is fine",
    C.assignBookings(rows.slice(0, 2), ["1", "2", "3", "4", "5"]).length, 2);
}

console.log("\nthe file itself");
{
  const rows = C.assignBookings(
    C.buildRows([
      // Verbatim from CONTEXT.md §4 — no comma in it, so no quotes: a field
      // that quotes when it doesn't need to is noise in a diff.
      { date: "31-07-2026", reference: "Deposit - Jill Shields", recPayType: "Debtor Payment Receipt", amount: "1,056.93" },
      // And one that does need them.
      { date: "01-08-2026", reference: "Tsfr 1105, part 2", recPayType: "Debtor Payment Receipt", amount: "420.00" },
    ]).rows,
    ["13201"], 1
  );
  const csv = C.toCsv(rows);
  const lines = csv.trimEnd().split("\n");
  check("the header is the agreed five", lines[0], "Date,Reference,Rec/Pay Type,Amount,Booking No");
  check("a plain row carries no quotes", lines[1], "2026-07-31,Deposit - Jill Shields,Debtor Payment Receipt,1056.93,13201");
  check("a comma'd row gets them", lines[2], '2026-08-01,"Tsfr 1105, part 2",Debtor Payment Receipt,420.00,13201');
  ok("the file ends with a newline", csv.endsWith("\n"));
  check("header plus two rows", lines.length, 3);

  // Round-trip: what a naive importer reads back must equal what went in. The
  // comma inside a reference is the case that would silently split a row into
  // six columns and shift every value one to the left.
  const fields = (line) => (line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g) || [])
    .map((f) => f.replace(/,$/, ""))
    .filter((_, i, a) => i < a.length - 1 || a[i] !== "")
    .map((f) => (f.startsWith('"') ? f.slice(1, -1).replace(/""/g, '"') : f));
  check("five fields, not six", fields(lines[2]).length, 5);
  check("and the comma is still inside the reference", fields(lines[2])[1], "Tsfr 1105, part 2");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

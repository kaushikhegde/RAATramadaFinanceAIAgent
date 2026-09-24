/**
 * make-dvc-fixtures.js — the two spreadsheets a DVC run reconciles, as .csv
 * and .xlsx, written offline.
 *
 *   npm run fixtures:dvc
 *
 * Writes four files into fixtures/:
 *
 *   dvc-westpac.csv / .xlsx    the Westpac DVC report, as it arrives after the
 *                              cardholder name column has been deleted
 *   dvc-tramada.csv / .xlsx    Tramada's Agency CC Reimbursement export
 *
 * ── Why this is NOT a subcommand of make-fixtures.js ─────────────────────────
 *
 * That script's whole contract is "create real bookings through `runFullBooking`,
 * then write the report file whose references point at what it just made" — it
 * needs a signed-in Chrome and it writes to Tramada. A DVC reconciliation
 * creates nothing: it matches two spreadsheets against each other and the
 * Tramada half of the pair is itself an export. There is nothing for a browser
 * to do here, and putting this behind one would mean a fixture that cannot be
 * rebuilt on a machine with no portal access — which is the opposite of what
 * CLAUDE.md §7 asks of this suite. `make-mint-csv.js` is the same shape and
 * here for the same reason.
 *
 * ── Where the SHAPE comes from, and where the DATA does not ──────────────────
 *
 * The column names, the column order and the mess in them are taken from the
 * client's own `DVC_REPORT EXPORT EXAMPLES` workbook (two sheets, "Westpac
 * Report Example" and "Tramada Report Example", read 22-09-2026). Everything
 * else — bookings, passengers, suppliers, merchants, card tails, amounts — is
 * invented. None of it is a real transaction, and none of it is a real person.
 *
 * The mess is copied deliberately, because it is what the parser has to survive:
 *
 *   - THE DATE COLUMN IS WRITTEN SIX WAYS. The real report carries 31/07/2026,
 *     31.07.2026, 31-07-2026, 29.08.26 and 29082026 in one column, and an Excel
 *     serial on top of that when the file arrives as .xlsx. `dvcDate` exists
 *     because of that column; this file is what proves it.
 *   - AMOUNTS CARRY FLOAT NOISE. A workbook stores 136.30 as
 *     136.30000000000001 and hands it back that way.
 *   - THERE IS NO CARDHOLDER NAME COLUMN. The real export has one; step 1 of
 *     docs/dvc.md has a person delete it before upload, for privacy. So the
 *     uploaded file is one column narrower than the sample and every index
 *     after it moves — which is exactly why the parser reads by header name.
 *   - THE TWO FILES DISAGREE ON DATE FORMAT BY CONTAINER. Tramada's export
 *     stores its Segment Date as a serial in the workbook and as a formatted
 *     date in the CSV, because that is what exporting the same sheet twice
 *     produces. Both have to come out the same, and `test/test-dvc.js` checks it.
 *
 * ── Every rule in docs/dvc.md has a row here ─────────────────────────────────
 *
 * The rows are chosen so that one run exercises the whole document: a clean
 * match, a five-cent rounding, a segment type that does not line up, the 3%
 * merchant fee both exactly and with rounding, one card charge over three
 * costings, three card charges against one costing, a refund that matches, a
 * refund that does not, a booking that is not in Tramada at all, a line with no
 * booking number, an amount error that is not a fee, a BR09 deposit that is not
 * an error at all, a costing type that is not
 * there, and two rows belonging to the previous day's settlement so the date
 * filter has something to filter.
 */
const fs = require("fs");
const path = require("path");
const XW = require("../xlsx-write");

const OUT = path.join(__dirname, "..", "fixtures");

/* ── the Westpac DVC report ──────────────────────────────────────────────── */

/* The client's own header row, minus PAX Name (deleted before upload, step 1)
   and plus Remarks (appended before upload, step 3 / BR16). Verbatim otherwise,
   SHOUTED the way the real export shouts them. */
const WESTPAC_HEADERS = [
  "ACCOUNT NUMBER", "SETTLEMENT DATE", "MERCHANT", "CARD REQUEST DATE",
  "BILLING CURRENCY", "TRANSACTION AMOUNT (AUD)", "AGENT INITIALS", "STORE CODE",
  "SUPPLIER NAME", "SUPPLIER REF", "TRAMADA NUMBER", "SEGMENT TYPE", "CARD NUMBER",
  "REMARKS",
];

const ACCOUNT = "3910882";

/*
 * `amountXlsx` is only given where the workbook's float differs from the text a
 * CSV export writes — that is the whole point of the column. Everything else
 * uses `amount` in both containers.
 */
const WESTPAC = [
  // settled, merchant, requested, amount, agent, shop, supplier, ref, booking, segment, card
  ["04/09/2026", "STAYWELL* HB918204", "04/09/2026", "612.40", "RP", "ADL", "STAYWELL", "HB918204", "140221", "HOTEL", "XXXX-XXXX-XXXX-4417"],
  // Three cents out. BR04 allows five per transaction, so this still matches.
  ["04/09/2026", "EURORAIL* ER-41882", "04.09.2026", "288.55", "TM", "MAR", "EURORAIL", "", "140255", "TRAIN", "XXXX-XXXX-XXXX-9038"],
  // Segment type does not line up with the costing — step 5 downgrades it.
  ["04/09/2026", "DAYTRIPPER TOURS", "04-09-2026", "455.00", "LW", "COL", "DAY TRIPPER", "", "140310", "TOUR", "XXXX-XXXX-XXXX-2265"],
  // BR06, exactly 3% over the costing: 1200.00 + 36.00.
  ["04/09/2026", "PACIFIC BLUE AIR", "04092026", "1236.00", "JK", "WEST", "PACIFIC BLUE", "QN7T2K", "140344", "AIR TICKET", "XXXX-XXXX-XXXX-7731"],
  // BR06 again, this time where 3% does not land on a whole cent: 93.97 + 2.82.
  ["04/09/2026", "GUIDEHUB EU", "04.09.26", "96.79", "JK", "WEST", "GUIDE HUB", "", "140358", "TOUR", "XXXX-XXXX-XXXX-6104"],
  // BR05 — one card charge covering three hotel costings on one booking.
  ["04/09/2026", "STAYWELL* MK918330", "04/09/2026", "1448.30", "AB", "MOD", "STAYWELL", "", "140402", "HOTEL", "XXXX-XXXX-XXXX-3390"],
  // BR05 the other way — three seat charges against one air costing.
  ["04/09/2026", "PACIFIC BLUE AIR", "04/09/2026", "84.00", "AB", "MOD", "PACIFIC BLUE", "", "140466", "AIR TICKET", "XXXX-XXXX-XXXX-5512"],
  ["04/09/2026", "PACIFIC BLUE AIR", "04/09/2026", "84.00", "AB", "MOD", "PACIFIC BLUE", "", "140466", "AIR TICKET", "XXXX-XXXX-XXXX-5513"],
  ["04/09/2026", "PACIFIC BLUE AIR", "04/09/2026", "42.00", "AB", "MOD", "PACIFIC BLUE", "", "140466", "AIR TICKET", "XXXX-XXXX-XXXX-5514"],
  // BR07 — a refund, matched. Negative on the report, red on the spreadsheet.
  ["04/09/2026", "STAYWELL* RF901118", "12/06/2026", "-338.90", "RP", "ADL", "STAYWELL", "RF901118", "140501", "HOTEL", "XXXX-XXXX-XXXX-8820"],
  // BR07 — a refund with no Tramada entry at all. An exception.
  ["04/09/2026", "STAYWELL* TG899041", "20/05/2026", "-212.75", "TM", "MAR", "STAYWELL", "", "140588", "HOTEL", "XXXX-XXXX-XXXX-1174"],
  // BR08 — a charge whose booking is not in the Tramada export.
  ["04/09/2026", "CITYHOP SHUTTLES", "04/09/2026", "176.00", "LW", "COL", "CITY HOP", "", "140612", "TRANSFER", "XXXX-XXXX-XXXX-6683"],
  // No Tramada booking number on the card at all — step 11's first remark.
  ["04/09/2026", "CONSULATE FEES ONLINE", "03.09.2026", "64.00", "SD", "TCC", "VISA", "", "", "MISCELLANEOUS", "XXXX-XXXX-XXXX-0091"],
  // BR06's "all other amount errors": 980.00 against a 845.00 costing is 135.00
  // out, and 3% of 845.00 is 25.35 — not a merchant fee.
  ["04/09/2026", "HARBOUR LODGE", "04/09/2026", "980.00", "SD", "TCC", "HARBOUR LODGE", "", "140644", "HOTEL", "XXXX-XXXX-XXXX-4478"],
  // The booking is there; a CRUISE costing is not.
  ["04/09/2026", "SOUTHERN STAR CRUISES", "03/09/2026", "1900.00", "NH", "ELIZ", "SOUTHERN STAR", "SS-77412", "140701", "CRUISE", "XXXX-XXXX-XXXX-2036"],
  // The float a workbook actually stores for 136.30.
  ["04/09/2026", "STAYWELL* LP918447", "04/09/2026", "136.30", "NH", "ELIZ", "STAYWELL", "", "140733", "HOTEL", "XXXX-XXXX-XXXX-7715", "136.30000000000001"],
  // A PACKAGE costing facing a HOTEL charge. The sense check abstains rather
  // than flagging it — a package is one costing covering several segments.
  ["04/09/2026", "ESCAPE AGENTHUB", "04/09/2026", "725.15", "RP", "ADL", "ESCAPE COLLECTION", "", "140777", "HOTEL", "XXXX-XXXX-XXXX-9264"],
  // A segment type BR11's table never named. Unknown, not wrong — it matches.
  ["04/09/2026", "STAYWELL* NB918502", "04/09/2026", "410.00", "AB", "MOD", "STAYWELL", "", "140812", "MULTIPLE", "XXXX-XXXX-XXXX-3357"],
  /* BR09 — A DEPOSIT. $500 taken on the card against a $2,000 costing, which is
     RAA's own example (22-09-2026). It must NOT come back as a bare "Amount not
     match": there is nothing for anybody to investigate, it is a deposit, and
     what Travel Accounts needs to be told is that the 500.00 goes into that
     segment's amount box by hand and the row must not be ticked — ticking
     auto-fills the whole 2,000. */
  ["04/09/2026", "GRANDVIEW RESORT", "04/09/2026", "500.00", "RP", "ADL", "GRANDVIEW", "", "140966", "HOTEL", "XXXX-XXXX-XXXX-2041"],
  // Yesterday's settlement, still sitting in the same tab. The run is for one
  // day (BR02), so these two are filtered out and said out loud, never dropped.
  ["03/09/2026", "STAYWELL* JD918077", "03/09/2026", "301.20", "TM", "MAR", "STAYWELL", "", "140150", "HOTEL", "XXXX-XXXX-XXXX-5529"],
  ["03/09/2026", "GUIDEHUB EU", "03/09/2026", "58.40", "LW", "COL", "GUIDE HUB", "", "140166", "TOUR", "XXXX-XXXX-XXXX-8801"],
];

function westpacGrid(forWorkbook) {
  return {
    headings: WESTPAC_HEADERS,
    rows: WESTPAC.map((r) => {
      const [settled, merchant, requested, amount, agent, shop, supplier, ref, booking, segment, card, amountXlsx] = r;
      return [
        ACCOUNT, settled, merchant, requested, "AUD",
        forWorkbook && amountXlsx ? amountXlsx : amount,
        agent, shop, supplier, ref, booking, segment, card,
        "",                                  // Remarks — the run fills this in
      ];
    }),
  };
}

/* ── Tramada's Agency CC Reimbursement export ────────────────────────────── */

const TRAMADA_HEADERS = [
  "Seg. Type", "Booking No.",
  "Supplier Reference - Passenger Name - Supplier/Hotel Name",
  "Segment Date", "Balance Due", "Supplier Reference No",
];

const TRAMADA = [
  // segType, booking, description, date, amount, supplierRef
  ["HTL", "140221", "HB918204 - HB918204 - LINTON/PAUL MR - Staywell Harbour Inn", "04/09/2026", "612.40", "HB918204"],
  ["TRN", "140255", "ER-41882 - ER-41882 - LINTON/PAUL MR, LINTON/ROSE MRS - EuroRail", "04/09/2026", "288.52", "ER-41882"],
  // An air ticket costing facing a TOUR charge on the report.
  ["TKT", "140310", "QN9V4B - QN9V4B - OKAFOR/CHIDI MR - Pacific Blue Air", "04/09/2026", "455.00", "QN9V4B"],
  ["TKT", "140344", "QN7T2K - QN7T2K - HALE/MARGUERITE MS - Pacific Blue Air", "03/09/2026", "1200.00", "QN7T2K"],
  ["TUR", "140358", "GH-5512907 - GH-5512907 - HALE/MARGUERITE MS - Guide Hub", "03/09/2026", "93.97", "GH-5512907"],
  // Three costings, one card charge.
  ["HTL", "140402", "MK918330 - MK918330 - DRUMMOND/ALICE MRS - Staywell Lakeside", "04/09/2026", "612.50", "MK918330"],
  ["HTL", "140402", "MK918331 - MK918331 - DRUMMOND/ALICE MRS - Staywell Riverbank", "04/09/2026", "519.60", "MK918331"],
  ["HTL", "140402", "MK918332 - MK918332 - DRUMMOND/ALICE MRS - Staywell Riverbank", "04/09/2026", "316.20", "MK918332"],
  // One costing, three card charges.
  ["TKT", "140466", "QN3L8P - QN3L8P - MBEKI/THANDI MS, MBEKI/SIPHO MR - Pacific Blue Air", "04/09/2026", "210.00", "QN3L8P"],
  // The refund Travel Accounts entered on the consultant's behalf (step 9).
  ["HTL", "140501", "RF901118 - RF901118 - VOSS/ANNIKA MS - Staywell Parkside", "04/09/2026", "-338.90", "RF901118"],
  // The costing the 980.00 charge does not match.
  ["HTL", "140644", "9114882 - 9114882 - CRAWFORD/NEIL MR - Harbour Lodge", "04/09/2026", "845.00", "9114882"],
  // The booking is here; the CRUISE costing the card paid is not.
  ["TUR", "140701", "SS-77412 - SS-77412 - PENHALIGON/JUNE MRS - Southern Star Cruises", "03/09/2026", "640.00", "SS-77412"],
  ["HTL", "140733", "LP918447 - LP918447 - ARMITAGE/DEAN MR - Staywell Foreshore", "04/09/2026", "136.30", "LP918447"],
  ["PKG", "140777", "EC-220914 - EC-220914 - NAKAMURA/HARUKI MR - Escape Collection", "04/09/2026", "725.15", "EC-220914"],
  // No supplier reference at all — an instant-purchase item that issues one
  // only after payment, which BR01 says must never be treated as mandatory.
  ["HTL", "140812", "QUINTERO/ISABEL MS - Staywell Central", "04/09/2026", "410.00", ""],
  // The costing BR09's deposit is a part payment of.
  ["HTL", "140966", "GV-771204 - GV-771204 - OYELARAN/FEMI MR - Grandview Resort", "04/09/2026", "2000.00", "GV-771204"],
  // Nothing on the DVC report pays this one. It is not an error on its own —
  // the Tramada range is two days wider than the report (BR13) — but the
  // exception report has to show it.
  ["HTL", "140901", "JW918610 - JW918610 - TREMBLAY/YVES MR - Staywell Garden", "04/09/2026", "455.75", "JW918610"],
];

/**
 * A `dd/mm/yyyy` date as the serial a workbook stores.
 *
 * The epoch is 1899-12-30, not 1900-01-01: Excel believes 1900 was a leap year,
 * and the two-day offset is how everybody else's code stays compatible with
 * that. Same constant `recon-core.serialDate` reads back.
 */
function serialOf(ddmmyyyy) {
  const [d, m, y] = String(ddmmyyyy).split("/").map(Number);
  return String(Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000));
}

function tramadaGrid(forWorkbook) {
  return {
    headings: TRAMADA_HEADERS,
    rows: TRAMADA.map(([segType, booking, description, date, amount, ref]) => [
      segType, booking, description,
      forWorkbook ? serialOf(date) : date,
      amount, ref,
    ]),
  };
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * One grid → CSV text.
 *
 * Its own quoter rather than `recon-core.gridToCsv`: that one deliberately
 * quotes a leading-zero or leading-symbol cell so a spreadsheet cannot
 * reformat it, which is right for a file handed back to Finance and wrong for a
 * fixture, where the point is to write the file the bank writes. A cell
 * containing a comma or a quote is still quoted, because otherwise it is not a
 * CSV.
 */
function csv(grid) {
  const q = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [grid.headings.map(q).join(",")]
    .concat(grid.rows.map((r) => r.map(q).join(",")))
    .join("\n") + "\n";
}

function write(name, buf) {
  const at = path.join(OUT, name);
  fs.writeFileSync(at, buf);
  console.log(`  ✓ ${path.relative(path.join(__dirname, ".."), at)}  (${buf.length} bytes)`);
}

console.log("\nDVC fixtures — two spreadsheets, two containers each\n");
write("dvc-westpac.csv", Buffer.from(csv(westpacGrid(false)), "utf8"));
// Column 5 is TRANSACTION AMOUNT (AUD), zero-based. Money format, so 612.40
// reads as 612.40 rather than 612.4 when somebody opens the file to check it.
write("dvc-westpac.xlsx", XW.writeSheet(westpacGrid(true), "Westpac DVC Report", { moneyColumns: [5] }));
write("dvc-tramada.csv", Buffer.from(csv(tramadaGrid(false)), "utf8"));
// Column 4 is Balance Due.
write("dvc-tramada.xlsx", XW.writeSheet(tramadaGrid(true), "Agency CC Reimbursement", { moneyColumns: [4] }));
console.log(`\n  ${WESTPAC.length} DVC lines, ${TRAMADA.length} Tramada costings.\n`);

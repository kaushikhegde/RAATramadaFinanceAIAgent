/**
 * xlsx-write.js — one grid out as a real .xlsx, with no dependency.
 *
 * `xlsx-lite.js` reads a workbook; this writes one. Together they are about 400
 * lines and no supply chain, against a spreadsheet library's several hundred
 * thousand — on a tool that files real receipts against a finance system, that
 * trade is worth making twice.
 *
 * ── What an .xlsx actually is ────────────────────────────────────────────────
 *
 * A ZIP of XML. The five members below are the minimum Excel, Numbers, Google
 * Sheets and LibreOffice all accept:
 *
 *   [Content_Types].xml          what each part is
 *   _rels/.rels                  the package points at the workbook
 *   xl/workbook.xml              one sheet, named
 *   xl/_rels/workbook.xml.rels   the workbook points at the sheet
 *   xl/worksheets/sheet1.xml     the cells
 *
 * There is no sharedStrings.xml: every cell is written inline (`t="inlineStr"`).
 * A shared-string table saves bytes on a file with heavy repetition and costs a
 * second structure that has to stay in step with the sheet. A day's BPay file is
 * tens of rows.
 *
 * ── Why the ZIP is STORED, not deflated ──────────────────────────────────────
 *
 * Method 0 (store) is part of the ZIP spec, every reader supports it, and it
 * means this file needs no zlib and no CRC of a compressed stream to get wrong.
 * A 40-row spreadsheet is a few kilobytes either way. The only real cost of
 * compression here would be another way to produce a file that opens as
 * "damaged", which is the one failure mode that matters — a Finance user
 * double-clicks the file and Excel either shows it or does not.
 */
/* ── CRC-32, table-driven ─────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ── the ZIP container ────────────────────────────────────────────────────── */

/**
 * Members → a ZIP buffer.
 *
 * Timestamps are FIXED at 1980-01-01, the earliest a DOS date can express.
 * Not laziness: it makes the same grid produce byte-identical output every
 * time, so a test can compare files and a diff of two exports is a diff of the
 * data. `new Date()` here would make every build unique for no reader's benefit.
 */
function zip(members) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of members) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed: 2.0
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method 0 — stored
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(33, 12);          // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(33, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0, 38);             // external attrs
    dir.writeUInt32LE(offset, 42);        // where its local header is
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, dirBuf, end]);
}

/* ── the sheet ────────────────────────────────────────────────────────────── */

/**
 * XML text escaping, plus the control characters XML 1.0 cannot represent AT
 * ALL. A stray 0x1a or 0x00 in a bank reference — and finance exports do carry
 * them — makes the whole workbook unopenable, with an error naming a line
 * number rather than a cell. They are dropped.
 */
function xmlText(v) {
  return String(v == null ? "" : v)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → A, 25 → Z, 26 → AA. Spreadsheet column letters are base-26 with no zero. */
function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * A number stays a number, so Excel can total the Amount column.
 *
 * Strict: the whole cell must be a plain number. "1,056.93" and "$145.54" are
 * left as text on purpose — stripping the separators here would silently change
 * what the file says, and a reference like 0041 or a booking number like
 * 13127001 must never be reformatted into 4.1E+01 or lose its leading zero.
 */
function isPlainNumber(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^0\d/.test(s)) return false;
  return /^-?\d+(\.\d+)?$/.test(s);
}

function sheetXml(grid, money = []) {
  /* Money columns carry style 1, which is the `0.00` format defined in
     styles.xml. Without it a numeric 200.00 is the number 200 and Excel shows
     "200" in a column of 145.54s — correct, and the first thing an accounts
     team notices. The format is applied BY COLUMN rather than to every numeric
     cell, because a booking number is also a number and 13127.00 is worse than
     the problem being solved. */
  const moneyCols = new Set(money);
  const all = [grid.headings || []].concat(grid.rows || []);
  const rows = all.map((cells, r) => {
    const tds = (cells || []).map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (r > 0 && isPlainNumber(v)) {
        const s = moneyCols.has(c) ? ' s="1"' : "";
        return `<c r="${ref}"${s}><v>${xmlText(v)}</v></c>`;
      }
      const t = xmlText(v);
      if (!t) return `<c r="${ref}"/>`;
      // xml:space="preserve" or a cell of spaces comes back empty.
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${t}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${tds}</row>`;
  }).join("");

  const cols = Math.max(1, ...all.map((r) => (r || []).length));
  const dim = `A1:${colName(cols - 1)}${Math.max(1, all.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/>` +
    // The header row stays put when a person scrolls a 200-row file.
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData>${rows}</sheetData></worksheet>`;
}

/**
 * A grid → an .xlsx buffer.
 *
 * `grid` is `{ headings: [...], rows: [[...], ...] }` — exactly what
 * `recon-core`'s `buildExportGrid` returns, so the CSV and the workbook are the
 * same data through two encoders rather than two assemblies of it.
 */
function writeSheet(grid, sheetName = "Reconciliation", opts = {}) {
  const name = xmlText(String(sheetName || "Sheet1").slice(0, 31).replace(/[[\]:*?/\\]/g, " "));
  const file = (n, s) => ({ name: n, data: Buffer.from(s, "utf8") });

  return zip([
    file("[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`),
    file("_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`),
    file("xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    file("xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`),
    /* Two cell formats, and every one of these blocks is required even when
       empty — a styles.xml missing `fonts` or `fills` makes Excel declare the
       whole workbook damaged, while LibreOffice opens it perfectly happily.
         xf 0  the default
         xf 1  numFmtId 2, the built-in "0.00" — so a money column reads
               145.54 and 200.00 rather than 145.54 and 200. */
    file("xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `</cellXfs></styleSheet>`),
    file("xl/worksheets/sheet1.xml", sheetXml(grid, opts.moneyColumns || [])),
  ]);
}

module.exports = { writeSheet, crc32, colName, isPlainNumber, xmlText, sheetXml, zip };

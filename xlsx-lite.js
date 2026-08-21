/**
 * xlsx-lite.js — read an .xlsx workbook with no dependencies.
 *
 *   const { headers, rows } = readSheet(fs.readFileSync("mint.xlsx"));
 *
 * ── Why this exists rather than `npm i xlsx` ─────────────────────────────────
 *
 * The run has to work on a machine with no network at hand, and this project
 * already refuses to reach for a package it does not need (CLAUDE.md §7 — the
 * tests are offline by design). An .xlsx is a ZIP of XML documents, node ships
 * `zlib`, and the part of the format a Mint export uses is small: a shared
 * string table, a sheet of rows, and cells that are either a string index or a
 * number.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 *
 * No formulas (the cached value is read, the formula is ignored), no styles, no
 * date conversion — a date arrives as the serial number Excel stores, because
 * turning that back into a date needs the number format from styles.xml and
 * nothing here needs dates. No encrypted or ZIP64 workbooks. If a file needs
 * any of that this throws rather than returning something plausible.
 *
 * Everything is pure: bytes in, strings out. `test-xlsx-lite.js` runs it
 * against the real mint.xlsx.
 */
const zlib = require("zlib");

/* ── the ZIP container ───────────────────────────────────────────────────── */

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Every member of the archive, by name.
 *
 * Read through the CENTRAL DIRECTORY at the end of the file, not by scanning
 * for local headers: a local header's sizes can legitimately be zero with the
 * real values in a trailing data descriptor, so scanning finds entries it then
 * cannot read. The central directory always carries the true sizes.
 */
function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22) throw new Error("Not a workbook: the file is too small to be a zip.");

  // The end-of-central-directory record is last, but a zip comment can follow
  // it, so search backwards for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a workbook: no zip end-of-directory record.");

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (at === 0xffffffff) throw new Error("ZIP64 workbooks are not supported.");

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== SIG_CDIR) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const uncompressed = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    out.set(name, { method, compressed, uncompressed, localAt });
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (!out.size) throw new Error("Not a workbook: the zip directory is empty.");

  return {
    names: () => [...out.keys()],
    has: (name) => out.has(name),
    read(name) {
      const e = out.get(name);
      if (!e) return null;
      // The local header repeats the name and extra fields, and its extra
      // field length often DIFFERS from the central directory's — so the data
      // offset has to be computed from the local header, not the central one.
      if (buf.readUInt32LE(e.localAt) !== SIG_LOCAL) {
        throw new Error(`The workbook's "${name}" entry is not where the directory says.`);
      }
      const nameLen = buf.readUInt16LE(e.localAt + 26);
      const extraLen = buf.readUInt16LE(e.localAt + 28);
      const start = e.localAt + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compressed);
      if (e.method === 0) return raw;
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`The workbook uses compression method ${e.method}, which is not supported.`);
    },
  };
}

/* ── the XML ─────────────────────────────────────────────────────────────── */

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};

function unescapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * The shared string table.
 *
 * A string can be split across `<r>` runs when part of it is styled
 * differently — "Viva Holidays" and " Pty Ltd" as two runs of one value — so
 * every `<t>` inside an `<si>` is concatenated. Taking the first would silently
 * truncate company names.
 */
/**
 * SELF-CLOSING TAGS COME FIRST IN EVERY ONE OF THESE ALTERNATIONS.
 *
 * Written the other way round — `<c…>…</c>` before `<c…/>` — a self-closing
 * empty cell has no `</c>` of its own, so the lazy match runs on and closes on
 * the NEXT cell's, eating it. `<c r="O2" s="12"/><c r="P2"><v>46204</v></c>`
 * became one cell at O2 holding 46204, so the Mint sample's Statement Date
 * landed in the Settlement Amt column and every row came back one short. The
 * opening tag is matched with `[^>]*` for the same reason: it must not be able
 * to cross a `>`.
 */
const RE_SI = /<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g;
const RE_ROW = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
const RE_CELL = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
const RE_T = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const items = String(xml).match(RE_SI) || [];
  for (const si of items) {
    let text = "";
    const parts = si.match(RE_T) || [];
    for (const t of parts) text += unescapeXml(t.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, ""));
    out.push(text);
  }
  return out;
}

/** "A1" → 0, "B7" → 1, "AA3" → 26. */
function columnOf(ref) {
  const letters = String(ref || "").match(/^([A-Z]+)/i);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ── the sheet ───────────────────────────────────────────────────────────── */

/** The path of the first sheet, followed properly through the relationships. */
function firstSheetPath(zip) {
  const workbook = zip.read("xl/workbook.xml");
  const rels = zip.read("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const sheet = String(workbook).match(/<sheet\b[^>]*\/?>/);
    const rid = sheet && sheet[0].match(/r:id="([^"]+)"/);
    if (rid) {
      const rel = String(rels).match(new RegExp(`<Relationship[^>]*Id="${rid[1]}"[^>]*>`));
      const target = rel && rel[0].match(/Target="([^"]+)"/);
      if (target) {
        const t = target[1].replace(/^\//, "");
        return t.startsWith("xl/") ? t : `xl/${t}`;
      }
    }
  }
  // Some producers write no rels for the workbook. The conventional path is
  // the fallback, and a missing sheet throws below rather than reading nothing.
  return "xl/worksheets/sheet1.xml";
}

/**
 * The first worksheet as a header row plus data rows.
 *
 * EMPTY CELLS ARE PRESERVED BY POSITION. A row's cells carry their own `r`
 * reference ("E7"), and a sparse row simply omits the empty ones — so pushing
 * cells in document order would slide every later value left, which is the
 * column-shift bug this project has already been bitten by twice. Each value
 * is placed at the index its reference names.
 */
function readSheet(buf) {
  const zip = unzip(buf);
  const path = firstSheetPath(zip);
  const xml = zip.read(path);
  if (!xml) throw new Error(`The workbook has no sheet at ${path}.`);
  const strings = readSharedStrings(zip.read("xl/sharedStrings.xml"));
  const sheet = String(xml);

  const rows = [];
  const rowXml = sheet.match(RE_ROW) || [];
  for (const r of rowXml) {
    const cells = [];
    const cellXml = r.match(RE_CELL) || [];
    for (const c of cellXml) {
      const ref = (c.match(/\br="([A-Z]+\d+)"/i) || [])[1];
      const type = (c.match(/\bt="([^"]+)"/) || [])[1] || "n";
      let value = "";
      if (type === "inlineStr") {
        const parts = c.match(RE_T) || [];
        for (const t of parts) value += unescapeXml(t.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, ""));
      } else {
        // <v> holds the cached value; a formula's <f> is ignored on purpose.
        const v = c.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? unescapeXml(v[1]) : "";
        if (type === "s") {
          const i = parseInt(raw, 10);
          value = Number.isFinite(i) && strings[i] != null ? strings[i] : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else {
          value = raw;
        }
      }
      const at = ref ? columnOf(ref) : cells.length;
      if (at < 0) continue;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows.push(cells);
  }

  // A title band happens when a report carries one — a lone total figure or a
  // report title, one populated column each in an otherwise-wide row, ahead of
  // the row that actually names every column. The header is the first row that
  // names more than one of the columns it has more than one of — which is what
  // keeps this from eating a genuinely single-column sheet.
  let head = 0;
  while (head < rows.length - 1 && rows[head].length > 1 &&
    rows[head].filter((c) => String(c).trim() !== "").length <= 1) head++;
  const headers = (rows[head] || []).map((c) => String(c).trim());

  return {
    sheetPath: path,
    headers,
    rows: rows.slice(head + 1).filter((r) => r.some((c) => String(c).trim() !== "")),
  };
}

module.exports = { readSheet, unzip, readSharedStrings, columnOf, unescapeXml };

/**
 * The guide's columns, on the real page.
 *
 * Everything the BPay guide asks to be handed back to Finance — the Consultant
 * and Shop columns, the Remarks vocabulary, the BR14 ordering, and the lines
 * that could not be run appearing rather than vanishing — is assembled in the
 * BROWSER, in `exportCsv`. None of it is reachable from a node test, and its
 * failure mode is the quiet one: a file that opens perfectly well with a column
 * missing or three rows short.
 *
 * So this drives the built page, feeds a run's worth of verdicts through the
 * socket the way the server does, and reads back the file the button produces.
 *
 *   node shots/shot-bpay-rules.js → shots/out/bpay-remarks.png
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Screenshots land in shots/out/, never the repo root. A bare relative path in
   page.screenshot() resolves against cwd, not against this file, which is how a
   dozen PNGs ended up sitting beside server.js. */
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => path.join(OUT, name);

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-bpay-"));
process.env.RECON_STORE_DIR = DIR;
process.env.PORT = process.env.PORT || "3155";

require("../server");
const { chromium } = require("playwright");

let bad = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { bad++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* Headed the way the guide heads it — "Receipt No", no Rec/Pay Type column —
   because that is the file this is supposed to accept. Row 4 has no booking
   number, which is BR01: it cannot be run and must still come back. */
const CSV = [
  "B/PAY FILE DATE,Receipt No,Amount,Tramada Bkg No",
  "09-08-2026,CBA0001,145.54,13127",
  "09-08-2026,CBA0002,200.00,13128",
  "09-08-2026,CBA0003,790.00,13129",
  "09-08-2026,CBA0004,55.00,",
].join("\n") + "\n";

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

  /* The wiring keeps its socket in a local, so the instance is caught as it is
     constructed — before the page's own script runs. Dispatching a
     MessageEvent at that instance runs the very handler the server's frames
     run, which is the point: this exercises the real `recon_row` path rather
     than a stand-in for it. */
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sent = [];
    window.WebSocket = function (...args) {
      const s = new Real(...args);
      window.__ws = s;
      const send = s.send.bind(s);
      s.send = (data) => {
        try {
          const m = JSON.parse(data);
          window.__sent.push(m);
          if (m.type === "recon_run") return;   // stop here: nothing drives Tramada
        } catch (e) { /* not ours */ }
        return send(data);
      };
      return s;
    };
    window.WebSocket.prototype = Real.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = Real[k];
  });

  await page.goto(`http://127.0.0.1:${process.env.PORT}/`, { waitUntil: "networkidle" });

  const csvPath = path.join(DIR, "bpay-guide.csv");
  fs.writeFileSync(csvPath, CSV);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('[data-choose="bpay"]'),
  ]);
  await chooser.setFiles(csvPath);
  await page.waitForTimeout(700);

  /* ── the file the guide actually sends ─────────────────────────────────── */
  const loaded = await page.evaluate(() => {
    const card = document.querySelector('[data-card="bpay"]') || document.body;
    return { text: card.innerText, rows: (window.__sent || []).length };
  });
  ok("a Receipt No / no Rec-Pay-Type file is accepted",
    !/header is missing/i.test(loaded.text), loaded.text.slice(0, 200));
  ok("and the three runnable rows are counted", /3 rows|3 references/.test(loaded.text),
    loaded.text.slice(0, 200));
  ok("the line with no booking number is called out",
    /Skipped line 5/.test(loaded.text), loaded.text.slice(0, 300));

  /* ── replay a run's verdicts, exactly as server.js sends them ──────────── */
  const replayed = await page.evaluate(() => {
    const rows = [
      // BR07 — one segment exactly, and nothing to remark on.
      { n: 1, receiptNo: "R.0000009401", allocation: "Allocated", reconciliation: "Reconciled",
        consultant: "Priya Nair", shop: "WEST", remark: "", why: "$145.54 settles segment 1 exactly" },
      // BR09 — ticks nothing, asks a person.
      { n: 2, receiptNo: "R.0000009402", allocation: "Not allocated", reconciliation: "Reconciled",
        consultant: "Aaron Blake", shop: "ADL", remark: "Please allocate",
        why: "$200.00 matches 2 of the 3 segments added together, but not one on its own" },
      // BR05 — stopped before a receipt was raised.
      { n: 3, allocation: "Not allocated", reconciliation: "Not reconciled",
        consultant: "Zoe Adams", shop: "ADL", remark: "Please review, incorrect debtor found",
        why: 'no receipt raised — the debtor is "RAA of SA Limited (Corporate)"' },
    ];
    if (!window.__ws) return 0;
    // The server sends this the moment the run record is opened; the page needs
    // it so an edited cell can say which run it belongs to.
    window.__ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "recon_started", runId: "run-shot-1" }),
    }));
    for (const row of rows) {
      window.__ws.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "recon_row", n: row.n, row }),
      }));
    }
    return rows.length;
  });
  ok("the run's verdicts reached the page", replayed === 3, `replayed ${replayed}`);
  await page.waitForTimeout(300);

  /* ── the Remarks column, on screen ─────────────────────────────────────── */
  const table = await page.evaluate(() => {
    const t = document.querySelector("#triagePane table");
    if (!t) return null;
    return {
      head: [...t.querySelectorAll("thead th")].map((h) => h.textContent.trim()),
      body: [...t.querySelectorAll("tbody tr")].map((r) =>
        [...r.querySelectorAll("td")].map((c) => {
          const i = c.querySelector("input.cellIn");
          return i ? i.value : c.textContent.trim();
        })),
      remarks: [...t.querySelectorAll('tbody input.cellIn[data-k="remark"]')].map((i) => i.value),
    };
  });
  ok("the inbox has a Remarks column", !!table && table.head.includes("Remarks"),
    table ? table.head.join(" | ") : "no table");
  ok("every row is on screen, including the one that could not be run",
    !!table && table.body.length === 4, table ? `${table.body.length} rows` : "no table");
  /* A row the run never touches must not claim to be running. Measured on a
     live run 17-Aug-2026, where the BR01 row and the TOTAL row both sat in the
     table saying "running" for the whole run and "Pending" afterwards. */
  ok("and the unrunnable one is not pretending to run",
    !!table && !table.body.some((r) => r.join(" ").toLowerCase().includes("running")),
    table ? JSON.stringify(table.body.map((r) => r.slice(-4))) : "no table");
  ok("and the unrunnable one carries BR01's remark",
    !!table && table.remarks.includes("No booking number found"),
    table ? JSON.stringify(table.remarks) : "no table");

  // The Remarks column is the thing being photographed, so photograph the
  // screen it is on.
  await page.evaluate(() => {
    const nav = document.querySelector('.nav-item[data-go="inbox"]');
    if (nav) nav.click();
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: shot("bpay-remarks.png"), fullPage: false });

  /* ── the inbox shows the file's own columns ────────────────────────────── */
  const sheetTable = await page.evaluate(() => {
    const t = document.querySelector("#triagePane table");
    if (!t) return null;
    return {
      head: [...t.querySelectorAll("thead th")].map((h) => h.textContent.trim()),
      inputs: [...t.querySelectorAll("tbody input.cellIn")].map((i) => i.dataset.k),
      firstReceipt: (() => {
        const heads = [...t.querySelectorAll("thead th")].map((h) => h.textContent.trim());
        const i = heads.indexOf("Receipt No");
        const row = t.querySelector("tbody tr");
        return i < 0 || !row ? "" : (row.querySelectorAll("td")[i] || {}).textContent.trim();
      })(),
    };
  });
  for (const col of ["B/PAY FILE DATE", "Receipt No", "Amount", "Tramada Bkg No"]) {
    ok(`the inbox shows the file's own "${col}" column`,
      !!sheetTable && sheetTable.head.includes(col),
      sheetTable ? sheetTable.head.join(" | ") : "no table");
  }
  ok("under the file's own headings, not this code's",
    !!sheetTable && !sheetTable.head.includes("Statement line"),
    sheetTable ? sheetTable.head.join(" | ") : "no table");
  /* The file's Receipt No column holds CBA0001, the reference the row was found
     by. Tramada's own receipt number goes in a column of its own — showing it
     here loses the reference off the screen on a row that reconciled fine. */
  ok("the file's Receipt No column still shows the file's value",
    !!sheetTable && sheetTable.firstReceipt === "CBA0001", JSON.stringify(sheetTable));
  ok("and Tramada's number has a column of its own",
    !!sheetTable && sheetTable.head.includes("Tramada Receipt No"),
    sheetTable ? sheetTable.head.join(" | ") : "no table");
  ok("Consultant, Shop and Remarks are editable, and nothing else is",
    !!sheetTable && [...new Set(sheetTable.inputs)].sort().join(",") === "consultant,remark,shop",
    sheetTable ? JSON.stringify([...new Set(sheetTable.inputs)]) : "no table");

  /* ── correcting a cell by hand ─────────────────────────────────────────── */
  const edited = await page.evaluate(async () => {
    const box = document.querySelector('input.cellIn[data-k="shop"]');
    if (!box) return { ok: false, why: "no editable Shop cell" };
    /* A real keystroke fires `input`, then `change` on commit. Both are
       dispatched here because focus() does not always take in an automated
       context, and a test that only worked when it did would be testing the
       harness. */
    box.value = "MAR";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const sent = (window.__sent || []).filter((m) => m.type === "recon_edit");
    return { ok: true, sent: sent, n: Number(box.dataset.n) };
  });
  ok("an edited Shop cell is sent to the server",
    edited.ok && edited.sent.length === 1 && edited.sent[0].patch.shop === "MAR",
    JSON.stringify(edited));
  ok("naming the run and the row it belongs to",
    edited.ok && edited.sent[0].runId === "run-shot-1" && edited.sent[0].n === edited.n,
    JSON.stringify(edited.sent));

  /* ── the working file ──────────────────────────────────────────────────── */
  const grab = async () => {
    await page.evaluate(() => {
      window.__blob = null;
      const make = URL.createObjectURL;
      URL.createObjectURL = function (blob) { window.__blob = blob; return "blob:stub"; };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      window.__restore = () => {
        URL.createObjectURL = make;
        HTMLAnchorElement.prototype.click = click;
      };
      document.querySelector("#rcExport").click();
    });
    // exportCsv awaits the server now, so the blob arrives a tick or two later.
    await page.waitForFunction(() => window.__blob, null, { timeout: 15000 }).catch(() => {});
    const text = await page.evaluate(async () => {
      const b = window.__blob;
      if (window.__restore) window.__restore();
      return b ? await b.text() : "";
    });
    return text;
  };

  const csv = await grab();
  const lines = String(csv).replace(/^\ufeff/, "").trim().split("\n");
  const head = (lines[0] || "").split(",");

  ok("the working file keeps every column of the uploaded file",
    ["B/PAY FILE DATE", "Receipt No", "Amount", "Tramada Bkg No"].every((c) => head.includes(c)),
    head.join(" | "));
  for (const col of ["Consultant", "Shop", "Remarks"]) {
    ok(`and adds a ${col} column`, head.includes(col), head.join(" | "));
  }
  ok("Tramada's receipt number does not overwrite the file's Receipt No column",
    head.includes("Tramada Receipt No") && head.indexOf("Receipt No") === 1,
    head.join(" | "));
  ok("every row is in the file, including the one that could not be run",
    lines.length === 5, `${lines.length - 1} data rows`);

  // BR14 — Shop, then Consultant, with the unreadable one last. The hand-edited
  // WEST → MAR is what row 1 should now sort by.
  const shopCol = head.indexOf("Shop"), consCol = head.indexOf("Consultant");
  const order = lines.slice(1).map((l) => {
    const f = l.split(",");
    return [f[shopCol], f[consCol]];
  });
  eq("BR14 — sorted by Shop, then Consultant, blanks last", order, [
    ["ADL", "Aaron Blake"],
    ["ADL", "Zoe Adams"],
    ["MAR", "Priya Nair"],
    ["", ""],
  ]);
  ok("and the hand-edited cell is the one that was exported", /MAR/.test(csv), csv);
  ok("the remark vocabulary survives the round trip",
    /No booking number found/.test(csv) && /Please allocate/.test(csv) &&
    /Please review, incorrect debtor found/.test(csv), lines.join("\n"));

  /* ── an .xlsx upload comes back as .xlsx ───────────────────────────────── */
  const wb = await page.evaluate(async () => {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "xlsx", name: "bpay-guide.xlsx",
        columns: ["Date", "Receipt No", "Amount", "Booking No"],
        rows: [{ cells: { Date: "09-08-2026", "Receipt No": "CBA1", Amount: "145.54", "Booking No": "13127" },
                 consultant: "Priya Nair", shop: "WEST", remark: "", receiptNo: "R.1",
                 allocation: "Allocated", reconciliation: "Reconciled", why: "" }],
      }),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      type: res.headers.get("Content-Type") || "",
      disposition: res.headers.get("Content-Disposition") || "",
      pk: buf[0] === 0x50 && buf[1] === 0x4b,
      bytes: buf.length,
    };
  });
  ok("asking for xlsx returns a real workbook", wb.pk && wb.bytes > 500, JSON.stringify(wb));
  ok("with the spreadsheet content type", /spreadsheetml\.sheet/.test(wb.type), wb.type);
  ok("and an .xlsx file name", /\.xlsx"/.test(wb.disposition), wb.disposition);

  ok("no page errors", problems.length === 0, problems.join(" | "));

  console.log(`\n  shots/out/bpay-remarks.png written${bad ? " (with failures above)" : ""}\n`);
  await browser.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("\n  shot failed:", e); process.exit(1); });

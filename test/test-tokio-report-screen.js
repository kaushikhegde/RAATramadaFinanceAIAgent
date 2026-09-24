"use strict";

/**
 * THE TOKIO RESULT ON THE RECONCILIATION REPORT SCREEN.
 *
 * Asked for 24-Sep-2026: every other report is read on the Reconciliation
 * report screen, and Tokio's run could only be read on the upload card.
 *
 * This drives the BUILT page in jsdom the way a person drives it — pick four
 * files, press Reconcile in Tramada — and then asks the Reconciliation report
 * screen what it says. Checking the wire source instead would pass while the
 * built page was stale, and checking for strings instead of driving it would
 * pass while the card never rendered.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const tokioCore = require("../tokio-core.js");

const ROOT = path.join(__dirname, "..");
let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The parse reply, built by the SAME code the server builds it with, so the
   screen is fed the real shape rather than one invented here. */
function parseReply() {
  const b2b = [
    { xPolicyNo: "21922098", xTRVIssuedDate: "2026-08-04", xSellPriceIncGST: 100, xBranch: "Elizabeth Travel" },
    { xPolicyNo: "21922235", xTRVIssuedDate: "2026-08-07", xSellPriceIncGST: 137.5, xBranch: "Adelaide Travel" },
  ];
  const sources = {
    payment: tokioCore.indexByPolicy(
      [{ "Seg. Type": "INS", "Booking No.": "15938", Reference: "21922098 - 21922098 - GRAY/SPIDER MS", "Creditor Payable": "70" },
       { "Seg. Type": "INS", "Booking No.": "15941", Reference: "21922235 - 21922235 - WEB/PETER MR", "Creditor Payable": "96.25" }],
      (r) => r["Reference"]),
    costing: tokioCore.indexByPolicy([], (r) => r["Segment Reference"]),
    rcc: tokioCore.indexByPolicy([], (r) => r["Ticket/Booking No."]),
  };
  const con = tokioCore.buildConsolidated(b2b, sources);
  const monthDate = tokioCore.monthKeyToDate("2026-08");
  return {
    month: { key: "2026-08", label: "August 2026", counted: 2, outside: 0, unreadable: 0, warnings: [], overridden: false },
    labels: {
      paymentReference: tokioCore.paymentReference(monthDate),
      sessionLabel: tokioCore.sessionLabel(monthDate),
    },
    files: [],
    counts: {
      total: con.rows.length, travel: con.travel.length,
      retail: con.retail.length, exceptions: con.exceptions.length,
      undocumented: con.rows.filter((r) => r.undocumented).length,
    },
    rows: con.rows,
  };
}

/* The reconcile reply, in the shape server.js sends on a run that saved. */
const RECONCILE = {
  reference: "TOKIO_AUG 2026",
  label: "TOKIO_AUG 26",
  savedSession: true,
  ticked: [
    { policy: "21922098", bookingNo: "15938", amount: "70.00", expected: "70.00",
      differenceCents: 0, reference: "21922098 - 21922098 - GRAY/SPIDER MS" },
    { policy: "21922235", bookingNo: "15941", amount: "96.25", expected: "96.25",
      differenceCents: 0, reference: "21922235 - 21922235 - WEB/PETER MR" },
  ],
  mismatched: [],
  steps: [
    { step: "Steps 9-10", detail: "Issue Payments opened" },
    { step: "Step 10 — searched", detail: "[TOKIOMARINE] Tokio Marine" },
    { step: "Step 11 — payment header", detail: "EFT · Tokio · TOKIO_AUG 2026" },
    { step: "Steps 12-13 — matched", detail: "2 ticked, 0 mismatched" },
    { step: "Step 14 — session saved", detail: "TOKIO_AUG 26 — Issue was NOT clicked" },
  ],
  search: { creditor: "[TOKIOMARINE] Tokio Marine" },
  header: { reference: "TOKIO_AUG 2026" },
};

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;

  // Nothing this test does may reach a network. A call to an endpoint it has
  // not stubbed is a failure, not a silent empty screen.
  const seen = [];
  win.fetch = async (url, opts) => {
    seen.push(String(url));
    const body = (u, o) =>
      u.includes("/api/tokio/parse") ? parseReply()
      : u.includes("/api/tokio/reconcile") ? RECONCILE
      : u.includes("/api/runs") ? []
      : u.includes("/api/") ? {}
      : {};
    return { ok: true, status: 200, json: async () => body(String(url), opts) };
  };
  win.WebSocket = function () { this.close = () => {}; };
  // The card reads files through a FileReader; give it one that answers at once.
  win.FileReader = function () {
    this.readAsArrayBuffer = () => {
      this.result = new win.ArrayBuffer(3);
      if (this.onload) this.onload();
    };
  };

  await sleep(60);   // let DOMContentLoaded's handlers mount

  check("the Reconciliation report screen has a Tokio card, mounted", () => {
    const card = doc.getElementById("tokioReportCard");
    assert.ok(card, "#tokioReportCard was never mounted");
    assert.ok(doc.getElementById("s-inbox").contains(card),
      "the card is not on the Reconciliation report screen");
  });

  check("it is hidden while no Tokio run exists", () => {
    assert.strictEqual(doc.getElementById("tokioReportCard").style.display, "none");
  });

  // ── drive the upload card the way a person does ──
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (String(tag).toLowerCase() === "input") {
      // The picker sets .onchange then calls .click(); answer with a file.
      el.click = () => {
        Object.defineProperty(el, "files", { value: [{ name: "x.csv" }], configurable: true });
        if (el.onchange) el.onchange();
      };
    }
    return el;
  };
  const picks = [...doc.querySelectorAll("[data-tokio-pick]")];
  assert.strictEqual(picks.length, 4, "the upload card does not have four file slots");
  for (const b of picks) b.click();
  await sleep(80);
  doc.createElement = realCreate;

  check("four files parse into a consolidated sheet", () => {
    assert.ok(seen.some((u) => u.includes("/api/tokio/parse")), "the page never asked to parse");
    assert.ok(doc.getElementById("tokioCard").textContent.includes("Consolidated working sheet"));
  });

  check("the report screen shows the sheet as soon as it exists", () => {
    const card = doc.getElementById("tokioReportCard");
    assert.notStrictEqual(card.style.display, "none", "still hidden after a parse");
    assert.ok(card.textContent.includes("Consolidated working sheet"), "no sheet on the report screen");
    assert.ok(card.textContent.includes("TOKIO_AUG"), "the payment reference is not shown");
  });

  check("it does NOT carry the writing buttons", () => {
    const card = doc.getElementById("tokioReportCard");
    assert.ok(!card.querySelector("#tokioRun"), "a second Reconcile button");
    assert.ok(!card.querySelector("#tokioSave"), "a second Save Session button");
    assert.ok(card.querySelector("#tokioReportExport"), "no Export CSV");
  });

  // ── run it ──
  doc.getElementById("tokioRun").click();
  await sleep(80);

  check("the run's result reaches the report screen", () => {
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(t.includes("Session TOKIO_AUG 26 saved"), "the saved-session headline is missing");
    assert.ok(t.includes("21922098") && t.includes("21922235"), "the ticked policies are not listed");
    assert.ok(/2\s*ticked/.test(t), "the ticked count is missing");
  });

  check("the fifteen-step checklist is there, and counts what happened", () => {
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(/The guide.s 15 steps/.test(t), "no checklist");
    assert.ok(/14 of 15 done/.test(t), "the checklist did not derive 14 of 15: " +
      (t.match(/\d+ of 15 done/) || ["nothing"])[0]);
  });

  check("the step log is there, in order", () => {
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(t.includes("Steps taken (5)"), "no step log");
    assert.ok(t.indexOf("Step 11") > t.indexOf("Step 10"), "the log is out of order");
    assert.ok(t.includes("Issue was NOT clicked"), "BR16 is not stated on this screen");
  });

  check("the two screens cannot disagree — both read one run", () => {
    const a = doc.getElementById("tokioCard").textContent;
    const b = doc.getElementById("tokioReportCard").textContent;
    for (const claim of ["TOKIO_AUG 26", "21922098", "Issue was NOT clicked"]) {
      assert.ok(a.includes(claim) && b.includes(claim), claim + " is on only one of the two cards");
    }
  });

  // ── the payment-type filter ──
  const sel = doc.getElementById("ibReport");
  check("Tokio Marine is offered as a payment type", () => {
    const opt = [...sel.options].find((o) => o.value === "tokio");
    assert.ok(opt, "no Tokio option in the payment-type filter");
    assert.ok(!/none/.test(opt.textContent), "offered as empty while a run is on screen");
  });

  sel.value = "tokio";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(30);

  check("picking Tokio keeps the card and says why the table is empty", () => {
    const card = doc.getElementById("tokioReportCard");
    assert.notStrictEqual(card.style.display, "none", "the card hid when Tokio was selected");
    const pane = doc.getElementById("triagePane").textContent;
    assert.ok(/monthly creditor reconciliation/.test(pane),
      "the statement-line table says nothing about why it is empty");
  });

  sel.value = "ipsi";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(30);

  check("filtering to another payment type hides it", () => {
    assert.strictEqual(doc.getElementById("tokioReportCard").style.display, "none",
      "Tokio is still on screen under an IPSI filter");
  });

  assert.ok(!seen.some((u) => /^https?:\/\/(?!localhost)/.test(u)),
    "the page reached off-box: " + seen.join(", "));

  console.log("\n  " + n + " checks passed\n");
  dom.window.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

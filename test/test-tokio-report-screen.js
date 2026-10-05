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
    /* Mapped the way server.js maps them — `source: r.row` and the policy
       lifted to the top level. The raw tokio-core row has neither, so a
       fixture that skipped this step tested a shape the page never sees. */
    rows: con.rows.map((r) => ({
      line: r.line, policy: r.policy, outcome: r.outcome,
      undocumented: r.undocumented, source: r.row, appended: r.appended,
    })),
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

  check("four files parse, and the upload card says so in one line", () => {
    assert.ok(seen.some((u) => u.includes("/api/tokio/parse")), "the page never asked to parse");
    const up = doc.getElementById("tokioCard");
    assert.ok(up.querySelector(".tk-status"), "the upload card has no status line");
    assert.ok(/Not run in Tramada yet/.test(up.textContent), "it does not say the run has not happened");
    assert.ok(up.querySelector('.tk-status a[data-go="inbox"]'), "no link to the report");
  });

  check("the upload card does NOT repeat the result — that is the other screen's job", () => {
    /* This is the whole point of the split. Every other source card on
       Sources & upload names its file, counts its rows and starts the run;
       the result is read on the Reconciliation report screen. Tokio drew the
       tables on BOTH, which is two places to read one run. */
    const up = doc.getElementById("tokioCard").textContent;
    for (const claim of ["Consolidated working sheet", "Steps taken"]) {
      assert.ok(!up.includes(claim), "the upload card still shows: " + claim);
    }
  });

  check("the report screen shows the sheet as soon as it exists", () => {
    const card = doc.getElementById("tokioReportCard");
    assert.notStrictEqual(card.style.display, "none", "still hidden after a parse");
    assert.ok(card.textContent.includes("Consolidated working sheet"), "no sheet on the report screen");
    assert.ok(card.textContent.includes("TOKIO_AUG"), "the payment reference is not shown");
  });

  check("the two screens split the job, and neither takes the other's", () => {
    const up = doc.getElementById("tokioCard");
    const rep = doc.getElementById("tokioReportCard");
    // Writing stays where the files were dropped.
    assert.ok(up.querySelector("#tokioRun"), "no Reconcile button on the upload card");
    assert.ok(!rep.querySelector("#tokioRun"), "a second Reconcile button on the report screen");
    // Reading — export, and the step-15 mail — goes with the result.
    assert.ok(rep.querySelector("#tokioReportExport"), "no Export CSV on the report screen");
    assert.ok(!up.querySelector("#tokioExport"), "Export is still on the upload card too");
  });

  check("ONE button: reconciling and saving the session are one click", () => {
    /* It used to be two — tick and stop, then a second click to save — which
       read as a job half done and left a Tramada window holding ticks that
       vanish if the tab is closed. Asked for 28-Sep-2026. */
    const up = doc.getElementById("tokioCard");
    /* Every button on the card except the four file pickers — NOT scoped to
       .tk-acts, which is where the button used to live. Scoped to one
       container, moving the button somewhere else on the card would have made
       this check pass by finding nothing. */
    const buttons = [...up.querySelectorAll("button")].filter((b) => !b.hasAttribute("data-tokio-pick"));
    assert.strictEqual(buttons.length, 1,
      "expected one action button, found: " + buttons.map((b) => b.textContent.trim()).join(" | "));
    assert.ok(!up.querySelector("#tokioSave"), "the separate Save Session button is back");
    assert.ok(/save session/i.test(buttons[0].textContent),
      "the button does not say it saves: " + buttons[0].textContent);
  });

  check("the run button sits in the card's TITLE ROW, at the right end", () => {
    /* Asked for 05-Oct-2026. It was at the bottom of the card, below four file
       slots — on a tall card the thing you came to press was off the bottom of
       the screen. */
    const up = doc.getElementById("tokioCard");
    const head = up.querySelector(".tk-head");
    assert.ok(head, "the card has no title row");
    assert.ok(head.querySelector("h3"), "the title is not in the title row");
    const btn = head.querySelector("#tokioRun");
    assert.ok(btn, "the run button is not in the title row");
    // At the END of the row: the title comes first, the button last.
    const kids = [...head.children];
    assert.ok(kids.indexOf(head.querySelector("h3")) < kids.indexOf(btn.closest(".tk-head-act")),
      "the button is before the title rather than at the end of the row");
  });

  check("the BR16 sentence stayed on the card, not in the title row", () => {
    /* Two lines of explanation on a title row crowd out the thing they
       explain — but they must not be lost, because they are what says Issue is
       never pressed. */
    const up = doc.getElementById("tokioCard");
    assert.ok(!/BR16/.test(up.querySelector(".tk-head").textContent),
      "the BR16 note was moved into the title row");
    assert.ok(/BR16\/BR18/.test(up.textContent), "the BR16 note is gone from the card entirely");
  });

  check("no run button at all until the four files have been read", () => {
    /* A button in the header that cannot do anything is worse than no button:
       the header is the first thing read on the card. */
    const wire = fs.readFileSync(path.join(ROOT, "design", "recon-wire.html"), "utf8");
    const at = wire.indexOf("function tokioRunButton()");
    assert.ok(at > -1, "no tokioRunButton()");
    const body = wire.slice(at, at + 420);
    assert.ok(/if \(!res \|\| !res\.rows \|\| !res\.rows\.length\) return '';/.test(body),
      "the button renders before there is anything to reconcile");
  });

  check("...and it sends the literal the server insists on", () => {
    /* The two-button flow was the only thing that used to send it. If the one
       button sends nothing, every run is a dry run and NOTHING is ever saved —
       which would look exactly like success on this screen. */
    const wire = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    const at = wire.indexOf("card.querySelector('#tokioRun')");
    assert.ok(at > 0, "the Reconcile button is not wired at all");
    assert.ok(/tokioReconcile\('SAVE SESSION'\)/.test(wire.slice(at, at + 160)),
      "the button runs a dry run: " + wire.slice(at, at + 130));
  });

  check("BR16 is still stated where the button is", () => {
    // The one thing the merge must not quietly drop.
    const acts = doc.getElementById("tokioCard").querySelector(".tk-acts");
    assert.ok(/Issue is never pressed/i.test(acts.textContent),
      "nothing beside the button says Issue is not pressed");
  });

  check("both cards use the same badge words as every other source card", () => {
    const b = doc.getElementById("tokioCard").querySelector("h3 .badge");
    assert.ok(b, "the upload card lost its badge");
    assert.ok(/^(loaded|running…|processed|not run yet|not saved yet|reading…|\d of 4 uploaded)$/
      .test(b.textContent.trim()), "badge says its own thing: " + b.textContent);
    assert.strictEqual(b.textContent.trim(), "not run yet");
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

  check("the fifteen-step checklist is GONE", () => {
    /* Removed 28-Sep-2026. It restated the guide on every run — fifteen rows
       of which only three ever changed — above a step log that says what
       actually happened, in the run's own words. Two accounts of one run, and
       the longer one was the one that could not surprise you.

       Asserted rather than just deleted: "add the checklist back" should be a
       decision with a test to change, not a quiet re-render. */
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(!/15 steps/.test(t), "the checklist is back");
    assert.ok(!/not reached/.test(t), "the checklist's rows are back");
  });

  check("...but the step log, which says what the run DID, stays", () => {
    /* The guide's "Other features" asks to show the steps the agent took.
       That is this, not the checklist: it is the run's own account, and on a
       run that stopped it is the only thing that explains where. */
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(/Steps taken \(\d+\)/.test(t), "the step log went with the checklist");
  });

  check("the step log is there, in order", () => {
    const t = doc.getElementById("tokioReportCard").textContent;
    assert.ok(t.includes("Steps taken (5)"), "no step log");
    assert.ok(t.indexOf("Step 11") > t.indexOf("Step 10"), "the log is out of order");
    assert.ok(t.includes("Issue was NOT clicked"), "BR16 is not stated on this screen");
  });

  check("after the run the upload card updates its one line, and still shows no tables", () => {
    const up = doc.getElementById("tokioCard");
    assert.ok(/Session TOKIO_AUG 26 saved/.test(up.textContent), "the status line did not update");
    assert.ok(/Issue was NOT clicked/.test(up.textContent), "BR16 is not stated where the run is started");
    assert.ok(!up.textContent.includes("Consolidated working sheet"), "the sheet came back");
    assert.ok(!up.textContent.includes("Steps taken"), "the step log came back");
    assert.strictEqual(up.querySelector("h3 .badge").textContent.trim(), "processed");
  });

  check("the statement-line table says which nothing it means", () => {
    /* "Load a report on Sources & upload" written directly above a saved
       Tokio session reads as a broken page. Tokio is not a statement-line
       report, so this table is RIGHT to be empty — it has to say so. */
    const pane = doc.getElementById("triagePane").textContent;
    assert.ok(/No statement-line report in this run/.test(pane),
      "the empty table still says 'Load a report' over a finished Tokio run");
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

  check("the screen's own filter row drives the Tokio card", () => {
    /* Asked for 28-Sep-2026: the filter row at the top of the Reconciliation
       report did nothing for Tokio, on the one screen whose whole job is
       narrowing a result down. */
    const chips = [...doc.querySelectorAll("#inboxGrid .triage .tri")];
    assert.ok(chips.length >= 5, "no Tokio chips: " + chips.map((c) => c.textContent).join("|"));
    const labels = chips.map((c) => c.textContent.replace(/\s+/g, " ").trim());
    for (const want of ["Travel", "Retail", "Exceptions", "Ticked in Tramada", "Not ticked"]) {
      assert.ok(labels.some((l) => l.startsWith(want)), want + " is not offered: " + labels.join(" | "));
    }
    // Both fixture rows are Travel, and both were ticked.
    assert.ok(/All lines 2/.test(labels[0]), labels[0]);
    assert.ok(labels.some((l) => /^Ticked in Tramada 2/.test(l)), labels.join(" | "));
    assert.ok(labels.some((l) => /^Not ticked 0/.test(l)), labels.join(" | "));
  });

  check("a row with no readable policy counts as NEITHER ticked nor not-ticked", () => {
    /* Counting it as "not ticked" would report a row nobody could judge as a
       row that failed — and on a screen of counts, nobody re-adds one. */
    const wire = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    const at = wire.indexOf("'ticked', 'Ticked in Tramada'");
    const block = wire.slice(at, at + 320);
    assert.ok(/!!r\.policy && tokioTickedKeys/.test(block),
      "the ticked chip no longer requires a policy: " + block.slice(0, 120));
    assert.ok(/!!r\.policy && r\.outcome === 'Travel'/.test(block),
      "the not-ticked chip counts rows it cannot judge: " + block.slice(0, 200));
  });

  check("the Status dropdown carries the same options, not the statement-line ones", () => {
    /* It is the same control as the chips, for a narrow screen. Left on
       "Receipted / Reconciled" it would offer three filters that mean nothing
       to a monthly creditor reconciliation. */
    const st = doc.getElementById("ibState");
    assert.deepStrictEqual([...st.options].map((o) => o.value),
      ["all", "travel", "retail", "exception", "ticked", "unticked"]);
  });

  check("picking a chip narrows the consolidated sheet", () => {
    const retail = [...doc.querySelectorAll("#inboxGrid .triage .tri")]
      .find((c) => /^Retail/.test(c.textContent.trim()));
    retail.click();
    const card = doc.getElementById("tokioReportCard");
    assert.ok(/Nothing matches that filter/.test(card.textContent),
      "filtering to Retail still shows the Travel rows");
    // and back
    [...doc.querySelectorAll("#inboxGrid .triage .tri")][0].click();
    assert.ok(doc.getElementById("tokioReportCard").textContent.includes("21922098"));
  });

  check("the search box searches the sheet AND the ticked table", () => {
    const box = doc.getElementById("ibSearch");
    box.value = "21922235";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    const card = doc.getElementById("tokioReportCard");
    assert.ok(card.textContent.includes("21922235"), "the row searched for is gone");
    assert.ok(!card.textContent.includes("21922098"),
      "the search did not narrow anything — other policies are still shown");
    assert.ok(/showing 1 of 2/.test(card.textContent),
      "the sheet does not say how much of it is hidden");
    box.value = "";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
  });

  check("the search placeholder names the columns it searches", () => {
    assert.ok(/policy/i.test(doc.getElementById("ibSearch").placeholder),
      doc.getElementById("ibSearch").placeholder);
  });

  check("the card carries its OWN filter bar, not only the row above", () => {
    /* The row above only reaches Tokio when the payment-type picker is set to
       Tokio Marine. On "All payment types" — how the screen opens — those
       chips are the statement-line ones and the card had no filter at all. */
    const card = doc.getElementById("tokioReportCard");
    const chips = [...card.querySelectorAll(".tk-filters [data-tkf]")];
    assert.ok(chips.length === 6, "expected six chips on the card, found " + chips.length);
    assert.ok(card.querySelector("#tokioSearch"), "no search box on the card");
  });

  check("its chips and the row above are ONE state, never two", () => {
    /* A card saying "Exceptions" under a row saying "All lines" is a screen
       nobody can trust. */
    const card = doc.getElementById("tokioReportCard");
    const travel = [...card.querySelectorAll("[data-tkf]")].find((c) => /^Travel/.test(c.textContent.trim()));
    travel.click();
    const onCard = [...card.querySelectorAll("[data-tkf].on")].map((c) => c.getAttribute("data-tkf"));
    const onRow = [...doc.querySelectorAll("#inboxGrid .triage .tri.on")].map((c) => c.dataset.tf);
    assert.deepStrictEqual(onCard, ["travel"]);
    assert.deepStrictEqual(onRow, ["travel"], "the row above did not follow the card");
    [...card.querySelectorAll("[data-tkf]")][0].click();     // back to All
  });

  await (async () => {
    const card = () => doc.getElementById("tokioReportCard");
    card().querySelector("#tokioSearch").value = "21922235";
    card().querySelector("#tokioSearch").dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(400);                       // the box is debounced

    check("typing in the card's own box narrows the sheet", () => {
      assert.ok(card().textContent.includes("21922235"), "the row searched for is gone");
      assert.ok(!card().textContent.includes("21922098"), "nothing was narrowed");
    });

    check("...and the box still holds what was typed afterwards", () => {
      /* Typing rebuilds the card, so the input is a NEW element. Rendered
         without its value the field blanks itself after one character and
         reads as broken — the same bug the balance fields had. */
      assert.strictEqual(card().querySelector("#tokioSearch").value, "21922235",
        "the card's search box emptied itself on re-render");
    });

    check("the bar says Export hands over the WHOLE sheet, not the filtered view", () => {
      /* BR17 gives Travel Accounts the consolidated file, not whichever slice
         somebody was looking at. "showing 1 of 2" beside a button marked
         Export CSV is how a person sends one row believing they sent two. */
      assert.ok(/Export hands over all 2, not the 1 on screen/.test(card().textContent),
        "the action bar does not say what Export will actually send");
    });

    check("...and the screen's own box was kept in step", () => {
      assert.strictEqual(doc.getElementById("ibSearch").value, "21922235",
        "the two search boxes disagree about what is being searched for");
    });

    card().querySelector("#tokioSearch").value = "";
    card().querySelector("#tokioSearch").dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(400);
  })();

  check("the card's filter works with the payment type back on All", () => {
    sel.value = "";
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    const card = doc.getElementById("tokioReportCard");
    assert.notStrictEqual(card.style.display, "none", "the card hid on All payment types");
    const retail = [...card.querySelectorAll("[data-tkf]")].find((c) => /^Retail/.test(c.textContent.trim()));
    assert.ok(retail, "no chips on the card when the row above is showing statement lines");
    retail.click();
    assert.ok(/Nothing matches that filter/.test(doc.getElementById("tokioReportCard").textContent),
      "the card's own chip did not narrow the sheet");
    [...doc.getElementById("tokioReportCard").querySelectorAll("[data-tkf]")][0].click();
  });

  sel.value = "tokio";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(30);

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

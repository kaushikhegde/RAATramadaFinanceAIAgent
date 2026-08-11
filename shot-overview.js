/**
 * A picture of the Run overview, from a seeded runs.json.
 *
 * Not a test — like the other shot-* tools it replays invented frames and
 * proves nothing about the automation. It exists because this screen's whole
 * failure mode is visual: a dashboard that renders zeroes, or renders a figure
 * a hundred times out, looks exactly like a dashboard that is working. The one
 * before this showed $7.2m of the mockup's invented balances and nobody
 * noticed for weeks.
 *
 *   node shot-overview.js        → overview.png
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-shot-"));
process.env.RECON_STORE_DIR = DIR;
process.env.PORT = process.env.PORT || "3122";

// A history worth looking at: a clean run, one with money left over, one that
// never reached Chrome.
fs.writeFileSync(path.join(DIR, "runs.json"), JSON.stringify({
  version: 1,
  runs: [
    {
      id: "run-20260810-091500-1", startedAt: "2026-08-10T09:15:00Z", finishedAt: "2026-08-10T09:22:00Z",
      source: "bpay", file: { name: "tramada-statement-lines.csv" }, statementDate: "10-08-2026",
      pageNumber: 10, status: "done", error: null,
      totals: { rows: 6, amountCents: 305693, reconciledCents: 305693, unreconciledCents: 0, failedCents: 0 },
      balances: { opening: "111753.97", closing: "120000.00", unpresented: "8246.03", calculated: "120000.00" },
      // Consistent with `rows` below — five reconciled, one failed receipt.
      // A fixture whose summary disagrees with its own rows makes a reference
      // picture that quietly teaches the wrong thing.
      summary: { total: 6, allocated: 5, reconciled: 5, notReconciled: 1, both: 5, failed: 1 },
      committed: { done: true, ticked: 5, missing: [], futureDated: [] },
      activity: [
        { at: "2026-08-10T09:15:04Z", message: "Reading the existing [TRUST] Trust Account statement pages…", ok: true },
        { at: "2026-08-10T09:16:10Z", message: "9 existing pages read (highest 9); creating page 10.", ok: true },
        { at: "2026-08-10T09:17:02Z", message: "Page 10 created (10-08-2026).", ok: true },
        { at: "2026-08-10T09:18:30Z", message: "Sorting by date descending, then filtering to Client Payment Receipt…", ok: true },
        { at: "2026-08-10T09:19:05Z", message: "47 transactions showing after the filter.", ok: true },
        { at: "2026-08-10T09:20:11Z", message: "Row 5: receipt failed: element is not enabled (blocked by <div>)", ok: false },
        { at: "2026-08-10T09:21:40Z", message: "Statement balances set — opening $111753.97, closing $120000.00.", ok: true },
        { at: "2026-08-10T09:21:55Z", message: "5 transactions ticked.", ok: true },
        { at: "2026-08-10T09:22:00Z", message: "Done — the statement page is committed with 5 transactions reconciled.", ok: true },
      ],
      rows: [
        { n: 1, bookingNo: "13157", reference: "VIX122334", amountCents: 105693, reconciliation: "Reconciled", receiptNo: "R.0000009403" },
        { n: 2, bookingNo: "13158", reference: "NW", amountCents: 60000, reconciliation: "Reconciled", receiptNo: "R.0000009404" },
        { n: 3, bookingNo: "13159", reference: "Trip File Tsfr 1105", amountCents: 40000, reconciliation: "Reconciled", receiptNo: "R.0000009405" },
        { n: 4, bookingNo: "13160", reference: "Deposit - Jill Shields", amountCents: 15000, reconciliation: "Reconciled", receiptNo: "R.0000009406" },
        { n: 5, bookingNo: "13161", reference: "ING2507202653904", amountCents: 60000, reconciliation: "Not reconciled", error: "element is not enabled", why: "receipt failed: element is not enabled (blocked by <div>)" },
        { n: 6, bookingNo: "13162", reference: "CRU26072026476131", amountCents: 25000, reconciliation: "Reconciled", receiptNo: "R.0000009407", mismatch: "the page says $240.00, the file says $250.00" },
      ],
    },
    {
      id: "run-20260809-090200-2", startedAt: "2026-08-09T09:02:00Z", finishedAt: "2026-08-09T09:06:00Z",
      source: "mint", file: { name: "mint.xlsx" }, statementDate: "09-08-2026",
      pageNumber: 11, status: "done", error: null,
      totals: { rows: 4, amountCents: 122550, reconciledCents: 115000, unreconciledCents: 7550, failedCents: 0 },
      summary: { total: 4, reconciled: 3, notReconciled: 1, mismatched: 1, failed: 0 },
      committed: { done: true, ticked: 3, missing: ["P.0000009999"], futureDated: [] },
      rows: [{}, {}, {}, {}],
    },
    {
      id: "run-20260807-081100-3", startedAt: "2026-08-07T08:11:00Z", finishedAt: "2026-08-07T08:11:20Z",
      source: "bpay", file: { name: "bpay-07-aug.csv" }, statementDate: "07-08-2026",
      pageNumber: null, status: "failed",
      error: "Could not connect to Chrome on 127.0.0.1:9222. Run \"npm run start:chrome\" and sign into Tramada in that window.",
      totals: { rows: 3, amountCents: 91000, reconciledCents: 0, unreconciledCents: 91000, failedCents: 0 },
      summary: null, committed: { done: false, ticked: 0, missing: [], futureDated: [] },
      rows: [{}, {}, {}],
    },
  ],
}, null, 2));

require("./server");
const { chromium } = require("playwright");

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  // CHROMIUM_PATH lets this run where the pinned playwright build and the
  // installed browser disagree — a container with a Chromium already on it
  // should not have to download a second one.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  /**
   * A page error and a bad response, tracked separately.
   *
   * `console` error text does not carry the URL, so a 404 arrives as an
   * anonymous "Failed to load resource" — which turned out to be Chromium
   * asking for a favicon this project does not have. Watching RESPONSES names
   * the thing, so the check can ignore that one and still fail on a real
   * missing asset.
   */
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) {
      problems.push(`${r.status()} ${r.url()}`);
    }
  });

  await page.goto(`http://127.0.0.1:${process.env.PORT}/`, { waitUntil: "networkidle" });
  await page.click('[data-go="overview"]').catch(() => {});
  await page.waitForFunction(
    () => !/29 July 2026/.test(document.querySelector("#s-overview .lead h2").textContent),
    null, { timeout: 10000 });
  await page.waitForTimeout(300);

  const seen = await page.evaluate(() => {
    const host = document.querySelector("#s-overview");
    const txt = (s) => { const n = host.querySelector(s); return n ? n.textContent.replace(/\s+/g, " ").trim() : "(missing)"; };
    return {
      // The mockup's own structure — if any of these has gone, the wiring has
      // redrawn a screen it is only supposed to fill in.
      structure: {
        hero: !!host.querySelector(".hero .ring svg"),
        heroStats: host.querySelectorAll(".hero-stats .hs").length,
        balance: host.querySelectorAll(".bal > div").length,
        note: !!host.querySelector(".note"),
        streams: host.querySelectorAll(".g-4 .stream").length,
        reactionTable: host.querySelectorAll(".g-main table tbody tr").length,
        // The row's own eight cells, and the entry's <time> + <p>. These hold
        // as many ENTRIES as the run produced — the count is data — but the
        // shape of one is the client's design and must not drift.
        reactionCells: (host.querySelector(".g-main table tbody tr") || { children: [] }).children.length,
        timeline: host.querySelectorAll(".g-main .tl li").length,
        timelineShape: !!host.querySelector(".g-main .tl li time") && !!host.querySelector(".g-main .tl li p"),
        heroClasses: (host.querySelector(".hero") || {}).className || "",
        sampleBanner: !!host.querySelector(".sample-tag"),
      },
      reaction: [...host.querySelectorAll(".g-main table tbody tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())),
      activity: [...host.querySelectorAll(".g-main .tl li")].map((li) =>
        li.textContent.replace(/\s+/g, " ").trim()),
      ring: txt(".ring b"),
      h2: txt(".lead h2"),
      p: txt(".lead p"),
      stats: [...host.querySelectorAll(".hero-stats .hs")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
      bal: [...host.querySelectorAll(".bal > div")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
      streams: [...host.querySelectorAll(".g-4 .stream")].map((n) => ({
        title: (n.querySelector("h4") || {}).textContent || "",
        big: (n.querySelector(".big") || {}).textContent.replace(/\s+/g, " ").trim(),
      })),
    };
  });

  console.log("\n  " + seen.h2);
  console.log("  " + seen.p);
  console.log("  ring " + seen.ring + "   stats: " + seen.stats.join(" · "));
  console.log("  bal:  " + seen.bal.join(" · "));
  console.log("  streams:");
  for (const s of seen.streams) console.log(`    ${s.title.trim()} — ${s.big}`);

  let bad = 0;
  const ok = (name, cond, detail) => {
    if (cond) console.log(`  ✓ ${name}`);
    else { bad++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
  };
  console.log("");
  ok("no page errors", problems.length === 0, problems.join(" | "));

  // THE POINT OF THIS CHECK: the client's markup is all still there. The
  // wiring fills this screen in; it does not get to redraw it.
  const st = seen.structure;
  ok("the hero ring is still the mockup's", st.hero);
  ok("four hero stats", st.heroStats === 4, String(st.heroStats));
  ok("five balance figures", st.balance === 5, String(st.balance));
  ok("the balance note is untouched", st.note);
  ok("all four stream cards survive", st.streams === 4, String(st.streams));
  ok("the reaction table is still a table with rows", st.reactionTable > 0, String(st.reactionTable));
  ok("a row still has the mockup's eight cells", st.reactionCells === 8, String(st.reactionCells));
  ok("the activity timeline is still a list", st.timeline > 0, String(st.timeline));
  ok("an entry still has its <time> and its <p>", st.timelineShape);

  // …and the numbers in it are the run's, not the mockup's.
  ok("the heading names the real statement date", seen.h2.includes("10-08-2026"), seen.h2);
  ok("the lede counts real rows", /5 of 6 statement lines/.test(seen.p), seen.p);
  ok("the ring is the real percentage", seen.ring === "83%", seen.ring);
  ok("the balance strip is the run's own read-back",
    seen.bal.some((b) => b.includes("111753.97")), seen.bal.join(" ~ "));
  ok("variance is computed, not asserted",
    seen.bal.some((b) => b.includes("$0.00")), seen.bal.join(" ~ "));
  ok("the BPay stream shows real counts",
    seen.streams[1].big.replace(/\s/g, "") === "5/6", seen.streams[1].big);
  // This system has only BPay and Mint. The design's other two cards read
  // 0 / 0 rather than keeping its example figures — invented money next to
  // four real panels is the thing this whole screen is trying not to be.
  ok("the streams with no report behind them read zero",
    seen.streams[2].big.replace(/\s/g, "") === "0/0" && seen.streams[3].big.replace(/\s/g, "") === "0/0",
    seen.streams.map((s) => s.big).join(" ~ "));

  // The two panels that were still the mockup's until now.
  ok("the reaction table holds the run's own rows",
    seen.reaction.some((r) => r.join(" ").includes("13161")), JSON.stringify(seen.reaction).slice(0, 240));
  ok("ranked by dollar impact, worst first",
    Number(seen.reaction[0][4].replace(/,/g, "")) >= Number(seen.reaction[seen.reaction.length - 1][4].replace(/,/g, "")),
    seen.reaction.map((r) => r[4]).join(" ~ "));
  ok("a difference is listed as well as a failure",
    seen.reaction.some((r) => r.join(" ").includes("Difference on the page")),
    JSON.stringify(seen.reaction).slice(0, 240));
  ok("the timeline is the run's own log",
    seen.activity.some((a) => a.includes("Page 10 created")), seen.activity.slice(0, 3).join(" ~ "));
  ok("newest first", /committed with 5 transactions/.test(seen.activity[0]), seen.activity[0]);
  ok("a line that stopped the run is marked",
    seen.activity.some((a) => a.includes("stopped")), seen.activity.join(" ~ ").slice(0, 200));
  ok("no sample-data banner is left on this screen", !seen.structure.sampleBanner);

  /* THE STREAM CARDS SAY WHAT THE UPLOAD CARDS SAY.
     The mockup's third and fourth were "Merchant settlements" and "Passenger
     refunds" — a design drawn before this system had IPSI and TravelPay — and
     they were wired to sources named 'merchant' and 'refunds' that have never
     existed here, so they read 0 / 0 however many IPSI runs had been done. */
  const cards = await page.evaluate(() => [...document.querySelectorAll("#s-overview .g-4 .stream")]
    .map((c) => ({
      title: (c.querySelector("h4") || {}).textContent || "",
      sub: (c.querySelector(".src") || {}).textContent || "",
      big: (c.querySelector(".big") || {}).textContent || "",
    })));
  ok("four stream cards", cards.length === 4, String(cards.length));
  ok("the third is IPSI", cards[2] && cards[2].title === "IPSI", cards[2] && cards[2].title);
  ok("the fourth is TravelPay", cards[3] && cards[3].title === "TravelPay", cards[3] && cards[3].title);
  ok("named the same as the upload cards",
    /IPSI merchant settlement/.test(cards[2].sub) && /TravelPay merchant settlement/.test(cards[3].sub),
    cards[2].sub + " ~ " + cards[3].sub);
  ok("and no mockup names survive anywhere on the screen",
    !(await page.evaluate(() => /Merchant settlements|Passenger refunds/.test(
      (document.querySelector("#s-overview") || {}).textContent || ""))),
    "Merchant settlements / Passenger refunds");

  /* PAST RUNS. The inbox showed one run — the one you had just started — while
     every run before it sat in runs.json, reachable over HTTP and unreachable
     from the screen a person works in. #ibDate is the mockup's own "Report
     date" select, dead until there was something to put in it. */
  await page.evaluate(() => {
    const go = document.querySelector('[data-go="inbox"]');
    if (go) go.click();
  });
  await page.waitForTimeout(600);
  const picker = await page.evaluate(() => {
    const sel = document.querySelector("#ibDate");
    return sel ? {
      shown: sel.style.display !== "none",
      options: [...sel.options].map((o) => o.textContent),
      value: sel.value,
    } : null;
  });
  ok("the inbox has a run picker", picker && picker.shown, JSON.stringify(picker));
  ok("it starts on this run", picker && picker.value === "", picker && picker.value);
  ok("and lists the runs in runs.json",
    picker && picker.options.length === 4, JSON.stringify(picker && picker.options));
  ok("each one says when, what and how many",
    picker && /·/.test(picker.options[1]) && /row/.test(picker.options[1]), picker && picker.options[1]);
  // Newest first: the dates in the labels have to descend.
  const when = (picker.options || []).slice(1).map((t) => t.split(" ")[0]);
  ok("newest first", when.join(",") === when.slice().sort().reverse().join(","), when.join(" | "));

  // Picking one draws it. The live run is empty here, so rows appearing at all
  // is the proof that a stored run reached the table.
  await page.selectOption("#ibDate", picker.options[1] ? await page.evaluate(() =>
    document.querySelector("#ibDate").options[1].value) : "");
  await page.waitForTimeout(700);
  const past = await page.evaluate(() => ({
    rows: document.querySelectorAll("#triagePane tbody tr").length,
    badge: ((document.querySelector("#inboxGrid .triage .badge") || {}).textContent || "").trim(),
  }));
  ok("choosing a past run shows its rows", past.rows > 0, JSON.stringify(past));
  ok("and the screen says it is a past run", /past run/i.test(past.badge), past.badge);

  await page.selectOption("#ibDate", "");
  await page.waitForTimeout(400);
  const back = await page.evaluate(() =>
    ((document.querySelector("#inboxGrid .triage .badge") || {}).textContent || "").trim());
  ok("and going back says so too", !/past run/i.test(back), back);

  await page.evaluate(() => {
    const go = document.querySelector('[data-nav="overview"], [data-go="overview"]');
    if (go) go.click();
  });
  await page.waitForTimeout(400);

  /**
   * And the state that actually shipped broken: NO runs at all.
   *
   * This returned early and left the mockup's figures standing — $7.2m of
   * invented balances and a full activity log, with the "sample data" banner
   * removed. The first thing anyone saw on a fresh install was three days of
   * somebody else's reconciliation presented as their own.
   */
  console.log("\n  with an empty runs.json");
  fs.writeFileSync(path.join(DIR, "runs.json"), JSON.stringify({ version: 1, runs: [] }));
  const fresh = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await fresh.goto(`http://127.0.0.1:${process.env.PORT}/`, { waitUntil: "networkidle" });
  await fresh.click('[data-go="overview"]').catch(() => {});
  await fresh.waitForFunction(
    () => /No runs yet/.test(document.querySelector("#s-overview .lead h2").textContent),
    null, { timeout: 10000 }).catch(() => {});
  const blank = await fresh.evaluate(() => {
    const host = document.querySelector("#s-overview");
    return {
      h2: host.querySelector(".lead h2").textContent.trim(),
      ring: host.querySelector(".ring b").textContent.trim(),
      stats: [...host.querySelectorAll(".hero-stats .hs b")].map((b) => b.textContent.trim()),
      bal: [...host.querySelectorAll(".bal > div b")].map((b) => b.textContent.trim()),
      note: host.querySelector(".note b").textContent.trim(),
      streams: [...host.querySelectorAll(".g-4 .stream .big")].map((b) => b.textContent.replace(/\s/g, "")),
      body: host.querySelector(".g-main table tbody").textContent.replace(/\s+/g, " ").trim(),
      tl: host.querySelector(".g-main .tl").textContent.replace(/\s+/g, " ").trim(),
      structure: host.querySelectorAll(".hero-stats .hs").length + "/" +
        host.querySelectorAll(".bal > div").length + "/" + host.querySelectorAll(".g-4 .stream").length,
    };
  });
  console.log("    " + blank.h2 + " · ring " + blank.ring + " · " + blank.note);
  ok("a fresh install says it has no runs", blank.h2 === "No runs yet", blank.h2);
  ok("the ring is zero, not the mockup's 84%", blank.ring === "0%", blank.ring);
  ok("no invented hero stats", blank.stats.every((s) => s === "0"), blank.stats.join(","));
  ok("no invented balances", blank.bal.every((b) => b === "—"), blank.bal.join(" ~ "));
  ok("the balance note does not claim agreement",
    !/in agreement/.test(blank.note), blank.note);
  ok("every stream reads 0 / 0", blank.streams.every((s) => s === "0/0"), blank.streams.join(" ~ "));
  ok("nothing invented in the reaction table", !/118299|MT BARKER/.test(blank.body), blank.body.slice(0, 120));
  ok("nothing invented in the timeline", !/Princess Cruises|Jill S/.test(blank.tl), blank.tl.slice(0, 120));
  ok("and the markup is still all there", blank.structure === "4/5/4", blank.structure);
  await fresh.screenshot({ path: path.join(__dirname, "overview-empty.png"), fullPage: false });
  await fresh.close();

  await page.screenshot({ path: path.join(__dirname, "overview.png"), fullPage: false });
  console.log(`\n  overview.png written${bad ? " (with failures above)" : ""}\n`);
  await browser.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("\n  shot failed:", e); process.exit(1); });

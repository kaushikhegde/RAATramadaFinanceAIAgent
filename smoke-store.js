/**
 * A live check of the store, over the real socket and the real HTTP routes.
 *
 * Not a test (it starts a server and talks to it, so it is not offline and it
 * does not belong in `npm test`), but the upload path and the overview routes
 * have no offline coverage at all — the parts under test here are exactly the
 * parts that only exist once express and ws are running.
 *
 *   node smoke-store.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recon-smoke-"));
process.env.RECON_STORE_DIR = DIR;
process.env.PORT = "3111";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

require("./server");
const WebSocket = require("ws");

const get = (p) => fetch(`http://127.0.0.1:3111${p}`).then((r) => r.json());

(async () => {
  await new Promise((r) => setTimeout(r, 500));

  console.log("\nthe overview before anything has happened");
  const empty = await get("/api/overview");
  ok("it answers", !!empty, JSON.stringify(empty));
  ok("with no runs", empty.runs === 0);
  ok("and no money", empty.amountCents === 0);

  console.log("\na BPay CSV arriving on the socket");
  const csv = fs.readFileSync(path.join(__dirname, "tramada-statement-lines.csv"));
  const ws = new WebSocket("ws://127.0.0.1:3111/ws");
  await new Promise((r) => ws.on("open", r));

  const stored = await new Promise((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "recon_uploaded") resolve(m);
    });
    ws.send(JSON.stringify({
      type: "recon_upload", source: "bpay",
      name: "tramada-statement-lines.csv", base64: csv.toString("base64"),
    }));
  });
  ok("the server says it kept it", !stored.error, stored.error);
  ok("under uploads/", /^uploads[/\\]/.test((stored.file || {}).stored || ""), JSON.stringify(stored.file));
  ok("the bytes on disk match the bytes sent",
    fs.existsSync(path.join(DIR, stored.file.stored)) &&
    fs.readFileSync(path.join(DIR, stored.file.stored)).equals(csv));

  console.log("\na run is recorded even when it cannot reach Chrome");
  // No Chrome on 9222 here, so the run fails at openBrowser — which is the
  // point: a run that could not start still has to appear on the dashboard,
  // with a reason, rather than vanishing.
  const done = await new Promise((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "recon_done") resolve(m);
    });
    ws.send(JSON.stringify({
      type: "recon_run", source: "bpay",
      rows: [{ date: "2026-08-10", reference: "VIX122334", recPayType: "Debtor Payment Receipt", amount: "150.00", bookingNo: "13157" }],
      statementDate: "2026-08-10", openingBalance: "111,753.97", closingBalance: "120000",
    }));
  });
  ok("the run ends with an error, as it must with no Chrome", !!done.error, JSON.stringify(done).slice(0, 200));
  ok("and it hands back a run id", !!done.runId, JSON.stringify(done).slice(0, 200));

  const after = await get("/api/overview");
  ok("the dashboard now has one run", after.runs === 1, JSON.stringify(after).slice(0, 200));
  ok("marked failed", after.failed === 1);
  ok("carrying the file it was given", after.recent[0].file === "tramada-statement-lines.csv");
  ok("and the money it was asked to move", after.amountCents === 15000, String(after.amountCents));

  const runs = await get("/api/runs");
  const run = runs[0];
  ok("the run keeps its rows", (run.rows || []).length === 1);
  ok("the balances were normalised on the way in", run.openingBalance === "111753.97", run.openingBalance);
  ok("the failure is written down", !!run.error, run.error);
  ok("a single run is fetchable by id", (await get(`/api/runs/${run.id}`)).id === run.id);

  console.log("\nall three reports in one run");
  // Still no Chrome, so this fails at openBrowser again — but it has to fail as
  // ONE run holding both reports' rows, not as two runs or as a refusal.
  const combined = await new Promise((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "recon_done" && m.runId !== done.runId) resolve(m);
    });
    ws.send(JSON.stringify({
      type: "recon_run", source: "both",
      byReport: {
        bpay: [{ date: "2026-08-10", reference: "VIX122334", recPayType: "Debtor Payment Receipt", amount: "150.00", bookingNo: "13157" }],
        mint: [{ transNo: "P.0000004123", amount: "400.00", amountCents: 40000, toCompany: "READY ROOMS" }],
        travelpay: [{ transNo: "31282716", amount: "1480.88", amountCents: 148088, toCompany: "Monarto Resort Pty Ltd" }],
      },
      statementDate: "2026-08-10", openingBalance: "111753.97", closingBalance: "120000",
    }));
  });
  ok("the combined run is accepted, not refused", !!combined.runId, JSON.stringify(combined).slice(0, 200));

  const both = (await get("/api/runs")).find((r) => r.id === combined.runId);
  ok("it is ONE run, not two", both && both.source === "both", both && both.source);
  ok("holding every report's rows", both && both.rows.length === 3, both && String(both.rows.length));
  ok("each row knows which report it came from",
    both && both.rows.map((r) => r.src).join(",") === "bpay,mint,travelpay",
    both && both.rows.map((r) => r.src).join(","));
  ok("numbered across both, so no row overwrites another",
    both && both.rows.map((r) => r.n).join(",") === "1,2,3",
    both && both.rows.map((r) => r.n).join(","));
  ok("and its money is every report added up", both && both.totals.amountCents === 203088,
    both && String(both.totals.amountCents));

  const dash = await get("/api/overview");
  ok("the dashboard counts it under both sources",
    dash.bySource.bpay === 2 && dash.bySource.mint === 1 && dash.bySource.travelpay === 1,
    JSON.stringify(dash.bySource));

  ws.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n  smoke failed:", e); process.exit(1); });

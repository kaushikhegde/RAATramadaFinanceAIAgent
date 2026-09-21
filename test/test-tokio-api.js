"use strict";

/**
 * The Tokio upload endpoint, over HTTP.
 *
 * tokio-core is tested on its own; this tests the seam — that four CSVs in
 * produce a consolidated sheet out, that the month comes back derived and
 * overridable, and that a missing or empty file is refused rather than
 * reconciled against nothing.
 */

const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3896;
const ROOT = path.join(__dirname, "..");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Four small files in the real shape, with the real column names.
const B2B = [
  "xPolicyNo,xTRVIssuedDate,xSellPriceIncGST,xBranch",
  "21085663,2026-07-01,218.93,Elizabeth Travel",      // Travel, in payment
  "21085668,2026-07-04,313.21,Elizabeth",             // not Travel, in RCC -> Retail
  "21085670,2026-07-09,100.00,Adelaide Travel",       // Travel, nowhere -> exception
].join("\n");

const PAYMENT = [
  "Seg. Type,Booking No.,Reference,Creditor Payable",
  "INS,74585,21085663 - 21085663 - SOMEONE/A MRS,153.25",
].join("\n");

const COSTING = ["Segment Reference,Due Amount", "21099999,10.00"].join("\n");
const RCC = ["Ticket/Booking No.,Total", "21085668,313.21", "RAAQ-846157711,141.45"].join("\n");

const FILES = {
  b2b: { name: "b2b.csv", base64: b64(B2B) },
  payment: { name: "pay.csv", base64: b64(PAYMENT) },
  costing: { name: "cost.csv", base64: b64(COSTING) },
  rcc: { name: "rcc.csv", base64: b64(RCC) },
};

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
          catch { reject(new Error("not JSON (" + res.statusCode + "): " + out.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (child.exitCode !== null) throw new Error("server exited with " + child.exitCode);
    try {
      await new Promise((res, rej) => {
        const r = http.request({ host: "127.0.0.1", port: PORT, path: "/", method: "GET" }, (x) => { x.resume(); res(); });
        r.on("error", rej);
        r.end();
      });
      return;
    } catch { await sleep(250); }
  }
  throw new Error("server never came up on " + PORT);
}

(async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: "", NOVNC_PORT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  try {
    await waitForServer(child);

    const r = await post("/api/tokio/parse", { files: FILES });
    check("four files in, a consolidated sheet out", () => {
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.strictEqual(r.body.counts.total, 3);
    });

    check("the month is derived from the B2B dates and labelled", () => {
      assert.strictEqual(r.body.month.key, "2026-07");
      assert.strictEqual(r.body.month.label, "July 2026");
      assert.strictEqual(r.body.month.overridden, false);
    });

    check("the guide's two labels come back built from that month", () => {
      assert.strictEqual(r.body.labels.paymentReference, "TOKIO_JUL 2026");
      assert.strictEqual(r.body.labels.sessionLabel, "TOKIO_JUL 26");
    });

    check("each row is sorted the way steps 7 and 8 say", () => {
      const by = {};
      r.body.rows.forEach((x) => (by[x.policy] = x.outcome));
      assert.strictEqual(by["21085663"], "Travel", "Travel branch, found in the Payment Report");
      assert.strictEqual(by["21085668"], "Retail", "not Travel, found in RCC only");
      assert.strictEqual(by["21085670"], "Exception", "Travel branch, nowhere in Tramada");
      assert.deepStrictEqual(r.body.counts, { total: 3, travel: 1, retail: 1, exceptions: 1, undocumented: 0 });
    });

    check("the policy is dug out of the Payment Report's Reference", () => {
      const row = r.body.rows.find((x) => x.policy === "21085663");
      assert.strictEqual(row.appended["Tramada Payment Report"], "21085663");
      assert.strictEqual(row.appended["Tramada Costing Report"], "N/A");
    });

    check("the B2B report's own columns come back untouched", () => {
      const row = r.body.rows.find((x) => x.policy === "21085663");
      assert.strictEqual(row.source.xBranch, "Elizabeth Travel");
      assert.strictEqual(String(row.source.xSellPriceIncGST), "218.93");
    });

    check("Remarks is appended after the three lookups", () => {
      assert.deepStrictEqual(r.body.appendedColumns.slice(-1), ["Remarks"]);
      const exc = r.body.rows.find((x) => x.outcome === "Exception");
      assert.ok(/Please check/.test(exc.appended.Remarks), exc.appended.Remarks);
    });

    const over = await post("/api/tokio/parse", { files: FILES, month: "2026-08" });
    check("the month can be overridden, and says it was", () => {
      assert.strictEqual(over.status, 200);
      assert.strictEqual(over.body.month.key, "2026-08");
      assert.strictEqual(over.body.month.label, "August 2026");
      assert.strictEqual(over.body.month.overridden, true);
      assert.strictEqual(over.body.labels.sessionLabel, "TOKIO_AUG 26");
    });

    const badMonth = await post("/api/tokio/parse", { files: FILES, month: "2026-13" });
    check("an impossible month is refused, not rounded", () => {
      assert.strictEqual(badMonth.status, 400);
      assert.ok(/not a month/i.test(badMonth.body.error), badMonth.body.error);
    });

    for (const k of ["b2b", "payment", "costing", "rcc"]) {
      const short = { ...FILES };
      delete short[k];
      const miss = await post("/api/tokio/parse", { files: short });
      check(`a missing ${k} file is refused, citing BR01`, () => {
        assert.strictEqual(miss.status, 400);
        assert.ok(/BR01/.test(miss.body.error), miss.body.error);
        assert.deepStrictEqual(miss.body.missing, [k]);
      });
    }

    const empty = await post("/api/tokio/parse", {
      files: { ...FILES, costing: { name: "cost.csv", base64: b64("Segment Reference,Due Amount") } },
    });
    check("a file with headers and no rows is refused, not read as zero matches", () => {
      // An empty Costing Report would quietly turn every Travel row into an
      // exception, which looks like a data problem rather than a wrong upload.
      assert.strictEqual(empty.status, 400);
      assert.ok(/has no rows/i.test(empty.body.error), empty.body.error);
    });

    console.log("\n" + n + " assertions passed.");
  } catch (err) {
    console.error("\nFAILED: " + (err && err.message ? err.message : err));
    if (log) console.error("\n--- server output ---\n" + log.slice(-1200));
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
  }
})();

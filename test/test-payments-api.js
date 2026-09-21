"use strict";

/**
 * The payments conversation over HTTP.
 *
 * payments-chat.js is tested on its own; this tests the seam — that the routes
 * carry the conversation, that a session survives between calls, and that the
 * two answers a caller must not be able to fake (ready, decision) only ever
 * appear when the engine says so.
 *
 * It spawns the real server rather than importing the handlers, because the
 * thing most likely to break is the wiring, not the logic.
 */

const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3897;
const ROOT = path.join(__dirname, "..");

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
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

const APPROVED =
  "APPROVED\nBooking Number: 13061\nIPSI Transaction Reference Number: 1792412290cXt4Z\n" +
  "Cardholder Name: Isaac Gates\nAmount: $1,289.00";

(async () => {
  // DATABASE_URL is deliberately blanked: the run store falls back to memory,
  // and these routes have nothing to do with it.
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

    const start = await post("/api/ipsi-payment/start", { text: APPROVED });
    check("start parses the approval and asks which card", () => {
      assert.strictEqual(start.status, 200);
      assert.ok(start.body.id, "no session id");
      assert.strictEqual(start.body.step, "card");
      assert.deepStrictEqual(start.body.choices, [
        "Visa Credit", "Visa Debit", "Mastercard Credit", "Mastercard Debit",
      ]);
      assert.strictEqual(start.body.ready, false);
      assert.strictEqual(start.body.decision, undefined, "a decision leaked before confirmation");
    });

    const id = start.body.id;

    const bare = await post(`/api/ipsi-payment/${id}/reply`, { text: "Visa" });
    check("a bare brand is refused over HTTP too", () => {
      assert.strictEqual(bare.body.step, "card");
      assert.ok(/credit or debit/i.test(bare.body.message), bare.body.message);
    });

    const card = await post(`/api/ipsi-payment/${id}/reply`, { text: "Visa Credit" });
    check("the session persists between calls", () => {
      assert.strictEqual(card.body.step, "payer");
      assert.strictEqual(card.body.suggestion, "Isaac Gates");
    });

    const payer = await post(`/api/ipsi-payment/${id}/reply`, { text: "yes" });
    check("it stops at the confirmation, with no decision yet", () => {
      assert.strictEqual(payer.body.step, "confirm");
      assert.strictEqual(payer.body.ready, false);
      assert.strictEqual(payer.body.decision, undefined, "the decision was handed over before a human confirmed");
      assert.ok(payer.body.message.includes("1792412290cXt4Z"), payer.body.message);
    });

    const vague = await post(`/api/ipsi-payment/${id}/reply`, { text: "hmm" });
    check("an unclear confirmation does not go ready", () => {
      assert.strictEqual(vague.body.step, "confirm");
      assert.strictEqual(vague.body.ready, false);
    });

    const done = await post(`/api/ipsi-payment/${id}/reply`, { text: "yes" });
    check("an explicit yes returns the decision, once", () => {
      assert.strictEqual(done.body.step, "ready");
      assert.strictEqual(done.body.ready, true);
      assert.ok(done.body.decision && done.body.decision.receipt, "no decision on ready");
      assert.strictEqual(done.body.decision.receipt.card.number, "4242424242424242");
      assert.strictEqual(done.body.decision.receipt.payerName, "Isaac Gates");
    });

    const again = await post(`/api/ipsi-payment/${id}/reply`, { text: "yes" });
    check("a finished conversation will not issue a second receipt", () => {
      assert.strictEqual(again.body.ready, false);
      assert.strictEqual(again.body.step, "ready");
    });

    check("the audit log comes back with every turn", () => {
      assert.ok(Array.isArray(done.body.log) && done.body.log.length >= 5, "log too short");
      assert.ok(done.body.log.some((e) => e.from === "user"), "no user turns logged");
    });

    const gone = await post("/api/ipsi-payment/does-not-exist/reply", { text: "yes" });
    check("an unknown session is 404, and says what to do", () => {
      assert.strictEqual(gone.status, 404);
      assert.ok(/paste the ipsi approval again/i.test(gone.body.error), gone.body.error);
    });

    const blank = await post("/api/ipsi-payment/start", { text: "" });
    check("an empty paste asks for the booking number rather than failing", () => {
      assert.strictEqual(blank.status, 200);
      assert.strictEqual(blank.body.step, "collect");
      assert.strictEqual(blank.body.awaiting, "bookingNo");
    });

    /* ---------------- the IPSI card's "raise the receipts" plan ---------- */

    const ROWS = [
      { bookingNo: "14504", txnRef: "IP-1", amount: "145.54", cardholderName: "Spider Gray", brand: "VISA" },
      { bookingNo: "14510", txnRef: "IP-2", amount: "790.00", cardholderName: "Spider Gray", brand: "MASTERCARD" },
      { bookingNo: "", txnRef: "IP-3", amount: "10.00", cardholderName: "Spider Gray", brand: "VISA" },
    ];

    const noCard = await post("/api/ipsi-payment/plan", { rows: ROWS });
    check("the plan needs a card type, citing BR02", () => {
      assert.strictEqual(noCard.status, 400);
      assert.ok(/BR02/.test(noCard.body.error), noCard.body.error);
      assert.deepStrictEqual(noCard.body.choices, [
        "Visa Credit", "Visa Debit", "Mastercard Credit", "Mastercard Debit",
      ]);
    });

    const bareBrand = await post("/api/ipsi-payment/plan", { rows: ROWS, cardType: "Visa" });
    check("a bare brand is not a card type here either", () => {
      assert.strictEqual(bareBrand.status, 400);
    });

    const plan = await post("/api/ipsi-payment/plan", { rows: ROWS, cardType: "Visa Credit" });
    check("the plan says which rows are ready and which are not", () => {
      assert.strictEqual(plan.status, 200);
      assert.strictEqual(plan.body.cardType, "Visa Credit");
      assert.strictEqual(plan.body.ready, 1);
      assert.strictEqual(plan.body.skipped, 2);
    });

    check("a Mastercard row is skipped on a Visa run, not coerced", () => {
      const mc = plan.body.plan.find((p) => p.txnRef === "IP-2");
      assert.ok(mc.skip && /MASTERCARD/i.test(mc.skip), JSON.stringify(mc));
    });

    check("a row with no booking number is skipped with its reason", () => {
      const bad = plan.body.plan.find((p) => p.txnRef === "IP-3");
      assert.ok(bad.skip && /booking number/i.test(bad.skip), JSON.stringify(bad));
    });

    check("the plan carries NO card number anywhere", () => {
      // The whole §4 argument: the card is selected in Tramada, never typed,
      // so nothing that reaches the browser can contain a PAN.
      const flat = JSON.stringify(plan.body);
      assert.ok(!/\b\d{13,19}\b/.test(flat), "a long digit run reached the page: " + flat);
    });

    const none = await post("/api/ipsi-payment/plan", { rows: [], cardType: "Visa Credit" });
    check("an empty file is refused rather than planning nothing", () => {
      assert.strictEqual(none.status, 400);
      assert.ok(/no settlement rows/i.test(none.body.error), none.body.error);
    });

    /* ------- the shape the IPSI card really sends, end to end ----------- */

    // parseIpsiRows calls the cardholder `cardHolder`. The page mapped
    // `cardHolderName`, so every row skipped with "missing payer name (BR01)"
    // — a rule refusing a value the file was carrying all along.
    const reconCore = require("../recon-core");
    const fs = require("fs");
    const csvPath = path.join(ROOT, "csv_uploads", "ipsi-payments.csv");
    if (fs.existsSync(csvPath)) {
      const grid = reconCore.csvGrid(fs.readFileSync(csvPath, "utf8"));
      const parsed = reconCore.parseIpsiRows(grid.headers, grid.rows).rows;

      check("parseIpsiRows really carries the cardholder", () => {
        assert.ok(parsed.length, "the sample settlement file parsed to nothing");
        assert.ok(parsed[0].cardHolder, "no cardHolder on a parsed row — the field was renamed");
      });

      const asPageSends = parsed.map((r) => ({
        bookingNo: r.bookingNo || "",
        txnRef: r.reference || "",
        amount: r.amount,
        cardholderName: r.cardHolder || "",
        brand: r.cardType || r.brand || "",
      }));

      const live = await post("/api/ipsi-payment/plan", {
        rows: asPageSends,
        cardType: "Visa Credit",
      });

      check("the real settlement file plans receipts, not five skips", () => {
        assert.strictEqual(live.status, 200);
        assert.ok(live.body.ready > 0,
          "every row skipped: " + live.body.plan.map((p) => p.skip).join(" | "));
      });

      check("only the row with no booking number is skipped", () => {
        const skipped = live.body.plan.filter((p) => p.skip);
        assert.strictEqual(skipped.length, 1, JSON.stringify(skipped));
        assert.ok(/booking number/i.test(skipped[0].skip), skipped[0].skip);
      });

      check("the payer comes from the file, not from a prompt", () => {
        const ok = live.body.plan.find((p) => !p.skip);
        assert.strictEqual(ok.payerName, "Spider Gray");
      });
    }

    console.log("\n" + n + " assertions passed.");
  } catch (err) {
    console.error("\nFAILED: " + (err && err.message ? err.message : err));
    if (log) console.error("\n--- server output ---\n" + log.slice(-1500));
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
  }
})();

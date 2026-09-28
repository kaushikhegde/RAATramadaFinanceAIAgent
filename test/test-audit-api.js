"use strict";

/**
 * THE AUDIT LOG, END TO END, THROUGH THE REAL SERVER.
 *
 * `test-audit.js` proves what an event IS. This proves the wiring actually
 * runs: that a request reaching this app leaves a line, that the line carries
 * §3.1.1's where-clause filled in from the real request rather than from a
 * literal in a test, and that it lands on the volume as a file somebody can
 * hand to RAA.
 *
 * The source-shape checks in test-audit.js cannot catch a hook that is present
 * but unreachable — `if (0) req.audit(…)` reads as wired and logs nothing. Only
 * asking the running server can.
 *
 * Offline: 127.0.0.1, no DATABASE_URL, no Entra, and RECON_STORE_DIR pointed at
 * a throwaway directory so the suite never writes into the repo's own logs.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3897;
const ROOT = path.join(__dirname, "..");
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "recon-audit-"));

let n = 0;
const check = (what, fn) => { fn(); n++; console.log("  ok  " + what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: pathname, method,
      headers: {
        "User-Agent": "audit-suite/1.0",
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); }
        catch { resolve({ status: res.statusCode, body: null, raw: out }); }
      });
    });
    r.on("error", reject);
    r.end(data);
  });
}

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
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: "", NOVNC_PORT: "",
      RECON_STORE_DIR: STORE,
      // No Entra: requireAuth passes through, and every event is attributed to
      // "anonymous" — which is the honest answer for a deployment with no
      // sign-in, and the warning server.js already prints at boot.
      AZURE_TENANT_ID: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  try {
    await waitForServer(child);

    // Something to find in the log besides the read itself.
    const resolve404 = await req("POST", "/api/runs/no-such-run/resolve");
    const read = await req("GET", "/api/audit?limit=50");

    check("the log can be read back over HTTP", () => {
      assert.strictEqual(read.status, 200, JSON.stringify(read).slice(0, 300));
      assert.ok(Array.isArray(read.body.events), "no events array came back");
    });

    check("reading it left a line of its own (§3.1.1, changes to log data)", () => {
      /* The one a source-text check cannot prove: `if (0) req.audit(...)` still
         reads as wired. This asks the server. */
      const mine = read.body.events.find((e) => e.event === "audit.read");
      assert.ok(mine, "reading the audit log is not audited: " +
        read.body.events.map((e) => e.event).join(", "));
    });

    check("and that line carries §3.1.1's where-clause from the REAL request", () => {
      const mine = read.body.events.find((e) => e.event === "audit.read");
      assert.ok(mine.where, "no where-clause at all");
      assert.strictEqual(mine.where.method, "GET");
      assert.ok(String(mine.where.url).startsWith("/api/audit"), mine.where.url);
      assert.ok(mine.where.ip, "no originating address");
      assert.strictEqual(mine.where.userAgent, "audit-suite/1.0");
      assert.strictEqual(mine.where.port, PORT);
    });

    check("a 404 on a real route is recorded as a failure, not silently", () => {
      assert.strictEqual(resolve404.status, 404);
      const mine = read.body.events.find((e) => e.event === "row.resolved");
      assert.ok(mine, "nothing recorded for the resolve attempt");
      assert.strictEqual(mine.outcome, "failure");
      assert.strictEqual(mine.target, "run no-such-run");
    });

    check("every event comes back with the standard's category and risk on it", () => {
      for (const e of read.body.events) {
        assert.ok(e.category, e.event + " has no §3.1.3 category");
        assert.ok(["normal", "high", "unknown"].includes(e.risk), e.event + " risk=" + e.risk);
        assert.ok(e.at && e.user && e.target, e.event + " is missing a required field");
      }
    });

    check("the catalogue travels with the answer, so a reader needs no source", () => {
      assert.ok(read.body.catalogue && read.body.catalogue["signin.success"]);
      assert.ok(read.body.standardFields && read.body.standardFields.at);
    });

    check("newest first", () => {
      const ats = read.body.events.map((e) => e.at);
      assert.deepStrictEqual(ats, [...ats].sort().reverse());
    });

    check("the filter narrows it", () => {
      // A second read, so there are at least two audit.read lines to narrow to.
      return req("GET", "/api/audit?event=row.resolved").then((r2) => {
        assert.strictEqual(r2.status, 200);
        assert.ok(r2.body.events.every((e) => e.event === "row.resolved"),
          "the event filter let something else through");
      });
    });

    await sleep(200);

    check("it is on the volume as a file, one JSON object per line", () => {
      /* The file is the record — it has to survive a deployment with no
         DATABASE_URL, which is exactly the deployment this test runs as. */
      const dir = path.join(STORE, "logs");
      assert.ok(fs.existsSync(dir), "no logs directory was created under RECON_STORE_DIR");
      const files = fs.readdirSync(dir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      assert.ok(files.length, "no audit-YYYY-MM-DD.jsonl file: " + fs.readdirSync(dir).join(", "));
      const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
      assert.ok(lines.length >= 2, "expected at least the resolve and the read");
      for (const l of lines) {
        const o = JSON.parse(l);   // throws if a line is not one whole object
        assert.ok(o.at && o.event, "a line is missing its timestamp or type");
      }
    });

    check("nothing in the file looks like a credential", () => {
      const dir = path.join(STORE, "logs");
      const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(all), "a token reached the log file");
      assert.ok(!/"(password|secret|apiKey|authorization)"\s*:\s*"(?!\[redacted\])/i.test(all),
        "an unredacted secret-named field reached the log file");
    });

    console.log("\n  " + n + " checks passed\n");
  } catch (err) {
    console.error(err);
    console.error("\n--- server output ---\n" + log.slice(-3000));
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  }
})();

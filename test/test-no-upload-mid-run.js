/* No new file while a run is driving the browser.
 *
 * Uploading mid-run never corrupted the run itself -- a run works on the rows
 * in the frame that started it. What it did was change what the NEXT run would
 * pick up, silently, while somebody's attention was on a reconciliation in
 * progress: the file landed on a card, looked loaded, and joined whatever ran
 * next.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let n = 0, failures = 0;
const check = (what, fn) => {
  try { fn(); n++; console.log("  ✓ " + what); }
  catch (e) { failures++; console.log("  ✗ " + what + "\n      " + e.message); }
};

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const WIRE = fs.readFileSync(path.join(__dirname, "..", "design", "recon-wire.html"), "utf8");
const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const AUDIT = require("../audit.js");

function bodyOf(src, name) {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*(?:async )?function ${name}\\b`).test(l));
  assert.ok(i >= 0, `no ${name}`);
  let d = 0, started = false, j = i;
  for (; j < lines.length; j++) {
    for (const c of lines[j]) { if (c === "{") { d++; started = true; } else if (c === "}") d--; }
    if (started && d === 0) break;
  }
  return lines.slice(i, j + 1).join("\n");
}

console.log("\nthe server turns the file away");

const shut = bodyOf(SERVER, "uploadsClosed");

check("it asks the same lock the runs ask", () => {
  assert.match(shut, /runLock\.heldBy\(\)/, "it has its own idea of whether a run is going");
});

check("with no run going it lets everything through", () => {
  assert.match(shut, /if \(!by\) return null;/, "uploads could be refused when nothing is running");
});

check("the refusal names who is running it", () => {
  // "Cannot upload" with no reason reads as a broken page.
  assert.match(shut, /\$\{by\}/, "the message does not say who holds the run");
});

check("a refused upload is recorded", () => {
  assert.ok(AUDIT.EVENTS["upload.refused"], "no upload.refused event in the catalogue");
  assert.match(shut, /upload\.refused/, "nothing is written when a file is turned away");
});

console.log("\nBOTH upload paths are guarded");

/* Two messages carry files: recon_parse (every workbook, and most CSVs) and
   recon_upload (the BPay CSV, which the page parses itself). Guarding one and
   not the other leaves a door open that looks shut. */
for (const [fn, why] of [
  ["handleReconParse", "workbooks and most CSVs"],
  ["handleReconUpload", "the BPay CSV the page parses itself"],
]) {
  check(`${fn} — ${why}`, () => {
    const b = bodyOf(SERVER, fn);
    assert.match(b, /uploadsClosed\(/, `${fn} accepts files mid-run`);
  });
  check(`${fn} refuses BEFORE the bytes are kept`, () => {
    const b = bodyOf(SERVER, fn);
    const guard = b.indexOf("uploadsClosed(");
    const kept = b.indexOf("keep(session");
    if (kept >= 0) {
      assert.ok(guard < kept, `${fn} stores the file and then refuses it`);
    }
  });
}

check("nothing else calls keep() without passing the guard first", () => {
  /* keep() is what writes session.files. A third caller added later is exactly
     how this hole reopens. */
  const callers = SERVER.split("\n")
    .map((l, i) => ({ l, i }))
    .filter((x) => /(?<!function )\bkeep\(session/.test(x.l));
  assert.strictEqual(callers.length, 2,
    "keep(session, …) is called from " + callers.length + " places, not the 2 that are guarded: " +
      callers.map((c) => "server.js:" + (c.i + 1)).join(", "));
});

console.log("\nthe page says so on the card, without a round trip");

check("load() turns a file away while a run is going", () => {
  const b = bodyOf(WIRE, "load");
  assert.match(b, /if \(running\)/, "the page accepts the file and lets the server refuse it");
  assert.match(b, /reconciliation is running/, "no reason is shown on the card");
});

check("it refuses before the file is read", () => {
  const b = bodyOf(WIRE, "load");
  const guard = b.indexOf("if (running)");
  const read = b.indexOf("new FileReader()");
  assert.ok(guard > -1 && read > -1 && guard < read,
    "the file is read first — the card shows 'Reading…' for a file that is about to be refused");
});

check("the built page carries it, not just the wire", () => {
  // public/index.html is what the server serves; editing only the wire is a
  // change nobody sees.
  assert.match(PAGE, /a reconciliation is running/, "npm run build was not run");
});

console.log("\n" + (failures ? failures + " FAILED" : n + " passed, 0 failed") + "\n");
process.exit(failures ? 1 : 0);

/**
 * build-recon.js — rebuild public/index.html from the client's mockup.
 *
 *   node build-recon.js
 *
 * The reconciliation UI is recon-ui-mockup.html exactly as the client designed
 * it, plus three additions kept in recon-wire.html: the app-switcher styles,
 * the Chat / Bank statements nav, and the script that points the Sources screen
 * and the inbox table at the real run.
 *
 * It exists because the mockup is going to change again. Hand-patching a
 * 168 KB file each time is how the two drift apart and how a fix lands in one
 * copy and not the other — so the mockup stays pristine and this reapplies the
 * same three edits, or fails loudly if the anchors it needs have moved.
 */
const fs = require("fs");
const path = require("path");

const MOCKUP = path.join(__dirname, "recon-ui-mockup.html");
const WIRE = path.join(__dirname, "recon-wire.html");
const OUT = path.join(__dirname, "public", "index.html");

const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

let mock, wire;
try { mock = fs.readFileSync(MOCKUP, "utf8"); } catch { die(`Can't read ${path.basename(MOCKUP)}.`); }
try { wire = fs.readFileSync(WIRE, "utf8"); } catch { die(`Can't read ${path.basename(WIRE)}.`); }

const part = (name) => {
  const a = wire.indexOf(`<!--@${name}-->`);
  if (a < 0) die(`${path.basename(WIRE)} has no <!--@${name}--> block.`);
  const rest = wire.slice(a + `<!--@${name}-->`.length);
  const next = rest.search(/<!--@[A-Z]+-->/);
  return next < 0 ? rest : rest.slice(0, next);
};

// Anchors. If the mockup is restructured these throw rather than producing a
// page that is silently missing its nav or its wiring.
const anchors = [
  ["</style>", "the mockup has no </style> to put the switcher styles before"],
  ["</body>", "the mockup has no </body> to append the wiring to"],
  ["</title>", "the mockup has no </title> to put the favicon link after"],
];
for (const [a, why] of anchors) if (!mock.includes(a)) die(why);

/**
 * THE MOCKUP'S OWN SCRIPT IS TURNED OFF.
 *
 * It is not a styling prototype, it is a working demo with its own brain:
 * ~90 KB of state, an UPLOADS store, a source-type detector, and — fatally —
 * `document.addEventListener('click' …)` and `…('change' …)` delegates that
 * catch every event in the page.
 *
 * So the two scripts fought, and the demo won the arguments that mattered.
 * Uploading one CSV made it show five reports (Westpac, Mint, BPay, passenger
 * refunds, Nuve) because its `ingest()` ran alongside the real one and rebuilt
 * the tile grid from its own fixtures; its "Process all" button did nothing
 * because the real run is not what it calls. Cloning #filePicker and #startRun
 * to strip their listeners could never have fixed this — a delegate on
 * `document` is not attached to the node.
 *
 * Changing the type attribute leaves the source in the file, exactly as the
 * client wrote it, and stops the browser executing it. The handful of things it
 * did that the page genuinely needs — screen navigation, mainly — are
 * reimplemented in recon-wire.html against real data.
 */
const scripts = (mock.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length;
if (!scripts) die("the mockup has no inline <script> — has it been restructured?");
mock = mock.replace(/<script(?![^>]*\bsrc=)([^>]*)>/g,
  '<script type="text/x-mockup-demo"$1><!-- disabled by build-recon.js: see the note in that file -->');

/**
 * REPLACEMENTS ARE FUNCTIONS, NOT STRINGS, AND THAT IS NOT A STYLE CHOICE.
 *
 * `String.replace(needle, str)` interprets `$` sequences in `str`: `$&` is the
 * match, `` $` `` is everything before it, and **`$'` is everything after it**.
 * The wiring contains `return '$' + n.toFixed(2)` — a dollar sign in a quoted
 * string, which is `$'` to that parser. So the built page got the whole tail of
 * the document spliced into the middle of a JS string literal:
 *
 *     return '
 *     </html>
 *      + n.toFixed(2)...
 *
 * The wiring script then failed to parse and the page did nothing. Nothing in
 * the source looked wrong, and it only bit money formatting because that is
 * where the first `$` happened to land — any future `$` in the wiring would do
 * the same. A replacer FUNCTION is handed the match and returns a literal
 * string; no `$` in it means anything.
 */
let out = mock;

/* THE FAVICON, and the tab's own title.
   Added by the build rather than typed into the mockup, for the same reason
   everything else here is: the client sends a new mockup and anything typed
   into the old one goes with it. Straight after </title> so it is in the head
   and the browser has it before the page paints — injecting it from the wiring
   script would show the default page icon first and then swap it.

   The title loses "— UI Mockup", because it is not one any more and that is
   what a person reads in a tab strip of twenty. */
out = out.replace(/<title>[^<]*<\/title>/, () =>
  '<title>RAA Travel · Reconciliation Agent</title>\n' +
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n' +
  '<link rel="apple-touch-icon" href="/favicon.svg">');

out = out.replace("</style>", () => part("CSS") + "</style>");

// No NAV block: the app switcher belonged to a two-page app. This one has a
// single page, and recon-wire.html hides the header outright.

out = out.replace("</body>", () => part("SCRIPT") + "\n</body>");

// The hooks the wiring reaches for. Missing one means the mockup was
// restructured and the wiring needs revisiting — better said now than found by
// an agent whose upload does nothing.
const HOOKS = ["filePicker", "startRun", "stmtDate", "readyNote", "tileGrid",
  "detectPanel", "triagePane", "inboxGrid", "ibTitle", "ibLede", "ibActions", "s-sources"];
const missing = HOOKS.filter((id) => !mock.includes(`id="${id}"`));
if (missing.length) {
  console.error(`\n  ⚠ the mockup no longer has: ${missing.join(", ")}`);
  console.error("    The wiring reaches for these — check recon-wire.html before shipping.\n");
}

// Navigation is reimplemented in the wiring now that the demo script is off, so
// these are load-bearing in a way ids alone don't capture. Without data-go the
// sidebar stops switching screens and the page looks frozen on Run overview.
const NAV = [
  ["data-go=", "no [data-go] buttons — the sidebar would not switch screens"],
  ['id="topTitle"', "no #topTitle — the top bar would keep whatever it shipped with"],
  ['class="screen', "no .screen sections — nothing to show or hide"],
];
for (const [needle, why] of NAV) if (!mock.includes(needle)) console.error(`\n  ⚠ ${why}\n`);

/**
 * ── the built page checks itself before it is written ────────────────────────
 *
 * A build that silently produces a broken page is worse than one that fails:
 * the file looks the right size, opens, renders the design, and simply does
 * nothing. That is what shipped when `$'` ate the document tail — and it was
 * invisible here because the container's copy was assembled a different way.
 *
 * So: the wiring that ends up in the FILE has to parse as JavaScript, and the
 * document has to still be one document.
 */
const vm = require("vm");

const wireStart = out.indexOf("LIVE WIRING");
if (wireStart < 0) die("the wiring block is not in the output at all.");
const openTag = out.indexOf("<script>", wireStart);
const closeTag = out.indexOf("</script>", openTag);
if (openTag < 0 || closeTag < 0) die("the wiring block has no <script>…</script> in the output.");
try {
  new vm.Script(out.slice(openTag + "<script>".length, closeTag));
} catch (err) {
  die(`the wiring does not parse in the built page: ${err.message}\n` +
      "  This is what a $-pattern in a String.replace() replacement looks like — see the note above.");
}

for (const [tag, want] of [["</body>", 1], ["</html>", 1]]) {
  const n = (out.match(new RegExp(tag.replace("/", "\\/"), "g")) || []).length;
  if (n !== want) die(`the built page has ${n} ${tag} (expected ${want}) — something spliced the document.`);
}
if (out.indexOf("LIVE WIRING") > out.indexOf("</body>")) {
  die("the wiring landed after </body> — it would not run.");
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`\n  public/index.html ← ${path.basename(MOCKUP)} (${mock.length} bytes) + ${path.basename(WIRE)}`);
console.log(`  ${scripts} mockup script${scripts === 1 ? "" : "s"} disabled; the wiring drives the page.`);
console.log(`  ${out.length} bytes written.${missing.length ? "  (with warnings above)" : ""}\n`);

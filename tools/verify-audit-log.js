#!/usr/bin/env node
"use strict";

/**
 * Check the audit log has not been tampered with.
 *
 * RAA Logging and Monitoring Standard v1.1 §3.1.1 — "Direct changes made to log
 * data must be captured." Every line carries the hash of the one before it, so
 * an edited, deleted or reordered line breaks the chain at exactly the point it
 * happened. This walks the files and says whether it does, and where.
 *
 *   npm run audit:verify
 *   npm run audit:verify -- --dir /data/logs
 *   npm run audit:verify -- --day 2026-09-28
 *
 * Exit code 0 when every file verifies, 1 when one does not — so it can sit in
 * a cron or a health check and mean something.
 *
 * WHAT THIS IS NOT: proof. Anyone who can write to the volume could recompute
 * the whole chain from the line they changed onwards. It is a tripwire, and it
 * catches the realistic case — somebody opening one file and deleting one line
 * — not a patient attacker with write access and this repo open.
 */

const fs = require("fs");
const path = require("path");
const audit = require("../audit");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DIR = path.resolve(argOf("--dir",
  path.join(process.env.RECON_STORE_DIR || path.join(__dirname, ".."), "logs")));
const DAY = argOf("--day", null);

if (!fs.existsSync(DIR)) {
  console.error(`No log directory at ${DIR}.`);
  console.error("Point it at the volume with --dir, or set RECON_STORE_DIR.");
  process.exit(1);
}

const files = fs.readdirSync(DIR)
  .filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .filter((f) => !DAY || f.includes(DAY))
  .sort();

if (!files.length) {
  console.error(`No audit files in ${DIR}${DAY ? ` for ${DAY}` : ""}.`);
  process.exit(1);
}

console.log(`\nChecking ${files.length} file${files.length === 1 ? "" : "s"} in ${DIR}\n`);

let bad = 0;
let totalLines = 0;
/* The chain runs ACROSS files — a day's file starts wherever the last one
   ended — so the tail of one is checked against the head of the next. Checking
   each file on its own would miss a whole day deleted. */
let carried = null;

for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), "utf8").trim();
  const lines = [];
  let parseError = null;
  raw.split("\n").filter(Boolean).forEach((l, i) => {
    try { lines.push(JSON.parse(l)); }
    catch (err) { if (!parseError) parseError = `line ${i + 1} is not one whole JSON object`; }
  });

  if (parseError) {
    console.log(`  ✗ ${f} — ${parseError}`);
    bad++;
    carried = null;
    continue;
  }

  const run = carried ? [carried, ...lines] : lines;
  const result = audit.verifyChain(run);
  totalLines += lines.length;

  if (result.ok) {
    console.log(`  ✓ ${f} — ${lines.length} line${lines.length === 1 ? "" : "s"}, chain intact`);
    carried = lines.length ? lines[lines.length - 1] : carried;
  } else {
    // The index is into `run`, which may carry one line from the file before.
    const atLine = carried ? result.index : result.index + 1;
    const WHY = {
      edited: "a line does not hash to its own recorded hash — its contents were changed",
      deleted: "the link to the previous line is broken — a line was removed",
      reordered: "the sequence number did not go up by one — lines were reordered",
      unsealed: "a line carries no hash (written before the chain existed, or stripped)",
    };
    console.log(`  ✗ ${f} — line ${atLine}: ${WHY[result.reason] || result.reason}`);
    if (result.line) {
      console.log(`      ${result.line.at || "?"}  ${result.line.event || "?"}  ${result.line.user || "?"}`);
    }
    bad++;
    carried = null;   // everything after a break is unverifiable against what came before
  }
}

console.log(
  `\n${bad ? `  ${bad} file${bad === 1 ? "" : "s"} FAILED` : `  all ${files.length} verified`}` +
  ` · ${totalLines} line${totalLines === 1 ? "" : "s"} checked\n`
);
process.exit(bad ? 1 : 0);

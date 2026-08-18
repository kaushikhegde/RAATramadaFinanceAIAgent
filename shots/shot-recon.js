/**
 * shot-recon.js — photograph the page, with no run and no server.
 *
 *   node shot-recon.js
 *
 * Opens `public/index.html` straight off disk, loads a CSV into the BPay card
 * and photographs each screen. It answers one question: does the page still
 * look right after a rebuild?
 *
 * The mockup changes; screens come and go. `shot-recon-run.js` and
 * `shot-mint-run.js` photograph runs in progress. This one is the cheap check
 * that nothing fell over.
 */
const fs = require("fs");
const path = require("path");

/* Screenshots land in shots/out/, never the repo root. A bare relative path in
   page.screenshot() resolves against cwd, not against this file, which is how a
   dozen PNGs ended up sitting beside server.js. */
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => path.join(OUT, name);
const { chromium } = require("playwright");

// The sample statement lines, with a booking number filled in so every row
// parses. The file ships with that column blank on purpose.
const CSV = fs.readFileSync(path.join(__dirname, "..", "fixtures", "tramada-statement-lines.csv"), "utf8")
  .replace(/,\s*$/gm, ",13201");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto("file://" + path.join(__dirname, "..", "public/index.html"));
  await page.waitForTimeout(500);

  const csvPath = path.join(require("os").tmpdir(), "shot-recon.csv");
  fs.writeFileSync(csvPath, CSV);
  await page.evaluate(() => document.querySelector('[data-choose="bpay"]').click());
  await page.locator("#filePicker").setInputFiles(csvPath);
  await page.waitForTimeout(600);

  for (const [screen, file] of [["inbox", "recon-inbox.png"], ["sources", "recon-sources.png"], ["overview", "recon-overview.png"]]) {
    await page.evaluate((s) => document.querySelector(`.nav-item[data-go="${s}"]`).click(), screen);
    await page.waitForTimeout(350);
    await page.screenshot({ path: shot(file) });
    console.log("wrote shots/out/" + file);
  }

  // The header is hidden in this project and the unwired screens are marked.
  // Both are easy to lose in a rebuild and neither shows up in a node test.
  const checks = await page.evaluate(() => ({
    headerHidden: !document.querySelector("header.top") ||
      getComputedStyle(document.querySelector("header.top")).display === "none",
    sampleMarkers: document.querySelectorAll(".sample-tag").length,
    screens: [...document.querySelectorAll("section.screen")].map((s) => s.id),
  }));
  console.log(JSON.stringify(checks));
  if (!checks.headerHidden) console.error("⚠ the header is showing — recon-wire.html should hide it");
  if (!checks.sampleMarkers) console.error("⚠ no sample-data markers — unwired screens would read as real");

  await browser.close();
})();

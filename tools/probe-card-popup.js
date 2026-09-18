/**
 * probe-card-popup.js — READ-ONLY. Opens the Issue Debtor Payment Receipt form,
 * chooses Credit Card Swipe, clicks "Add", and prints every control on whatever
 * window that opens. Fills nothing, saves nothing, issues nothing.
 *
 *   node tools/probe-card-popup.js 13061
 *
 * Why: the Add form is opened with window.open, so it is a separate browser
 * window. `enterNewBookingCard` looks for a card-number field by a list of
 * candidate ids; when none of them is right the run stops with nothing useful
 * to say. This asks the page instead of guessing again.
 *
 * Paste the output back — the ids are what the wiring needs.
 */
require("dotenv").config();
const { chromium } = require("playwright");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP = `http://${process.env.CDP_HOST || "127.0.0.1"}:${process.env.CDP_PORT || "9222"}`;
const bookingNo = process.argv[2] || "13061";
const line = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ids, names and labels only — never values. This page may hold a PAN. */
async function describe(ctx, what) {
  const rows = await ctx.evaluate(() => {
    const labelFor = (n) => {
      if (n.id) {
        const l = document.querySelector(`label[for="${CSS.escape(n.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const td = n.closest("td");
      const prev = td && td.previousElementSibling;
      return prev ? prev.textContent.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    };
    const out = [];
    document.querySelectorAll("input, select, textarea, button").forEach((n) => {
      const id = n.id || "";
      const nm = n.getAttribute("name") || "";
      if (!id && !nm) return;
      const kind = n.tagName.toLowerCase() + (n.type ? `[${n.type}]` : "");
      let opts = "";
      if (n.tagName === "SELECT") {
        opts = "\n        OPTS: " + [...n.options].map((o) => `${o.value}=${o.text.trim()}`).join(" | ").slice(0, 400);
      }
      const safe = /button|submit|reset/.test(n.type || "") ? ` "${n.value || n.textContent.trim()}"` : "";
      out.push(`  ${kind.padEnd(16)} #${id.padEnd(28)} name=${nm}${safe}   <- ${labelFor(n)}${opts}`);
    });
    return out;
  });
  line(`\n=== ${what} (${rows.length} controls) ===`);
  rows.forEach(line);
}

(async () => {
  line(`Connecting to Chrome on ${CDP} …`);
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  await page.goto(`${BASE}/booking/booking-receipts.htm?mode=edit&id=${bookingNo}`, {
    waitUntil: "domcontentloaded",
  });
  if (/login/i.test(await page.title())) {
    line("\nThat Chrome is signed out of Tramada. Sign in, then run this again.");
    await page.close();
    process.exit(2);
  }

  await page.selectOption("#receiptCategory", "DEBTOR_PAYMENT_RECEIPT").catch(() => {});
  await sleep(500);
  await page.click('input[value="Add / Issue Receipt"]');
  await page.waitForSelector("#receipttransactionTypeCode", { timeout: 20000 });

  // The Credit Card Details block only exists once the type is a card type.
  await page.selectOption("#receipttransactionTypeCode", "CS");
  await sleep(1500);
  line("\nTransaction type set to CS (Credit Card Swipe).");

  const cards = await page
    .$$eval("#receiptcreditCard option", (os) => os.map((o) => `${o.value} = ${o.text.trim()}`))
    .catch(() => []);
  line("\n=== #receiptcreditCard already offers ===");
  cards.forEach((c) => line("  " + c));

  const before = new Set(context.pages());
  line("\nClicking #addCreditCardButton …");

  let popup = null;
  try {
    [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 8000 }),
      page.click("#addCreditCardButton"),
    ]);
    line("  the popup event fired.");
  } catch {
    line("  no popup event — looking for a new window instead.");
  }

  if (!popup) {
    for (let i = 0; i < 12 && !popup; i++) {
      const fresh = context.pages().filter((p) => !before.has(p));
      if (fresh.length) {
        popup = fresh[fresh.length - 1];
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        line("  found a new window by comparing context.pages().");
      }
      if (!popup) await sleep(500);
    }
  }

  line("\nPages now open in this context:");
  for (const p of context.pages()) line("  " + p.url());

  if (popup) {
    line("\nCard form URL: " + popup.url());
    await describe(popup, "Add Credit Card window");
    await popup.close().catch(() => {});
  } else {
    line("\nNo new window appeared at all. Checking this page and its frames:");
    await describe(page, "receipt form");
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      await describe(f, "frame " + f.url().slice(-60)).catch(() => {});
    }
  }

  line("\nRead-only probe finished. Nothing was filled, nothing was issued.");
  await page.close();
  await browser.close().catch(() => {});
})().catch((e) => {
  console.error("\nProbe failed: " + (e && e.message ? e.message : e));
  process.exit(1);
});

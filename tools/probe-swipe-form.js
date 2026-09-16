/**
 * probe-swipe-form.js — READ-ONLY. Opens the booking's Issue Receipt form as a
 * Credit Card Swipe and prints every control on it, plus the Add-Credit-Card
 * popup's controls. Never fills an amount, never clicks Issue/Save, never
 * enters a card number.
 *
 *   node tools/probe-swipe-form.js 13061
 *
 * Why: "Payments Guide - IPSI.docx" BR03 requires three fields to be set —
 * Transaction Type, Bank Account and Received From. `openReceiptForm` only
 * sets the first. The other two have no known selectors, and guessing a
 * selector for "which bank account does this money land in" is how you file a
 * receipt into the wrong account and find out at reconciliation. So ask the
 * page.
 *
 * Paste the whole output back; the ids are what the wiring needs.
 */
require("dotenv").config();
const { chromium } = require("playwright");

const BASE = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP = `http://${process.env.CDP_HOST || "127.0.0.1"}:${process.env.CDP_PORT || "9222"}`;
const bookingNo = process.argv[2] || "13061";
const line = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ids/names/labels only — never values. The page may hold a PAN. */
async function describe(ctx, what) {
  const rows = await ctx.evaluate(() => {
    const labelFor = (n) => {
      if (n.id) {
        const l = document.querySelector(`label[for="${CSS.escape(n.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const p = n.closest("td");
      const prev = p && p.previousElementSibling;
      return prev ? prev.textContent.trim().slice(0, 40) : "";
    };
    const out = [];
    document.querySelectorAll("input, select, textarea").forEach((n) => {
      const id = n.id || "";
      const nm = n.getAttribute("name") || "";
      if (!id && !nm) return;
      const kind = n.tagName.toLowerCase() + (n.type ? `[${n.type}]` : "");
      let opts = "";
      if (n.tagName === "SELECT") {
        opts =
          "  options: " +
          [...n.options].map((o) => `${o.value}=${o.text.trim()}`).join(" | ").slice(0, 400);
      }
      // A button's value is its label and is safe; a text input's is not.
      const safeVal = /button|submit|reset/.test(n.type || "") ? ` "${n.value}"` : "";
      out.push(`  ${kind.padEnd(16)} #${id.padEnd(30)} name=${nm}${safeVal}   ← ${labelFor(n)}${opts}`);
    });
    return out;
  });
  line(`\n=== ${what} (${rows.length} controls) ===`);
  rows.forEach(line);
}

(async () => {
  line(`Connecting to Chrome on ${CDP} …`);
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  await page.goto(`${BASE}/booking/booking-receipts.htm?mode=edit&id=${bookingNo}`, {
    waitUntil: "domcontentloaded",
  });

  if (/login/i.test(await page.title())) {
    line("\nThat Chrome is signed out of Tramada. Sign in, then run this again.");
    await page.close();
    process.exit(2);
  }

  // What receipt categories does THIS booking offer? (account-type dependent)
  const cats = await page
    .$$eval("#receiptCategory option", (os) => os.map((o) => `${o.value} = ${o.text.trim()}`))
    .catch(() => []);
  line(`\n=== booking ${bookingNo} — #receiptCategory offers ===`);
  cats.forEach((c) => line("  " + c));

  await page.waitForSelector('input[value="Add / Issue Receipt"]', { timeout: 15000 });
  await page.click('input[value="Add / Issue Receipt"]');
  await page.waitForSelector("#receipttransactionTypeCode", { timeout: 20000 });

  const txns = await page.$$eval("#receipttransactionTypeCode option", (os) =>
    os.map((o) => `${o.value} = ${o.text.trim()}`)
  );
  line("\n=== #receipttransactionTypeCode offers ===");
  txns.forEach((t) => line("  " + t));

  const swipe = txns.find((t) => /swipe/i.test(t));
  if (swipe) {
    await page.selectOption("#receipttransactionTypeCode", swipe.split(" = ")[0]);
    await sleep(1200);
    line(`\nSelected "${swipe}" — the form may have revealed more fields.`);
  } else {
    line("\nNo Credit Card Swipe option on this form. That is itself the answer.");
  }

  await describe(page, "receipt form, after choosing the transaction type");

  // The Add Credit Card popup — we open it to read the ids, fill nothing.
  const addSel = await (async () => {
    for (const s of ["#receiptaddCreditCardButton", 'input[value="Add"]', 'input[value="Add "]']) {
      if (await page.locator(s).count().catch(() => 0)) return s;
    }
    return null;
  })();

  if (!addSel) {
    line("\nNo 'Add' credit-card button found on this form.");
  } else {
    let popup = null;
    try {
      [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 8000 }), page.click(addSel)]);
    } catch {
      popup = null;
    }
    await sleep(1500);
    const target =
      popup || page.frames().find((f) => f !== page.mainFrame() && /card/i.test(f.url())) || page;
    await describe(target, `Add Credit Card form (${popup ? "popup" : "same page / frame"})`);
    if (popup) await popup.close().catch(() => {});
  }

  line("\nRead-only probe finished. Nothing was filled, nothing was issued.");
  await page.close();
  await browser.close().catch(() => {});
})().catch((e) => {
  console.error("\nProbe failed: " + (e && e.message ? e.message : e));
  process.exit(1);
});

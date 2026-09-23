"use strict";

/**
 * tramada-agency-cc.js — "Issue Agency Credit Card Transaction" on a booking.
 *
 * This is how a DVC charge gets INTO Tramada. The consultant pays the supplier
 * with a Westpac DVC virtual card; Tramada records that as an Agency CC receipt
 * on the booking — "a payment to the creditor by using an agency credit card",
 * in the form's own help text — and that transaction is what later appears on
 * Finance → Payments → Issue Payment → Agency CC Reimbursement, waiting for the
 * trust account to reimburse the card (docs/dvc.md steps 12-17).
 *
 * Nothing in the reconciliation calls this. It exists for
 * `tools/make-dvc-bookings.js`, because until it did the sandbox had no Agency
 * CC transactions at all and the Issue Payment grid came back empty — steps
 * 14-16 had never had a row to act on.
 *
 * Mapped read-only 23-09-2026 on booking 15593:
 *
 *   booking-receipts.htm?mode=edit&id={no}
 *     #receiptCategory  AGENCY_CC_CLIENT_PAYMENT_RECEIPT (retail booking) or
 *                       AGENCY_CC_DEBTOR_PAYMENT_RECEIPT (corporate booking) —
 *                       whichever the booking's account type offers (§4d)
 *     input[value="Add / Issue Receipt"]
 *   booking-client-payment-receipt.htm?...&isAgencyCreditCardReceipt=true
 *     #receipttransactionTypeCode  AG = Agency Credit Card   (the only option)
 *     #receiptagencyBankAccount    1 = [TRUST] Trust Account
 *     #creditor                    creditors on this booking's segments only
 *     #receiptcreditCard           5255 = 555003....0457 CA - A - Westpac DVC VCC
 *     #receiptpayerName #receiptdateReceived #receiptreceiptAmount
 *     #receiptreferenceNumber #receiptcreditCardAuthNumber
 *     Segments To Allocate: D | Seg. Type | Debtor Invoice No. | Reference |
 *       Debtor Receipted | Creditor Due | Creditor Paid | Balance Due | Allocate | A
 *     #useEmail (NEVER ticked) #preview #issue
 *
 * ── The card is a LABEL ─────────────────────────────────────────────────────
 *
 * Chosen from Tramada's own dropdown by its masked label and nothing else.
 * `core.assertCardLabel` refuses anything shaped like a PAN before the browser
 * opens (CLAUDE.md §4) — there is no card number anywhere in this file.
 */

require("dotenv").config();
const core = require("./recon-core");
const screen = require("./tramada-issue-payments");
const { ensureLoggedIn } = require("./tramada-auth");
const { readBookingReceipts } = require("./tramada-receipt");

const { TRAMADA_BASE_URL, sleep, clean } = screen;

const F = Object.freeze({
  category: "#receiptCategory",
  add: 'input[value="Add / Issue Receipt"]',
  txnType: "#receipttransactionTypeCode",
  bank: "#receiptagencyBankAccount",
  creditor: "#creditor",
  card: "#receiptcreditCard",
  auth: "#receiptcreditCardAuthNumber",
  payer: "#receiptpayerName",
  date: "#receiptdateReceived",
  amount: "#receiptreceiptAmount",
  reference: "#receiptreferenceNumber",
  useEmail: "#useEmail",
  issue: "#issue",
});

/**
 * Segments To Allocate, BY HEADER NAME.
 *
 * Not the receipt form's columns: this grid has Creditor Due / Creditor Paid /
 * Balance Due where the client receipt has Debtor Invoiced / Debtor Due, so
 * `tramada-receipt.readAllocatableSegments`, which counts to cells[7], would
 * read the wrong figure here without any error.
 */
async function readAgencySegments(page) {
  const grid = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    for (const t of document.querySelectorAll("table")) {
      const head = [...t.querySelectorAll("tr")].find((tr) =>
        /balance\s*due/i.test(tr.textContent) && /seg\.?\s*type/i.test(tr.textContent) &&
        !tr.querySelector("table"));
      if (!head) continue;
      const headers = [...head.children].map((c) => norm(c.textContent));
      const rows = [...t.querySelectorAll('input[id^="allocationAmount_"]')].map((inp) => {
        const tr = inp.closest("tr");
        return {
          segId: inp.id.replace("allocationAmount_", ""),
          cells: tr ? [...tr.children].map((c) => norm(c.textContent)) : [],
        };
      });
      return { headers, rows };
    }
    return { headers: [], rows: [] };
  });
  const cols = core.mapColumns(grid.headers, {
    segType: ["seg. type", "seg type"],
    reference: ["reference"],
    creditorDue: ["creditor due"],
    creditorPaid: ["creditor paid"],
    balanceDue: ["balance due"],
  });
  return {
    headers: grid.headers,
    rows: grid.rows.map((r) => {
      const at = (k) => (cols[k] >= 0 ? r.cells[cols[k]] || "" : "");
      return {
        segId: r.segId,
        segType: at("segType"),
        reference: at("reference"),
        creditorDue: at("creditorDue"),
        balanceDue: at("balanceDue"),
        balanceCents: core.cents(at("balanceDue")),
      };
    }),
  };
}

/** Type, then read back. A field that does not keep a value is a stop, never a shrug. */
async function typeAndCheck(page, selector, value, label) {
  await page.fill(selector, "").catch(() => {});
  await page.fill(selector, String(value));
  await page.locator(selector).press("Tab").catch(() => {});
  await sleep(250);
  const got = (await page.inputValue(selector).catch(() => "")).trim();
  if (got !== String(value).trim()) {
    throw new Error(`${label} did not stick: typed "${value}", the form reads "${got}". Nothing was issued.`);
  }
}

async function chooseByLabel(page, selector, wanted, label) {
  const offered = await screen.optionsOf(page, selector);
  const chosen = core.resolveSelectOption(offered, wanted, null);
  if (chosen.value == null) {
    throw new Error(`${label} does not offer "${wanted}"` +
      (chosen.ambiguous ? " (more than one option matched)" : "") +
      `. It offered: ${offered.map((o) => clean(o.text) || "(blank)").join(" | ")}`);
  }
  await page.selectOption(selector, chosen.value);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);
  const got = await page.inputValue(selector).catch(() => "");
  if (got !== chosen.value) throw new Error(`${label} did not stick: set "${chosen.value}", reads "${got}".`);
  return chosen;
}

/**
 * Record one Agency CC transaction against one booking's segment.
 *
 * `amount: "AUTO"` pays the segment's Balance Due as the form states it —
 * the figure this fixture then writes into both CSVs, so what the Westpac
 * report says the card was charged is what Tramada holds, to the cent (§3).
 */
async function runAgencyCcTransaction({
  bookingNo, creditor, cardLabel, amount = "AUTO", reference, dateReceived,
  payerName, segType = "", dryRun = false, callbacks = {},
} = {}) {
  const say = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo is required.");
  if (!creditor) throw new Error("creditor is required — the form only offers ones on this booking.");
  if (!reference) throw new Error("reference is required.");
  const card = core.assertCardLabel(cardLabel, "Credit Card");
  if (!card) throw new Error("cardLabel is required — the DVC card's label as Tramada's dropdown shows it.");

  const browser = await screen.openBrowser((p, m) => say(m));
  let page;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    /* A confirm() on Issue is Tramada asking whether to go ahead with what
       this function has already decided and verified; anything else it says
       is written down so a surprise is visible in the output. */
    page.on("dialog", (d) => { say(`Tramada asked: "${clean(d.message())}" — accepted.`); d.accept().catch(() => {}); });
    await ensureLoggedIn(page, { onNeedLogin: callbacks.onNeedLogin, onProgress: say });

    const listUrl = `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(F.add, { timeout: 15000 });

    /* ALREADY DONE IS DONE. Re-running the fixture after a failure further on
       must not charge the card twice for one segment — the Reimbursement grid
       would then carry two rows the Westpac file has one line for. */
    const before = await readBookingReceipts(page);
    const dup = before.find((r) => clean(r.reference) === String(reference));
    if (dup) {
      say(`Booking ${bookingNo} already has ${dup.receiptNo} under reference ${reference} — not raising it again.`);
      ok = true;
      return { already: true, receipt: dup, amount: dup.amount };
    }

    const cats = await screen.optionsOf(page, F.category);
    const agency = cats.find((o) => /^AGENCY_CC_/.test(o.value));
    if (!agency) {
      throw new Error(`Booking ${bookingNo} offers no Agency CC receipt category. It offered: ` +
        cats.map((o) => clean(o.text)).join(" | "));
    }
    await page.selectOption(F.category, agency.value);
    await sleep(400);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.click(F.add)]);
    await page.waitForSelector(F.txnType, { timeout: 20000 });
    if (!/isAgencyCreditCardReceipt=true/i.test(page.url()) &&
        (await page.inputValue(F.txnType).catch(() => "")) !== "AG") {
      throw new Error("The form that opened is not the Agency Credit Card transaction form.");
    }

    if ((await page.inputValue(F.txnType)) !== "AG") await page.selectOption(F.txnType, "AG");
    await chooseByLabel(page, F.bank, "Trust Account", "Bank Account");
    const chosenCreditor = await chooseByLabel(page, F.creditor, creditor, "Creditor");
    const chosenCard = await chooseByLabel(page, F.card, card, "Credit Card");
    say(`Creditor ${chosenCreditor.text}, card ${chosenCard.text}.`);

    const segs = await readAgencySegments(page);
    if (!segs.rows.length) {
      throw new Error(`Nothing to allocate on booking ${bookingNo} for ${chosenCreditor.text} ` +
        `(Segments To Allocate headers: ${segs.headers.join(" | ") || "none"}).`);
    }
    /* ONE ROW, CHOSEN BY WHAT IT IS. Measured 23-09-2026 on booking 15920: a
       flight + ticket costing + hotel booking lists TWO rows under its airline
       creditor on this form, and the fixture pays the ticket alone. `segType`
       names the row this charge is for; the charge still refuses unless
       exactly one row is that type, so a Westpac line and a grid row stay
       one-to-one. */
    const candidates = segType
      ? segs.rows.filter((r) => String(r.segType).toUpperCase() === String(segType).toUpperCase())
      : segs.rows;
    if (candidates.length !== 1) {
      throw new Error(`Booking ${bookingNo} has ${candidates.length} ${segType || ""} row(s) for ` +
        `${chosenCreditor.text} (the form lists: ${segs.rows.map((r) => `${r.segType || "?"} ` +
        `${r.reference || ""} $${r.balanceDue}`).join("; ") || "nothing"}); this pays exactly one, so ` +
        "the Westpac line and the grid row stay one-to-one.");
    }
    const seg = candidates[0];
    const payCents = /^auto$/i.test(String(amount)) ? seg.balanceCents : core.cents(amount);
    if (!payCents) throw new Error(`Booking ${bookingNo}'s segment has no balance due (${seg.balanceDue}).`);
    const payAmount = core.money(payCents);

    await typeAndCheck(page, F.payer, payerName || chosenCreditor.text.replace(/^\[[^\]]*\]\s*/, "").slice(0, 40), "Payer Name");
    await typeAndCheck(page, F.date, core.toTramadaDate(dateReceived || new Date().toISOString().slice(0, 10)), "Date Received");
    await typeAndCheck(page, F.amount, payAmount, "Amount Received");
    await typeAndCheck(page, F.reference, reference, "Reference");

    /* Tick the row with a REAL click, then prove the amount box came alive
       holding the balance: the row's click handler is what enables and fills
       it, exactly as on the client receipt form (field map §4b). */
    const row = page.locator(`tr:has(#allocationAmount_${seg.segId})`).first();
    await row.locator('input[type="checkbox"]').first().check();
    const box = page.locator(`#allocationAmount_${seg.segId}`);
    for (let i = 0; i < 20 && !(await box.isEditable().catch(() => false)); i++) await sleep(250);
    let got = core.cents(await box.inputValue().catch(() => ""));
    if (got !== payCents) {
      await box.click({ clickCount: 3 });
      await box.pressSequentially(payAmount, { delay: 30 });
      await box.press("Tab").catch(() => {});
      await sleep(300);
      got = core.cents(await box.inputValue().catch(() => ""));
    }
    if (got !== payCents) {
      throw new Error(`The allocation on segment ${seg.segId} reads $${core.money(got || 0)}, ` +
        `not the $${payAmount} being charged. Nothing was issued.`);
    }

    if (await page.locator(F.useEmail).isChecked().catch(() => false)) {
      throw new Error("The email box on this form is ticked — refusing to issue and mail a supplier.");
    }

    const staged = { bookingNo: String(bookingNo), creditor: chosenCreditor.text, card: chosenCard.text,
      amount: payAmount, reference: String(reference), segment: seg };
    if (dryRun) {
      say(`Staged $${payAmount} on ${chosenCard.text} — dry run, nothing issued.`);
      ok = true;
      return { staged, committed: false };
    }

    await page.click(F.issue);
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      if (/booking-receipts\.htm/i.test(page.url())) break;
      const banner = await screen.errorBanner(page);
      if (banner) throw new Error(`Tramada refused the Agency CC transaction: ${banner}`);
      // Issue is NOT pressed again while waiting: a slow server is not a
      // reason to charge the card twice.
    }

    /* Confirmed by what the receipts list SAYS, never by the URL (§6). */
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await sleep(800);
    const after = await readBookingReceipts(page);
    const mine = after.find((r) => clean(r.reference) === String(reference) &&
      core.cents(r.amount) === payCents);
    if (!mine) {
      throw new Error(`Issued, but booking ${bookingNo}'s receipts list shows no ${reference} for $${payAmount}. ` +
        "Look at the booking before running this again.");
    }
    say(`${mine.receiptNo} — $${payAmount} on ${chosenCard.text} to ${chosenCreditor.text}.`);
    ok = true;
    return { staged, receipt: mine, amount: payAmount, committed: true };
  } catch (err) {
    if (callbacks.onError) callbacks.onError(err.message);
    throw err;
  } finally {
    // CLOSE ON SUCCESS, LEAVE IT OPEN ON FAILURE (§5).
    if (ok && page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { runAgencyCcTransaction, readAgencySegments };

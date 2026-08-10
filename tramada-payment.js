/**
 * tramada-payment.js — raise a CREDITOR PAYMENT against a booking.
 *
 * Companion to tramada-receipt.js. Where that takes money IN from a client,
 * this pays money OUT to a creditor:
 *
 *   Booking Payments  →  Add / Issue Payment
 *     -> pick the creditor
 *       -> fill EFT / date / amount / reference
 *         -> tick the segments to allocate against
 *           -> Issue -> read the new Payment No. back and CHECK it is ours
 *
 * ── The client pays first ────────────────────────────────────────────────────
 *
 * A costed segment is NOT payable to the creditor until the client's receipt
 * has been taken and allocated against it. Money in before money out — an
 * agency cannot pay a supplier out of money it has not received. On a booking
 * that has only been costed, Segments To Allocate comes back completely empty
 * while `#creditor` still offers the creditor, which reads as a broken selector
 * and is not one. `readPayableSegments` says so in those words now.
 *
 * Mapped live 10-08-2026 against booking 13175 on raatravelsandbox; the field
 * map's "The creditor payment form" section is what came off that page.
 *
 * ── This is the one that moves money OUT ─────────────────────────────────────
 *
 * A receipt that goes wrong leaves money sitting unallocated. A payment that
 * goes wrong has left the trust account. So everything here is verified rather
 * than assumed: the creditor stuck, the allocation stuck, and the payment that
 * came back is the one we filed and not somebody else's.
 *
 * ── The remittance email is never sent ───────────────────────────────────────
 *
 * The form carries an email block — `#useEmail`, `#documentType` = "Remittance
 * Plus Allocation" — which mails the creditor when it is ticked. It ships
 * UNTICKED and nothing here ticks it. A fixture script that emails a real
 * supplier a remittance for money it invented would be a genuinely bad day, and
 * "we only fill what we mean to fill" is cheaper than an apology.
 */

const { chromium } = require("playwright");
const core = require("./recon-core");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The whole vocabulary — the form offers exactly these two, where the receipt
// form offers five. Cash and cards do not pay creditors.
const TXN_TYPE = { CHEQUE: "CQ", EFT: "ET" };

function resolveTxnType(t) {
  const raw = String(t || "EFT").toUpperCase().replace(/[\s-]+/g, "_");
  if (TXN_TYPE[raw]) return TXN_TYPE[raw];
  if (Object.values(TXN_TYPE).includes(raw)) return raw;
  if (/CHEQUE|CHECK|CQ/.test(raw)) return TXN_TYPE.CHEQUE;
  return TXN_TYPE.EFT;
}

/* ── the browser ─────────────────────────────────────────────────────────── */

async function openBrowser() {
  try {
    return await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
  } catch (err) {
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
      `Run "npm run start:chrome" and sign into Tramada in that window. [${err.message}]`
    );
  }
}

async function tramadaIsAuthed(page) {
  await page.goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" }).catch(() => {});
  return !page.url().includes("login.htm");
}

/** The human signs in. We wait, we never type credentials (CLAUDE.md §5). */
async function ensureLoggedIn(page, onNeedLogin) {
  if (await tramadaIsAuthed(page)) return;
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await tramadaIsAuthed(page)) return;
  }
  throw new Error("Timed out waiting for a Tramada login.");
}

/* ── the form ────────────────────────────────────────────────────────────── */

/**
 * The "Segments To Allocate" table, read BY HEADER NAME.
 *
 * The columns here are NOT the receipt form's:
 *
 *   receipt   D | Seg. Type | Invoice No. | Reference | Creditor ID |
 *             Debtor Invoiced | Debtor Receipted | Debtor Due | Allocate | A
 *   payment   D | Seg. Type | Reference | Creditor ID |
 *             Creditor Nett | Creditor Paid | Creditor Payable | Allocate | A
 *
 * Payable is index 6 where Due is index 7, because the payment form has no
 * Invoice No. column. `tramada-receipt.js` hardcodes its index and this project
 * has been bitten twice by exactly that, so this one asks the header — the same
 * rule the CSV, the workbook and both grids already follow.
 */
const SEGMENT_COLUMNS = {
  segType: ["seg. type", "seg type"],
  reference: ["reference"],
  creditorId: ["creditor id"],
  nett: ["creditor nett"],
  paid: ["creditor paid"],
  payable: ["creditor payable"],
};

async function readPayableSegments(page, creditor) {
  const grid = await page.evaluate(() => {
    const txt = (n) => (n.textContent || "").replace(/\s+/g, " ").trim();
    const rows = [];
    let headers = [];
    document.querySelectorAll('input[id^="allocationAmount_"]').forEach((inp) => {
      const tr = inp.closest("tr");
      if (!tr) return;
      if (!headers.length) {
        /* The header row, looked for in the row's own table FIRST and then
           anywhere on the page. Tramada grids sometimes put the header in a
           separate table from the body, and the old version only ever looked
           in `tr.closest("table")` — where it finds nothing it reported "no
           Creditor Payable column", which is a different and much more
           alarming statement than "I looked in the wrong table". */
        const scopes = [tr.closest("table"), document].filter(Boolean);
        for (const scope of scopes) {
          const head = [...scope.querySelectorAll("tr")]
            .find((r) => /creditor\s*payable/i.test(r.textContent));
          if (head) { headers = [...head.children].map(txt); break; }
        }
      }
      rows.push({ segId: inp.id.replace("allocationAmount_", ""), cells: [...tr.children].map(txt) });
    });
    return { headers, rows };
  });

  /* NO ROWS is not a missing column, and saying so cost a real debugging
     session. A costed segment only becomes payable to the creditor once the
     client's receipt has been taken and allocated against it — money in before
     money out. Until then this table is empty, and the creditor dropdown still
     lists the creditor, which is what makes it look like a selector fault. */
  if (!grid.rows.length) {
    throw new Error(
      `The payment form has no segments to allocate${creditor ? ` for ${creditor}` : ""}. ` +
      `Nothing is payable yet — a segment becomes payable only after the client's ` +
      `receipt has been taken and allocated against it. Raise the receipt first.`
    );
  }

  const cols = core.mapColumns(grid.headers, SEGMENT_COLUMNS);
  if (cols.payable < 0) {
    throw new Error(
      `The payment form's segment table has no "Creditor Payable" column ` +
      `(headers: ${grid.headers.join(" | ") || "(no header row found anywhere on the page)"}). ` +
      `It has ${grid.rows.length} row(s) that look like: ${JSON.stringify(grid.rows[0].cells)}. ` +
      `Refusing to guess which one holds the money.`
    );
  }
  return grid.rows.map((r) => ({
    segId: r.segId,
    segType: cols.segType >= 0 ? r.cells[cols.segType] : "",
    reference: cols.reference >= 0 ? r.cells[cols.reference] : "",
    creditorId: cols.creditorId >= 0 ? r.cells[cols.creditorId] : "",
    payable: r.cells[cols.payable] || "",
    payableCents: core.cents(r.cells[cols.payable]),
  }));
}

/**
 * Choose the creditor, and WAIT — picking one reloads the segment table.
 *
 * Only creditors with something payable on this booking are offered, so a
 * creditor that is not in the list is a real answer ("nothing is owed to them
 * here"), not a selector problem. Say which ones there were.
 */
async function chooseCreditor(page, wanted) {
  const options = await page.locator("#creditor option").evaluateAll((ns) =>
    ns.map((n) => ({ value: n.value, label: (n.textContent || "").trim() })).filter((o) => o.value));
  const w = String(wanted || "").trim().toLowerCase();
  const hit = options.find((o) => o.label.toLowerCase() === w)
    || options.find((o) => o.label.toLowerCase().startsWith(w))
    || options.find((o) => o.label.toLowerCase().includes(w))
    || options.find((o) => o.value.toLowerCase() === w);
  if (!hit) {
    throw new Error(
      `"${wanted}" is not a creditor this booking owes. It offers: ${options.map((o) => o.label).join(", ") || "(none)"}`
    );
  }
  await page.selectOption("#creditor", hit.value);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);

  const stuck = await page.evaluate(() => {
    const el = document.querySelector("#creditor");
    return el ? (el.options[el.selectedIndex] || {}).text || "" : "";
  }).catch(() => "");
  if (!stuck.trim()) throw new Error(`The creditor did not stick (the form reads "${stuck}").`);
  return { value: hit.value, label: hit.label, stuck: stuck.trim() };
}

/**
 * Fill a field with real keystrokes.
 *
 * Triple-click to clear rather than Control+A — that is Cmd+A on a Mac, so the
 * selection never happens and the typed figure lands beside the old one. Same
 * lesson as the allocation box and the statement balances.
 */
async function typeInto(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.click({ clickCount: 3 });
  await el.pressSequentially(String(value), { delay: 30 });
  await el.press("Tab").catch(() => {});
  await sleep(150);
}

/**
 * Tick the segments and type what goes against each.
 *
 * ORDER MATTERS, exactly as on the receipt form: the allocation box ships
 * `disabled readonly` and it is the row checkbox's own handler that enables it.
 * Typing first means clicking a permanently disabled input.
 */
async function allocate(page, allocation, segments) {
  if (Array.isArray(allocation) && !allocation.length) return [];
  if (!segments.length) throw new Error("The payment form has no payable segments to allocate against.");

  const list = allocation === "ALL"
    ? segments.filter((s) => (s.payableCents || 0) > 0).map((s) => ({ segId: s.segId, amount: core.money(s.payableCents) }))
    : allocation;

  const done = [];
  for (const a of list) {
    const seg = segments.find((s) => s.segId === String(a.segId));
    if (!seg) throw new Error(`Segment ${a.segId} is not on the payment form any more.`);

    const row = page.locator(`tr:has(#allocationAmount_${seg.segId})`).first();
    const cb = row.locator('input[name="segmentsToAllocate"]').first();
    if (await cb.count()) await cb.check();

    const box = page.locator(`#allocationAmount_${seg.segId}`);
    await box.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    if (!(await box.isEditable().catch(() => false))) {
      throw new Error(`The allocation box for segment ${seg.segId} never became editable.`);
    }
    await box.click({ clickCount: 3 });
    await box.pressSequentially(String(a.amount), { delay: 30 });
    await box.press("Tab").catch(() => {});
    await sleep(250);

    const got = await box.inputValue().catch(() => "");
    if (core.cents(got) !== core.cents(a.amount)) {
      throw new Error(`Tramada didn't keep the allocation ${a.amount} on segment ${seg.segId} (it reads "${got}").`);
    }
    done.push({ segId: seg.segId, amount: a.amount });
  }
  return done;
}

/**
 * The payment that was just issued — and a check that it is OURS.
 *
 * `tramada-receipt.js` takes the top `R.` row and trusts it. That is the second
 * finding in CODE-REVIEW.md: the list's sort order is not documented anywhere,
 * so on a booking with earlier payments the top row can be somebody else's, and
 * the run would adopt its number and report success. This one reads the whole
 * list and finds the row whose reference AND amount are the ones just filed.
 */
async function findIssuedPayment(page, { reference, amountCents }) {
  const rows = await page.evaluate(() => {
    const table = [...document.querySelectorAll("table")]
      .find((t) => /Payment\s*No/i.test(t.textContent));
    if (!table) return [];
    const trs = [...table.querySelectorAll("tr")];
    const head = trs.find((r) => /Payment\s*No/i.test(r.textContent));
    return trs.filter((r) => r !== head)
      .map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.replace(/\s+/g, " ").trim()))
      .filter((c) => c.length >= 8);
  });

  // Action | Payment No. | Category | Type | Trans. Type | Paid To | Reference | Date | Amount
  const found = rows
    .map((c) => ({
      paymentNo: c[1], category: c[2], paymentType: c[3], transType: c[4],
      paidTo: c[5], reference: c[6], date: c[7], amount: c[8],
    }))
    .filter((p) => /^P\./i.test(p.paymentNo || ""))
    .find((p) => core.refKey(p.reference) === core.refKey(reference)
      && core.cents(p.amount) === amountCents);

  if (!found) {
    const seen = rows.map((c) => `${c[1]} ${c[6]} ${c[8]}`).join(" | ");
    throw new Error(
      `The payment was not created, or not the one we filed — no row on the payments list has ` +
      `reference "${reference}" at $${core.money(amountCents)}. The list holds: ${seen || "(nothing)"}`
    );
  }
  return found;
}

/* ── the orchestrator ────────────────────────────────────────────────────── */

/**
 * Raise (and issue) a creditor payment against a booking.
 *
 * @param {object} args
 *   bookingNo   the booking to pay from
 *   creditor    the creditor's name as the form spells it, e.g. "READY ROOMS"
 *   payment     { transactionType?, amount, reference, paymentDate?, payeeName?,
 *                 allocation? }  allocation defaults to "ALL"
 *                 amount may be "AUTO" — pay whatever the form's Creditor
 *                 Payable rows add up to, rather than a figure worked out
 *                 beforehand that has to stay in step with them
 *   dryRun      fill and Preview, never Issue
 * @returns {Promise<{segments, staged, payment?, committed}>}
 */
async function runCreditorPayment({
  bookingNo,
  creditor,
  payment = {},
  dryRun = false,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo is required.");
  if (!creditor) throw new Error("creditor is required — the form only offers ones this booking owes.");
  if (!payment.reference) throw new Error("payment.reference is required.");
  /* "AUTO" = pay what the form says is payable.
     The receipt side of this project lost three live receipts to a figure
     worked out from a JSON fixture rather than from Tramada — Select All
     allocated more than the amount and every receipt was refused. A payment
     allocated with "ALL" has exactly the same failure mode, so the caller is
     allowed to stop guessing: the amount is read off the form, below, once the
     payable rows are known. */
  const AUTO = /^auto$/i.test(String(payment.amount || "").trim());
  let amountCents = AUTO ? null : core.cents(payment.amount);
  if (!AUTO && amountCents == null) {
    throw new Error(`payment.amount "${payment.amount}" could not be read as an amount.`);
  }

  const browser = await openBrowser();
  let page;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, callbacks.onNeedLogin);

    onProgress(20, `Opening the payments list for booking ${bookingNo}…`);
    await page.goto(
      `${TRAMADA_BASE_URL}/booking/booking-payments.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
      { waitUntil: "domcontentloaded" });
    // The button flow, not the form URL — the same "proven path" rule the
    // receipt module follows, and for the same reason.
    await page.waitForSelector("#add", { timeout: 15000 });
    await page.click("#add");
    await page.waitForSelector("#paymenttransactionTypeCode", { timeout: 20000 });

    onProgress(40, `Choosing ${creditor}…`);
    const txn = resolveTxnType(payment.transactionType);
    await page.selectOption("#paymenttransactionTypeCode", txn);
    await sleep(500);
    const chosen = await chooseCreditor(page, creditor);

    const segments = await readPayableSegments(page, `${creditor} on booking ${bookingNo}`);
    if (!segments.length) {
      throw new Error(
        `Booking ${bookingNo} has nothing payable to ${creditor} — take the client's ` +
        `receipt first, then pay the creditor.`
      );
    }

    const payableCents = segments.reduce((a, s) => a + (s.payableCents || 0), 0);
    if (AUTO) {
      if (!payableCents) {
        throw new Error(
          `Booking ${bookingNo} owes ${creditor} nothing — every Creditor Payable row reads 0.00.`
        );
      }
      amountCents = payableCents;
      onProgress(55, `The form says $${core.money(payableCents)} is payable — paying that.`);
    } else if ((payment.allocation || "ALL") === "ALL" && payableCents > amountCents) {
      // Refused here, not by Tramada after Issue. "ALL" allocates every payable
      // row in full, so a payment smaller than their total cannot be filed —
      // and the server's answer to that is a banner on a page that no longer
      // shows the rows.
      throw new Error(
        `Allocation cannot be greater than the payment: this payment is for ` +
        `$${core.money(amountCents)} but ${segments.length} payable row(s) total ` +
        `$${core.money(payableCents)}. Pay the full $${core.money(payableCents)} (or pass ` +
        `amount:"AUTO"), or allocate explicitly instead of "ALL". Nothing was issued.`
      );
    }

    onProgress(60, "Filling the payment…");
    await typeInto(page, "#paymentpayeeName", payment.payeeName || chosen.label.replace(/\s*\([^)]*\)\s*$/, ""));
    await typeInto(page, "#paymentpaymentDate", core.toTramadaDate(payment.paymentDate || ""));
    await typeInto(page, "#paymentpaymentAmount", core.money(amountCents));
    await typeInto(page, "#paymentreferenceNumber", payment.reference);
    /* Read it back, before Issue.
       `findIssuedPayment` looks the payment up by reference AND amount. A field
       that truncates or rewrites what was typed still lets the payment go out —
       real money leaves the trust account — and only the confirmation fails,
       reporting the payment as missing rather than as renamed. */
    const backRef = await page.inputValue("#paymentreferenceNumber").catch(() => null);
    if (backRef != null && backRef !== String(payment.reference)) {
      throw new Error(
        `The payment reference did not stick: typed "${payment.reference}", the form reads ` +
        `"${backRef}"` +
        (backRef.length < String(payment.reference).length ? " (truncated — use a shorter reference)" : "") +
        ". Nothing was issued."
      );
    }

    onProgress(70, "Allocating…");
    const allocated = await allocate(page, payment.allocation || "ALL", segments);

    const staged = {
      bookingNo: String(bookingNo),
      creditor: chosen.label,
      transactionType: txn,
      amount: core.money(amountCents),
      reference: String(payment.reference),
      allocated,
      segments,
    };

    if (dryRun) {
      onProgress(90, "Preview only — nothing was issued.");
      await page.click("#preview").catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(1200);
      ok = true;
      return { segments, staged, committed: false };
    }

    onProgress(85, "Issuing the payment…");
    // The email block is left exactly as it shipped — unticked. Issuing must
    // not mail a remittance to a real supplier.
    await page.click("#issue");
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      if (/booking-payments\.htm/i.test(page.url())) break;
      if (/error page/i.test((await page.title().catch(() => "")) || "")) {
        throw new Error("Tramada returned a server error page after Issue.");
      }
      const errs = await page.evaluate(() => [...new Set(
        [...document.querySelectorAll("a, span, li, font, div")]
          .filter((n) => !n.children.length)
          .map((n) => (n.textContent || "").trim())
          .filter((t) => t && t.length < 200 && /must be|is required|is invalid|cannot be/i.test(t))
      )].slice(0, 8)).catch(() => []);
      if (errs.length) throw new Error(`Payment rejected: ${errs.join("; ")}`);
      // NOTE: Issue is deliberately NOT re-clicked while waiting. On the receipt
      // form that retry can file the same money twice (CODE-REVIEW.md §1); a
      // slow server is not a reason to pay a creditor again.
    }

    if (!page.url().includes("booking-payments")) {
      await page.goto(
        `${TRAMADA_BASE_URL}/booking/booking-payments.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
        { waitUntil: "domcontentloaded" });
      await sleep(800);
    }
    const issued = await findIssuedPayment(page, { reference: payment.reference, amountCents });
    onProgress(100, `Payment ${issued.paymentNo} issued.`);
    ok = true;
    return { segments, staged, payment: issued, committed: true };
  } catch (err) {
    if (callbacks.onError) callbacks.onError(err.message);
    throw err;
  } finally {
    // On failure leave the tab open so the form stays inspectable.
    try { if (page && ok) await page.close(); } catch { /* already gone */ }
    try { await browser.close(); } catch { /* CDP: drops the connection only */ }
  }
}

module.exports = {
  runCreditorPayment, readPayableSegments, resolveTxnType, SEGMENT_COLUMNS, TXN_TYPE,
  // For probe-payment-form.js, so the probe drives the REAL code rather than a
  // copy of it. A probe that reimplements the thing it is probing can succeed
  // exactly where the real path fails, which is worse than no probe.
  openBrowser, ensureLoggedIn, chooseCreditor, TRAMADA_BASE_URL,
};

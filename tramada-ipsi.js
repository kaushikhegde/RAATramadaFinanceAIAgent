/**
 * tramada-ipsi.js — the IPSI merchant settlement, over the browser.
 *
 * Unlike every other report here, IPSI never touches a bank statement page. It
 * walks Tramada's Finance Receipts screens, ticks receipts that ALREADY EXIST,
 * and issues one Finance Merchant Payment Receipt covering them:
 *
 *   finance-receipts.htm        → "Issue Receipt" → Continue
 *     -> finance-receipts-issue.htm   fill the search, Go
 *       -> A NEW WINDOW opens: finance-merchant-payment-receipt.htm
 *         -> its URL is taken, loaded in THIS tab, and the window closed
 *           -> tick the matched rows -> Amount Received -> Issue
 *
 * ── Why the window is left behind ────────────────────────────────────────────
 *
 * Go really does open a window — `pop-up.js` calls window.open — and it is slow:
 * a fresh window painting from nothing, with every later step waiting on it.
 * The only thing it has that cannot be got any other way is its URL, which
 * carries the `dataContainerId` the server made for this search. That id is
 * why navigating straight to the form used to end at an Error Page. With it,
 * the form loads in an ordinary tab.
 *
 * So the URL is taken as soon as the navigation COMMITS — not when the window
 * has finished painting, which is where the time goes — loaded here, and the
 * window closed. The form is confirmed in this tab BEFORE the window is closed,
 * and if it does not appear the window is kept and used exactly as before.
 * `IPSI_KEEP_POPUP=true` switches the whole thing off.
 *
 * Every selector below was measured live on 10-08-2026; see the field map's
 * "The IPSI flow" section. Three of them would have been got wrong by guessing,
 * and each has a comment saying so.
 */

const { chromium } = require("playwright");
const core = require("./recon-core");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ── the Debtor Code autocomplete ────────────────────────────────────────── */

/**
 * Type into Tramada's autocomplete and take the suggestion.
 *
 * Three things measured the hard way, all on 10-08-2026:
 *
 *   1. It ignores the native value setter. Setting `.value` and dispatching
 *      `input` — the reactSet approach the rest of this project uses — leaves
 *      the field reading "Master" and NO list at all. Real keystrokes only.
 *   2. The typed text can be TRUNCATED. Six keystrokes once left `Mas` in the
 *      box, because every character fires a DWR lookup that rewrites the input.
 *      So the typed value is read back before the suggestion is taken.
 *   3. There is NO hidden code field. The form posts this visible text
 *      verbatim — a failed submit was seen posting `debtor=Mas`, answered with
 *      "Debtor Code must be entered". Whatever is in the box is the search.
 *
 * The list itself does have a stable hook, unlike the segment forms' widget:
 * `#{fieldId}_auto_complete_div`, and the highlighted row carries `.selected`.
 */
async function fillAutocomplete(page, fieldId, text, expect) {
  const field = page.locator(`#${fieldId}`);
  await field.click({ clickCount: 3 });
  await field.pressSequentially(String(text), { delay: 80 });

  const typed = await field.inputValue();
  if (typed !== String(text)) {
    throw new Error(
      `The ${fieldId} field only kept "${typed}" of "${text}" — its per-keystroke lookup ate the rest. ` +
      "Nothing was searched; retry rather than searching on a partial code."
    );
  }

  const list = page.locator(`#${fieldId}_auto_complete_div li`);
  await list.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  if (!(await list.count())) {
    throw new Error(`Typing "${text}" into ${fieldId} produced no suggestions.`);
  }
  const wanted = expect
    ? list.filter({ hasText: expect }).first()
    : list.first();
  if (!(await wanted.count())) {
    const offered = await list.allTextContents();
    throw new Error(`No suggestion for ${fieldId} matched "${expect}". It offered: ${offered.join(" | ")}`);
  }
  await wanted.click();
  await sleep(600);

  const settled = await field.inputValue();
  if (expect && !settled.includes(expect)) {
    throw new Error(`The ${fieldId} field reads "${settled}" after picking the suggestion, not "${expect}".`);
  }
  return settled;
}

/* ── the search, and the window it opens ─────────────────────────────────── */

/** The merchant receipt form's own route, wherever it is opened. */
const RECEIPT_FORM_URL = /finance-merchant-payment-receipt/i;

/**
 * How long Go is given to open its window.
 *
 * It used to be 30s, and 30s is not enough: the run stopped with
 *
 *     page.waitForEvent: Timeout 30000ms exceeded while waiting for event "popup"
 *
 * and the window then opened a moment later, orphaned — the wait had already
 * given up. The time is not the window painting, it is the SEARCH: Tramada
 * posts the form, works through the ledger, and only then calls window.open.
 * A wide date range on a busy debtor takes as long as it takes.
 *
 * So the default is three minutes, and it is tunable. Waiting longer costs
 * nothing; giving up early throws away a search that was going to succeed and
 * leaves a window nobody is holding.
 */
const POPUP_TIMEOUT_MS = parseInt(process.env.IPSI_POPUP_TIMEOUT_MS || "180000", 10);

/**
 * Which of the newly-opened windows is the one we want.
 *
 * Pure, and separate, because this runs against the human's OWN Chrome. A tab
 * they open while the search is running is a new page too, and adopting it
 * would drive the rest of the run against whatever they happened to be
 * reading. So: a window already showing the receipt form always wins; failing
 * that, exactly ONE new window is taken (it may still be blank and about to
 * navigate); two or more unidentifiable ones are not guessed between.
 *
 * @param {{url:string, closed?:boolean}[]} fresh  windows that were not there before
 * @returns {number} index into `fresh`, or -1
 */
function chooseWindow(fresh) {
  const live = (fresh || []).map((p, i) => ({ ...p, i })).filter((p) => !p.closed);
  const onForm = live.filter((p) => RECEIPT_FORM_URL.test(String(p.url || "")));
  if (onForm.length) return onForm[0].i;
  return live.length === 1 ? live[0].i : -1;
}

/**
 * Click Go and hand back the window it opens — however long that takes.
 *
 * The listeners go on BEFORE the click, and the poll runs alongside them, so a
 * window that opens between the two is still caught. `page.waitForEvent` alone
 * was both too short and too narrow: it only hears popups attributed to this
 * page, and it throws rather than returning, so the window that arrived one
 * second late was lost rather than used.
 */
async function waitForReceiptWindow(page, act, say = () => {}) {
  const ctx = page.context();
  const before = new Set(ctx.pages());
  const opened = [];
  const note = (p) => { if (!before.has(p) && !opened.includes(p)) opened.push(p); };
  ctx.on("page", note);
  page.on("popup", note);

  try {
    await act();
    const started = Date.now();
    let told = 0;
    for (;;) {
      for (const p of ctx.pages()) note(p);
      const pick = chooseWindow(opened.map((p) => ({ url: p.url(), closed: p.isClosed() })));
      if (pick >= 0) return opened[pick];

      const waited = Math.round((Date.now() - started) / 1000);
      if (waited >= POPUP_TIMEOUT_MS / 1000) return null;
      // Said out loud, because a silent wait of minutes reads as a hang and
      // this one is expected to be long.
      if (waited >= told + 15) {
        told = waited;
        say(`Still waiting for the receipt window — ${waited}s so far. The search is what takes the time.`);
      }
      await sleep(500);
    }
  } finally {
    ctx.off("page", note);
    page.off("popup", note);
  }
}

/**
 * Is the window's URL worth loading in this tab instead?
 *
 * Pure, so the branch that decides whether to leave the popup can be tested
 * without opening one. The rules, and why each is here:
 *
 *   - it has to BE the merchant receipt form. A popup still showing
 *     `about:blank`, or one that landed somewhere else, is not something to
 *     navigate to — that is a fallback, not a failure.
 *   - `dataContainerId` is the whole reason this works. The server makes a
 *     container for the search and the URL names it; without one, going
 *     straight to the form is the navigation that ends at an Error Page. A URL
 *     missing it is still tried — the fallback is right there — but it is said
 *     out loud first, because that is the thing to look at when it fails.
 */
function popupTarget(url) {
  const u = String(url || "");
  if (!RECEIPT_FORM_URL.test(u)) {
    return {
      relocate: false, url: u,
      warn: u && !/^about:/.test(u)
        ? `The window went to ${u.split("?")[0]}, not the merchant receipt form — using the window itself.`
        : "The window has not reached the merchant receipt form — using the window itself.",
    };
  }
  return {
    relocate: true, url: u,
    warn: /dataContainerId=/i.test(u) ? null
      : "The window's URL carries no dataContainerId — trying it in this tab anyway.",
  };
}

/**
 * Fill the Issue Receipts search, press Go, and hand back THE PAGE THE FORM IS
 * ON — this tab when the popup could be left behind, the popup itself when it
 * could not. Every step after this takes whichever it is.
 *
 * **THE DEBTOR IS FILLED LAST, AND THAT IS THE WHOLE TRICK.** Changing
 * `#receiptType`, `#agencyBankAccount` or `#sortOrder` CLEARS `#debtor` —
 * measured: the field read `[MASTER] [] MasterCard/Visa/Debit`, three selects
 * were set, and it read `""`. Fill it first and Go answers "Debtor Code must be
 * entered" while the form still looks complete.
 *
 * `#goButton` disables itself once clicked, so there is no retrying it in
 * place: a second attempt means reloading the search form and filling it again.
 */
/**
 * How far back the receipt search reaches, in days before the To date.
 *
 * The From date was left EMPTY, which on this screen means "everything up to
 * the To date" — every swipe receipt ever raised for that debtor, fetched and
 * rendered before anything could be ticked. That is most of why Go took long
 * enough to time out the window it opens.
 *
 * Two days rather than one: a receipt raised late in the evening settles the
 * next day, and a Monday run has a weekend behind it. `IPSI_FROM_DAYS` widens
 * or narrows it without touching this file.
 */
const IPSI_FROM_DAYS = parseInt(process.env.IPSI_FROM_DAYS || "2", 10);

async function searchIssueReceipts(page, {
  debtorCode = "MASTER",
  debtorLabel = "MasterCard/Visa/Debit",
  receiptType = "FINANCE_MERCHANT_PAYMENT_RECEIPT",
  bankAccount = "1",
  fromDate = "",
  toDate = "",
} = {}, say = () => {}) {
  /* From = To minus two days, unless the caller named one. An unreadable To
     date leaves From empty rather than inventing a range — see core.daysBefore. */
  const from = fromDate || core.daysBefore(toDate, IPSI_FROM_DAYS);
  say("Opening Finance → Receipts…");
  await page.goto(`${TRAMADA_BASE_URL}/finance/finance-receipts.htm?mode=edit&id=1`,
    { waitUntil: "domcontentloaded" });
  // "Search" is checked on load, so the issue radio has to be set explicitly.
  await page.waitForSelector("#form_selection_issue", { timeout: 20000 });
  await page.check("#form_selection_issue");
  await page.click("#form_continueButton");
  await page.waitForSelector("#goButton", { timeout: 20000 });

  // 1-4: the selects and the dates. Every one of these wipes the debtor, which
  // is why not one of them happens after it.
  await page.selectOption("#receiptType", receiptType);
  await page.selectOption("#agencyBankAccount", bankAccount);
  await page.selectOption("#sortOrder", "DESCENDING");   // it defaults to ASCENDING
  const typeDate = async (sel, v) => {
    if (!v) return;
    const el = page.locator(sel);
    await el.click({ clickCount: 3 });
    await el.pressSequentially(core.toTramadaDate(v), { delay: 40 });
  };
  await typeDate("#fromTransactionDate", from);
  await typeDate("#toTransactionDate", toDate);
  if (from || toDate) {
    say(`Receipts from ${from ? core.toTramadaDate(from) : "the beginning"} to ` +
      `${toDate ? core.toTramadaDate(toDate) : "today"}.`);
  }

  // 5: the debtor, LAST.
  say(`Choosing the debtor ${debtorCode}…`);
  await fillAutocomplete(page, "debtor", debtorCode, debtorLabel);

  // 6: read back everything the form would post, before committing to it. A
  // silently-emptied debtor searches the wrong ledger rather than failing.
  const posting = await page.evaluate(() => {
    const f = document.forms.form;
    const out = {};
    for (const n of f.elements) {
      if (/^(debtor|receiptType|agencyBankAccount|sortOrder|toTransactionDate)$/.test(n.name)) out[n.name] = n.value;
    }
    return out;
  });
  if (!posting.debtor || !posting.debtor.toUpperCase().includes(debtorCode.toUpperCase())) {
    throw new Error(
      `The Debtor Code did not survive the rest of the form — it would post "${posting.debtor}". ` +
      "The selects clear it; it has to be filled last."
    );
  }
  if (posting.receiptType !== receiptType) {
    throw new Error(`Receipt Category reads "${posting.receiptType}", not ${receiptType}.`);
  }

  /* Go opens A NEW WINDOW — not a tab, not this page. `pop-up.js` calls
     window.open, and a window that opens with nothing listening is simply lost:
     every selector after it would run against the search page, find nothing,
     and look exactly like an empty result set. Catch it AS it opens. */
  say("Searching… Go can take a while to open the receipt window.");
  const popup = await waitForReceiptWindow(page, () => page.click("#goButton"), say);
  if (!popup) {
    throw new Error(
      `Go was clicked but no window opened within ${Math.round(POPUP_TIMEOUT_MS / 1000)}s. ` +
      "The search itself is what takes the time — Tramada posts the form, works, and only then " +
      "calls window.open — so this is a search that ran long, not a broken selector. " +
      "Raise IPSI_POPUP_TIMEOUT_MS, or narrow the date range so there is less to fetch."
    );
  }

  /* ── OUT OF THE POPUP, INTO THIS TAB ─────────────────────────────────────
   *
   * The popup is slow — a fresh window painting from nothing — and every step
   * after this waits on it. But the only thing it has that cannot be got any
   * other way is its URL, which carries the `dataContainerId` the server just
   * made for this search:
   *
   *   finance/finance-merchant-payment-receipt.htm?…&dataContainerId=161&…
   *
   * That id is why navigating straight to the form used to end at an Error
   * Page — there was no container to show. With it, the form loads anywhere in
   * the same session. So take the URL, load it HERE, and drop the window.
   *
   * The URL is waited for, not the load: `waitForURL` resolves when the
   * navigation COMMITS, long before the window has finished painting, and that
   * is where the time goes.
   *
   * ORDER MATTERS. The form is confirmed in this tab BEFORE the popup is
   * closed, and if it never appears the popup is kept and used exactly as it
   * always was. Closing first would leave nothing to fall back to.
   *
   * IPSI_KEEP_POPUP=true switches this off and works in the window. */
  const keepPopup = process.env.IPSI_KEEP_POPUP === "true";
  if (!keepPopup) {
    // Same budget as opening it. A window that took two minutes to appear is
    // not going to settle its URL in one.
    await popup.waitForURL(RECEIPT_FORM_URL, { timeout: POPUP_TIMEOUT_MS }).catch(() => {});
    const target = popupTarget(popup.url());
    if (target.warn) say(target.warn, false);
    if (target.relocate) {
      try {
        await page.goto(target.url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#issue", { timeout: 20000 });
        if (!/error page/i.test((await page.title().catch(() => "")) || "")) {
          await popup.close().catch(() => {});
          say("Merchant receipt form opened in this tab — the popup window is closed.");
          return page;
        }
        say("That URL came back as an Error Page here — using the popup window.", false);
      } catch (err) {
        say(`The form would not open in this tab (${core.tidyError(err.message)}) — using the popup window.`, false);
      }
    }
  }

  // The popup, exactly as it has always worked.
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);

  if (/error page/i.test((await popup.title().catch(() => "")) || "")) {
    throw new Error("Tramada returned an Error Page instead of the merchant receipt window.");
  }
  if (!(await popup.locator("#issue").count())) {
    throw new Error(
      `The window that opened is not the merchant receipt form (it is "${await popup.title().catch(() => "?")}").`
    );
  }
  return popup;
}

/* ── the receipts waiting to be reconciled ───────────────────────────────── */

const RECEIPT_COLUMNS = {
  receiptNo: ["receipt no.", "receipt no"],
  bookingNo: ["booking no.", "booking no"],
  dateReceived: ["date received"],
  cardHolder: ["card holder"],
  reference: ["reference"],
  receivedFrom: ["received from"],
  receiptAmount: ["receipt amount"],
  dueAmount: ["due amount"],
};

/**
 * The "Receipts To Reconcile" rows, each with the handle needed to tick it.
 *
 * **The row checkbox has no id and no name.** Its whole attribute list is
 * `type, data-fn-click, value`, and the `value` is the receipt's internal
 * record id — NOT the receipt number. That value is the only handle on a row,
 * so it is read here alongside the text.
 *
 * Columns are read by header name, as everywhere else. There are two tables on
 * this page and only one of them is receipts; the other is Payments To
 * Reconcile, which is where a refund would live and which an IPSI run does not
 * touch.
 */
async function readReceiptsToReconcile(popup) {
  const grid = await popup.evaluate(() => {
    const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const table = [...document.querySelectorAll("table")]
      .find((t) => /Receipt\s*No/i.test(t.textContent) && /Received From/i.test(t.textContent));
    if (!table) return { headers: [], rows: [], ids: [] };
    const trs = [...table.querySelectorAll("tr")];
    const head = trs.find((r) => /Receipt\s*No/i.test(r.textContent));
    const body = trs.filter((r) => r !== head && r.querySelectorAll("td").length > 2);
    return {
      headers: head ? [...head.children].map((c) => clean(c.textContent)) : [],
      rows: body.map((r) => [...r.children].map((c) => clean(c.textContent))),
      ids: body.map((r) => {
        const cb = r.querySelector('input[type="checkbox"]');
        // "on" is the email checkboxes; a record id is numeric.
        return cb && /^\d+$/.test(cb.value) ? { value: cb.value, checked: !!cb.checked } : null;
      }),
    };
  });

  return core.rowsByHeader(grid.headers, grid.rows, RECEIPT_COLUMNS)
    .map((r, i) => ({
      ...r,
      selectId: (grid.ids[i] && grid.ids[i].value) || null,
      alreadyTicked: !!(grid.ids[i] && grid.ids[i].checked),
    }))
    .filter((r) => r.selectId);
}

/**
 * Tick the receipts this run matched. Real clicks, verified one at a time.
 *
 * `.checked = true` will not do: the box carries a bound click handler
 * (`data-fn-click`) and has no `name`, so it does not post as an ordinary form
 * field — the handler is what gathers the selection. A tick that did not fire
 * its handler is one the server never hears about.
 *
 * `#selectAll` is never used, and note there are TWO of them on this page
 * sharing an id — one per table. An IPSI run ticks only what it matched.
 */
async function tickReceipts(popup, selectIds, say = () => {}) {
  const ticked = [];
  const missed = [];
  for (const id of selectIds) {
    const box = popup.locator(`input[type="checkbox"][value="${id}"]`).first();
    if (!(await box.count())) { missed.push(id); continue; }
    if (await box.isChecked().catch(() => false)) { ticked.push(id); continue; }
    await box.click();
    await sleep(200);
    if (!(await box.isChecked().catch(() => false))) {
      throw new Error(`Ticking receipt record ${id} did not register on the page.`);
    }
    ticked.push(id);
  }
  say(`${ticked.length} receipt${ticked.length === 1 ? "" : "s"} ticked` +
    (missed.length ? `; ${missed.length} were not on the page` : "") + ".");
  return { ticked, missed };
}

/**
 * Fill the receipt header and press Issue. THIS COMMITS.
 *
 * Transaction Type is EFT because that is all this form offers — `CQ` and `ET`
 * only, no Credit Card Swipe. The receipts being reconciled may well have been
 * raised as swipe on the booking form, which offers five types; this screen is
 * a different select with a different vocabulary and cannot express it.
 *
 * The email block is left exactly as it ships — unticked. Issuing must not mail
 * a remittance to anybody.
 */
async function issueMerchantReceipt(popup, { payerName, amountCents, reference, dateReceived }, dryRun, say = () => {}) {
  await popup.selectOption("#receipttransactionTypeCode", "ET");
  const type = async (sel, v) => {
    if (v == null || v === "") return;
    const el = popup.locator(sel);
    if (!(await el.count())) return;
    await el.click({ clickCount: 3 });
    await el.pressSequentially(String(v), { delay: 30 });
    await el.press("Tab").catch(() => {});
  };
  await type("#receiptpayerName", payerName || "RAA");
  if (dateReceived) await type("#receiptdateReceived", core.toTramadaDate(dateReceived));
  await type("#receiptreceiptAmount", core.money(amountCents));
  await type("#receiptreferenceNumber", reference || "");
  await sleep(300);

  const back = await popup.evaluate(() => ({
    amount: (document.querySelector("#receiptreceiptAmount") || {}).value || "",
    payer: (document.querySelector("#receiptpayerName") || {}).value || "",
  }));
  if (core.cents(back.amount) !== amountCents) {
    throw new Error(`Amount Received reads "${back.amount}", not $${core.money(amountCents)}.`);
  }

  if (dryRun) {
    say(`Preview only — would issue $${core.money(amountCents)} as ${back.payer}.`, true);
    return { issued: false, amount: core.money(amountCents), payer: back.payer };
  }

  say(`Issuing $${core.money(amountCents)}…`);
  await popup.click("#issue");
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2000);

  const after = await popup.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const errs = [...document.querySelectorAll("a, span, li, font, div")]
      .filter((n) => !n.children.length)
      .map((n) => clean(n.textContent))
      .filter((t) => t && t.length < 200 && /must be|is required|is invalid|cannot be/i.test(t));
    return { stillOnForm: !!document.querySelector("#issue"), error: errs[0] || "" };
  }).catch(() => ({ stillOnForm: false, error: "" }));

  if (after.error) throw new Error(`Receipt rejected: ${after.error}`);
  if (after.stillOnForm) {
    throw new Error("Issue was pressed but the merchant receipt form is still showing.");
  }
  say(`Issued $${core.money(amountCents)}.`, true);
  return { issued: true, amount: core.money(amountCents), payer: back.payer };
}

/* ── the run ─────────────────────────────────────────────────────────────── */

/**
 * One IPSI settlement: match its rows to receipts on the screen, tick them,
 * and issue one receipt for what was ticked.
 *
 * Amount Received is the total of the rows that ACTUALLY TICKED — not the
 * file's headline settlement figure. A receipt has to balance against what it
 * allocates, and IPSI runs exclude refunds, so the two are not the same number.
 */
async function runIpsiReconciliation(o = {}) {
  const cb = o.callbacks || {};
  const say = cb.onProgress || (() => {});
  const row = cb.onRow || (() => {});
  const rows = o.rows || [];
  if (!rows.length) throw new Error("No rows to run.");

  /* A row that ALREADY has a number keeps it. On its own card these rows are
     1..n; inside a combined run they are numbered across every report, and
     renumbering them here would send `row(1, …)` for the first IPSI row and
     overwrite the first BPay row in the inbox and in runs.json. */
  const results = rows.map((r, i) => ({ ...r, n: r.n || i + 1 }));
  const browser = await openBrowser();
  let page;
  let form;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, cb.onNeedLogin);

    form = await searchIssueReceipts(page, {
      debtorCode: o.debtorCode || "MASTER",
      debtorLabel: o.debtorLabel || "MasterCard/Visa/Debit",
      fromDate: o.fromDate,
      toDate: o.toDate,
    }, say);

    const waiting = await readReceiptsToReconcile(form);
    say(`${waiting.length} receipt${waiting.length === 1 ? "" : "s"} waiting to be reconciled.`);

    const toTick = [];
    for (const r of results) {
      const m = core.matchIpsiAgainstReceipts(r, waiting);
      r.matchedOn = m.matched ? m.on : null;
      r.ticked = false;
      r.why = m.reason;
      if (m.matched) {
        r.receiptNo = m.receipt.receiptNo;
        r.selectId = m.receipt.selectId;
        toTick.push(m.receipt.selectId);
      }
      row(r.n, { reconciliation: m.matched ? "Reconciled" : "Not reconciled", why: r.why, receiptNo: r.receiptNo });
      say(`Row ${r.n}: ${m.reason}`, m.matched);
    }

    const sel = await tickReceipts(form, toTick, say);
    for (const r of results) if (r.selectId && sel.ticked.includes(r.selectId)) r.ticked = true;

    const summary = core.summariseIpsi(results);
    if (!summary.ticked) {
      say("Nothing matched, so no receipt was issued.", false);
      ok = true;
      return { results, summary, issued: null };
    }

    const issued = await issueMerchantReceipt(form, {
      payerName: o.payerName || "RAA",
      amountCents: summary.allocatedCents,
      reference: o.reference || "",
      dateReceived: o.dateReceived,
    }, !!o.dryRun, say);

    ok = true;
    return { results, summary, issued };
  } finally {
    // `form` is this tab when the popup was relocated out of, and the popup
    // itself when it was not. Either way the window does not outlive the run.
    if (ok && form && form !== page) await form.close().catch(() => {});
    if (ok && page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runIpsiReconciliation,
  searchIssueReceipts, readReceiptsToReconcile, tickReceipts, issueMerchantReceipt,
  fillAutocomplete, RECEIPT_COLUMNS,
  popupTarget, RECEIPT_FORM_URL, chooseWindow, POPUP_TIMEOUT_MS,
};

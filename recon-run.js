/**
 * recon-run.js — the reconciliation run, over the browser.
 *
 * One pass, in this order:
 *
 *   for each CSV row → raise a Debtor Payment Receipt against its booking,
 *                      allocated only when the amount equals what the receipt
 *                      form says is still outstanding
 *   then             → create a NEW reconciliation page (last page + 1)
 *   then             → SORT it, then filter it to Client Payment Receipt
 *   then             → look for each RECEIPT NUMBER in the Trans. No column
 *
 * Sorting clears the filter, so it goes first. And the match is on the receipt
 * number Tramada handed back — `R.0000009403` — against `Trans. No`, not on the
 * CSV's reference: the receipt number is the identity of the thing this run
 * actually filed, where the reference is free text on rows it did not create.
 *
 * Every decision it makes comes from `recon-core.js`, which is pure and tested.
 * This file's whole job is pages and clicks; if you find a rule being decided
 * here, it is in the wrong place.
 *
 * ── What it touches on the reconciliation page ───────────────────────────
 *
 * Sort, filter, the statement balances, the transactions it matched, and Done.
 *
 * This page COMMITS. Until 10-Aug-2026 the run deliberately stopped short of it
 * — sort and filter and nothing else — and the difference between a run that
 * reads a statement and a run that commits one was the whole point. It now
 * commits, by request. Two things follow from that and neither is optional:
 *
 *   - only rows this run positively MATCHED are ticked, never `Select All`;
 *   - the tick is verified before Done is pressed, because a Done that commits
 *     a page whose rows never registered is worse than no Done at all.
 *
 * Export is still never clicked.
 */

require("dotenv").config();
const { chromium } = require("playwright");
const core = require("./recon-core");
const { runTramadaReceipt } = require("./tramada-receipt");

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
    // Never launch a throwaway Chrome as a fallback — it would be signed out,
    // and "not logged into Tramada" is a far more confusing thing to debug
    // than "I couldn't reach your Chrome".
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

/* ── the bank statement screens ──────────────────────────────────────────── */

/**
 * Pick a bank account and WAIT FOR THE FORM TO COME BACK.
 *
 * Both statement screens post the whole form back when the account changes, and
 * the page that returns is a new document with the fields reset to their
 * defaults. Selecting and carrying straight on is a race, and it lost twice in
 * one run on 06-Aug-2026:
 *
 *   - on the SEARCH screen, the Search button was clicked mid-postback, so the
 *     result list came back empty. Zero existing pages reads as "this account
 *     has no statements", so the next page number was computed as 1.
 *   - on the NEW-STATEMENT screen, the postback landed after the page number
 *     had been typed and reset it to the default, which is also 1.
 *
 * Both ended at the same place: Tramada answering "Page Number already exists
 * for bank account 'TRUST'" on an account that already holds pages 1–9.
 *
 * The reload is detected rather than slept through — hold a node from the old
 * document and watch for it to detach. A fixed sleep is either too short on a
 * slow day or wasted on every run.
 */
async function selectAccountAndWait(page, selector, accountLabel, anchorSelector) {
  const anchor = await page.$(anchorSelector);
  await page.selectOption(selector, { label: accountLabel });

  // Give the postback up to 4s to start. If nothing detaches in that time the
  // screen did not reload, which is fine — carry on.
  const startedBy = Date.now() + 4000;
  let reloaded = false;
  while (Date.now() < startedBy) {
    await sleep(200);
    if (!anchor) break;
    const stillThere = await anchor.evaluate((el) => el.isConnected).catch(() => false);
    if (!stillThere) { reloaded = true; break; }
  }

  if (reloaded) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForSelector(selector, { state: "visible", timeout: 20000 });
    await page.waitForSelector(anchorSelector, { state: "visible", timeout: 20000 });
    await sleep(600);
  }

  // The selection has to have survived whatever just happened. If it did not,
  // everything after this would be filed against the wrong account — a far
  // worse outcome than stopping here.
  const chosen = await page.$eval(selector, (el) =>
    (el.options[el.selectedIndex] || {}).text || "").catch(() => "");
  if (chosen.trim() !== accountLabel.trim()) {
    throw new Error(
      `The bank account did not stick: asked for "${accountLabel}", the form reads "${chosen.trim()}".`
    );
  }
  return reloaded;
}

/**
 * Every existing statement page for an account.
 *
 * Read fresh every run rather than remembered: a second run in the same day has
 * to land on the page AFTER the one the first run created, and a remembered
 * number would quietly reuse a page.
 */
async function readExistingPages(page, accountLabel = "[TRUST] Trust Account") {
  await page.goto(`${TRAMADA_BASE_URL}/finance/finance-statements.htm`, { waitUntil: "domcontentloaded" });
  // The mode chooser. #form_selection_search ("Search Existing Statement(s)")
  // is checked by default, so Continue is all that is needed — but assert the
  // form is really there first, because an expired session serves a login page
  // quite happily and every later selector would then miss for the wrong
  // reason.
  //
  // The button here is #form_continueButton. The NEW-STATEMENT form's is
  // #continue. Two different pages, two different ids — measured 06-Aug-2026.
  await page.waitForSelector("#searchForm_account, #form_selection_search", { timeout: 20000 });
  if (!(await page.locator("#searchForm_account").count())) {
    await page.check("#form_selection_search");
    await page.click("#form_continueButton");
    await page.waitForSelector("#searchForm_account", { timeout: 20000 });
  }
  // Changing the account posts this form back — click Search before it lands
  // and the search runs against nothing and answers with an empty list.
  await selectAccountAndWait(page, "#searchForm_account", accountLabel, "#searchButton");

  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  /**
   * COLUMNS ARE FOUND BY HEADER NAME, NEVER BY POSITION.
   *
   * The results grid opens with an **Action** column of icon links:
   *
   *   Action | Bank Account | Page No | Statement Date | Opening | Closing | Period | Balanced
   *
   * Counting from zero put `pageNo` on "TRUST" and every other field one to the
   * left. `nextPageNumber` then had nine rows whose page numbers were all the
   * word TRUST, discarded them all as unreadable, and answered 1 — for an
   * account whose grid was showing 1 through 9 on screen at the time. The run
   * went on to try pages 1, 2 and 3, each already taken.
   *
   * This is the same rule the CSV parser follows and for the same reason: a
   * column inserted at the front shifts every value while each row still looks
   * perfectly plausible.
   *
   * `sawTable`, `saysEmpty` and `headers` are what tell "this account has no
   * statements" apart from "the list did not render the way we expect". Both
   * give zero rows and only one of them means page 1 is free.
   */
  // The browser only reads text out. Which column is which is decided by
  // `recon-core.rowsByHeader`, where it is tested against captured headers.
  const grid = await page.evaluate(() => {
    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const table = [...document.querySelectorAll("table")]
      .find((t) => [...t.querySelectorAll("th, td")].some((c) => /page\s*no/i.test(c.textContent)));
    const saysEmpty = /no\s+(records|statements|results|matching|data)/i.test(document.body.innerText || "");
    if (!table) return { headers: [], rows: [], sawTable: false, saysEmpty };

    const trs = [...table.querySelectorAll("tr")];
    const headRow = trs.find((tr) => /page\s*no/i.test(tr.textContent));
    return {
      headers: headRow ? [...headRow.children].map((c) => norm(c.textContent)) : [],
      rows: trs.filter((tr) => tr !== headRow).map((tr) => [...tr.children].map((c) => norm(c.textContent))),
      sawTable: true,
      saysEmpty,
    };
  });

  const pages = core
    .rowsByHeader(grid.headers, grid.rows, core.STATEMENT_COLUMNS)
    // A data row is one whose Page No is actually a number. That drops header
    // repeats, spacer rows and any footer, without counting columns.
    .filter((p) => /^\d+$/.test(p.pageNo));

  return { pages, sawTable: grid.sawTable, saysEmpty: grid.saysEmpty, headers: grid.headers };
}

/**
 * Create a NEW reconciliation statement and land on its transaction screen.
 *
 * Asserts the page number it was given is not already taken. Tramada will
 * happily accept a duplicate and the run would then be reading somebody else's
 * statement while reporting success.
 */
async function createStatement(page, { pageNumber, statementDate, openingBalance, closingBalance, accountLabel }) {
  await page.goto(`${TRAMADA_BASE_URL}/finance/finance-statements.htm`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#form_selection_issue", { timeout: 20000 });
  await page.check("#form_selection_issue");     // "Reconcile New Statement"
  await page.click("#form_continueButton");
  await page.waitForSelector("#pageNumber", { timeout: 20000 });

  // ACCOUNT FIRST, AND WAIT. This posts the form back and hands you a fresh one
  // with Page Number reset to its default of 1 — so every field typed before it
  // settles is thrown away, silently, and the run files against page 1 on an
  // account that already has nine pages.
  await selectAccountAndWait(page, "#bankAccount", accountLabel, "#pageNumber");

  /**
   * REAL KEYSTROKES, not fill().
   *
   * Measured 06-Aug-2026: setting #pageNumber and #statementDate through the
   * native value setter with input/change events reads back correctly in the
   * DOM and is then DISCARDED on submit — the form comes back with both fields
   * empty and highlighted, as if nothing had been typed. `page.fill()` does the
   * same thing the same way and fails identically.
   *
   * Clicking the field and typing it works. This is the §5 rule ("PrimeNG
   * calendars ignore even that — they need real keystrokes") applying to a
   * plain-looking text input, so it is written down here rather than left for
   * the next person to rediscover against a financial form.
   */
  const typeInto = async (selector, value) => {
    if (value === "" || value == null) return;
    const el = page.locator(selector);
    await el.click();
    await el.press("Control+a").catch(() => {});
    await el.pressSequentially(String(value), { delay: 40 });
  };
  await typeInto("#pageNumber", pageNumber);
  await typeInto("#statementDate", core.toTramadaDate(statementDate));
  await typeInto("#openingBalance", openingBalance);
  await typeInto("#closingBalance", closingBalance);
  // Blur the last field so any on-change handler has run before submit.
  await page.locator("#pageNumber").click();

  /**
   * Read the values back IMMEDIATELY BEFORE SUBMITTING, with a settle first.
   *
   * The settle is the point. A postback in flight resets the form, and a
   * read-back taken before it lands agrees with everything you typed and is
   * then wrong by the time Continue is clicked. Tramada's date field also
   * reformats on blur, and a silently-rejected date would file the statement
   * against the wrong day.
   */
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(700);
  const back = await page.evaluate(() => ({
    page: (document.querySelector("#pageNumber") || {}).value,
    date: (document.querySelector("#statementDate") || {}).value,
    account: (() => {
      const el = document.querySelector("#bankAccount");
      return el ? (el.options[el.selectedIndex] || {}).text || "" : "";
    })(),
  }));
  if (String(back.account).trim() !== String(accountLabel).trim()) {
    throw new Error(`The form lost the bank account before submit (it reads "${back.account}").`);
  }
  if (String(back.page).trim() !== String(pageNumber)) {
    throw new Error(`Tramada didn't keep page number ${pageNumber} (it reads "${back.page}").`);
  }
  if (String(back.date).trim() !== core.toTramadaDate(statementDate)) {
    throw new Error(
      `Tramada didn't keep the statement date ${core.toTramadaDate(statementDate)} (it reads "${back.date}").`
    );
  }

  await page.locator("#continue").click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  /**
   * SUCCESS IS THE RECONCILE SCREEN BEING ON IT, NOT A URL.
   *
   * The landing URL is `/finance/finance-statement.htm`. This checked for
   * `finance-statement-generation.htm` and a page created perfectly well was
   * reported as a failure every time. Page 10 was sitting there on screen,
   * headed "Reconcile Bank Statement Page 10", while the run said it had not
   * been made.
   *
   * (That route does exist — corrected 10-08-2026, it is the reconcile screen
   * itself, reached from the search grid's "Reconcile Bank Statement" icon. It
   * simply is not where CREATING a statement lands you. The original note here
   * said the name never existed, which sent the next reader looking for the
   * wrong thing.)
   *
   * A URL is a guess about someone else's routing. The screen's own controls
   * and heading are the thing we actually need to be true, so they are what is
   * checked — including that the heading says the page number we asked for.
   */
  const landed = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h1, h2, h3, b, td, div, span")]
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
      .find((t) => /^Reconcile Bank Statement Page\s+\d+/i.test(t)) || "";
    const m = heading.match(/Page\s+(\d+)/i);
    return {
      heading,
      pageNo: m ? m[1] : "",
      hasControls: !!document.querySelector("#filterColumn") && !!document.querySelector("#sortBy"),
    };
  });

  if (landed.hasControls || landed.pageNo) {
    if (landed.pageNo && String(landed.pageNo) !== String(pageNumber)) {
      throw new Error(
        `Asked for page ${pageNumber} but landed on "${landed.heading}".`
      );
    }
    return page.url();
  }

  /**
   * Only now is this a failure — and the message has to come from something
   * that is actually an error.
   *
   * Scanning every `<td>` for the word "error" quoted a TRANSACTION back as
   * Tramada's complaint: a row whose reference read "July Staff Errors" became
   * `Tramada said: July Staff Errors`, on a run that had in fact succeeded.
   * Error containers first, then a tight phrase match in small elements —
   * never the bare word "error", and never a data cell.
   */
  const err = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const boxes = [...document.querySelectorAll(
      '.error, .errors, .fieldError, .errorMessage, [class*="error" i], [id*="error" i]')];
    for (const b of boxes) {
      const t = clean(b.textContent);
      if (t && t.length < 300) return t;
    }
    return [...document.querySelectorAll("span, div, p, li, b, a")]
      .map(clean)
      .find((t) => t && t.length < 200 &&
        /(already exists|is required|must be|cannot be|is invalid|not valid)/i.test(t)) || "";
  });

  // What Tramada ACTUALLY received, not what we meant to send — but only if the
  // form is still on screen. Reporting page "undefined" from a screen that has
  // no page field is noise pretending to be evidence.
  const sent = await page.evaluate(() => {
    const val = (sel) => { const el = document.querySelector(sel); return el ? el.value : null; };
    return { page: val("#pageNumber"), date: val("#statementDate") };
  }).catch(() => ({}));
  const held = sent && (sent.page != null || sent.date != null)
    ? ` The form was holding page "${sent.page}", date "${sent.date}".` : "";

  const e = new Error(
    `The new statement wasn't created${err ? ` — Tramada said: ${err.slice(0, 200)}` : ` (landed on ${page.url()})`}.${held}`
  );
  e.pageTaken = /already exists/i.test(err);
  throw e;
}

/**
 * Filter and sort the open reconciliation page, then read what it leaves
 * showing.
 *
 * **Client Payment Receipt, not Debtor Payment Receipt.** A receipt raised on a
 * booking can only ever be a Client Payment Receipt — that is the only relevant
 * option the booking's receipt form offers. So the receipts this run just
 * created appear under that type, and filtering to it turns the reconciliation
 * step into a check that our own work actually reached the bank statement.
 * Filtering to Debtor Payment Receipt would match the pre-existing lines the CSV
 * was scraped from and never look at what we filed.
 *
 * **SORT FIRST, THEN FILTER — sorting clears the filter.** Doing it the other
 * way round leaves the screen showing every transaction on the page again,
 * which reads as a successful filter that simply matched a great many rows.
 * Newest first, so the receipts just created sit at the top where a person
 * checking this screen against the run's output sees them first.
 *
 * The filter HIDES rows, it does not remove them: page 9 held 4,242 rows in the
 * DOM with 47 visible after filtering. Reading `tbody tr` would return every
 * transaction in the system while looking like it had respected the filter, so
 * only rows actually on screen are read.
 *
 * Sort and Filter are the only things clicked HERE. Ticking and Done happen in
 * `selectMatchedTransactions` / `finishStatementPage`, after the matching is
 * done and only for rows that matched. Export is never clicked.
 */
/**
 * Sort the page. SUBMITS, so it happens ONCE and it happens first.
 *
 * `#sortButton` is `type="submit"` — it posts the form and Tramada hands back a
 * rebuilt list with the filter dropdowns at their blank default AND every tick
 * gone. `#filterButton` is `type="button"`: its handler only hides rows in the
 * page that is already there. That difference is what makes a run over two
 * report types possible at all — sort once, then swap the filter as often as
 * you like and the ticks made in between survive.
 */
async function sortPage(page) {
  await page.waitForSelector("#filterColumn", { timeout: 20000 });
  await page.selectOption("#sortBy", { label: "Date" }).catch(() => {});
  await page.selectOption("#sortOrder", { label: "Descending" }).catch(() => {});
  await page.click("#sortButton").catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1500);
  await page.waitForSelector("#filterColumn", { timeout: 20000 });
}

/** Show one Rec/Pay Type. Client-side; ticks already made are not disturbed. */
async function applyFilter(page, recPayType) {
  await page.selectOption("#filterColumn", { label: "Rec/Pay Type" });
  await page.waitForSelector("#recPayType", { state: "visible", timeout: 10000 });
  await page.selectOption("#recPayType", { label: recPayType });
  await page.click("#filterButton");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1500);

  // The filter has to have actually taken. If it silently reset, every
  // transaction on the page is visible and the matcher would be searching the
  // whole statement while the log says it filtered.
  const applied = await page.evaluate(() => {
    const el = document.querySelector("#recPayType");
    return el ? (el.options[el.selectedIndex] || {}).text || "" : "";
  }).catch(() => "");
  if (applied.trim() !== recPayType) {
    throw new Error(`The ${recPayType} filter did not stick (the screen reads "${applied.trim()}").`);
  }
}

async function filterAndRead(page, recPayType = "Client Payment Receipt") {
  await sortPage(page);
  await applyFilter(page, recPayType);
  return readVisibleTransactions(page);
}

/**
 * The rows currently ON SCREEN, with each one's checkbox id.
 *
 * BY HEADER NAME, as on the search grid. The documented layout is
 *
 *   Date | Trans. No | Rec/Pay Type | Trans Type | Reference |
 *   Receipt For/Payment To | Debit | Credit | ☑
 *
 * but that was measured once, and the search grid taught us what a single
 * unexpected leading column does: every field shifts and every row still looks
 * plausible. Positions are the fallback, not the plan.
 */
async function readVisibleTransactions(page) {
  const grid = await page.evaluate(() => {
    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const t = [...document.querySelectorAll("table")]
      .find((x) => /Rec\/Pay\s*Type/i.test(x.textContent) && /Trans\./i.test(x.textContent));
    if (!t) return { headers: [], rows: [] };
    const trs = [...t.querySelectorAll("tr")];
    const headRow = trs.find((tr) => /rec\/pay\s*type/i.test(tr.textContent));
    // Only rows actually on screen — see the note above about the filter
    // hiding rows rather than removing them.
    const body = trs.filter((tr) =>
      tr !== headRow && tr.querySelectorAll("td").length >= 7 && tr.offsetParent !== null);
    return {
      headers: headRow ? [...headRow.children].map((c) => norm(c.textContent)) : [],
      rows: body.map((tr) => [...tr.children].map((c) => norm(c.textContent))),
      /**
       * The row's own checkbox VALUE, carried alongside its text.
       *
       * Every one of these checkboxes is `name="selected"` with `id="selected"`
       * — the id is duplicated across all 4,257 of them and is useless as a
       * selector. The `value` is the statement record's id and is unique, so
       * it is the only stable handle on a row. Read here, while we already
       * have the row, rather than scraped a second time later: ticking calls
       * `moveCheckedToTop()` and REORDERS the table, so any index taken now
       * would be pointing at a different row by the second tick.
       */
      ids: body.map((tr) => {
        const cb = tr.querySelector('input[type="checkbox"][name="selected"]');
        return cb ? { value: cb.value, checked: !!cb.checked } : null;
      }),
    };
  });

  return core
    .rowsByHeader(grid.headers, grid.rows, core.TRANSACTION_COLUMNS, core.TRANSACTION_FALLBACK)
    .map((r, i) => ({
      date: r.date, transNo: r.transNo, recPayType: r.recPayType, transType: r.transType,
      reference: r.reference, payee: r.payee,
      // Debit or credit, whichever the row carries — a receipt is a credit, but
      // reading only one column would silently score a debit as zero.
      amount: r.credit || r.debit || "",
      selectId: (grid.ids[i] && grid.ids[i].value) || null,
      alreadyTicked: !!(grid.ids[i] && grid.ids[i].checked),
    }));
}

/* ── the statement balances, on the reconcile page ───────────────────────── */

/**
 * The three balance fields ship READONLY and ONE unnamed button unlocks them.
 *
 * Measured live 10-Aug-2026 on page 9. `#openingBalance`, `#closingBalance` and
 * `#statementDate` are all `readonly` when the reconcile screen renders, and the
 * only thing that clears that is an `<input type="button" value="Edit">` with no
 * id and no name, sitting in `dl.edit > dt.input-short-button`. Typing into a
 * readonly input succeeds silently and changes nothing, which is exactly why
 * the opening balance never appeared: the run typed it on the NEW-STATEMENT
 * form, where it is accepted, and then the reconcile page — the one anybody
 * actually looks at — showed the account's own figure instead.
 *
 * The value is normalised through `cents()` before it is typed. The agent types
 * "111,753.97" as readily as "111753.97" and the raw string is not what a money
 * field should be handed.
 */
const BALANCE_EDIT_BUTTON =
  'dl.edit input[type="button"][value="Edit"], input.button[type="button"][value="Edit"]';

async function setStatementBalances(page, { openingBalance, closingBalance } = {}, say = () => {}) {
  const want = {
    openingBalance: core.money(core.cents(openingBalance)),
    closingBalance: core.money(core.cents(closingBalance)),
  };
  // An unreadable balance is refused rather than typed. Nothing here rounds a
  // number it merely failed to parse (recon-core §money).
  for (const [field, v] of Object.entries(want)) {
    const given = field === "openingBalance" ? openingBalance : closingBalance;
    if (v === "" && given != null && String(given).trim() !== "") {
      throw new Error(`The ${field === "openingBalance" ? "opening" : "closing"} balance "${given}" could not be read as an amount.`);
    }
  }
  if (!want.openingBalance && !want.closingBalance) return null;

  await page.waitForSelector("#openingBalance", { timeout: 20000 });

  const locked = await page.$eval("#openingBalance", (el) => el.readOnly).catch(() => false);
  if (locked) {
    const edit = page.locator(BALANCE_EDIT_BUTTON).first();
    if (!(await edit.count())) {
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll("input[type=button], input[type=submit]")]
          .map((n) => `${n.id ? "#" + n.id : ""}[${n.value}]`).join(" | ")).catch(() => "");
      throw new Error(
        `The statement balances are read-only and the Edit button that unlocks them is not on the page. It offered: ${controls}`
      );
    }
    await edit.click();
    await page
      .waitForFunction(() => {
        const el = document.querySelector("#openingBalance");
        return el && !el.readOnly;
      }, null, { timeout: 10000 })
      .catch(() => {});
  }

  const stillLocked = await page.$eval("#openingBalance", (el) => el.readOnly).catch(() => true);
  if (stillLocked) {
    throw new Error("Clicked Edit but the statement balance fields are still read-only.");
  }

  // Real keystrokes, and TRIPLE-CLICK rather than Control+A to clear what is
  // already there — Control+A is Cmd+A on a Mac, so the selection never
  // happens and the typed figure lands next to the existing one. That lesson
  // is already written down against the allocation box in tramada-receipt.js;
  // it applies to every prefilled money field on this portal.
  const typeInto = async (selector, value) => {
    if (!value) return;
    const el = page.locator(selector);
    await el.click({ clickCount: 3 });
    await el.pressSequentially(String(value), { delay: 40 });
    await el.press("Tab").catch(() => {});
    await sleep(200);
  };
  await typeInto("#openingBalance", want.openingBalance);
  await typeInto("#closingBalance", want.closingBalance);

  // Read back. A balance that did not stick leaves the reconciliation
  // unanchored, and the page is about to be committed.
  const back = await page.evaluate(() => ({
    opening: (document.querySelector("#openingBalance") || {}).value || "",
    closing: (document.querySelector("#closingBalance") || {}).value || "",
    calculated: (document.querySelector("#calculatedClosingBalance") || {}).value || "",
    unpresented: (document.querySelector("#fieldGroupUnpresentedBalance") || {}).value || "",
  }));
  for (const [field, label] of [["opening", "opening"], ["closing", "closing"]]) {
    const wanted = want[`${label}Balance`];
    if (wanted && core.cents(back[field]) !== core.cents(wanted)) {
      throw new Error(
        `The ${label} balance did not stick: typed $${wanted}, the field reads "${back[field]}".`
      );
    }
  }
  say(`Statement balances set — opening $${back.opening}, closing $${back.closing}.`, true);
  return back;
}

/* ── ticking what matched, then Done ─────────────────────────────────────── */

/**
 * Tick the transactions this run matched. Real clicks, one at a time, verified.
 *
 * Three things about this page make the obvious implementation wrong, all
 * measured live 10-Aug-2026:
 *
 *   1. `checked = true` DOES NOTHING USEFUL. The checkbox carries a bound
 *      jQuery click handler (`calculateTotal`), which is what updates
 *      `#calculatedClosingBalance` and `#fieldGroupUnpresentedBalance`. Setting
 *      the property skips it, so the page would submit a tick whose balances
 *      never moved. Same rule as the receipt form's segment checkboxes.
 *   2. `calculateTotal` calls `moveCheckedToTop()` — the row JUMPS to the top
 *      of the table the moment it is ticked. Anything holding a row index is
 *      pointing somewhere else by the next tick, so rows are addressed by
 *      `input[name="selected"][value="<record id>"]`, which does not move.
 *   3. A transaction dated AFTER the statement date raises a `confirm()` and
 *      turns the row red (`checkSelectedTransaction`,
 *      `transactionDateIsAfterStatementDate`, `#hiddenKeepTransaction`). An
 *      unhandled dialog freezes Playwright outright, so one is registered
 *      before the first click and every firing is reported.
 *
 * `Select All` is never used. It would tick all 4,257 unpresented transactions
 * on the page, which is not what "reconcile what this run filed" means.
 */
async function selectMatchedTransactions(page, statementRows, matchedTransNos, say = () => {}) {
  const wanted = new Map();
  for (const t of matchedTransNos || []) {
    const k = core.receiptKey(t);
    if (k) wanted.set(k, t);
  }
  if (!wanted.size) return { ticked: [], missing: [], futureDated: [] };

  const byKey = new Map();
  for (const r of statementRows || []) {
    if (r.selectId) byKey.set(core.receiptKey(r.transNo), r);
  }

  const futureDated = [];
  const onDialog = async (d) => {
    futureDated.push(String(d.message() || "").replace(/\s+/g, " ").trim().slice(0, 200));
    // Accept: the only rows this run ticks are ones it matched to a receipt it
    // filed itself, so "keep the future dated transaction" is yes. It is still
    // reported — a receipt dated past its own statement page is worth seeing.
    await d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);

  const ticked = [];
  const missing = [];
  try {
    for (const [key, shown] of wanted) {
      const row = byKey.get(key);
      if (!row) { missing.push(shown); continue; }
      if (row.alreadyTicked) { ticked.push(shown); continue; }

      const box = page.locator(`input[type="checkbox"][name="selected"][value="${row.selectId}"]`).first();
      if (!(await box.count())) { missing.push(shown); continue; }
      await box.click();
      await sleep(250);

      // Verify this one before moving on. A tick that did not register is the
      // difference between committing what we filed and committing nothing.
      const on = await box.isChecked().catch(() => false);
      if (!on) {
        throw new Error(`Ticking transaction ${shown} did not register on the page.`);
      }
      ticked.push(shown);
    }
  } finally {
    page.off("dialog", onDialog);
  }

  say(`${ticked.length} transaction${ticked.length === 1 ? "" : "s"} ticked` +
    (missing.length ? `; ${missing.length} could not be found on the page` : "") +
    (futureDated.length ? `; ${futureDated.length} dated after the statement date and were kept` : "") + ".",
    !missing.length);
  return { ticked, missing, futureDated };
}

/**
 * Press Done. This COMMITS the page.
 *
 * `#done` is a submit on the reconcile form; Tramada's `preSubmitForm()`
 * gathers the ticked rows into `#hiddenSelectedStatementRecords` on the way
 * out. Nothing is clicked here unless at least one row was ticked and verified
 * — committing an empty page is not a no-op, it finalises a statement that
 * reconciles nothing.
 */
async function finishStatementPage(page, tickedCount, say = () => {}) {
  if (!tickedCount) {
    say("Nothing matched, so Done was not pressed — the page is left open, uncommitted.", false);
    return { done: false, reason: "nothing was ticked" };
  }
  const done = page.locator("#done");
  if (!(await done.count())) {
    throw new Error("The reconcile page has no Done button (#done).");
  }
  await done.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1500);

  // Did it take? Either we are off the reconcile screen, or the screen is
  // telling us why not.
  const after = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const boxes = [...document.querySelectorAll('.error, .errors, .errorMessage, [class*="error" i]')]
      .map((b) => clean(b.textContent)).filter((t) => t && t.length < 300);
    return {
      url: location.href,
      stillOnReconcile: !!document.querySelector("#done"),
      error: boxes[0] || "",
    };
  }).catch(() => ({ url: "", stillOnReconcile: false, error: "" }));

  if (after.stillOnReconcile) {
    throw new Error(
      `Done was pressed but the reconcile page is still showing${after.error ? ` — Tramada said: ${after.error}` : ""}.`
    );
  }
  say(`Done — the statement page is committed with ${tickedCount} transaction${tickedCount === 1 ? "" : "s"} reconciled.`, true);
  return { done: true, tickedCount };
}

/* ── the run ─────────────────────────────────────────────────────────────── */

/**
 * Read the account's existing pages, work out the next number, and create it.
 *
 * Shared by both runs. The BPay run and the Mint run each get their own fresh
 * page — that was the decision, and it means two runs in a day leave two pages,
 * which is visible and undoable rather than clever and surprising.
 */
async function openFreshStatementPage(page, o) {
  const say = o.say || (() => {});
  const accountLabel = o.accountLabel || "[TRUST] Trust Account";

  say(`Reading the existing ${accountLabel} statement pages…`);
  let found = await readExistingPages(page, accountLabel);

  /**
   * An empty list is only allowed to mean "page 1 is free" when the screen
   * SAID so. Otherwise it means the search did not render, and computing a page
   * number from it invents one — CLAUDE.md §3. That is precisely what happened
   * when the account dropdown's postback swallowed the search: zero rows, page
   * 1, and Tramada answering "Page Number already exists for bank account
   * 'TRUST'" on an account holding pages 1–9.
   */
  if (!found.pages.length && !found.saysEmpty) {
    throw new Error(
      `Couldn't read the existing statement pages for ${accountLabel} — the result list ` +
      `${found.sawTable ? `rendered but no row had a readable Page No (headers: ${found.headers.join(" | ")})`
        : "never rendered"}, and this run will not guess a page number.`
    );
  }
  if (!found.pages.length) say(`${accountLabel} has no statements yet — starting at page 1.`);

  let pageNumber = core.nextPageNumber(found.pages);
  // Say what was actually read, not just the conclusion. "Last page is 0" next
  // to a grid showing 1–9 is the whole story; "0 pages read" would have said it
  // outright.
  say(`${found.pages.length} existing page${found.pages.length === 1 ? "" : "s"} read` +
    (found.pages.length ? ` (highest ${pageNumber - 1})` : "") + `; creating page ${pageNumber}.`);

  /* Someone else may have taken the number between reading and writing — a
     second run, or a person in the same sandbox. Tramada says so plainly, so
     re-read and move up rather than stopping. Only ever forwards, and only a
     few times: a number that keeps coming back taken means something else is
     wrong and the loop should not paper over it. */
  for (let attempt = 1; ; attempt++) {
    try {
      await createStatement(page, {
        pageNumber,
        statementDate: o.statementDate,
        openingBalance: o.openingBalance,
        closingBalance: o.closingBalance,
        accountLabel,
      });
      break;
    } catch (err) {
      if (!err.pageTaken || attempt >= 3) throw err;
      say(`Page ${pageNumber} was taken — re-reading the statement list.`, false);
      found = await readExistingPages(page, accountLabel);
      pageNumber = Math.max(core.nextPageNumber(found.pages), pageNumber + 1);
      say(`Trying page ${pageNumber}.`);
    }
  }
  say(`Page ${pageNumber} created (${core.toTramadaDate(o.statementDate)}).`, true);
  return pageNumber;
}

/* ── phase one: the receipts ─────────────────────────────────────────────── */

/**
 * File a receipt per row. NO PAGE OF OUR OWN IS HELD HERE, and that is not an
 * accident.
 *
 * `runTramadaReceipt` opens its own CDP connection and calls `browser.close()`
 * in its finally. Over CDP that tears down the shared browser, so a page opened
 * before this loop is dead by the end of it — the first run stopped with
 * "Target page, context or browser has been closed" the moment the statement
 * phase touched its page again.
 *
 * So: the receipts run first, each managing its own connection, and the caller
 * only connects once they are all done. That is also why two report types
 * cannot be run as two concurrent flows — the second one's `browser.close()`
 * would pull the page out from under the first, with real receipts already
 * filed. One run does both, in order.
 *
 * Each row is its own attempt — a booking that fails must not stop the rest,
 * because the receipts already filed are real and nothing rolls back.
 */
async function fileReceipts(results, { auth, cb, say, row }) {
  for (const r of results) {
    row(r.n, { allocation: "Running" });
    try {
      say(`Row ${r.n}: opening the receipt form for booking ${r.bookingNo}…`);
      // Staged first purely to READ what is outstanding — this does not
      // commit. The decision needs the form's own figure, which is only
      // knowable with the form open.
      const probe = await runTramadaReceipt({
        ...auth,
        bookingNo: r.bookingNo,
        receipt: {
          transactionType: "EFT",
          amount: r.amount,
          reference: r.reference,
          dateReceived: r.date,
          allocation: [],
        },
        dryRun: true,
        skipIfNoAllocatable: true,
        callbacks: { onNeedLogin: cb.onNeedLogin },
      });

      const segments = (probe && probe.segments) || [];
      const decision = core.decideAllocation(r.amountCents, segments);
      say(`Row ${r.n}: ${decision.reason}`);

      const filed = await runTramadaReceipt({
        ...auth,
        bookingNo: r.bookingNo,
        receipt: {
          transactionType: "EFT",
          amount: r.amount,
          reference: r.reference,
          dateReceived: r.date,
          allocation: decision.allocation,
        },
        dryRun: false,
        skipIfNoAllocatable: false,
        callbacks: { onNeedLogin: cb.onNeedLogin },
      });

      // On a real commit runTramadaReceipt returns `receipt` — the issued
      // record, whose receiptNo it has already asserted starts with "R.".
      r.receiptNo = (filed && filed.receipt && filed.receipt.receiptNo) || "";
      r.allocation = decision.status;
      r.why = decision.reason;
      row(r.n, { receiptNo: r.receiptNo, allocation: r.allocation, why: r.why });
      say(`Row ${r.n}: receipt ${r.receiptNo || "(no number returned)"} — ${decision.status}`,
        decision.status === "Allocated");
    } catch (err) {
      // Tidied before it goes anywhere near a table cell. Raw, this is a
      // Playwright call log with ANSI codes in it, and the Why column becomes
      // a paragraph of escape sequences with the reason buried inside.
      const why = core.tidyError(err.message);
      r.allocation = "Not allocated";
      r.error = why;
      r.why = `receipt failed: ${why}`;
      row(r.n, { allocation: r.allocation, why: r.why });
      say(`Row ${r.n}: ${why}`, false);
    }
  }
  return results;
}

/* ── the runs ────────────────────────────────────────────────────────────── */

/**
 * The BPay run on its own — one report, its own statement page.
 *
 * @param {object} o
 *   rows              parsed CSV rows (recon-core.parseReconCsv)
 *   statementDate     dd-mm-yyyy or ISO
 *   openingBalance    what the agent typed
 *   closingBalance    what the agent typed
 *   accountLabel      defaults to the Trust Account
 *   callbacks         { onProgress(msg, ok), onRow(n, patch), onNeedLogin() }
 */
async function runReconciliation(o = {}) {
  const cb = o.callbacks || {};
  const say = cb.onProgress || (() => {});
  const row = cb.onRow || (() => {});
  const accountLabel = o.accountLabel || "[TRUST] Trust Account";
  const rows = o.rows || [];
  if (!rows.length) throw new Error("No rows to run.");
  const results = rows.map((r, i) => ({ ...r, n: i + 1 }));
  await fileReceipts(results, {
    auth: { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD },
    cb, say, row,
  });

  /* 2 — only NOW is it safe to hold a page: nothing else will close the
     browser out from under it. */
  const browser = await openBrowser();
  let page;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, cb.onNeedLogin);

    const pageNumber = await openFreshStatementPage(page, {
      accountLabel,
      statementDate: o.statementDate,
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
      say,
    });

    /* 3 — sort, filter, read, match. Nothing else is clicked here. */
    say("Sorting by date descending, then filtering to Client Payment Receipt…");
    const statement = await filterAndRead(page);
    say(`${statement.length} transaction${statement.length === 1 ? "" : "s"} showing after the filter.`);

    const matched = [];
    for (const r of results) {
      const m = core.matchAgainstStatement(r, statement);
      r.reconciliation = m.status;
      r.why = r.error ? r.why : m.reason;
      if (m.duplicates) r.why += ` — ${m.duplicates} transactions carry that number`;
      if (m.reconciled && m.transNo) { r.transNo = m.transNo; matched.push(m.transNo); }
      row(r.n, { reconciliation: r.reconciliation, why: r.why, transNo: r.transNo });
      say(`Row ${r.n}: ${m.status} — ${m.reason}`, m.reconciled);
    }

    /* 4 — the balances, then the ticks, then Done. In that order and all after
       the sort and the filter: sorting rebuilds the page, so anything typed
       before it would be typed into a document that no longer exists. */
    const balances = await setStatementBalances(page, {
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
    }, say);

    const selection = await selectMatchedTransactions(page, statement, matched, say);
    const finished = await finishStatementPage(page, selection.ticked.length, say);

    ok = true;
    return {
      results, pageNumber, statementRows: statement.length,
      summary: core.summarise(results),
      balances, selection, finished,
    };
  } finally {
    // On success close our tab; on failure leave it open so the page that
    // stopped the run is still on screen. Closing a CDP browser only drops the
    // connection — it never closes the user's Chrome.
    if (ok && page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * The Mint daily settlement run.
 *
 * Nothing is filed. Mint settlements are transactions Tramada already holds;
 * the only question is whether each one reached the statement page. So this is
 * the second half of `runReconciliation` on its own — create the page, sort,
 * filter, look each transaction reference up — with no receipt phase at all.
 *
 * Filtered to **Creditor Payment**, sorted date descending. Sort first: it
 * clears the filter.
 *
 * @param {object} o
 *   rows            parsed Mint rows (recon-core.parseMintRows)
 *   statementDate   dd-mm-yyyy or ISO
 *   openingBalance  what the agent typed
 *   closingBalance  what the agent typed
 *   recPayType      defaults to "Creditor Payment"
 *   accountLabel    defaults to the Trust Account
 *   callbacks       { onProgress(msg, ok), onRow(n, patch), onNeedLogin() }
 */
async function runMintReconciliation(o = {}) {
  const cb = o.callbacks || {};
  const say = cb.onProgress || (() => {});
  const row = cb.onRow || (() => {});
  const accountLabel = o.accountLabel || "[TRUST] Trust Account";
  const recPayType = o.recPayType || "Creditor Payment";
  const rows = o.rows || [];
  if (!rows.length) throw new Error("No rows to run.");

  const results = rows.map((r, i) => ({ ...r, n: i + 1 }));
  // Said up front, because "no receipts were created" is a surprising thing to
  // discover afterwards on a screen whose other flow files them.
  say(`${results.length} settlement${results.length === 1 ? "" : "s"} to check. ` +
    "Nothing is filed — this run only looks for them on the statement page.");

  const browser = await openBrowser();
  let page;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, cb.onNeedLogin);

    const pageNumber = await openFreshStatementPage(page, {
      accountLabel,
      statementDate: o.statementDate,
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
      say,
    });

    say(`Sorting by date descending, then filtering to ${recPayType}…`);
    const statement = await filterAndRead(page, recPayType);
    say(`${statement.length} transaction${statement.length === 1 ? "" : "s"} showing after the filter.`);

    const matched = [];
    for (const r of results) {
      const m = core.matchMintAgainstStatement(r, statement);
      r.reconciliation = m.status;
      r.mismatch = m.mismatch;
      r.why = m.reason;
      if (m.duplicates) r.why += ` — ${m.duplicates} transactions carry that number`;
      if (m.reconciled && m.transNo) { r.transNo = m.transNo; matched.push(m.transNo); }
      row(r.n, { reconciliation: r.reconciliation, why: r.why, mismatch: r.mismatch, transNo: r.transNo });
      say(`Row ${r.n}: ${m.status} — ${m.reason}`, m.reconciled);
    }

    const balances = await setStatementBalances(page, {
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
    }, say);

    const selection = await selectMatchedTransactions(page, statement, matched, say);
    const finished = await finishStatementPage(page, selection.ticked.length, say);

    ok = true;
    return {
      results, pageNumber, statementRows: statement.length,
      summary: core.summariseMint(results),
      balances, selection, finished,
    };
  } finally {
    if (ok && page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Both reports, one run, ONE statement page.
 *
 * A freshly created page lists every unpresented transaction on the account —
 * measured, not assumed (docs/tramada-field-map.md: page 10, created empty,
 * immediately showed 4,191 rows going back to 2020). So the BPay receipts this
 * run files and the Mint creditor payments Tramada already holds are both
 * already sitting on the same page. Reconciling them together is not a
 * convenience, it is what the page was always showing.
 *
 * The order is forced by the portal, not chosen:
 *
 *   1. RECEIPTS FIRST, and not concurrently with anything. `runTramadaReceipt`
 *      closes the shared CDP browser in its finally, so nothing else may hold a
 *      page while it runs. This is why "run them in parallel" is not on the
 *      table — the second flow would close the first one's page mid-run with
 *      real receipts already filed.
 *   2. SORT ONCE. `#sortButton` submits and comes back with every tick gone.
 *   3. THEN SWAP THE FILTER PER REPORT. `#filterButton` only hides rows in the
 *      page already on screen, so ticks made under the first filter survive the
 *      second. Client Payment Receipt for the BPay rows, Creditor Payment for
 *      the Mint ones.
 *   4. Balances, then ONE Done for both.
 *
 * A failure in one report does not stop the other, and Done still commits what
 * matched: the receipts that were filed are real whatever happens next, and
 * abandoning the page would leave them unreconciled as well as unexplained.
 */
async function runCombinedReconciliation(o = {}) {
  const cb = o.callbacks || {};
  const say = cb.onProgress || (() => {});
  const row = cb.onRow || (() => {});
  const accountLabel = o.accountLabel || "[TRUST] Trust Account";
  const mintType = o.recPayType || "Creditor Payment";

  // One numbering across both reports: `n` reaches the page and the store, and
  // two rows called 1 would overwrite each other in both.
  const results = [
    ...(o.bpayRows || []).map((r) => ({ ...r, src: "bpay" })),
    ...(o.mintRows || []).map((r) => ({ ...r, src: "mint" })),
  ].map((r, i) => ({ ...r, n: i + 1 }));
  if (!results.length) throw new Error("No rows to run.");

  const bpay = results.filter((r) => r.src === "bpay");
  const mint = results.filter((r) => r.src === "mint");
  say(`${bpay.length} BPay row${bpay.length === 1 ? "" : "s"} and ${mint.length} Mint settlement` +
    `${mint.length === 1 ? "" : "s"}, on one statement page. ` +
    (bpay.length ? "The BPay rows are filed as receipts; " : "") +
    "the Mint rows are only looked for.");

  if (bpay.length) {
    await fileReceipts(bpay, {
      auth: { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD },
      cb, say, row,
    });
  }

  const browser = await openBrowser();
  let page;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, cb.onNeedLogin);

    const pageNumber = await openFreshStatementPage(page, {
      accountLabel,
      statementDate: o.statementDate,
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
      say,
    });

    await sortPage(page);
    let ticked = [];
    let missing = [];
    let futureDated = [];
    let seen = 0;

    // One pass per report: filter, read, match, tick. Ticking inside the pass
    // rather than at the end is deliberate — a row hidden by the NEXT filter
    // cannot be clicked, and Playwright will not click what it cannot see.
    const pass = async (label, rowsForPass, match) => {
      if (!rowsForPass.length) return;
      say(`Filtering to ${label}…`);
      await applyFilter(page, label);
      const statement = await readVisibleTransactions(page);
      seen += statement.length;
      say(`${statement.length} ${label} transaction${statement.length === 1 ? "" : "s"} showing.`);

      const matched = [];
      for (const r of rowsForPass) {
        const m = match(r, statement);
        r.reconciliation = m.status;
        r.mismatch = m.mismatch;
        r.why = r.error ? r.why : m.reason;
        if (m.duplicates) r.why += ` — ${m.duplicates} transactions carry that number`;
        if (m.reconciled && m.transNo) { r.transNo = m.transNo; matched.push(m.transNo); }
        row(r.n, { reconciliation: r.reconciliation, why: r.why, mismatch: r.mismatch, transNo: r.transNo });
        say(`Row ${r.n}: ${m.status} — ${m.reason}`, m.reconciled);
      }
      const sel = await selectMatchedTransactions(page, statement, matched, say);
      ticked = ticked.concat(sel.ticked);
      missing = missing.concat(sel.missing);
      futureDated = futureDated.concat(sel.futureDated);
    };

    await pass("Client Payment Receipt", bpay, core.matchAgainstStatement);
    await pass(mintType, mint, core.matchMintAgainstStatement);

    const balances = await setStatementBalances(page, {
      openingBalance: o.openingBalance,
      closingBalance: o.closingBalance,
    }, say);

    const selection = { ticked, missing, futureDated };
    const finished = await finishStatementPage(page, ticked.length, say);

    ok = true;
    return {
      results, pageNumber, statementRows: seen,
      summary: core.summariseCombined(results),
      balances, selection, finished,
    };
  } finally {
    if (ok && page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runReconciliation, runMintReconciliation, runCombinedReconciliation,
  sortPage, applyFilter, readVisibleTransactions, fileReceipts,
  readExistingPages, createStatement, openFreshStatementPage, filterAndRead,
  setStatementBalances, selectMatchedTransactions, finishStatementPage,
};

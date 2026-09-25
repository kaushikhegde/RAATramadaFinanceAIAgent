"use strict";

/**
 * tramada-dvc.js — steps 12 to 16 of docs/dvc.md, the Tramada half.
 *
 * Steps 4 to 11 are `recon-core.reconcileDvc`: two spreadsheets against each
 * other, no browser, entirely offline. This is what happens afterwards —
 * Finance → Payments → Issue Payment, tick the transactions the reconciliation
 * settled cleanly, and save them as the Payment Session `DVC DD/MM/YYYY`
 * (step 16). It runs straight after the reconciliation, with no click in
 * between — once the two spreadsheets reconcile with no errors (RAA's drawing,
 * 23-09-2026). The session is saved even if Tramada raises something; the
 * accounts team check it, change what needs changing, and Issue.
 *
 * ── What this file is allowed to decide: NOTHING ────────────────────────────
 *
 * Which rows are ticked is `core.planDvcPayment`. Whether to save the session
 * is `core.decideDvcCommit`. Both are pure and tested offline, which is the
 * only reason any of this can be checked without a live financial form (§2).
 * Everything here is pages, clicks and read-backs.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 *   - It never presses Issue. Step 17 is Travel Accounts': they reopen the
 *     session, check it, tick Round Remaining if it needs it, and Issue. Issue
 *     moves money out of the trust account and nothing rolls it back, so
 *     `pressAndCheck` refuses any button whose text says "issue", whatever it
 *     was asked to find.
 *   - It never types a credential. `ensureLoggedIn` waits for a human (§5).
 *   - It never ticks Select All. Only rows a clean DVC line paid, each one
 *     verified after the click, exactly as the statement page does (§6). An
 *     unsure line's row is left untouched for Travel Accounts (step 14).
 *   - It never saves a second session for a day that already has one: that
 *     session is reopened, re-checked and saved again — see `runDvcPayment`.
 *   - It never touches a card number. BR12 names the DVC card by the masked
 *     label Tramada shows in its own dropdown, and `core.assertCardLabel`
 *     refuses anything that looks like a PAN before the browser opens (§4).
 *
 * ── What has not been measured ──────────────────────────────────────────────
 *
 * The search form was measured 18-09-2026 (docs/tokio-marine.md). Below it —
 * the Credit Card field that only appears for this payment category, the
 * results grid, the session label and its button — nothing had. So every
 * one of those is DISCOVERED here, by label or by what a button says, and a run
 * that cannot find one stops and prints what the page actually had. Nothing is
 * addressed by position. `npm run probe:dvc` turns the guesses into measurements.
 */

require("dotenv").config();
const core = require("./recon-core");
const screen = require("./tramada-issue-payments");
const { ensureLoggedIn } = require("./tramada-auth");

const { SEARCH, sleep, clean } = screen;

/** `2026-09-02` → `02-09-2026`, without going through a Date and a timezone. */
function isoToTramadaDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Expected an ISO date, got "${iso}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Type a date and prove it took.
 *
 * `fill` is what the Tokio flow measured working on these two fields, so it is
 * tried first. The fallback is real keystrokes, because a calendar widget that
 * ignores a programmatic value is a thing this portal has done before —
 * PrimeNG's calendars need them (§5) — and the failure mode is silent: the
 * field shows the date, the form submits the one it had.
 */
async function typeDate(page, selector, value, field) {
  await page.fill(selector, "").catch(() => {});
  await page.fill(selector, value).catch(() => {});
  if ((await page.inputValue(selector).catch(() => "")) === value) return value;

  await page.click(selector).catch(() => {});
  await page.fill(selector, "").catch(() => {});
  await page.type(selector, value, { delay: 60 });
  await page.keyboard.press("Tab").catch(() => {});
  await sleep(300);

  const got = await page.inputValue(selector).catch(() => "");
  if (got !== value) {
    throw new Error(
      `${field} would not take "${value}" — the field reads "${got}". A search run on the wrong ` +
      `date range silently omits transactions, so this stops rather than searching.`);
  }
  return got;
}

/* ───────────────────────────────────────────── step 13: the search parameters */

/**
 * BR12's Credit Card field, which the measured capture of this form does not have.
 *
 * The capture was taken with Payment Category on Creditor Payment, and this
 * screen posts itself back when the category changes — so the field is expected
 * to appear only once Agency CC Reimbursement is selected. It is looked for by
 * label, then by an id saying "card", then by a select already offering the
 * card we were given.
 *
 * REFUSING IS THE RIGHT ANSWER WHEN IT IS NOT THERE. Every other parameter can
 * be set and the search will still run; it will just return every agency card's
 * transactions instead of the DVC card's, which is a longer list of other
 * people's payments that looks exactly like a correct one.
 */
async function chooseCreditCard(page, cardLabel, say) {
  const found = await screen.findControl(page, {
    label: "Credit Card",
    idHint: "card",
    optionText: cardLabel,
    tag: "select",
  });
  if (!found.selector) {
    const seen = (found.seen || [])
      .map((s) => `${s.selector}${s.options.length ? ` [${s.options.slice(0, 4).join(" | ")}]` : ""}`)
      .join("\n      ");
    throw new Error(
      `The Issue Payment parameters screen has no Credit Card field that this run could find. ` +
      `BR12 requires one — without it the search returns every agency card, not the DVC card. ` +
      `The selects on the page were:\n      ${seen || "(none)"}`);
  }

  const offered = await screen.optionsOf(page, found.selector);
  const chosen = core.resolveSelectOption(offered, cardLabel, null);
  if (chosen.value == null) {
    throw new Error(
      `Credit Card (${found.selector}, found by ${found.how}) does not offer "${cardLabel}". ` +
      `It offered: ${offered.map((o) => clean(o.text) || "(blank)").join(" | ")}`);
  }
  await screen.pick(page, found.selector, chosen.value, "Credit Card");

  const got = await page.inputValue(found.selector).catch(() => "");
  if (got !== chosen.value) {
    throw new Error(`Credit Card did not stick: set "${chosen.value}", the form reads "${got}".`);
  }
  say(`Credit Card set to "${chosen.text}" (found by ${found.how}).`, true);
  return { selector: found.selector, how: found.how, label: chosen.text, value: chosen.value };
}

/**
 * Step 13. Fill every parameter BR12 fixes, then press Go.
 *
 * Read back before Go, all of it. This screen's whole output is a list, and a
 * list built from the wrong category, the wrong account or the wrong dates is
 * indistinguishable from a right one until somebody has paid it.
 */
async function fillSearch(page, o, say = () => {}) {
  const P = core.DVC_PAYMENT_PARAMETERS;
  const V = core.DVC_ISSUE_PAYMENT_OPTIONS;
  const range = core.dvcDateRange(o.statementDate, o.today);
  if (!range.from) {
    throw new Error(
      `Could not work out the From Segment Created Date from a statement date of ` +
      `"${o.statementDate}". BR13 sets it two days before, and guessing at it would search ` +
      `a range that quietly misses transactions.`);
  }

  const settled = {};
  settled.paymentCategory = await screen.setByLabel(
    page, SEARCH.paymentType, P.paymentCategory, V.paymentCategory, "Payment Category", core);

  /* THE CATEGORY POSTS THE FORM BACK. Changing the bank account on the bank
     statement search does exactly this (docs/tramada-field-map.md), and the
     Credit Card field is only expected to exist for this category at all — so
     everything else is set AFTER the page has settled, or it is set on a form
     that is about to be replaced. */
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);
  await page.waitForSelector(SEARCH.bankAccount, { timeout: 20000 });

  settled.bankAccount = await screen.setByLabel(
    page, SEARCH.bankAccount, P.bankAccount, V.bankAccount, "Bank Account", core);
  settled.creditCard = await chooseCreditCard(page, o.creditCard, say);

  /* BR12 — both level branches blank.
   *
   * AN EMPTY SELECT IS ALREADY BLANK. Measured 22-09-2026: `#level2Branch`
   * cascades off Level 1, so with Level 1 left blank — which is what BR12 asks
   * for — Level 2 comes back holding nothing at all after the category
   * posts the form back. Treating that as "the field is not there" refused a
   * search that was exactly right, which is a rule enforced against a rendering
   * detail rather than against a fact.
   *
   * What is still worth refusing is a branch that is SET and will not clear:
   * that narrows the search to one shop, and a day's DVC transactions come from
   * fourteen of them. */
  for (const [sel, key, field] of [
    [SEARCH.level1Branch, "level1Branch", "Level 1 Branch"],
    [SEARCH.level2Branch, "level2Branch", "Level 2 Branch"],
  ]) {
    if (!(await page.locator(sel).count())) {
      if (sel === SEARCH.level1Branch) throw new Error(`${field} (${sel}) is not on this screen.`);
      settled[key] = { value: "", text: "", how: "not on the screen" };
      continue;
    }
    const offered = await screen.optionsOf(page, sel);
    const hasRealOption = offered.some((o) => String(o.value || "") !== "");
    if (!hasRealOption) {
      const current = await page.inputValue(sel).catch(() => "");
      if (current) {
        throw new Error(
          `${field} (${sel}) reads "${current}" and offers nothing to clear it with. BR12 wants it ` +
          `blank; searching with a branch set returns one shop's transactions out of fourteen.`);
      }
      settled[key] = { value: "", text: "", how: "nothing to choose" };
      continue;
    }
    settled[key] = await screen.setByLabel(page, sel, "", "", field, core);
  }

  settled.from = await typeDate(page, SEARCH.fromCreated, isoToTramadaDate(range.from), "From Segment Created Date");
  settled.to = await typeDate(page, SEARCH.toCreated, isoToTramadaDate(range.to), "To Segment Created Date");

  settled.sortBy = await screen.setByLabel(page, SEARCH.sortBy, P.sortBy, V.sortBy, "Sort by", core);
  settled.sortOrder = await screen.setByLabel(page, SEARCH.sortOrder, P.sortOrder, V.sortOrder, "Sort order", core);

  /* Everything, once more, off the live form. The reads above each happened
     immediately after their own write; this catches a field a LATER write
     knocked over, which is the failure the IPSI receipt form actually had —
     see "FILL THE DEBTOR LAST — the selects wipe it" in the field map. */
  const again = {
    paymentCategory: await page.inputValue(SEARCH.paymentType).catch(() => ""),
    bankAccount: await page.inputValue(SEARCH.bankAccount).catch(() => ""),
    creditCard: await page.inputValue(settled.creditCard.selector).catch(() => ""),
    from: await page.inputValue(SEARCH.fromCreated).catch(() => ""),
    to: await page.inputValue(SEARCH.toCreated).catch(() => ""),
    sortBy: await page.inputValue(SEARCH.sortBy).catch(() => ""),
    sortOrder: await page.inputValue(SEARCH.sortOrder).catch(() => ""),
  };
  const wanted = {
    paymentCategory: settled.paymentCategory.value,
    bankAccount: settled.bankAccount.value,
    creditCard: settled.creditCard.value,
    from: settled.from,
    to: settled.to,
    sortBy: settled.sortBy.value,
    sortOrder: settled.sortOrder.value,
  };
  for (const [k, v] of Object.entries(wanted)) {
    if (again[k] !== v) {
      throw new Error(`${k} did not survive the rest of the form: wanted "${v}", it now reads "${again[k]}".`);
    }
  }

  say(`Issue Payment parameters set — ${P.paymentCategory}, ${P.bankAccount}, ` +
    `${settled.creditCard.label}, segments created ${settled.from} to ${settled.to}, ` +
    `sorted by ${P.sortBy} ${P.sortOrder.toLowerCase()} (BR12, BR13).`, true);

  /* GO OPENS THE RESULTS IN A NEW TAB. Measured 23-09-2026: the search tab
     stays behind, blank below the form, and the grid arrives in a second tab
     at `finance/finance-debtor-refund-payment.htm?isAgencyCreditCardPayment=
     true&…`, titled "Issue Agency Credit Card Reimbursement". Reading the
     original tab is why every earlier probe reported "no grid" on a sandbox
     that had rows to show. So the popup is waited for, and everything after
     this — the grid, the ticks, the session — happens on it.

     Go also disables itself after one click (a `this.clicked` guard), so the
     click is never retried on the same form. */
  const popup = page.context().waitForEvent("page", { timeout: 30000 }).catch(() => null);
  await page.click(SEARCH.go);
  const results = await popup;
  if (results) {
    await results.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1800);
  } else {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1800);
  }

  const banner = await screen.errorBanner(page);
  if (banner) throw new Error(`Tramada refused the Issue Payment search: ${banner}`);
  if (results) {
    const b2 = await screen.errorBanner(results);
    if (b2) throw new Error(`Tramada refused the Issue Payment search: ${b2}`);
  }

  return { ...settled, range, resultsPage: results || page, searchPage: page };
}

/* ─────────────────────────────────────────────── step 14: reading and ticking */

/**
 * The grid, read and turned into rows the plan can reason about.
 *
 * AN EMPTY LIST IS ONLY "NOTHING THERE" WHEN THE SCREEN SAYS SO (§6). Otherwise
 * it means the grid did not render, and a run that treats that as "no
 * outstanding transactions" goes on to report a whole correct day as having
 * nothing to pay.
 */
async function readGrid(page) {
  const grid = await screen.readResultsGrid(page);
  const saysEmpty = () => page.evaluate(() =>
    /no\s+(records|results|transactions|data)|nothing to display|no matching/i
      .test(document.body.innerText || "")).catch(() => false);
  /* KEPT UNDER `tidyError`'S 400 CHARACTERS. The first draft ran to 500 and the
     store, the page and the inbox all showed it cut off mid-word — an error
     that explains itself right up to the part that mattered. The cause goes
     first, the evidence second, so a truncation loses the least.

     THE CAUSE, MEASURED 22-09-2026: this screen returns no grid and no message
     when there is genuinely nothing payable, and so does the Creditor Payment
     category with a valid creditor over a ten-year range — so it is a property
     of the screen, not of DVC. A costing only reaches it once the client's
     receipt has been taken AND allocated against it (docs/tramada-field-map.md,
     "Nothing is payable until the client has paid"). Without naming that, the
     error sends somebody looking for a broken selector. */
  const refuse = (what) => new Error(
    `${what}, and nothing on screen says the search found nothing either — so this is not ` +
    `"no outstanding transactions", which would be a number nobody read (§3). Usually nothing ` +
    `is payable yet: a costing appears here only once the client's receipt is allocated ` +
    `against it. Tables seen: ` +
    (grid.tables && grid.tables.length ? grid.tables.join(" || ")
      : grid.headers.length ? grid.headers.join(" | ") : "(none)").slice(0, 80));

  if (!grid.found) {
    if (await saysEmpty()) return { rows: [], columns: [], headers: [], empty: true };
    throw refuse("No results grid on the Issue Payment screen");
  }

  const parsed = core.parseIssuePaymentRows(grid.headers, grid.rows);
  if (parsed.missingColumns.length) {
    throw new Error(
      `The Issue Payment grid has no column for: ${parsed.missingColumns.join(", ")}. ` +
      `Booking number and amount are what BR03 matches on, and counting columns from a ` +
      `position instead is the bug §6 opens with. Its headers were: ${grid.headers.join(" | ")}`);
  }
  /* A grid that rendered its header row and no body rows lands here, because a
     Select All in the header is a checkbox and `readResultsGrid` takes any
     table that has one. It gets the same treatment as no grid at all. */
  if (!parsed.rows.length && !(await saysEmpty())) throw refuse("The Issue Payment grid came back with no rows");
  return { ...parsed, empty: !parsed.rows.length, headers: grid.headers };
}

/**
 * Step 14 — tick every row a clean DVC line paid, and verify each one.
 *
 * One at a time, addressed by the row's own checkbox rather than its position,
 * because ticking a row on this portal's reconcile screen reorders the table
 * underneath (§6) and step 14 says ticking here fires the handler that
 * auto-fills the amount. A tick that cannot be verified STOPS the run: a
 * half-ticked grid is worse than an untouched one, because it looks finished.
 */
async function tickPlannedRows(page, plan, say = () => {}) {
  const ticked = [];
  const failed = [];
  for (const row of plan.rows) {
    if (!row.tick) continue;
    if (!row.selectId) {
      failed.push({ row, why: "the row's checkbox has no id or name to address it by" });
      continue;
    }
    const out = await screen.tickRow(page, row.selectId);
    if (!out.ticked) {
      failed.push({ row, why: out.why });
      continue;
    }
    row.tickedAt = new Date().toISOString();
    ticked.push(row);
  }

  if (failed.length) {
    throw new Error(
      `${failed.length} of ${plan.ticked} row${plan.ticked === 1 ? "" : "s"} would not tick: ` +
      failed.map((f) => `${core.issuePaymentRowLabel(f.row)} (${f.why})`).join("; ") +
      `. Nothing has been saved — the page is left open so the grid can be looked at.`);
  }

  /* Every tick, read back off the page in one pass. The per-row poll above
     already proved each click landed; this proves they are ALL still on, which
     is a different claim — a screen that reorders rows on click, or that
     reloads the grid, can drop an earlier tick while every individual click
     was genuinely successful. */
  const lost = await page.evaluate((selectors) =>
    selectors.filter((s) => {
      const el = document.querySelector(s);
      return !el || !el.checked;
    }), ticked.map((r) => r.selectId));
  if (lost.length) {
    throw new Error(
      `${lost.length} tick${lost.length === 1 ? "" : "s"} did not survive the rest of the grid. ` +
      `Nothing has been saved.`);
  }

  say(`${ticked.length} transaction${ticked.length === 1 ? "" : "s"} ticked and verified` +
    (plan.left ? `; ${plan.left} left alone` : "") + " (step 14).", true);
  return ticked;
}

/* ───────────────────────────────────────────────── step 16: saving the session */

/**
 * Press a button found by what it says, then ask the page whether it
 * complained.
 *
 * NEVER CONFIRMED BY THE URL (§6): the reconcile screen has two routes and
 * landing on the one that looks like the form you submitted is how a page
 * created perfectly well got reported as a failure.
 */
async function pressAndCheck(page, wantText, what, say) {
  const btn = await screen.findButton(page, wantText);
  if (!btn.selector) {
    throw new Error(
      `No ${what} button on the Issue Payment screen. It had: ` +
      (btn.seen.length ? btn.seen.join(", ") : "(no buttons at all)"));
  }
  /* ISSUE IS NEVER THE BUTTON THIS PRESSES. Found by text, so a pattern loose
     enough to match "Issue" — or a screen that one day labels its button
     "Save and Issue" — would move money on a click meant to save a draft. The
     check is on what was FOUND, not on what was asked for. */
  if (/issue/i.test(btn.text)) {
    throw new Error(`Refusing to press "${btn.text}" (${btn.selector}) while looking for ${what} — ` +
      "the agent never issues a payment; that is Travel Accounts' step 17.");
  }
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click(btn.selector),
  ]);
  await sleep(2000);

  /* A SUCCESS MESSAGE IS NOT A COMPLAINT. Measured 23-09-2026: saving a
     REOPENED session answers "Finance session was saved." in the same
     message box the form uses for errors, and `errorBanner` — which reads that
     box — reported a perfectly good save as a failure. Only that exact kind of
     confirmation is let through; anything else is still a refusal. */
  const banner = await screen.errorBanner(page);
  const confirmedSaved = /\b(session )?was saved\b|saved successfully/i.test(banner || "");
  if (banner && !confirmedSaved) throw new Error(`${what} was pressed and Tramada said: ${banner}`);
  say(`${what} pressed (${btn.selector} "${btn.text}")` + (confirmedSaved ? ` — Tramada: "${banner}"` : "") + ".", true);
  return { pressed: true, selector: btn.selector, text: btn.text };
}

/**
 * The results page's OWN payment header — "Issue Agency Credit Card
 * Reimbursement" over Payment Overview / Payment Details / Document Details —
 * separate from the search parameters `fillSearch` already set two clicks ago.
 *
 * NEVER MEASURED UNTIL A SESSION SAVE FAILED ON IT (RAA, 25-09-2026):
 * "Amount Of Payment must equal the allocated amount" and "Transaction Type
 * must be selected", on a screen `tramada-dvc.js`'s own header used to say
 * stopped at Round Remaining, Session and Issue. It does not: Session
 * validates this header too, even though nothing here is Issued.
 *
 * ONLY THESE TWO ARE THE AGENT'S TO FILL (RAA, 25-09-2026). Payee Name,
 * Reference and Payment Notes are left exactly as they load — blank — for
 * Travel Accounts to fill before Issue; typing a reference or a payee here
 * would be inventing one (§3). Bank Account, Document Template, Document
 * Heading and Document Type are read-only or already correct and are not
 * touched.
 *
 *   Transaction Type    always EFT — DVC's only committed a Payment Session
 *                       when the run's own money agrees to the cent, so a
 *                       cheque or a card is never in play here.
 *   Amount Of Payment   the allocated amount, which on this screen means
 *                       `commit.paidCents` — the same figure the email and
 *                       the run record already call "ticked total", not the
 *                       report's own total, which a partial commit would not
 *                       match.
 *
 * Discovered by label (§6), same as the Credit Card field two steps back —
 * this part of the page has never been probed, so a hard-coded id would be a
 * guess wearing a selector's clothes.
 */
async function fillPaymentHeader(page, { paidCents }, say = () => {}) {
  const txn = await screen.findControl(page, { label: "Transaction Type", idHint: "transactionType", tag: "select" });
  if (!txn.selector) {
    const seen = (txn.seen || []).map((s) => s.selector).join(", ");
    throw new Error(
      `No Transaction Type field on the results page — Session cannot save without it. ` +
      `Selects seen: ${seen || "(none)"}`);
  }
  const setTxn = await screen.setByLabel(page, txn.selector, "EFT", null, "Transaction Type", core);
  say(`Transaction Type set to "${setTxn.text}".`, true);

  const amt = await screen.findControl(page, { label: "Amount Of Payment", idHint: "paymentAmount", tag: "input" });
  if (!amt.selector) {
    throw new Error(`No Amount Of Payment field on the results page — Session cannot save without it.`);
  }
  const amount = core.money(paidCents);
  await page.fill(amt.selector, "").catch(() => {});
  await page.fill(amt.selector, amount).catch(() => {});
  let got = await page.inputValue(amt.selector).catch(() => "");
  if (core.cents(got) !== paidCents) {
    await page.click(amt.selector).catch(() => {});
    await page.fill(amt.selector, "").catch(() => {});
    await page.type(amt.selector, amount, { delay: 40 });
    got = await page.inputValue(amt.selector).catch(() => "");
  }
  if (core.cents(got) !== paidCents) {
    throw new Error(
      `Amount Of Payment would not take "${amount}" (the allocated total) — the field ` +
      `(${amt.selector}) reads "${got}". Nothing has been saved.`);
  }
  say(`Amount Of Payment set to $${amount} — the allocated total.`, true);
  return { transactionType: setTxn, amount };
}

/**
 * Step 16 — type the session label, prove it took, press Session.
 *
 * The label box is found by what it is called rather than by an id nobody had
 * measured when this was written (see `findSessionLabel`), and read back before
 * the button: a session saved under the wrong name is one Travel Accounts
 * cannot find in the morning, which is a session that might as well not exist.
 *
 * Then the page is asked whether the session is REALLY there — by what is on
 * screen afterwards, never by the URL (§6). A save that raised no error banner
 * and left no trace of its label anywhere is reported as unconfirmed rather
 * than as a success.
 */
async function saveSession(page, label, say = () => {}) {
  const box = await findSessionLabel(page);
  if (!box.selector) {
    const seen = (box.seen || []).map((s) => s.selector).join(", ");
    throw new Error(
      `Step 16 needs the session label box and the Issue Payment screen has none this run could ` +
      `find. Nothing was saved. Text inputs on the page: ${seen || "(none)"}`);
  }
  await page.fill(box.selector, "").catch(() => {});
  await page.fill(box.selector, label);
  let got = await page.inputValue(box.selector).catch(() => "");
  if (got !== label) {
    await page.click(box.selector).catch(() => {});
    await page.fill(box.selector, "").catch(() => {});
    await page.type(box.selector, label, { delay: 40 });
    got = await page.inputValue(box.selector).catch(() => "");
  }
  if (got !== label) {
    throw new Error(`The session label would not take "${label}" — the box (${box.selector}) reads ` +
      `"${got}". Nothing was saved.`);
  }

  const pressed = await pressAndCheck(page, "^\\s*(save\\s+)?session\\s*$", "Session", say);

  /* CONFIRMED ON TRAMADA'S OWN LIST OF SESSIONS, not on the page the button
     left behind. Finance → Payment Sessions
     (`finance/finance-sessions-payments.htm`, measured 23-09-2026) lists every
     saved session with its label in the Info. column — the same list Travel
     Accounts reopen it from, so it is the one place whose answer matters. */
  const listed = await findSavedSessions(page, label).catch(() => []);
  const confirmed = listed.length === 1;
  if (listed.length > 1) {
    /* A REOPENED SESSION SAVED AS A SECOND ONE. Not observed yet — pressing
       Session on a reopened session has not been measured — and if Tramada
       ever does this, there are now two sessions a person could Issue over the
       same charges. Said as loudly as the run can say anything. */
    say(`Tramada now lists ${listed.length} sessions called "${label}". Cancel all but the newest in ` +
      "Finance → Payment Sessions before anyone Issues — two sessions would pay the same charges twice.", false);
  } else if (!confirmed) {
    say(`Session pressed, and Tramada raised no error — but "${label}" is not on Finance → Payment ` +
      "Sessions afterwards, so the save is unconfirmed. Check the session list before relying on it.", false);
  }
  return { ...pressed, labelSelector: box.selector, label, confirmed, duplicates: Math.max(0, listed.length - 1) };
}

const SESSIONS_URL = () => `${screen.TRAMADA_BASE_URL}/finance/finance-sessions-payments.htm?mode=edit&id=1`;

/**
 * Every Payment Session on Finance → Payment Sessions carrying this label, with
 * the link that reopens it.
 *
 * TRAMADA'S LIST IS THE AUTHORITY, NOT THE RUN HISTORY. Measured 23-09-2026:
 * the run store recorded "DVC 24/09/2026" as saved and refused the re-run,
 * while the session had been cancelled in Tramada and was not on this list at
 * all. Whether a session exists is a fact about Tramada, so it is read here.
 *
 * Each row carries a "View Payment" link (title attribute, measured on the
 * Tokio Marine session: `finance-creditor-payment.htm?…&isFinanceSession=true&
 * entitySessionId=8…`) and a "Cancel Finance Session" link beside it. ONLY the
 * View link is ever returned — the cancel link is not so much as read.
 *
 * Read in a tab of its own, so whatever page the caller is on stays as it was.
 */
async function findSavedSessions(page, label) {
  const tab = await page.context().newPage();
  try {
    await tab.goto(SESSIONS_URL(), { waitUntil: "domcontentloaded" });
    await sleep(1200);
    return await tab.evaluate((label) => {
      const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const out = [];
      for (const tr of document.querySelectorAll("tr")) {
        if (tr.querySelector("table")) continue;
        const cells = [...tr.children].map((c) => norm(c.textContent));
        if (!cells.includes(label)) continue;
        const view = [...tr.querySelectorAll("a")].find((a) => /view payment/i.test(a.title || ""));
        out.push({ cells, viewHref: view ? view.href : "" });
      }
      return out;
    }, label);
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Is exactly one session with this label on the list? Never throws. */
async function sessionListed(page, label) {
  const found = await findSavedSessions(page, label).catch(() => []);
  return found.length === 1;
}

/**
 * The session label box (`#sessionLabel`, "Session Label", measured
 * 23-09-2026). Label first, then an id or name saying "session".
 * `findControl` is shared with the Credit Card lookup and refuses loudly with
 * everything it did see, which is the only useful thing to print when Tramada
 * renames a field.
 */
async function findSessionLabel(page) {
  for (const label of ["Session Label", "Session Name", "Session"]) {
    const found = await screen.findControl(page, { label, idHint: "session", tag: "input" });
    if (found.selector) return found;
    if (label === "Session") return found;
  }
  return { selector: null, seen: [] };
}

/* ───────────────────────────────────────────────────────────────── the run */

/**
 * Steps 12 to 16, end to end. Step 17 — Issue — is a person's.
 *
 * `dryRun` defaults TRUE and means what it means everywhere else in this
 * project: everything happens for real except the click that makes it
 * permanent. The search runs, the grid is read, the rows are ticked and
 * verified — and the page is left on screen with this run's own rows ticked on
 * it, with Session not pressed.
 *
 * A DAY THAT ALREADY HAS A SESSION IS REOPENED AND RE-CHECKED (RAA,
 * 23-09-2026): found on Tramada's own Payment Sessions list, opened through its
 * View Payment link, ticked where it is confident now, and saved again. Two
 * sessions with one label is refused before anything is touched.
 */
async function runDvcPayment(o = {}) {
  const cb = o.callbacks || {};
  const say = cb.onProgress || (() => {});
  const stage = cb.onStage || (() => {});
  const dryRun = o.dryRun !== false;

  /* §4, BEFORE THE BROWSER OPENS. A PAN that got this far would already be in
     the run's arguments, and every throw below quotes its inputs. */
  const cardLabel = core.assertCardLabel(o.creditCard, "Credit Card");
  if (!cardLabel) {
    throw new Error(
      "Step 13 needs the Credit Card to select on the Issue Payment screen — BR12's " +
      "\"[card] CA – A – Westpac DVC VCC\" as Tramada's dropdown writes it. Without it the " +
      "search returns every agency card's transactions.");
  }

  /* THE SAME GATE AGAIN, AND NOT BY ACCIDENT. `server.js` checks this before
     it calls in; a second caller — a tool, a probe, a future flow — that got
     the order wrong still cannot open a browser to tick nothing. */
  const gate = core.dvcTramadaGate(o.dvcSummary, o.totalCheck);
  if (!gate.open) {
    throw new Error(`Steps 12-16 were not run: ${gate.why}. Nothing has been opened in Tramada.`);
  }

  const browser = await screen.openBrowser((pct, msg) => say(msg, true));
  let page;
  let searchPage = null;
  let ok = false;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, {
      auth: o.auth,
      onNeedLogin: cb.onNeedLogin,
      onLoginOk: cb.onLoginOk,
      onProgress: say,
    });

    /* IS THERE ALREADY A SESSION FOR THIS DAY? Asked of Tramada's own list
       before anything else (see findSavedSessions). */
    const label = core.dvcSessionLabel(o.statementDate);
    const existing = await findSavedSessions(page, label);
    if (existing.length > 1) {
      throw new Error(`Tramada already lists ${existing.length} Payment Sessions called "${label}". Cancel all ` +
        "but one in Finance → Payment Sessions first — re-checking either would leave two sessions a person " +
        "could Issue over the same charges. Nothing was touched.");
    }
    const reopened = existing.length === 1;
    let settled;
    if (reopened) {
      if (!existing[0].viewHref) {
        throw new Error(`Payment Session "${label}" is on the list but has no View Payment link to reopen it ` +
          "by. Nothing was touched.");
      }
      say(`Payment Session "${label}" already exists — reopening it to check again.`, true);
      await page.goto(existing[0].viewHref, { waitUntil: "domcontentloaded" });
      await sleep(1800);
      const banner = await screen.errorBanner(page);
      if (banner) throw new Error(`Tramada would not reopen "${label}": ${banner}`);
      stage("dvc_payment_screen", { url: page.url(), reopened: true });
      settled = { reopened: true };
    } else {
      // Step 12.
      await screen.openIssuePayments(page, (pct, msg) => say(msg, true));
      stage("dvc_payment_screen", { url: page.url() });

      // Step 13.
      settled = await fillSearch(page, {
        statementDate: o.statementDate, today: o.today, creditCard: cardLabel,
      }, say);
      /* From here on the RESULTS tab is the page (see fillSearch). The search
         tab has done its job; it is closed at the end with the rest. */
      searchPage = page;
      page = settled.resultsPage;
    }

    // Step 14 — read, decide, tick.
    const grid = await readGrid(page);
    if (grid.empty) {
      /* LEFT OPEN ON PURPOSE, unlike every other clean finish. "Nothing
         outstanding" is the one result somebody will want to see for
         themselves — it is how a run reports a whole correct day as having
         nothing to pay — so the search that produced it stays on screen. */
      say("The Issue Payment search came back with no outstanding transactions for that range, " +
        "and the screen says so. Nothing to tick. The page is left open so the search can be " +
        "checked.", false);
      return {
        ranSearch: true, settled, grid, plan: null, saved: false,
        commit: core.decideDvcCommit({ plan: null, dvcSummary: o.dvcSummary, totalCheck: o.totalCheck,
          statementDate: o.statementDate, dryRun, reopened }),
      };
    }
    say(`${grid.rows.length} outstanding transaction${grid.rows.length === 1 ? "" : "s"} on the ` +
      `Issue Payment grid (columns: ${grid.columns.join(", ")}).`, true);

    const plan = core.planDvcPayment(o.dvcRows || [], grid.rows, { toleranceCents: o.toleranceCents });
    stage("dvc_payment_plan", {
      ticked: plan.ticked, left: plan.left, exceptions: plan.exceptions,
      outsideReport: plan.outsideReport, missingFromGrid: plan.missingFromGrid,
    });
    for (const m of plan.missingFromGrid) say(m.why, false);

    /* DECIDED BEFORE ANYTHING IS TICKED. An earlier session for this day, or a
       plan with nothing in it, means this run saves nothing — and a grid left
       covered in ticks nobody is going to save is worse than one left alone. */
    const commit = core.decideDvcCommit({
      plan, dvcSummary: o.dvcSummary, totalCheck: o.totalCheck,
      statementDate: o.statementDate, dryRun, reopened,
    });
    for (const e of commit.errors) say(e, false);

    let ticked = [];
    let saved = null;
    if (commit.wanted === core.DVC_COMMIT.session) {
      ticked = await tickPlannedRows(page, plan, say);
      if (commit.action === core.DVC_COMMIT.session) {
        // The page's own header validates on Session too, not only on Issue —
        // see `fillPaymentHeader`. After ticking, so nothing left to touch the
        // page runs between filling it and pressing Session.
        await fillPaymentHeader(page, { paidCents: commit.paidCents }, say);
        saved = await saveSession(page, commit.sessionLabel, say);
      }
    } else {
      say("Nothing was ticked — this run is not going to save a session, and a grid left covered " +
        "in ticks nobody saved is worse than one left alone.", false);
    }

    say(commit.why, !!saved || commit.held === "dry run");
    stage("dvc_payment_done", {
      action: saved ? commit.action : core.DVC_COMMIT.nothing, held: commit.held, ticked: plan.ticked,
      paidCents: commit.paidCents, complete: commit.complete, errors: commit.errors,
    });

    /* CLOSED ONCE THE SESSION IS SAVED — it is in Tramada now, and the person
       who Issues it reopens it from there. A dry run's page stays up: its whole
       point is to be looked at. */
    ok = !!saved;
    return { ranSearch: true, settled, grid, plan, ticked: ticked.length, commit,
      saved: !!saved, session: saved, reopened };
  } catch (err) {
    if (cb.onError) cb.onError(err.message);
    throw err;
  } finally {
    /* CLOSE ON SUCCESS, LEAVE IT OPEN ON FAILURE (§5). A run that stopped
       half way through the grid is a page somebody needs to look at, and
       closing it takes away the only evidence of what went wrong. */
    if (ok && page) await page.close().catch(() => {});
    /* The emptied search tab is never evidence of anything — the results tab
       is — so it goes whichever way the run ended. */
    if (searchPage && searchPage !== page) await searchPage.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runDvcPayment,
  // Exported so tools/probe-dvc-payment.js drives the REAL code rather than a
  // copy of it. A probe that reimplements what it is probing succeeds exactly
  // where the real path fails.
  isoToTramadaDate,
  fillSearch,
  chooseCreditCard,
  readGrid,
  tickPlannedRows,
  fillPaymentHeader,
  saveSession,
  findSessionLabel,
  findSavedSessions,
  screen,
};

/**
 * tramada-receipt.js — Playwright + CDP receipt automation for the chat flow.
 *
 * Companion to tramada-booking.js. Where that module ADDS a booking, this one
 * records a RECEIPT against an existing booking:
 *
 *   resolve booking (by number, or search + pick from a list)
 *     -> confirm booking details
 *       -> guard: an itinerary segment must exist & be costed
 *         -> Booking Transactions > Receipts > Add/Issue Receipt
 *           -> fill (Cash / EFT / Credit Card), allocate to segment(s)
 *             -> preview -> issue -> read back the new Receipt No.
 *
 * All selectors were mapped live against the raatravelsandbox TTMS (v7.10.3);
 * see docs/tramada-receipt-workflow.md for the field map.
 *
 * Reuses the shared CDP Chrome (start-chrome.sh, port 9222) so it runs in the
 * SAME already-logged-in browser as the rest of the flow. Because it attaches
 * to a live session and skips login when one exists, a warm Tramada session
 * means no repeated OTP challenge.
 */

const { chromium } = require("playwright");
/* The one rule this module asks for rather than deciding itself: "has this
   exact receipt already been filed?" is a judgement about money, so it lives in
   recon-core with the rest of them and is tested offline. */
const core = require("./recon-core");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "external";
/* Chrome by default, Edge when that is what the machine has. Playwright takes
   "msedge" as a channel and drives it identically — Edge is Chromium. RAA's
   machines default to Edge, and `channel: "chrome"` on a machine without Chrome
   fails at launch with a Playwright error about a missing browser rather than
   anything a person can act on. Override with BROWSER_CHANNEL=msedge. */
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "1,234.50" -> 123450, and "" -> null.
 *
 * Money is compared in whole cents here for the same reason it is everywhere
 * else in this project: 0.1 + 0.2 is not 0.3, and an allocation that is one
 * float-hair over the receipt is rejected by Tramada exactly as hard as one
 * that is a hundred dollars over.
 */
const centsOf = (v) => {
  const s = String(v == null ? "" : v).replace(/[^0-9.-]/g, "");
  if (!/\d/.test(s)) return null;
  const neg = s.trim().startsWith("-");
  const [whole, frac = ""] = s.replace(/-/g, "").split(".");
  const n = Number(whole || "0") * 100 + Number(`${frac}00`.slice(0, 2));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
};

// Tramada Transaction Type dropdown values (receipt.transactionTypeCode).
const TXN_TYPE = {
  CASH: "CA",
  CHEQUE: "CQ",
  CREDIT_CARD: "CC", // "Credit Card CCCF"
  CREDIT_CARD_SWIPE: "CS",
  EFT: "ET",
};

// yyyy-mm-dd -> dd-mm-yyyy (Tramada date input format). Passes through
// values already in dd-mm-yyyy, and defaults blank to today.
function toTramadaDate(input) {
  if (!input) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  /* Delegated to recon-core, which is where every other date in this project is
     read. There used to be a second implementation here that understood
     yyyy-mm-dd and passed everything else through — including RAA's own
     07-01-26, straight into a live receipt's Date Received field. Two date
     parsers is one too many when one of them is typing into a finance system. */
  return core.toTramadaDate(input);
}

// Normalise a caller-supplied transaction type to a Tramada code.
function resolveTxnType(t) {
  if (!t) return TXN_TYPE.CASH;
  const key = String(t).toUpperCase().replace(/[\s-]+/g, "_");
  if (TXN_TYPE[key]) return TXN_TYPE[key];
  // Accept raw codes too (CA/CQ/CC/CS/ET)
  const raw = String(t).toUpperCase();
  if (Object.values(TXN_TYPE).includes(raw)) return raw;
  // Common aliases
  if (/CARD/.test(raw)) return TXN_TYPE.CREDIT_CARD;
  if (/CASH/.test(raw)) return TXN_TYPE.CASH;
  if (/EFT|TRANSFER|BANK/.test(raw)) return TXN_TYPE.EFT;
  return TXN_TYPE.CASH;
}

function isCreditCard(code) {
  return code === TXN_TYPE.CREDIT_CARD || code === TXN_TYPE.CREDIT_CARD_SWIPE;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Browser / login (mirrors tramada-booking.js)
 * ──────────────────────────────────────────────────────────────────────── */

async function openBrowser(onProgress) {
  const launchChrome = async () => {
    const browser = await chromium.launch({
      channel: BROWSER_CHANNEL,
      headless: HEADLESS,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return { browser, launched: true };
  };

  if (CDP_MODE === "internal") {
    onProgress(5, `Launching Chrome (${BROWSER_CHANNEL})...`);
    return await launchChrome();
  }

  onProgress(5, `Connecting to CDP Chrome at ${CDP_HOST}:${CDP_PORT}...`);
  try {
    const browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    return { browser, launched: false };
  } catch (cdpErr) {
    // Fail honestly rather than launching an unauthenticated throwaway Chrome.
    // Shown in the reconciliation inbox's Why column now, not only in a
    // terminal — so it reads as a sentence rather than as shouting.
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and sign into Tramada in that window first. [${cdpErr.message}]`
    );
  }
}

/**
 * Ensure we have an authenticated Tramada session on `page`.
 * If credentials are supplied and we land on login.htm, it logs in.
 * If the session is already warm (attached CDP Chrome), it just returns —
 * so a browser a human already signed into (past OTP) is reused as-is.
 */
/**
 * Signed in? Asked of a PROTECTED page, and answered by what is ON it.
 *
 * The URL alone is not enough in either direction. `login.htm` serves the form
 * even when authenticated, which reads as logged out; and — measured
 * 17-Aug-2026 — an expired session serves the LOGIN FORM at the protected URL
 * you asked for, with the address bar still saying `booking-search.htm`. A
 * URL-only check answers "signed in" to that, `ensureLoggedIn` returns
 * immediately, and every row of the run then fails with "could not be opened"
 * while nothing ever asks the human to sign in. That is exactly what a whole
 * run did before this was tightened.
 *
 * So: the presence of a password field is the answer.
 */
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  if (page.url().includes("login.htm")) return false;
  const showingLogin = await page
    .evaluate(() => !!document.querySelector("input[type=password], #loginForm_login"))
    .catch(() => false);
  return !showingLogin;
}

/* The same question as tramadaIsAuthed, asked WITHOUT touching the page.
   tramadaIsAuthed NAVIGATES, and the wait loop below asks every three seconds —
   on the very tab the human is typing their password into. Every ask reloaded
   the login form and wiped both fields, so the login page appeared to reload
   forever and there was no way to sign in at all. It went unnoticed while the
   workflow was "sign in first, then start a run"; it became the only path the
   moment the app started showing the login screen itself.

   This shares the browser's cookie jar, so it sees the same session no matter
   which tab the login happened in, and it never navigates anything. */
async function tramadaIsAuthedQuietly(page) {
  try {
    const res = await page.request.get(`${TRAMADA_BASE_URL}/home/home.htm`, { timeout: 15000 });
    // The URL is not the answer, for the same reason tramadaIsAuthed above stops
    // trusting it: measured 25-08-2026, signed out this GET comes back 200 with
    // the address still .../home/home.htm and the LOGIN FORM in the body — no
    // redirect to login.htm. A url-only check read that as "signed in", so the
    // wait loop's confirm-navigation fired every three seconds and reloaded the
    // login form under the human, wiping the password before it could be typed.
    // So read the BODY the way tramadaIsAuthed reads the DOM: a password field
    // or the login form means NOT signed in, whatever the address bar says.
    if (res.url().includes("login.htm")) return false;
    const body = await res.text();
    const showingLogin =
      /type=["']?password|name=["']?password|loginForm_login|action=["'][^"']*login\.htm/i.test(body);
    return !showingLogin;
  } catch {
    // A probe that could not run has not proved anything — least of all that
    // somebody is signed in (CLAUDE.md §6).
    return false;
  }
}

async function ensureLoggedIn(page, { username, password, onNeedLogin, onLoginOk } = {}) {
  if (await tramadaIsAuthed(page)) return; // warm session — nothing to do

  if (username && password) {
    await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#loginForm_password", password);
    await page.click("#loginForm_login");
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 }).catch(() => {});
    if (page.url().includes("login.htm")) throw new Error("Tramada login failed (check credentials / OTP).");
    await sleep(500);
    return;
  }

  // No credentials — ask the user to sign in and WAIT (don't quit the run).
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await tramadaIsAuthedQuietly(page))) continue;
    /* Signed in. This tab is still on the login form, so put it on a real page
       and confirm THERE — the probe proves the session is good, not that this
       tab is usable. The only navigation in the whole wait, and it happens
       after the human has finished. */
    if (!(await tramadaIsAuthed(page))) continue;
    await sleep(500);
    // Paired with onNeedLogin above: the page put a login screen up on that
    // frame and only this one takes it down. The credentialed branch returns
    // earlier without either, which is right — it never asked anybody.
    if (typeof onLoginOk === "function") onLoginOk();
    return;
  }
  throw new Error("Timed out waiting for Tramada login. Sign in to the shared Chrome and try again.");
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 1 — resolve the booking (req 5)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Search bookings and return a list to show in chat when the user has no
 * booking number. Returns [{bookingNo, clientName, debtorName, itinerary,
 * depDate, retDate, finalTkt}].
 *
 * @param {object} opts { status?: NEW|QUOTE|BOOKED|FINALISED|CANCELLED, clientName?, bookingNo? }
 */
// Fill a sidebar search field located by its LABEL text (the input ids vary
// per tenant; the labels don't). Sets value with proper events.
async function fillSearchFieldByLabel(page, labelText, value) {
  if (!value) return false;
  return await page.evaluate((arg) => {
    const leaves = Array.from(document.querySelectorAll("body *")).filter(
      (n) => n.children.length === 0 && (n.textContent || "").trim().toLowerCase() === arg.label.toLowerCase()
    );
    for (const lb of leaves) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      walker.currentNode = lb;
      let n;
      while ((n = walker.nextNode())) {
        if (n.tagName === "INPUT" && (!n.type || n.type === "text")) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(n, arg.value);
          n.dispatchEvent(new Event("input", { bubbles: true }));
          n.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, { label: labelText, value: String(value) });
}

async function searchBookings(page, opts = {}) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#searchButton", { timeout: 15000 });

  const hasFilters = !!(opts.status || opts.bookingNo || (opts.clientName || "").trim());

  // NO filters → the landing page ALREADY shows "Recently Accessed Bookings".
  // Clicking Search with empty criteria returns an empty set on this tenant
  // (which read as "No bookings found") — so just scrape the recent list.
  if (!hasFilters) {
    await sleep(600);
    return await scrapeBookingList(page);
  }

  if (opts.status) {
    await page.selectOption("#searchForm_bookingStatus", opts.status).catch(() => {});
  }
  if (opts.bookingNo) {
    await fillSearchFieldByLabel(page, "Booking No", opts.bookingNo);
  }
  if (opts.clientName) {
    await fillSearchFieldByLabel(page, "Client Name", opts.clientName);
  }

  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  return await scrapeBookingList(page);
}

// Scrape whichever table carries the "Bkg No" header (search results or the
// default "Recently Accessed Bookings" list).
async function scrapeBookingList(page) {
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Bkg\s*No/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 6) {
            out.push({
              bookingNo: clean(c[1]),
              clientName: clean(c[2]),
              debtorName: clean(c[3]),
              itinerary: clean(c[4]),
              depDate: clean(c[5]),
              retDate: clean(c[6]),
              finalTkt: clean(c[7]),
            });
          }
        }
        return out;
      }
    }
    return [];
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 2 — booking details (req 1)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Open a booking by its number and scrape the header details for confirmation.
 * The booking id in Tramada URLs IS the booking number, so we navigate directly.
 */
async function getBookingDetails(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);

  const details = await page.evaluate(() => {
    // The left header block uses <b>Label:</b> value pairs; read the sidebar text.
    const bodyText = document.body.innerText;
    /* THE LABEL HAS TO END WHERE IT SAYS IT ENDS.
     *
     * Without the \b this matched "Debtor" inside "Debtors" — the Finance nav
     * item, which appears above the booking header — and captured the "s" as
     * the value. Measured on a live run 17-Aug-2026: every row came back
     * "Please review, incorrect debtor found — the debtor is \"s\"", so BR05
     * stopped receipts that were perfectly fine. A label that gates money is
     * not a substring search.
     *
     * The value is allowed to sit on the next line, because these headers
     * render as a label above its field as often as beside it, and a lone
     * newline between the two is not a different field. */
    const grab = (label) => {
      const re = new RegExp("(?:^|\\n)\\s*" + label + "\\b\\s*:?[ \\t]*\\n?[ \\t]*([^\\n]+)", "i");
      const m = bodyText.match(re);
      const v = m ? m[1].trim() : "";
      // A label immediately followed by the next label is an empty field, not a
      // field whose value happens to be the word "Debtor".
      return /^[A-Za-z][A-Za-z0-9 .]*:$/.test(v) ? "" : v;
    };
    const clientName = grab("Client Name");
    return {
      bookingNo: grab("Booking No\\.?"),
      client: grab("Client"),
      clientName,
      /* The DEFAULT payer name, not a rule. This used to carry a comment
         calling it a business rule; the BPay guide's BR06 says a BPay
         receipt's payer name is the literal "BPAY", and the BPay run now
         passes that explicitly. This stays as the fallback for a caller that
         names no payer of its own. */
      payerName: clientName,
      // Step 6 / BR05 reads this. It is never COMPARED here — the decision is
      // pure and lives in recon-core, where it can be tested without a browser.
      debtor: grab("Debtor"),
      itinerary: grab("Itinerary"),
      bookDate: grab("Book\\.? Date"),
      // Step 4 / BR02 / BR04.
      depDate: grab("Dep\\.? Date"),
      /* Step 7 — the travel consultant, off the summary header. The guide
         sends you to the Cons1 field and Cons1 is on THIS page, so the name
         costs no extra navigation. */
      consultant: grab("Cons1"),
    };
  });

  const loaded = !page.url().includes("booking-search") && !!details.bookingNo;
  if (!loaded) {
    /* SAY WHICH of the two it was. "could not be opened" is true of a booking
       that does not exist AND of a session that has quietly expired, and those
       need opposite things from the person reading it — one is a bad row in the
       file, the other is "go and sign in". Measured against a real run on
       17-Aug-2026, where every row failed this way and the log could not say
       that Tramada had simply logged the browser out. */
    const url = page.url();
    const looksLikeLogin = /login|signin|sso/i.test(url) ||
      (await page.locator("#loginForm_login, input[type=password]").count().catch(() => 0)) > 0;
    throw new Error(looksLikeLogin
      ? `Booking ${bookingNo} could not be opened — Tramada showed a login page instead. ` +
        `Sign in to the Chrome window on port ${CDP_PORT || "9222"} and run this again.`
      : `Booking ${bookingNo} could not be opened — Tramada returned a page with no booking ` +
        `number on it (${url.split("?")[0]}). Check the booking number is right.`);
  }
  return details;
}

/**
 * Steps 8 and 9 — the RAA shop branch, from the booking's Profile page.
 *
 * READ THE CONTROL, NEVER THE PAGE TEXT. This is the whole lesson of this
 * function and it cost a wrong answer on every booking to learn.
 *
 * `document.body.innerText` renders a `<select>` as ALL of its options, one per
 * line. Reading "the line after the Level 1 Branch label" therefore returns the
 * FIRST OPTION IN THE LIST — `[ADL] RAA Adelaide` — for every booking in the
 * system, whatever is actually selected. Booking 13394 is a West Croydon
 * booking and reported ADL, and it looked entirely plausible in the report
 * because ADL is a real branch.
 *
 * Worse, there is a decoy: the Consultant 1 dropdown on the same page reads
 * "Kaushik Hegde [ADL]" — the CONSULTANT's home branch, not the booking's. A
 * text scrape that wandered a few lines either way would find a bracketed code
 * that is real, wrong, and impossible to spot in a spreadsheet.
 *
 * So both fields come from `options[selectedIndex]` of a named control:
 *   #level1Branch   [WEST] RAA West Croydon      → the booking's branch
 *   #retailDebtor   RAA of SA Limited (Retail)   → BR05, from a select rather
 *                                                  than from prose
 * Measured live on booking 13394, 17-Aug-2026.
 *
 * The guide says the shortcode alone is enough ("[ADL]", "[COL]", "[WEST]"), so
 * `branchCode` pulls the bracketed code out of the label.
 *
 * NEVER THROWS. A branch that cannot be read is a blank cell and a note in the
 * log — the receipt does not depend on it, and a booking whose profile renders
 * differently must not stop money being receipted.
 */
async function getBookingBranch(page, bookingNo) {
  try {
    await page.goto(
      `${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForSelector("#level1Branch", { timeout: 15000 }).catch(() => {});
    await sleep(300);
    return await page.evaluate(() => {
      const chosen = (el) => {
        if (!el) return "";
        const o = el.options ? el.options[el.selectedIndex] : null;
        return o ? (o.text || "").trim() : "";
      };
      // Measured on booking 13394, 17-Aug-2026.
      let branch = chosen(document.querySelector("#level1Branch"));
      let debtor = chosen(document.querySelector("#retailDebtor"));

      // Fallback by label, still reading the CONTROL and never the page text.
      if (!branch) {
        const label = [...document.querySelectorAll("label, td, th, span, div")]
          .find((e) => /^\s*Level\s*1\s*Branch\s*$/i.test(e.textContent || ""));
        const holder = label && (label.parentElement || label);
        const sel = holder && (holder.querySelector("select") ||
          (holder.nextElementSibling && holder.nextElementSibling.querySelector
            ? holder.nextElementSibling.querySelector("select") : null));
        branch = chosen(sel);
      }
      return { branch, debtor };
    });
  } catch {
    return { branch: "", debtor: "" };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Guard — an itinerary segment must exist before a receipt can be raised
 * ──────────────────────────────────────────────────────────────────────── */

async function getItinerarySegments(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-itineraries.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Seg\.?\s*Type/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        const segs = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 3) {
            segs.push({ segType: clean(c[1]), reference: clean(c[2]) });
          }
        }
        return segs;
      }
    }
    return [];
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 3 — the receipt form
 * ──────────────────────────────────────────────────────────────────────── */

// Read the "Segments To Allocate" table on the open receipt form:
// [{ segId, segType, reference, debtorDue }]
async function readAllocatableSegments(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[id^="allocationAmount_"]').forEach((inp) => {
      const segId = inp.id.replace("allocationAmount_", "");
      const row = inp.closest("tr");
      const cells = row ? Array.from(row.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
      // Column layout, read off the live form 06-Aug-2026:
      //   0 D | 1 Seg. Type | 2 Invoice No. | 3 Reference | 4 Creditor ID
      //   5 Debtor Invoiced | 6 Debtor Receipted | 7 Debtor Due | 8 Allocate | 9 A
      //
      // debtorDue was cells[6] — "Debtor RECEIPTED", which is 0.00 on a booking
      // nothing has been receipted against yet. Every allocate-or-not decision
      // therefore compared against $0.00 and refused to allocate anything. It
      // went unnoticed because the existing flows pass allocation:"ALL", which
      // clicks Select All and lets Tramada fill the amounts — they never read
      // this figure. The reconciliation run is the first caller that does.
      out.push({
        segId,
        segType: cells[1] || "",
        reference: cells[3] || "",
        debtorInvoiced: cells[5] || "",
        debtorReceipted: cells[6] || "",
        debtorDue: cells[7] || inp.value || "",
      });
    });
    return out;
  });
}

/**
 * Open a fresh Debtor Payment Receipt form for a booking and fill the header
 * fields. Returns the list of allocatable segments so the caller can allocate.
 */
// Set a field with native setter + input/change/blur events — the method the
// two successful hand-driven receipts used (matches the browser extension's
// form_input). Plain Playwright fill() skips the change handlers Tramada uses.
async function setFieldWithEvents(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
  }, String(value));
}

/**
 * Every receipt already on the booking, read BY HEADER NAME.
 *
 * The list this reads is the one the run is standing on anyway — the receipts
 * page it opens to reach "Add / Issue Receipt" — so nothing extra is loaded to
 * find out what is already there.
 *
 * `readLatestReceipt` reads the same grid by hard-coded column index. That one
 * is checking a row it just created, one field, immediately; this one decides
 * whether real money gets taken again, so it asks the header.
 */
async function readBookingReceipts(page) {
  const grid = await page.evaluate(() => {
    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const table = [...document.querySelectorAll("table")]
      .find((t) => /receipt\s*no/i.test(t.textContent) && /reference/i.test(t.textContent));
    if (!table) return { headers: [], rows: [] };
    const trs = [...table.querySelectorAll("tr")];
    const head = trs.find((tr) => /receipt\s*no/i.test(tr.textContent));
    if (!head) return { headers: [], rows: [] };
    return {
      headers: [...head.children].map((c) => norm(c.textContent)),
      // The TOTALS row has no receipt number and must not read as a receipt.
      rows: trs.filter((tr) => tr !== head && tr.querySelectorAll("td").length >= 5)
        .map((tr) => [...tr.querySelectorAll("td")].map((td) => norm(td.textContent)))
        .filter((cells) => cells.some((c) => /^R\./i.test(c))),
    };
  }).catch(() => ({ headers: [], rows: [] }));

  const cols = core.mapColumns(grid.headers, core.BOOKING_RECEIPT_COLUMNS);
  return grid.rows.map((cells) => {
    const out = {};
    for (const [key, i] of Object.entries(cols)) out[key] = i >= 0 ? cells[i] || "" : "";
    return out;
  });
}

async function openReceiptForm(page, bookingNo, receipt) {
  // PROVEN PATH: open the Receipts list and click "Add / Issue Receipt".
  // (Navigating straight to the form URL once ended in a Tramada server error
  // on Issue — the button flow is what both successful receipts used.)
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector('input[value="Add / Issue Receipt"]', { timeout: 15000 });

  /* STEP 11 — THE RECEIPT CATEGORY, CHOSEN BEFORE Add / Issue IS CLICKED.
   *
   * `#receiptCategory` is on the RECEIPTS LIST, not on the form, which is
   * exactly where the guide puts it ("Selects top right dropdown 'Debtor
   * Payment Receipt', click on 'Add/Issue Receipt'"). It decides which form
   * opens, so it has to be set first.
   *
   * WHAT IT OFFERS DEPENDS ON THE CLIENT, and that is the whole answer to a
   * question this project carried unresolved for a week. Measured
   * 17-Aug-2026:
   *
   *   13115  client GRAY/MEGAN DR   → Debtor Payment Receipt, Agency CC Debtor
   *                                   Receipt, Migration Debtor Payment
   *                                   Receipt, Creditor Refund Receipt
   *   13394  client GRAY/SPIDER MS  → Client Payment Receipt, Agency CC Client
   *                                   Receipt, Migration Client Payment
   *                                   Receipt, Creditor Refund Receipt
   *
   * Same debtor on both (RAA of SA Limited (Retail)); it is the CLIENT's
   * account type that swaps Debtor for Client throughout the list. A BPay
   * payment belongs on a debtor-account booking, so a booking that cannot offer
   * Debtor Payment Receipt is an exception to raise, not a receipt to file
   * under whatever type happens to be there.
   */
  if (receipt.receiptCategory) {
    const want = String(receipt.receiptCategory);
    const offered = await page.evaluate(() => {
      const el = document.querySelector("#receiptCategory");
      return el ? [...el.options].map((o) => ({ text: (o.text || "").trim(), value: o.value })) : null;
    });
    if (offered === null) {
      return { categoryUnavailable: true, wanted: want, offered: [] };
    }
    const match = offered.find((o) => o.value === want) ||
      offered.find((o) => o.text.toLowerCase() === want.toLowerCase());
    if (!match) {
      return { categoryUnavailable: true, wanted: want, offered: offered.map((o) => o.text) };
    }
    await page.selectOption("#receiptCategory", match.value);
    await sleep(400);
    // Read back: a select that silently reset would open the wrong form, and
    // the receipt would be filed under a type the reconcile filter never shows.
    const took = await page.evaluate(() => {
      const el = document.querySelector("#receiptCategory");
      return el ? el.value : "";
    });
    if (took !== match.value) {
      throw new Error(
        `The receipt category did not take on booking ${bookingNo}: asked for ` +
        `"${match.text}" and the screen reads "${took}".`
      );
    }
  }

  /* ALREADY FILED? THEN NOTHING IS FILED AGAIN.
   *
   * Same reference AND same amount on this booking means this exact receipt has
   * already been taken — upload the same CSV twice and the second run would
   * take the money a second time, against a booking that no longer owes it.
   *
   * Both have to match: a booking can legitimately take two receipts for the
   * same amount under different references, and one reference can be followed
   * by a correcting receipt for a different figure. The pair is what makes it
   * the same receipt.
   *
   * Read here, on the list the run already has open, BEFORE Add is clicked —
   * so the duplicate never reaches a form at all. */
  if (receipt.skipIfAlreadyFiled !== false && receipt.reference) {
    const already = await readBookingReceipts(page);
    const dupe = core.findFiledReceipt(already, {
      reference: receipt.reference,
      amount: receipt.amount,
    });
    if (dupe) return { alreadyFiled: dupe, onBooking: already.length };
  }

  await page.click('input[value="Add / Issue Receipt"]');
  await page.waitForSelector("#receipttransactionTypeCode", { timeout: 20000 });

  const txn = resolveTxnType(receipt.transactionType);

  // Transaction Type (req 2) — set first so credit-card sections render.
  await page.selectOption("#receipttransactionTypeCode", txn);
  await sleep(800);

  // Payer Name = booking client name (business rule, req: always client name).
  if (receipt.payerName) {
    await setFieldWithEvents(page, "#receiptpayerName", receipt.payerName);
  }
  // Date Received (defaults to today if omitted).
  await setFieldWithEvents(page, "#receiptdateReceived", toTramadaDate(receipt.dateReceived));
  // Amount Received.
  await setFieldWithEvents(page, "#receiptreceiptAmount", String(receipt.amount));
  // Reference — REQUIRED (req 6).
  if (!receipt.reference) {
    throw new Error("Receipt reference is required.");
  }
  await setFieldWithEvents(page, "#receiptreferenceNumber", String(receipt.reference));
  /* Read it back.
     This is the one field the receipt is found by afterwards — `readLatestReceipt`
     and the reconciliation both look the transaction up by its reference. If the
     input carries a maxlength, or a handler rewrites what was typed, the receipt
     is still filed and takes real money; only the lookup fails, and it fails
     saying the receipt is missing rather than saying the reference was cut short.
     Checked while nothing has been committed. */
  const back = await page.inputValue("#receiptreferenceNumber").catch(() => null);
  if (back != null && back !== String(receipt.reference)) {
    throw new Error(
      `The receipt reference did not stick: typed "${receipt.reference}", the form reads "${back}"` +
      (back.length < String(receipt.reference).length ? " (truncated — use a shorter reference)" : "") +
      ". Nothing was issued."
    );
  }

  return { txn, segments: await readAllocatableSegments(page) };
}

/**
 * Credit-card path (req 4): enter a NEW booking credit card each time — a card
 * tied to this receipt, NOT saved to the client profile. Reached only via the
 * receipt form's "Add" button, which opens client-edit-credit-card.htm in
 * booking-card mode.
 *
 * NOTE: card data is sensitive. `card` should be supplied over a secure channel;
 * this module only types what it is given and never logs it.
 *
 * @param {object} card { number, type, holder, expiry } and optional { creditor, authNumber }
 */
// What the card form's fields are called is a guess until a real page proves
// it, so every lookup below is a list of candidates tried in order and the
// failure path DUMPS what the page actually had. The first live credit-card
// receipt died on `waitForSelector("#cardNumberDisplay") timed out` with no
// clue whether the Add button had even fired — 15 wasted seconds that said
// nothing. Never let a selector fail silently on this form again.
const CARD_ADD_BUTTONS = [
  "#addCreditCardButton",
  "#addCreditCard",
  "#receiptaddCreditCardButton",
  'input[value="Add"][onclick*="redit"]',
  'input[onclick*="credit-card"]',
  'a[href*="credit-card"]',
];
const CARD_FIELD = {
  number: ["#cardNumberDisplay", "#cardNumber", "#creditCardNumber", 'input[name*="ardNumber"]'],
  type: ["#cardType", "#creditCardType", 'select[name*="ardType"]'],
  holder: ["#cardHolder", "#cardHolderName", 'input[name*="ardHolder"]'],
  expiry: ["#expiryDate", "#cardExpiry", 'input[name*="xpiry"]'],
  save: ["#save", 'input[value="Save"]', 'button[type="submit"]'],
};

/** First selector in `list` that exists in `ctx`, or null. */
async function firstPresent(ctx, list) {
  for (const sel of list) {
    if (await ctx.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

/**
 * Every control on the page, so a failure report names what was really there
 * instead of only what was missing. IDs and names only — never values, because
 * this runs on a page that may already hold a PAN.
 */
async function describeControls(ctx) {
  return await ctx
    .evaluate(() => {
      const out = [];
      document.querySelectorAll("input, select, button, a[href]").forEach((n) => {
        const id = n.id || "";
        const nm = n.getAttribute("name") || "";
        if (!id && !nm) return;
        const kind = n.tagName.toLowerCase() + (n.type ? `[${n.type}]` : "");
        // A button's value IS its label ("Add", "Save") and is safe to show;
        // a text input's value could be the card number, so it never is.
        const label =
          n.tagName === "INPUT" && /button|submit/i.test(n.type || "") ? ` "${n.value}"` : "";
        out.push(`${kind} #${id}${nm ? ` name=${nm}` : ""}${label}`);
      });
      return [...new Set(out)].slice(0, 60);
    })
    .catch(() => []);
}

/**
 * Creditor Details (the merchant facility the card is processed through).
 * Tramada renders this select only once Credit Card is the transaction type,
 * and rejects the receipt on Issue with "Creditor must be selected" if it is
 * left blank — AFTER the card has already been created. So it is resolved
 * here, before any card exists, and the list is read off the page rather than
 * guessed: which facilities a tenant has is a tenant's business, not ours.
 */
async function chooseReceiptCreditor(page, wanted) {
  const sel = await firstPresent(page, ["#creditor", "#receiptcreditor", 'select[name*="reditor"]']);
  if (!sel) return; // this tenant doesn't ask for one

  const options = await page.locator(`${sel} option`).evaluateAll((ns) =>
    ns.map((n) => ({ value: n.value, label: (n.textContent || "").trim() })).filter((o) => o.value)
  );

  if (wanted) {
    const w = String(wanted).trim().toLowerCase();
    const hit =
      options.find((o) => o.label.toLowerCase() === w) ||
      options.find((o) => o.label.toLowerCase().includes(w)) ||
      options.find((o) => o.value.toLowerCase() === w);
    if (!hit) {
      const e = new Error(`"${wanted}" isn't one of this booking's creditors.`);
      e.needsCreditor = { options: options.map((o) => o.label) };
      throw e;
    }
    await page.selectOption(sel, hit.value);
    await sleep(400);
    return;
  }

  // Already set (Tramada sometimes defaults it) — leave it alone.
  const current = await page.locator(sel).inputValue().catch(() => "");
  if (current) return;

  if (options.length === 1) {
    await page.selectOption(sel, options[0].value);
    await sleep(400);
    return;
  }

  const e = new Error("This credit-card receipt needs a creditor.");
  e.needsCreditor = { options: options.map((o) => o.label) };
  throw e;
}

async function enterNewBookingCard(page, card) {
  await chooseReceiptCreditor(page, card.creditor);

  // Click "Add" — Tramada opens the card form in a popup window.
  const addSel = await firstPresent(page, CARD_ADD_BUTTONS);
  if (!addSel) {
    throw new Error(
      "Couldn't find the receipt form's 'Add credit card' button. The form offered: " +
        (await describeControls(page)).join(" | ")
    );
  }

  let popup = null;
  try {
    [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 8000 }),
      page.click(addSel),
    ]);
  } catch {
    popup = null; // fall through to in-page / iframe fallback
  }

  // Where did the card form land? Popup, same page, or an iframe — check all
  // three rather than assuming, then say which one worked.
  let cardCtx = null;
  let numberSel = null;
  for (let i = 0; i < 20 && !numberSel; i++) {
    const candidates = [popup, page, ...page.frames().filter((f) => f !== page.mainFrame())].filter(Boolean);
    for (const ctx of candidates) {
      const sel = await firstPresent(ctx, CARD_FIELD.number);
      if (sel) { cardCtx = ctx; numberSel = sel; break; }
    }
    if (!numberSel) await sleep(750);
  }

  if (!numberSel) {
    const where = popup ? "popup" : "same page";
    throw new Error(
      `Clicked ${addSel} but no card-number field appeared (${where}). ` +
        `Page now: ${page.url()}. Controls present: ` +
        (await describeControls(popup || page)).join(" | ")
    );
  }

  await cardCtx.fill(numberSel, String(card.number));
  const typeSel = await firstPresent(cardCtx, CARD_FIELD.type);
  if (card.type && typeSel) {
    await cardCtx.selectOption(typeSel, { label: card.type }).catch(async () => {
      await cardCtx.selectOption(typeSel, card.type).catch(() => {});
    });
  }
  const holderSel = await firstPresent(cardCtx, CARD_FIELD.holder);
  if (card.holder && holderSel) await cardCtx.fill(holderSel, String(card.holder));
  const expirySel = await firstPresent(cardCtx, CARD_FIELD.expiry);
  if (card.expiry && expirySel) await cardCtx.fill(expirySel, String(card.expiry));

  // Save the booking card. If it was a popup it closes; the parent refreshes
  // its #receiptcreditCard dropdown with (and auto-selects) the new card.
  const saveSel = await firstPresent(cardCtx, CARD_FIELD.save);
  if (!saveSel) {
    throw new Error(
      "Filled the card but found no Save button. Card form offered: " +
        (await describeControls(cardCtx)).join(" | ")
    );
  }
  if (popup && cardCtx === popup) {
    await Promise.all([
      popup.waitForEvent("close").catch(() => {}),
      popup.click(saveSel),
    ]);
  } else {
    await cardCtx.click(saveSel);
  }
  await sleep(1500);

  // Ensure a card is selected on the parent form; if not, pick the newest option.
  await page.evaluate(() => {
    const sel = document.getElementById("receiptcreditCard");
    if (sel && !sel.value && sel.options.length) {
      sel.selectedIndex = sel.options.length - 1;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Authorisation Number (optional).
  if (card.authNumber) {
    await page.fill("#receiptcreditCardAuthNumber", String(card.authNumber));
  }
}

/**
 * Stop before Issue when the form is about to allocate more than the receipt.
 *
 * Tramada refuses this outright — "Allocation cannot be greater than Amount
 * Received" — and it refuses it AFTER the form is submitted, as a one-line
 * banner on a page that no longer shows which row was the problem. Three live
 * TravelPay receipts died that way on 10-Aug-2026 and the run reported only
 * the banner.
 *
 * It is reachable because "ALL" clicks Tramada's own Select All, which ticks
 * EVERY allocatable row and fills each with its full due — including rows the
 * caller's amount was never chosen to cover. A booking with a 200.00 ticket
 * and a 60.00 hotel receipted for 200.00 allocates 260.00 and is rejected.
 *
 * So the same figures are read back off the form and added up here, while
 * nothing has been committed and every row is still on screen to name.
 *
 * This only ever refuses what Tramada was going to refuse anyway: an
 * allocation at or under the amount is left completely alone.
 */
async function refuseOverAllocation(page, amountReceived) {
  const cap = centsOf(amountReceived);
  if (cap == null) return;                       // caller didn't say — nothing to check against
  const rows = await page.$$eval('input[id^="allocationAmount_"]', (ns) =>
    ns.map((n) => {
      const tr = n.closest("tr");
      const cells = tr ? Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
      return { segId: n.id.replace("allocationAmount_", ""), value: n.value || "", segType: cells[1] || "" };
    })).catch(() => []);
  const total = rows.reduce((a, r) => a + (centsOf(r.value) || 0), 0);
  if (total <= cap) return;

  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const named = rows
    .filter((r) => (centsOf(r.value) || 0) > 0)
    .map((r) => `${r.segType || `segment ${r.segId}`} ${money(centsOf(r.value))}`)
    .join(" + ");
  throw new Error(
    `Allocation cannot be greater than Amount Received: this receipt is for ` +
    `${money(cap)} but Select All ticked ${named || "every row"}, totalling ${money(total)}. ` +
    `Receipt the full ${money(total)}, or pass an explicit allocation instead of "ALL". ` +
    `Nothing was issued.`
  );
}

/**
 * Allocate the receipt across segments (req 3).
 *
 * @param {"ALL"|Array} allocation
 *   "ALL"                    -> tick every segment, use each segment's due
 *   [{ segId, amount }]      -> allocate specific amounts to specific segments
 *   [{ index, amount }]      -> same, by row index (0-based)
 * @param {string|number} [amountReceived]  The receipt's own amount. Given, it
 *   is checked against what is actually about to be allocated — see
 *   `refuseOverAllocation` below for why that is worth doing before Issue.
 */
async function allocateSegments(page, allocation, segments, amountReceived) {
  // An EXPLICITLY empty allocation means "raise this receipt and allocate it to
  // nothing" — a real, wanted outcome rather than a mistake. The reconciliation
  // run passes it whenever the statement amount doesn't equal what is
  // outstanding: the receipt still has to exist, unallocated, because
  // "allocated" versus "not allocated" is exactly how those two cases are told
  // apart afterwards.
  //
  // Without this, the throw below fired on any booking with nothing left
  // outstanding and NO receipt was raised at all — the row failed outright
  // instead of coming back as the unallocated receipt it was meant to be.
  if (Array.isArray(allocation) && allocation.length === 0) return;

  if (!segments || segments.length === 0) {
    throw new Error(
      "No costed segments to allocate against — create & cost an itinerary segment first."
    );
  }

  if (allocation === "ALL" || allocation == null) {
    // PROVEN PATH: real-click the "Segments To Allocate" section's Select All
    // button — its onclick both ticks every row AND auto-fills each allocation
    // amount with the segment's due. (Hand-ticking checkboxes left the amounts
    // empty, which is what sank the first manual attempt.) There are two
    // #selectAll buttons on the page; the segments one is the second.
    const selectAlls = page.locator("#selectAll");
    const n = await selectAlls.count();
    if (n > 0) {
      await selectAlls.nth(n - 1).click();
      await sleep(800);
    }
    // Verify: every checkbox ticked and amounts populated; fix up any gaps the
    // button missed using the segment's own due value.
    await page.evaluate(() => {
      document.querySelectorAll('input[id^="allocationAmount_"]').forEach((inp) => {
        const row = inp.closest("tr");
        const cb = row && row.querySelector('input[name="segmentsToAllocate"]');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (!parseFloat(inp.value || "0")) {
          const cells = row ? Array.from(row.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
          const due = cells.filter((c) => /^\d+(\.\d\d)?$/.test(c)).pop();
          if (due) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(inp, due);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    });
    await refuseOverAllocation(page, amountReceived);
    return;
  }

  // Specific allocations.
  //
  // Checked as arithmetic before a single key is pressed. The per-row verify
  // further down catches a box that didn't take the value; it cannot catch a
  // caller whose rows add up to more than the receipt, and that is the failure
  // Tramada answers with a banner after the form is gone.
  const asked = allocation.reduce((a, x) => a + (centsOf(x.amount) || 0), 0);
  const cap = centsOf(amountReceived);
  if (cap != null && asked > cap) {
    throw new Error(
      `Allocation cannot be greater than Amount Received: this receipt is for ` +
      `$${(cap / 100).toFixed(2)} but the ${allocation.length} allocation(s) asked for ` +
      `total $${(asked / 100).toFixed(2)}.`
    );
  }

  for (const a of allocation) {
    const seg =
      a.segId != null
        ? segments.find((s) => s.segId === String(a.segId))
        : segments[a.index];
    if (!seg) continue;
    /**
     * ORDER MATTERS: tick the row FIRST, then type the amount.
     *
     * The allocation box ships as `disabled readonly` with class
     * "disabled text-readonly". It is the row checkbox's own click handler that
     * enables it — the same handler Select All fires for every row at once.
     * Typing first meant clicking a permanently disabled input, which is
     * exactly how the first live partial allocation died:
     *
     *   locator.click: Timeout 30000ms exceeded ... element is not enabled
     *
     * The checkbox is clicked for real rather than having `.checked` set,
     * because setting the property does not run the handler that enables the
     * box or recomputes the footer tally.
     */
    const row = page.locator(`tr:has(#allocationAmount_${seg.segId})`).first();
    const cb = row.locator('input[name="segmentsToAllocate"]').first();
    if (await cb.count()) await cb.check();

    const box = page.locator(`#allocationAmount_${seg.segId}`);
    if (await box.count()) {
      // Ticking usually auto-fills the segment's full due. Wait for the box to
      // actually come alive before touching it, rather than racing the handler.
      await box.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      const live = await box.isEditable().catch(() => false);
      if (!live) {
        throw new Error(
          `Allocation box for segment ${seg.segId} never became editable — ` +
          `ticking its row did not enable it.`
        );
      }

      // REAL KEYSTROKES, then read back. setFieldWithEvents (native setter +
      // events) is what the rest of this file uses, and it is what the
      // bank-statement form silently discarded on submit. On an allocation
      // amount a dropped value means money against the wrong segment, or none.
      //
      // Triple-click to select what ticking auto-filled, NOT Control+A — that
      // is Cmd+A on a Mac, so the selection would not happen and the typed
      // amount would land next to the full due already sitting there. Verified
      // live on booking 13127: tick → box holds 200.00 → triple-click, type
      // 150.00, Tab → box holds 150.00 and the footer tally follows it.
      await box.click({ clickCount: 3 });
      await box.pressSequentially(String(a.amount), { delay: 30 });
      await box.press("Tab").catch(() => {});
      await sleep(300);
      const got = await box.inputValue().catch(() => "");
      if (parseFloat(got || "0").toFixed(2) !== parseFloat(String(a.amount)).toFixed(2)) {
        throw new Error(
          `Tramada didn't keep the allocation ${a.amount} on segment ${seg.segId} (it reads "${got}").`
        );
      }
    }
  }
}

// Read back the top REAL receipt row after issuing — skips "No records found"
// and TOTALS rows; only a row whose Receipt No. looks like "R.000..." counts.
async function readLatestReceipt(page) {
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Receipt\s*No/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        let row = null;
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 9 && /^R\./i.test((cells[1].textContent || "").trim())) {
            row = rows[i];
            break;
          }
        }
        if (!row) return null;
        const c = row.querySelectorAll("td");
        return {
          receiptNo: clean(c[1]),
          receiptCategory: clean(c[2]),
          receiptType: clean(c[3]),
          transType: clean(c[4]),
          receivedFrom: clean(c[5]),
          reference: clean(c[6]),
          dateReceived: clean(c[7]),
          amount: clean(c[8]),
          allocated: clean(c[9]),
        };
      }
    }
    return null;
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Orchestrator
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Create (and optionally issue) a receipt against an existing booking.
 *
 * @param {object} args
 * @param {string} [args.username] / [args.password]  Only used if the shared
 *        Chrome session is NOT already logged in (avoids re-triggering OTP).
 * @param {string|number} args.bookingNo   Booking to receipt against (req 5:
 *        if you don't have one, call searchBookingsForReceipt first and let the
 *        user pick).
 * @param {object} args.receipt
 *        {
 *          transactionType: "Cash"|"EFT"|"Cheque"|"Credit Card"|"Credit Card Swipe",
 *          amount: number|string,
 *          reference: string,             // REQUIRED (req 6)
 *          dateReceived?: "YYYY-MM-DD",   // defaults today
 *          payerName?: string,            // defaults to booking client name (req: always client name)
 *          allocation?: "ALL" | [{segId|index, amount}],   // req 3
 *          card?: { number, type, holder, expiry, creditor?, authNumber? } // req 4, credit card only
 *        }
 * @param {boolean} [args.dryRun=false]  When true: fill the form and capture a
 *        preview screenshot but DO NOT click Issue (nothing is committed, and
 *        for credit cards the card popup is skipped so no card is created).
 *        Use this to show the user a confirmation before committing.
 * @param {object} [args.callbacks] { onProgress(pct,msg), onError(msg) }
 * @returns {Promise<{details, segments, staged, receipt?, previewImage?}>}
 */
async function runTramadaReceipt({
  username,
  password,
  bookingNo,
  receipt = {},
  dryRun = false,
  skipIfNoAllocatable = false, // return {skipped:true} instead of throwing when
                               // the receipt form has nothing to allocate
  /* Default ON. A receipt already on this booking with the SAME reference and
     the SAME amount is this receipt, already taken — upload the same CSV twice
     and without this the second run takes the money again. Pass false only for
     something that genuinely means to file a second identical receipt. */
  skipIfAlreadyFiled = true,
  /* Steps 8-9. Off by default because it costs a page load per row and only
     the BPay report puts a Shop column in front of Finance. The probe pass
     turns it on; the commit pass does not, so the profile page is opened once
     per row rather than twice. */
  withBranch = false,
  /* Step 11. The value of `#receiptCategory` on the booking's Receipts list —
     `DEBTOR_PAYMENT_RECEIPT` for BPay. Left unset, the list's own default is
     used, which is what every caller did before this existed. */
  receiptCategory = "",
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});

  if (!bookingNo) throw new Error("bookingNo is required (resolve or ask the user first).");
  if (!receipt.reference) throw new Error("receipt.reference is required.");
  if (receipt.amount == null || receipt.amount === "") {
    throw new Error("receipt.amount is required.");
  }

  const txnCode = resolveTxnType(receipt.transactionType);
  if (isCreditCard(txnCode) && !dryRun && !receipt.card) {
    throw new Error("Credit card receipt requires receipt.card { number, type, holder, expiry }.");
  }

  let browser, context, page, launched = false;
  let _ok = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(12, "Checking Tramada session...");
    await ensureLoggedIn(page, { username, password, onNeedLogin: callbacks.onNeedLogin, onLoginOk: callbacks.onLoginOk });

    onProgress(25, `Opening booking ${bookingNo}...`);
    const details = await getBookingDetails(page, bookingNo);
    if (withBranch) {
      onProgress(30, "Reading the shop branch from the booking profile...");
      const profile = await getBookingBranch(page, bookingNo);
      details.branch = core.branchCode(profile.branch);
      details.branchLabel = profile.branch || "";
      /* The profile's own debtor dropdown beats the summary's prose, and BR05
         is a money gate — so where the select gives an answer, it wins. The
         summary read stays as the fallback for a page that renders without it. */
      if (profile.debtor) details.debtor = profile.debtor;
    }

    onProgress(35, "Checking itinerary segments...");
    const itin = await getItinerarySegments(page, bookingNo);
    if (!itin || itin.length === 0) {
      throw new Error(
        `Booking ${bookingNo} has no itinerary segment. Create (and cost) an ` +
          `itinerary segment before raising a receipt.`
      );
    }

    // Payer Name always = booking client name unless explicitly overridden.
    const payerName = receipt.payerName || details.payerName || details.clientName || "";

    onProgress(50, `Preparing ${dryRun ? "receipt preview" : "receipt"}...`);
    const opened = await openReceiptForm(page, bookingNo, {
      ...receipt,
      payerName,
      receiptCategory,
      skipIfAlreadyFiled: skipIfAlreadyFiled !== false,
    });

    /* THE BOOKING CANNOT TAKE THIS KIND OF RECEIPT.
       `#receiptCategory` offers Debtor variants on a debtor-account client and
       Client variants on a retail one, so a BPay payment landing on a booking
       that offers no Debtor Payment Receipt is a booking set up differently to
       what the guide assumes. Nothing is filed and nothing is guessed at: the
       row comes back saying what was wanted and what was on offer. */
    if (opened.categoryUnavailable) {
      onProgress(100,
        `Booking ${bookingNo} does not offer "${opened.wanted}" — no receipt raised.`);
      _ok = true;
      return {
        details, itinerary: itin, segments: [], committed: false,
        skipped: true, reason: "receipt category unavailable",
        wanted: opened.wanted, offered: opened.offered,
      };
    }

    /* This receipt is already on the booking — same reference, same amount.
       Nothing was opened, nothing was typed, and the run gets the receipt that
       is already there rather than a second one taking the money again. */
    if (opened.alreadyFiled) {
      const was = opened.alreadyFiled;
      onProgress(100,
        `Booking ${bookingNo} already has ${was.receiptNo} for $${was.amount} on reference ` +
        `"${was.reference}" — nothing filed.`);
      _ok = true;
      return {
        details, itinerary: itin, segments: [], committed: false,
        skipped: true, reason: "already filed",
        receipt: was,
        duplicates: was.duplicates,
      };
    }
    const { segments } = opened;

    // Credit card entry only on real commit (a card is a real side effect;
    // dryRun skips it so a preview never creates a card).
    if (isCreditCard(txnCode) && !dryRun) {
      onProgress(60, "Entering new booking credit card...");
      await enterNewBookingCard(page, receipt.card);
    }

    // Nothing to allocate (booking already fully paid / no outstanding balance).
    // With skipIfNoAllocatable, return a clean skip instead of throwing.
    if ((!segments || segments.length === 0) && skipIfNoAllocatable) {
      onProgress(100, `Nothing outstanding to allocate on booking ${bookingNo} — no receipt raised.`);
      _ok = true;
      return { details, itinerary: itin, segments: [], skipped: true, reason: "nothing to allocate", committed: false };
    }

    onProgress(70, "Allocating to segment(s)...");
    await allocateSegments(page, receipt.allocation || "ALL", segments, receipt.amount);
    await sleep(400);

    const staged = {
      bookingNo: String(bookingNo),
      transactionType: txnCode,
      payerName,
      amount: String(receipt.amount),
      reference: String(receipt.reference),
      dateReceived: toTramadaDate(receipt.dateReceived),
      allocation: receipt.allocation || "ALL",
      segments,
    };

    if (dryRun) {
      onProgress(90, "Preview ready — awaiting confirmation (not committed).");
      let previewImage = null;
      try {
        previewImage = await page.screenshot({ encoding: "base64", fullPage: true });
      } catch { /* screenshot optional */ }
      onProgress(100, "Preview ready.");
      _ok = true;
      return { details, itinerary: itin, segments, staged, previewImage, committed: false };
    }

    onProgress(85, "Issuing receipt...");
    // Real click on Issue, then WAIT for a definitive outcome: back on the
    // receipts list (success), a Tramada error page, or on-form validation
    // errors. A fixed sleep raced the server and produced false successes.
    await page.click("#issue");
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      const url = page.url();
      if (/booking-receipts\.htm/i.test(url)) break; // back on the list → issued
      const title = (await page.title().catch(() => "")) || "";
      if (/error page/i.test(title)) {
        throw new Error("Tramada returned a server error page after Issue.");
      }
      const errs = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("a, span, li, font, div").forEach((n) => {
          if (n.children.length) return;
          const t = (n.textContent || "").trim();
          if (t && t.length < 200 && /must be|is required|is invalid|cannot be/i.test(t)) out.push(t);
        });
        return [...new Set(out)].slice(0, 8);
      }).catch(() => []);
      if (errs.length) throw new Error(`Receipt rejected: ${errs.join("; ")}`);
      if (i === 8) { try { await page.click("#issue", { timeout: 3000 }); } catch { /* busy */ } }
    }

    // Land on the Booking Receipts list and read back the new receipt.
    if (!page.url().includes("booking-receipts")) {
      await page.goto(
        `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
        { waitUntil: "domcontentloaded" }
      );
      await sleep(800);
    }
    const issued = await readLatestReceipt(page);

    // STRICT: success means a real receipt number (R.000...) in the list —
    // anything else is a failure, never a silent "Receipt issued."
    if (!issued || !/^R\./i.test(issued.receiptNo || "")) {
      try { await page.screenshot({ path: "last-error.png", fullPage: true }); } catch { /* best-effort */ }
      throw new Error(
        "Receipt was NOT created — the receipts list shows no new receipt. [screenshot: last-error.png]"
      );
    }

    onProgress(100, `Receipt ${issued.receiptNo} issued.`);
    _ok = true;
    return { details, itinerary: itin, segments, staged, receipt: issued, committed: true };
  } catch (err) {
    onError(err.message);
    throw err;
  } finally {
    try {
      // On failure leave the tab open (failed form stays inspectable).
      if (page && _ok) await page.close();
    } catch { /* tab may be closed */ }
    try {
      if (browser) await browser.close(); // CDP: only drops the connection
    } catch { /* ignore */ }
  }
}

/**
 * Convenience wrapper for the "no booking number" branch (req 5):
 * open a search, return the list for the chat to display.
 */
async function searchBookingsForReceipt({ username, password, status, clientName, bookingNo } = {}) {
  let browser, page;
  try {
    ({ browser } = await openBrowser(() => {}));
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();
    await ensureLoggedIn(page, { username, password });
    return await searchBookings(page, { status, clientName, bookingNo });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

module.exports = {
  runTramadaReceipt,
  searchBookingsForReceipt,
  // exported for reuse/testing
  toTramadaDate,
  resolveTxnType,
  allocateSegments,
  readBookingReceipts,
  /* Step 7's consultant (`Cons1`) lives on the booking summary and nowhere else,
     so a caller that wants Consultant WITHOUT raising a receipt — filling the
     BPay report's Consultant column ahead of the run — had no way to reach it
     and would have had to re-scrape the summary itself. That is the copy-of-the-
     thing-being-probed trap `tramada-payment.js` names in its own exports: a
     second scraper succeeds exactly where the real one fails, and the label
     regex here is the part that has already been wrong twice ("Debtors" matching
     "Debtor", a `<select>` rendering as all of its options). One reader. */
  getBookingDetails,
  getBookingBranch,
  centsOf,
  TXN_TYPE,
};

/**
 * tramada-segments.js — Playwright + CDP itinerary/segment + costing automation.
 *
 * Fills the middle of the pipeline that tramada-booking.js (add booking) and
 * tramada-receipt.js (receipt) leave open:
 *
 *   add booking  →  ADD SEGMENTS (flight, hotel)  →  COST THEM  →  receipt
 *
 * Field IDs were mapped live against raatravelsandbox TTMS (v7.10.3):
 *   - Flight segment:  booking-flight-segment.htm?mode=add&parentId={id}
 *   - Hotel segment:   booking-hotel-segment.htm?mode=add&parentId={id}   (pricing is inline → self-costs)
 *   - Ticket costing:  booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId={id}
 *   - Costing list:    booking-costings.htm?mode=edit&id={id}
 *
 * IMPORTANT — only COSTED segments are receiptable. A hotel is costed on its own
 * form (rate incl GST). A flight/ticket carries no price on the segment form, so
 * it must be costed separately via a Ticket costing entry.
 *
 * NOTE on creditor fields (#costingcreditor): these behave like autocompletes in
 * Tramada. This module types the value; if a tenant requires picking a matched
 * suggestion, verify that step live (see the pickAutocomplete helper).
 */

const { chromium } = require("playwright");
const { runTramadaAddAndSearch } = require("./tramada-booking");
const { runTramadaReceipt } = require("./tramada-receipt");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toTramadaDate(input) {
  if (!input) return "";
  const iso = String(input).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  return input;
}

// Flight number: digits only, max 4 chars ("QF400" -> "400"). Tramada rejects >4.
function toFlightNumber(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 4);
}

// Booking-class code, max 2 chars. Maps common cabin names; else takes ≤2 chars.
function toClassCode(v) {
  if (!v) return "";
  const map = { economy: "Y", business: "J", first: "F", "premium economy": "W", premium: "W" };
  const key = String(v).trim().toLowerCase();
  if (map[key]) return map[key];
  return String(v).toUpperCase().slice(0, 2);
}

/* ── browser / login (same pattern as sibling modules) ─────────────────── */

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
    // Fail honestly rather than launching an unauthenticated throwaway Chrome
    // (which would produce a misleading "not logged in").
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and log into Tramada IN THAT WINDOW first. [${cdpErr.message}]`
    );
  }
}

// Reliable auth check via a PROTECTED page (login.htm serves the form even when
// authenticated, so checking it directly gives false "not logged in").
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  return !page.url().includes("login.htm");
}

async function ensureLoggedIn(page, { username, password, onNeedLogin } = {}) {
  if (await tramadaIsAuthed(page)) return;

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
    if (await tramadaIsAuthed(page)) { await sleep(500); return; }
  }
  throw new Error("Timed out waiting for Tramada login. Sign in to the shared Chrome and try again.");
}

/* ── small helpers ─────────────────────────────────────────────────────── */

// Fill a field only if a value was supplied and the field exists AND is
// editable. Tramada computes some fields (e.g. hotel #duration from the
// check-in/out dates) and marks them readonly — filling those hangs Playwright
// for 30s, so skip them. Short timeout so a surprise never stalls a run.
async function fillIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const first = el.first();
  const editable = await first
    .evaluate((n) => !n.readOnly && !n.disabled)
    .catch(() => true);
  if (!editable) return; // computed/readonly field — Tramada fills it itself
  await first.fill(String(value), { timeout: 10000 });
}

// Set a <select> instantly by matching value, exact label, or label-contains.
// (Playwright's selectOption WAITS 30s per failed attempt when the value
// doesn't exactly match an option — "Adult" vs value "ADULT", "Published" vs
// label "Published [PUBLISHED]" — which is what made costing take minutes.)
async function selectIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.first().evaluate((sel, want) => {
    const w = String(want).trim().toLowerCase();
    const opts = Array.from(sel.options || []);
    const hit =
      opts.find((o) => (o.value || "").toLowerCase() === w) ||
      opts.find((o) => (o.textContent || "").trim().toLowerCase() === w) ||
      opts.find((o) => (o.textContent || "").toLowerCase().includes(w));
    if (hit) {
      sel.value = hit.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, String(value)).catch(() => { /* leave default */ });
}

// In-page finder for the best autocomplete suggestion for the input given by
// arg.sel. CRITICAL: only nodes in the DROPDOWN ZONE — directly BELOW the
// input and horizontally overlapping it — are candidates. Without that, a
// contains-match can hit unrelated page text (the sidebar "Itinerary: MEL →
// SYD" link matched "MEL" once, and clicking it navigated the whole page).
// Prefers an exact CODE match — "(MEL) ..." / "[TEMPO] ..." — over contains.
// Returns {text, x, y} or null; when arg.doClick, also fires a synthetic click.
function _findSuggestion(arg) {
  const input = document.querySelector(arg.sel);
  if (!input) return null;
  const ir = input.getBoundingClientRect();
  const val = String(arg.raw).trim().toUpperCase();
  const esc = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const inDropdownZone = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const below = r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340; // just under the field
    const overlap = r.left < ir.right + 80 && r.right > ir.left - 80; // roughly same column
    return below && overlap;
  };

  const vis = Array.from(document.querySelectorAll("li, div, td, a")).filter(
    (n) =>
      n.offsetParent !== null &&
      (n.textContent || "").trim() &&
      (n.textContent || "").length < 80 &&
      inDropdownZone(n)
  );

  let hit = vis.find((n) => new RegExp("^\\s*[\\(\\[]" + esc + "[\\)\\]]").test(n.textContent || ""));
  /* VAL as a whole token — bounded by a non-alphanumeric character or the
     string edge — never as a bare prefix. The old "contains" fallback
     (`t.includes(val) && t !== val`) let a suggestion for "X1" satisfy a
     search for "X" just as well as the real "X" entry, and picked whichever
     the dropdown rendered first — confirmed live 28-Aug-2026 in the sibling
     copy of this function (tramada-booking.js), where typing the exact,
     correct client code "GRAY/MEGAN DR" always silently landed on
     "GRAY/MEGAN DR1" instead. Same risk here for any autocomplete whose
     values collide by suffix (creditor names, airline codes, etc). */
  if (!hit) {
    const boundary = new RegExp("(^|[^A-Z0-9])" + esc + "([^A-Z0-9]|$)");
    hit = vis.find((n) => boundary.test((n.textContent || "").trim().toUpperCase()));
  }
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  if (arg.doClick) hit.click();
  return { text: (hit.textContent || "").trim().slice(0, 60), x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * EVERY visible suggestion under a field, not just the one that matches.
 *
 * Same geometry as _findSuggestion — Tramada's dropdown has no stable class to
 * hook (the input is only marked `ctrl-type-AutoCompleteAndEditToggleTextField`
 * and the list is plain `li`/`div` nodes), so "visible, just below the field,
 * roughly the same column" is the only reliable test.
 *
 * This exists so the creditor question can SHOW the agent what Tramada offers.
 * Measured 05-Aug-2026: the creditor autocomplete POSTs back to the segment
 * page itself (`booking-hotel-segment.htm`, body key `costing.creditor`) — there
 * is no standalone creditor endpoint anywhere — so the only place these names
 * can be obtained is the open form.
 */
function _listSuggestions(arg) {
  const input = document.querySelector(arg.sel);
  if (!input) return [];
  const ir = input.getBoundingClientRect();
  const inDropdownZone = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340 &&
           r.left < ir.right + 80 && r.right > ir.left - 80;
  };
  const typed = String(arg.raw || "").trim().toUpperCase();
  const out = [];
  for (const n of document.querySelectorAll("li, div, td, a")) {
    if (n.offsetParent === null) continue;
    const t = (n.textContent || "").trim();
    if (!t || t.length > 80) continue;
    if (!inDropdownZone(n)) continue;
    // Skip the field's own echo of what was typed, and any wrapper that merely
    // contains a row rather than being one.
    if (t.toUpperCase() === typed) continue;
    if (n.querySelector("li, td, a")) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 40);
}

/**
 * What Tramada offers for this creditor search, as plain labels.
 *
 * Polls for a STABLE list for the same reason pickAutocomplete does: the
 * dropdown is populated by an async POST and reading it too early returns the
 * previous search's rows.
 */
async function readCreditorOptions(page, selector, typed) {
  if (!typed) return [];
  const el = page.locator(selector);
  if (!(await el.count())) return [];
  const first = el.first();
  try {
    await first.click();
    await first.fill("");
    await first.type(String(typed), { delay: 60 }); // real keystrokes → dropdown
    let prev = null;
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const cur = await page.evaluate(_listSuggestions, { sel: selector, raw: String(typed) }).catch(() => []);
      if (cur.length && prev && cur.length === prev.length && cur[0] === prev[0]) return cur;
      prev = cur;
    }
    return prev || [];
  } catch {
    return []; // an unreadable dropdown must not break the run — we just ask freely
  } finally {
    await first.fill("").catch(() => {});
  }
}

/**
 * Fill a Tramada autocomplete field reliably.
 *
 * Per attempt (max 2, re-typing between attempts):
 *   1. Type with REAL keystrokes, then poll until the suggestion list is
 *      loaded AND STABLE (same entry at the same position on two consecutive
 *      polls — dropdowns reposition while rendering, which made single-shot
 *      coordinate clicks miss).
 *   2. Commit with a SYNTHETIC in-page click first — proven for the city and
 *      supplier dropdowns (it's what saved the flights in earlier runs).
 *   3. VERIFY the field's value actually changed. If not, fall back to a REAL
 *      mouse click at freshly measured coordinates — required by the Creditor
 *      widget, which ignores synthetic clicks. Verify again.
 * Fields that expand inline with no dropdown (e.g. Airline) are accepted via a
 * blur-and-check. Only after both attempts fail does it throw.
 */
async function pickAutocomplete(page, selector, value) {
  if (!value) return null;
  const el = page.locator(selector);
  if (!(await el.count())) return null;
  const first = el.first();
  const typed = String(value).trim().toUpperCase();

  // The pick "registered" iff the field holds the suggestion's OWN text
  // (`expected`, when a pick just happened) or, failing that, anything other
  // than the raw typed text. Comparing only against `typed` was the bug: it
  // assumed a successful pick always changes the field's text from what was
  // typed, which is false whenever the typed value is already the complete,
  // correct name — the field is filled correctly and this returned null every
  // time. Confirmed live 28-Aug-2026 in the sibling copy of this function.
  const registered = async (expected) => {
    const v = ((await first.inputValue().catch(() => "")) || "").trim();
    if (!v) return null;
    if (expected) return v.toUpperCase() === expected.toUpperCase() ? v : null;
    return v.toUpperCase() !== typed ? v : null;
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    await first.click();
    await first.fill("");
    await first.type(String(value), { delay: 60 }); // real keystrokes → dropdown

    // Poll for a STABLE match: same text & position on two consecutive polls.
    let match = null;
    let prev = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const cur = await page
        .evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: false })
        .catch(() => null);
      if (cur && prev && cur.text === prev.text && Math.abs(cur.y - prev.y) < 2) {
        match = cur;
        break;
      }
      prev = cur;
    }

    if (!match) {
      // No dropdown — maybe an inline-expanding field (Airline). Blur and check.
      await first.evaluate((n) => n.blur()).catch(() => {});
      await sleep(800);
      const v = await registered();
      if (v) return v; // widget expanded it itself, e.g. "QANTAS" → "QANTAS AIRWAYS(QF)"
      continue; // re-type and try again
    }

    // (a) Synthetic in-page click — the method that worked for city/supplier.
    await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: true }).catch(() => null);
    await sleep(500);
    let v = await registered(match.text);
    if (v) return v;

    // (b) Real mouse click at FRESH coordinates — needed by the Creditor widget.
    const fresh =
      (await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: false }).catch(() => null)) ||
      match;
    await page.mouse.move(fresh.x, fresh.y);
    await sleep(150);
    await page.mouse.click(fresh.x, fresh.y);
    await sleep(600);
    v = await registered(fresh.text);
    if (v) return v;
    // Neither click registered — loop re-types and tries once more.
  }

  throw new Error(`Autocomplete ${selector}: could not select "${value}" (no click registered after 2 attempts)`);
}

// Set a date input the PROVEN way: native setter + input/change/blur events
// (this is exactly how all three successful manual bookings were driven).
// Playwright fill() left the hotel Check Out Date mangled, so dates avoid it.
// Verifies the field holds exactly what we set.
async function setDateField(page, selector, value) {
  if (!value) return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const got = await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
    return n.value;
  }, String(value));
  if (got !== String(value)) {
    throw new Error(`Date field ${selector} ended up as "${got}" (expected "${value}")`);
  }
}

/**
 * Read any validation errors after a save.
 *
 * This runs the instant a save is judged to have failed, which is exactly when
 * Tramada may still be swapping the document — and in that window
 * `document.body` is NULL. Reading `.innerText` off it threw
 * "Cannot read properties of null (reading 'innerText')", which then surfaced
 * AS the run's failure and buried the real one: this function exists to read
 * the validation message, so its own crash replaced "City Code is invalid" with
 * a stack trace. Wait for the document, guard the body, and retry.
 */
async function readSaveErrors(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await _readSaveErrorsOnce(page).catch(() => null);
    if (out) return out;
    await sleep(400);
  }
  return [];
}

async function _readSaveErrorsOnce(page) {
  return await page.evaluate(() => {
    if (!document.body) return null; // mid-navigation — the caller retries
    const out = [];
    const sels = [
      'div[style*="border"][style*="red"]',
      ".errorMessages",
      'fieldset[class*="error"]',
      '[class*="error" i]',
      'font[color="red"]',
      'span[style*="red"]',
      'a[href*="#"][style*="red"]',
    ];
    document.querySelectorAll(sels.join(",")).forEach((box) => {
      const t = (box.textContent || "").trim();
      // The vocabulary matters more than it looks. The client form says
      // "Unable to save - please complete the mandatory fields Surname, First
      // Name & Title", which matched NONE of the original keywords — it says
      // "mandatory", not "required" — so a real refusal was discarded as noise
      // and the caller reported no error at all. Cover the phrasings the app
      // actually uses.
      if (
        t &&
        t.length < 400 &&
        /invalid|must be|required|mandatory|unable to save|please (complete|enter|provide|select)|entered|cannot|no longer than|already|missing/i.test(t)
      ) {
        t.split("\n").map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
      }
    });

    // Layout-based fallback: Tramada renders the error box between the
    // "Add / Edit ..." title and the "Segment Created :" label. Whatever text
    // sits in that band IS the error list, regardless of markup/CSS.
    const lines = (document.body.innerText || "").split("\n").map((s) => s.trim());
    const start = lines.findIndex((l) => /^Add\s*\/\s*Edit/i.test(l));
    const end = lines.findIndex((l) => /^Segment Created/i.test(l));
    if (start >= 0 && end > start + 1) {
      lines
        .slice(start + 1, end)
        .filter((l) => l && !/^(Help|Knowledge Base|Undo|Save)$/i.test(l))
        .forEach((l) => out.push(l));
    }
    return [...new Set(out)].slice(0, 10);
  });
}

// Set a money/number field the proven way: native setter + input/change/blur
// events, so Tramada's recompute handlers (Client Due totals) actually fire —
// Playwright fill() alone left the totals at 0.00. Verifies numerically
// (Tramada may reformat "200" → "200.00").
async function setMoneyField(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const got = await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
    return n.value;
  }, String(value));
  if (Math.abs(parseFloat(got || "0") - parseFloat(String(value))) > 0.001) {
    throw new Error(`Field ${selector} ended up as "${got}" (expected ${value})`);
  }
}

// Candidate ids/attribute matches for the "Confirmation / Reference Number" box.
// Tramada names this field differently per segment form — the tour form uses
// #itineraryconfirmationOrReferenceNumber, insurance uses
// #confirmationOrReferenceNumber — and the hotel form's id could not be read
// directly (the browser wasn't signed in, and I won't guess at a field that
// carries the booking reference). So we PROBE, most-specific first, and report
// which one we used rather than hard-coding a guess.
const CONFIRMATION_REF_SELECTORS = [
  "#itineraryconfirmationOrReferenceNumber",
  "#confirmationOrReferenceNumber",
  "#itineraryconfirmationNumber",
  "#confirmationNumber",
  "#itineraryreferenceNumber",
  "#referenceNumber",
  'input[name*="confirmationOrReference" i]',
  'input[name*="confirmation" i]',
  'input[id*="confirmation" i]',
  'input[name*="referenceNumber" i]',
  'input[id*="referenceNumber" i]',
];

/**
 * Write the booking reference (e.g. "Q422380 / AQ788851") into whichever
 * confirmation/reference field this form actually has.
 *
 * NON-FATAL by design: if no candidate exists, the segment is still correct in
 * every other respect, and losing the whole run over a cosmetic-ish field would
 * be worse than saving without it. Returns the selector that took the value, or
 * null — callers log it so the real id gets pinned down on the first live run.
 */
async function setConfirmationRef(page, value) {
  if (value == null || value === "") return null;
  for (const sel of CONFIRMATION_REF_SELECTORS) {
    const el = page.locator(sel);
    let n = 0;
    try { n = await el.count(); } catch { continue; }
    if (!n) continue;
    const first = el.first();
    const usable = await first
      .evaluate((node) => {
        if (node.type === "hidden" || node.readOnly || node.disabled) return false;
        // A zero-size node is a template/offscreen field, not the real one.
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .catch(() => false);
    if (!usable) continue;
    try {
      await first.fill(String(value), { timeout: 8000 });
      return sel;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Has the segment form reached a SAVED state? Two distinct success shapes:
 *  - Flights: Tramada NAVIGATES back to the itinerary list.
 *  - Hotels: Tramada RELOADS THE SAME FORM in edit mode — the URL gains an id
 *    and the "Segment Created :" header gets a timestamp. Treating that as
 *    "not saved" made the code re-click Save and record the segment again.
 */
async function segmentFormSaved(page) {
  const url = page.url();
  if (!/-segment\.htm/i.test(url)) return true; // navigated away → saved
  if (/[?&]id=\d+/.test(url)) return true; // form reloaded in EDIT mode → saved
  return await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/Segment Created\s*:\s*([^\n]+)/i);
    return !!(m && m[1] && m[1].trim()); // "Segment Created : Fri 24 Jul ..." → saved
  }).catch(() => false);
}

/**
 * Click Save and WAIT for a definitive outcome: a saved state (navigation OR
 * edit-mode reload) or an error box. Polls up to ~15s; re-clicks Save once
 * midway ONLY while the form is still verifiably unsaved.
 */
async function saveSegmentForm(page) {
  const clickSave = async () => {
    try { await page.click("#save", { timeout: 5000 }); } catch { /* button busy */ }
  };
  await clickSave();
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    if (await segmentFormSaved(page)) return; // saved (either shape)
    const errs = await readSaveErrors(page);
    if (errs.length) return; // rejected with visible errors → assertSaved reports them
    if (i === 8) await clickSave(); // ~5s in, still unsaved and error-free — click once more
  }
}

// After a segment save, confirm it actually persisted (either success shape).
// Only an unsaved form is a failure — surfaced with the on-page validation
// text and a screenshot in last-error.png.
async function assertSaved(page, kind) {
  if (await segmentFormSaved(page)) return;
  const errors = await readSaveErrors(page);
  let shot = "";
  try {
    await page.screenshot({ path: "last-error.png", fullPage: true });
    shot = " [screenshot: last-error.png]";
  } catch { /* screenshot is best-effort */ }
  throw new Error(
    `${kind} did not save${errors.length ? ": " + errors.join("; ") : " (form rejected, no error text found)"}${shot}`
  );
}

/* ── Flight segment (details only; not priced) ─────────────────────────── */

async function addFlightSegment(page, bookingNo, seg) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-flight-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#airline", { timeout: 15000 });

  // Airline + cities are VALIDATED AUTOCOMPLETES (type → pick), not free text.
  // Airline "QANTAS" resolves to "QANTAS AIRWAYS(QF)"; cities to "(SYD) SYDNEY, ...".
  await pickAutocomplete(page, "#airline", seg.airline);            // Airline Name (required)
  await pickAutocomplete(page, "#departureCityCode", seg.fromCity); // e.g. MEL (required)
  await pickAutocomplete(page, "#arrivalCityCode", seg.toCity);     // e.g. SYD (required)
  // Flight Number must be ≤4 chars (digits only); Class must be ≤2 chars (booking code).
  await fillIf(page, "#flightNumber", toFlightNumber(seg.flightNumber));
  await fillIf(page, "#airlineClass", toClassCode(seg.class));      // Class
  await setDateField(page, "#departureDate", toTramadaDate(seg.departureDate)); // required
  await fillIf(page, "#departureTime", seg.departureTime);
  await setDateField(page, "#arrivalDate", toTramadaDate(seg.arrivalDate));     // required
  await fillIf(page, "#arrivalTime", seg.arrivalTime);
  await fillIf(page, "#fareBasis", seg.fareBasis);
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");   // Confirmed [HK]
  await selectIf(page, "#baggageAllowanceTypeCode", seg.baggage);

  // Journey Info (right column) = the stopOvers sector-0 collection. Its
  // Departure City auto-syncs from the main field, but the ARRIVAL city does
  // NOT — leaving "Journey Info › Arrival City" blank. Fill sector-0 arrival
  // (autocomplete) plus its dates/times so the journey detail matches the
  // itinerary. Wrapped in try/catch: on tenants without this section the
  // selectors simply don't exist and are skipped.
  try {
    await setDateField(page, "#stopOversFieldSetCollectiondepartureDate0", toTramadaDate(seg.departureDate));
    await fillIf(page, "#stopOversFieldSetCollectiondepartureTime0", seg.departureTime);
    await setDateField(page, "#stopOversFieldSetCollectionarrivalDate0", toTramadaDate(seg.arrivalDate));
    await fillIf(page, "#stopOversFieldSetCollectionarrivalTime0", seg.arrivalTime);
    await pickAutocomplete(page, "#stopOversFieldSetCollectionarrivalCityCode0", seg.toCity);
  } catch { /* no Journey Info sector on this tenant */ }

  await sleep(300);
  await saveSegmentForm(page);
  await assertSaved(page, `Flight segment ${seg.fromCity || ""}→${seg.toCity || ""}`);
  return { type: "FLT", reference: `${seg.airline || ""} ${seg.flightNumber || ""}`.trim() };
}

/* ── Hotel segment (pricing inline → self-costs) ───────────────────────── */

/**
 * Is this page already parked on THIS booking's hotel form, still holding THIS
 * hotel? Then the only thing missing is the creditor and we can finish the form
 * instead of retyping it.
 *
 * Decided by reading the page, never by remembering "we were on the form" — a
 * remembered flag is a lie as soon as the agent clicks something in that tab,
 * and being wrong here means filling a form that is really a DIFFERENT booking's.
 * Every uncertain answer is `false`, which falls back to the full path: today's
 * behaviour, and safe.
 */
/**
 * The resume decision, as a pure function of what the page says.
 *
 * Separated from the page read so it can be tested offline — this repo's tests
 * never mock Playwright (CLAUDE.md §7), so the only way to cover this logic is
 * to hand it captured facts. And it needs covering: being wrong here means
 * filling a form that belongs to a DIFFERENT booking.
 *
 * Every uncertain answer is false, which falls back to the full path — the
 * behaviour that shipped before this, and safe.
 */
function shouldResumeHotelForm(facts, bookingNo, seg) {
  const f = facts || {};
  const url = String(f.url || "");
  if (!/booking-hotel-segment\.htm/i.test(url)) return false;
  if (!/[?&]mode=add\b/i.test(url)) return false;
  const parent = (url.match(/[?&]parentId=([^&#]+)/i) || [])[1];
  if (!parent) return false;
  let decoded = parent;
  try { decoded = decodeURIComponent(parent); } catch { /* keep raw */ }
  if (decoded !== String(bookingNo)) return false;
  if (!f.hasForm) return false;

  const want = String((seg && (seg.hotelName || seg.hotelNameFreeForm || seg.supplierName)) || "").trim().toUpperCase();
  if (!want) return false;
  // Tramada rewrites a picked supplier to its own casing and wording, and the
  // name may sit in either field depending on whether it matched a listed
  // supplier — so compare on the first significant word rather than the whole
  // string. "NOVOTEL BALI AIRPORT" must still match "Novotel Bali Ngurah Rai".
  const key = want.split(/\s+/)[0];
  if (!key) return false;
  return [f.hotelField, f.supplierField].some((v) => v && String(v).toUpperCase().includes(key));
}

/** Read the page, then decide. Any read failure is "no". */
async function canResumeHotelForm(page, bookingNo, seg) {
  try {
    const held = await page.evaluate(() => {
      const g = (id) => { const e = document.querySelector(id); return e ? String(e.value || "") : ""; };
      return { hotelField: g("#hotelName"), supplierField: g("#supplierName"), hasForm: !!document.querySelector("#costingcreditor") };
    });
    return shouldResumeHotelForm({ ...held, url: page.url() }, bookingNo, seg);
  } catch {
    return false;
  }
}

async function addHotelSegment(page, bookingNo, seg) {
  // Resume: the form is already filled and we came back only for the creditor.
  const resuming = await canResumeHotelForm(page, bookingNo, seg);
  if (resuming) return await finishHotelSegment(page, seg, { resumed: true });

  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-hotel-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#supplierName, #hotelName", { timeout: 15000 });

  // Hotel name. #supplierName is a VALIDATED AUTOCOMPLETE of KNOWN suppliers.
  // Document names ("Novotel Bali Ngurah Rai Airport") usually AREN'T in that
  // list (Tramada has "NOVOTEL BALI AIRPORT"), so: only try the autocomplete for
  // an explicit listed supplier, and on no-match FALL BACK to the free-form name
  // field (#hotelName) instead of hard-failing the whole run.
  const hotelNameValue = seg.hotelName || seg.hotelNameFreeForm || seg.supplierName;
  let pickedSupplier = false;
  if (seg.hotelSupplier) {
    try {
      await pickAutocomplete(page, "#supplierName", seg.hotelSupplier);
      await sleep(1500); // supplier ajax auto-fills the address block
      pickedSupplier = true;
    } catch { /* not a listed supplier → free-form below */ }
  }
  if (!pickedSupplier) {
    await fillIf(page, "#hotelName", hotelNameValue);
  }
  // City Code (#checkInLocation). Tramada REJECTS the save with "City Code is
  // invalid" when this is blank, so one shot at one value is not enough — and
  // the value most likely to be wrong is the one we used to try first.
  //
  // Room-Res reports the SUBURB, not the city: "Haymarket" for a hotel in
  // Sydney, "Bondi Junction" for one in Sydney's east. Neither is a Tramada
  // city, so the autocomplete found nothing, the catch swallowed it, the field
  // stayed empty and Tramada refused the segment. The city the user actually
  // searched ("Sydney") is the reliable answer, so seg.cityCandidates carries it
  // ahead of the suburb. Try each in turn and keep the first that registers.
  const cityTried = [];
  let cityCodeSet = null;
  for (const candidate of (seg.cityCandidates && seg.cityCandidates.length
    ? seg.cityCandidates
    : [seg.cityCode, seg.city])) {
    if (!candidate || cityTried.includes(candidate)) continue;
    cityTried.push(candidate);
    try {
      const got = await pickAutocomplete(page, "#checkInLocation", candidate);
      if (got) { cityCodeSet = got; break; }
    } catch { /* try the next candidate */ }
  }
  // Stop and ask rather than save a form Tramada will reject. Same contract as
  // the creditor question below: the caller asks, the answer comes back as
  // seg.cityCode, and the whole action is re-run.
  if (!cityCodeSet && cityTried.length) throw makeNeedsCity(cityTried, seg.city);
  await selectIf(page, "#roomTypeCode", seg.roomTypeCode);
  await fillIf(page, "#roomType", seg.roomType);           // free-form room type
  await setDateField(page, "#checkInDate", toTramadaDate(seg.checkInDate));
  await setDateField(page, "#checkOutDate", toTramadaDate(seg.checkOutDate));
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Confirmation / reference number. For a Room-Res booking this carries BOTH
  // numbers together — "Q422380 / AQ788851" (quote / itinerary) — so the segment
  // can be traced back to the portal record from inside Tramada.
  const refField = await setConfirmationRef(
    page,
    seg.confirmationNumber || seg.reference || seg.confirmationOrReference
  );
  if (seg.confirmationNumber && !refField) {
    // Don't fail — but make the gap visible so the real id can be pinned down.
    console.warn(
      `[tramada] No confirmation/reference field found on the hotel segment form; "${seg.confirmationNumber}" was not recorded.`
    );
  }

  return await finishHotelSegment(page, seg, { cityTried, refField });
}

/**
 * Everything from the creditor onwards.
 *
 * Split out so a resumed run can re-enter HERE — the fields above are already
 * on the form, and retyping them is what made answering the creditor question
 * look like starting over.
 */
async function finishHotelSegment(page, seg, ctx = {}) {
  const hotelNameValue = seg.hotelName || seg.hotelNameFreeForm || seg.supplierName;
  const cityTried = ctx.cityTried || [];
  const refField = ctx.refField || null;

  // Creditor (REQUIRED by Tramada). Choose "Different from supplier" then match
  // it. If it's missing or doesn't match a listed creditor, STOP and ask the
  // user — don't skip (Tramada would reject the save) or guess.
  //
  // The question now carries what the form itself offers for this hotel. Asking
  // for "the exact name" with nothing on screen made this unanswerable unless
  // the agent already knew Tramada's spelling, which is the whole complaint.
  {
    const diff = page.locator("#creditorDifferentRadio");
    if (await diff.count()) await diff.check().catch(() => {});
    if (!seg.creditor) {
      throw makeNeedsCreditor("hotel", seg.supplierName || hotelNameValue,
        await readCreditorOptions(page, "#costingcreditor", hotelNameValue));
    }
    const unmatched = await pickCreditor(page, "#costingcreditor", seg.creditor);
    if (unmatched) {
      throw makeNeedsCreditor("hotel", unmatched,
        await readCreditorOptions(page, "#costingcreditor", hotelNameValue));
    }
  }

  // Pricing (this is what makes the hotel receiptable). AUD rate incl GST is the
  // primary field for AUD bookings; localRateInclGst mirrors it for local currency.
  await setMoneyField(page, "#audRateIncGst", seg.rate);
  await setMoneyField(page, "#localRateInclGst", seg.localRate || seg.rate);
  await fillIf(page, "#numberOfRooms", seg.rooms || 1);
  await selectIf(page, "#durationTypeCode", seg.durationType || "Nights");
  // NOTE: #duration is READONLY — Tramada auto-computes nights from the
  // check-in/check-out dates. Do not fill it (fillIf skips readonly anyway).

  await sleep(400);
  await saveSegmentForm(page);
  try {
    await assertSaved(page, `Hotel segment ${hotelNameValue || ""}`.trim());
  } catch (err) {
    // "City Code is invalid" is the one rejection we can explain precisely, so
    // say which values were offered rather than leaving the agent to guess at a
    // field the automation filled.
    if (/city\s*code/i.test(err.message) && cityTried.length) {
      err.message +=
        ` — none of ${cityTried.join(", ")} matched a Tramada city.` +
        " Room-Res reports the suburb rather than the city, so a hotel in an outer suburb may need the city naming explicitly.";
    }
    throw err;
  }
  return {
    type: "HTL",
    reference: hotelNameValue || seg.creditor || "Hotel",
    confirmationNumber: seg.confirmationNumber || null,
    confirmationField: refField, // which selector actually took it (null = none found)
    resumed: ctx.resumed === true,
  };
}

/* ── Ticket costing (costs a flight so it becomes receiptable) ──────────── */

async function addTicketCosting(page, bookingNo, ticket) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#airlineCode, #costingcreditor", { timeout: 15000 });

  await pickAutocomplete(page, "#costingcreditor", ticket.creditor); // supplier/airline creditor
  await fillIf(page, "#airlineCode", ticket.airline);
  await fillIf(page, "#ticketClass", ticket.class);
  await selectIf(page, "#passengerTypeCode", ticket.passengerType || "Adult");
  await selectIf(page, "#ticketFareCode", ticket.fareType || "Published");
  await fillIf(page, "#itinerarySummary", ticket.itinerary);
  await fillIf(page, "#ticketNumber", ticket.ticketNumber);

  // Amount (incl GST). AUD Amount is the client-facing fare; the Client Due
  // (costingclientAmountDue) computes from it automatically.
  await setMoneyField(page, "#audAmountIncGst", ticket.fare);
  await setMoneyField(page, "#localTicketAmountIncGst", ticket.localFare || ticket.fare);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Ticket costing ${ticket.airline || ""} ${ticket.class || ""}`.trim());
  return { type: "TKT", reference: `${ticket.airline || ""} ${ticket.class || ""}`.trim() };
}

/* ── PDF-pipeline segments/costings (Tour, Insurance, Service Fee) ───────────
 *
 * Field ids mapped live on booking 12752 (see pdf-field-map.md). Tramada's
 * element id = the field NAME with dots removed (verified: costing.creditor →
 * #costingcreditor, itinerary.statusTypeCode → #itinerarystatusTypeCode). NOTE
 * the Tour form uses audRate**Incl**Gst (with an "l"), unlike the Hotel form's
 * audRateIncGst — the ids below are the exact verified names, not guesses.
 * ────────────────────────────────────────────────────────────────────────── */

// Try to match a creditor autocomplete. Returns null on success, or the
// UNMATCHED value so the caller can report it. The run CONTINUES instead of
// hard-failing on a name that isn't a listed Tramada creditor (doc names like
// "Tour East Bali" / "Novotel Bali Ngurah Rai Airport" usually aren't).
async function pickCreditor(page, selector, value) {
  if (!value) return null;
  try { await pickAutocomplete(page, selector, value); return null; }
  catch { return value; }
}

// Raise a recognizable "I need a creditor from the user" signal. The caller
// (server) catches this, PAUSES the run, asks the user for the creditor, and
// re-runs with their answer — instead of skipping (which then fails Tramada's
// required "Creditor Name must be entered") or guessing.
function makeNeedsCity(tried, suburb) {
  const e = new Error(
    `Tramada City Code: none of ${tried.join(", ")} matched a listed city.`
  );
  e.needsCity = { tried, suburb: suburb || "" };
  return e;
}

function makeNeedsCreditor(kind, supplierName, options) {
  const e = new Error(`Creditor needed for ${kind}${supplierName ? ` "${supplierName}"` : ""}.`);
  // `options` is what the form's own autocomplete returned for this supplier.
  // server.js renders a type-ahead when it is non-empty and falls back to a
  // free-text question when it is not — an unlisted creditor must stay
  // answerable, so an empty list is a valid outcome, not a failure.
  e.needsCreditor = { kind, supplierName: supplierName || "", options: Array.isArray(options) ? options : [] };
  return e;
}

/* ── Tour segment (itinerary) ──────────────────────────────────────────── */

async function addTourSegment(page, bookingNo, seg) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-tour-segment.htm?mode=add&pageSourceParam=itinerariesPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#tourCompanyName, #costingcreditor", { timeout: 15000 });

  // Tour company FREE-FORM name (the product, e.g. "Tour East Bali").
  await fillIf(page, "#tourCompanyName", seg.supplierName || seg.tourCompany);

  // Creditor (REQUIRED). Choose "Different from supplier" then match it. If it's
  // missing or unmatched, STOP and ask the user rather than skip/guess.
  {
    const diff = page.locator('[name="creditorSameOrDifferentFromSupplier"][value="DIFFERENT"]');
    if (await diff.count()) await diff.first().check().catch(() => {});
    const creditor = seg.creditor || seg.supplierName;
    if (!creditor) throw makeNeedsCreditor("tour", seg.supplierName);
    const unmatched = await pickCreditor(page, "#costingcreditor", creditor);
    if (unmatched) throw makeNeedsCreditor("tour", unmatched);
  }

  await fillIf(page, "#freeTextDescription", seg.description);
  if (seg.city) {
    // City autocompletes are non-fatal (a doc city that doesn't match won't kill the save).
    try { await pickAutocomplete(page, "#departureCity", seg.city); } catch { /* skip */ }
    try { await pickAutocomplete(page, "#finishCity", seg.city); } catch { /* skip */ }
  }
  await setDateField(page, "#startDate", toTramadaDate(seg.startDate));
  await setDateField(page, "#finishDate", toTramadaDate(seg.finishDate || seg.startDate));
  await setDateField(page, "#itineraryconfirmationOrIssueDate", toTramadaDate(seg.startDate));
  await fillIf(page, "#itineraryconfirmationOrReferenceNumber", seg.reference);
  await fillIf(page, "#costingcreditorInvoiceNumber", seg.reference);
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Amount: put the line TOTAL in the rate with passengers=1 / duration=1 so
  // Tramada's computed total equals the doc's tour total exactly (no surprise
  // rate × pax × days multiplication).
  await setMoneyField(page, "#localRateInclGst", seg.amount);
  await setMoneyField(page, "#audRateInclGst", seg.amount);
  await fillIf(page, "#numberOfPassengers", seg.passengers || 1);
  await selectIf(page, "#durationTypeCode", seg.durationType || "Days");
  await fillIf(page, "#duration", seg.duration || 1);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Tour segment ${seg.supplierName || ""}`.trim());
  return { type: "TUR", reference: seg.reference || seg.supplierName || "Tour" };
}

/* ── Insurance costing line ────────────────────────────────────────────── */

async function addInsuranceCosting(page, bookingNo, ins) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-insurance-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#costingcreditor", { timeout: 15000 });

  const creditor = ins.creditor || ins.supplierName; // e.g. "Tokio Marine" (IS on the doc)
  if (!creditor) throw makeNeedsCreditor("insurance", ins.supplierName);
  const insUnmatched = await pickCreditor(page, "#costingcreditor", creditor);
  if (insUnmatched) throw makeNeedsCreditor("insurance", insUnmatched);
  await setDateField(page, "#startDate", toTramadaDate(ins.startDate));
  await setDateField(page, "#endDate", toTramadaDate(ins.endDate));
  await selectIf(page, "#statusTypeCode", ins.status || "Confirmed");
  await setDateField(page, "#confirmationOrIssueDate", toTramadaDate(ins.issueDate));
  await fillIf(page, "#confirmationOrReferenceNumber", ins.reference); // policy no (if any)
  await fillIf(page, "#costingcreditorInvoiceNumber", ins.reference);

  // Primary amount (incl GST). Insurance here is GST-free so excl auto-mirrors it.
  await setMoneyField(page, "#policyGrossAmountInclGst", ins.amount);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Insurance line ${ins.supplierName || ins.creditor || ""}`.trim());
  return { type: "INS", reference: ins.reference || ins.supplierName || "Insurance" };
}

/* ── Service Fee costing line (OPTIONAL) ────────────────────────────────────
 * Under an EFT receipt there is normally no credit-card surcharge, so the PDF
 * pipeline SKIPS this by default. When enabled, the fee-TYPE code (e.g.
 * A_CS_SFE_FEE) is normally chosen via a "Select Fee Type" lookup on the form —
 * that lookup is NOT yet automated here; we set the visible fields and rely on a
 * default/typed fee type. If a run needs a specific fee type, map that lookup
 * live first. Kept best-effort so the main EFT path never depends on it.
 * ────────────────────────────────────────────────────────────────────────── */

async function addServiceFeeCosting(page, bookingNo, fee) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-service-fee-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#description, #costingcreditor", { timeout: 15000 });

  await selectIf(page, "#serviceFeeType", fee.serviceFeeType || "Booking Fee");
  if (fee.feeType) await fillIf(page, "#feeType", fee.feeType);
  await fillIf(page, "#description", fee.description || "Service Fee");
  const creditor = fee.creditor || fee.supplierName;
  if (creditor) {
    const feeUnmatched = await pickCreditor(page, "#costingcreditor", creditor);
    if (feeUnmatched) throw makeNeedsCreditor("servicefee", feeUnmatched);
  }
  await fillIf(page, "#quantity", fee.quantity || 1);
  await setMoneyField(page, "#grossFeeAmountInclGst", fee.amount);
  await fillIf(page, "#issueDate", toTramadaDate(fee.issueDate));

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Service fee ${fee.description || ""}`.trim());
  return { type: "SFE", reference: fee.description || "Service Fee" };
}

// Read the costing table so callers can confirm what's receiptable.
async function readCostings(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-costings.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const t of tables) {
      const head = t.querySelector("tr");
      if (head && /Due\s*inc\s*GST/i.test(head.textContent)) {
        const rows = t.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 7 && !/TOTALS/i.test(rows[i].textContent)) {
            out.push({ segType: clean(c[1]), reference: clean(c[2]), dueIncGst: clean(c[7]) });
          }
        }
        return out;
      }
    }
    return [];
  });
}

// Read the itinerary list — used when resuming an existing booking to skip
// segments that are already there.
async function readItinerary(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-itineraries.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");

    // The row's dates, taken by pattern rather than by column index — the
    // itinerary table's columns differ by segment type, so "the 4th cell is
    // the start date" is only ever true for one kind of segment.
    const datesIn = (cells) => {
      const found = [];
      for (const c of cells) {
        const m = clean(c).match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
        if (!m) continue;
        let [, d, mo, y] = m;
        if (y.length === 2) y = `20${y}`;
        const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) found.push(iso);
      }
      found.sort();
      return { from: found[0] || null, to: found.length > 1 ? found[found.length - 1] : null };
    };

    for (const t of document.querySelectorAll("table")) {
      const h = t.querySelector("tr");
      if (h && /Seg\.?\s*Type/i.test(h.textContent)) {
        const out = [];
        const rows = t.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 3 && clean(c[1])) {
            // Dates carried alongside the segment: a booking that already has
            // a flight and a hotel knows perfectly well when the trip runs, and
            // dropping these was why insurance asked for travel dates on a
            // booking whose segments spelled them out.
            const { from, to } = datesIn(c);
            out.push({ segType: clean(c[1]), reference: clean(c[2]), dateFrom: from, dateTo: to });
          }
        }
        return out;
      }
    }
    return [];
  });
}

// Booking header details (for the state card): client, itinerary, dates.
async function readBookingHeader(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    const grab = (label) => {
      const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
      return m ? m[1].trim() : "";
    };
    // The Passengers table at the top of the summary. It carries the age, the
    // membership number and the email address — three of the things the
    // insurance flow used to ask for while they sat on the page it had just
    // read. Columns are located by their headers, not by index.
    const passengers = (() => {
      for (const t of document.querySelectorAll("table")) {
        const head = t.querySelector("tr");
        if (!head || !/Passenger\s*Name/i.test(head.textContent || "")) continue;
        const cols = Array.from(head.querySelectorAll("th, td")).map((c) =>
          (c.textContent || "").trim().toLowerCase()
        );
        const at = (re) => cols.findIndex((c) => re.test(c));
        const iName = at(/passenger\s*name/);
        const iAge = at(/^age$/);
        const iMem = at(/member/);
        const iMail = at(/e-?mail/);
        const out = [];
        const rows = t.querySelectorAll("tr");
        for (let r = 1; r < rows.length; r++) {
          const c = rows[r].querySelectorAll("td");
          if (!c.length) continue;
          const cell = (i) => (i >= 0 && c[i] ? (c[i].textContent || "").trim() : "");
          const name = cell(iName);
          // "Page 1 ..." is the pager row, not a passenger.
          if (!name || /^page\b/i.test(name)) continue;
          out.push({
            name,
            age: cell(iAge),
            membershipNumber: cell(iMem),
            email: cell(iMail),
          });
        }
        if (out.length) return out;
      }
      return [];
    })();

    return {
      bookingNo: grab("Booking No\\.?"),
      client: grab("Client"),
      clientName: grab("Client Name"),
      itinerary: grab("Itinerary(?:\\s*Summary)?"),
      bookDate: grab("Book\\.? Date"),
      // The summary labels these "Departure Date" / "Return Date". We only
      // asked for "Dep. Date" and never asked for the return at all, so a
      // booking that plainly showed 01-10-2026 → 15-10-2026 still had the
      // agent typing both dates into the insurance flow by hand.
      depDate: grab("Departure Date") || grab("Dep\\.? Date"),
      returnDate: grab("Return Date"),
      passengers,
      totalDue: grab("Total Client/Debtor Due"),
      receipted: grab("Client/Debtor Receipted"),
      balance: grab("Client/Debtor Balance"),
    };
  });
}

// Existing receipts on the booking (part-payments visible in the state card).
async function readReceiptsList(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    for (const t of document.querySelectorAll("table")) {
      const h = t.querySelector("tr");
      if (h && /Receipt\s*No/i.test(h.textContent)) {
        const out = [];
        const rows = t.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 9 && /^R\./i.test(clean(c[1]))) {
            out.push({
              receiptNo: clean(c[1]),
              transType: clean(c[4]),
              reference: clean(c[6]),
              dateReceived: clean(c[7]),
              amount: clean(c[8]),
              allocated: clean(c[9]),
            });
          }
        }
        return out;
      }
    }
    return [];
  });
}

/**
 * Read the full state of a booking in one pass: header, itinerary segments,
 * costing lines, and receipts. Powers the "what's already here" summary card
 * and the assistant's suggestions (e.g. remaining balance).
 */
async function runReadBookingState({ username, password, bookingNo, callbacks = {} } = {}) {
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const header = await readBookingHeader(page, bookingNo);
    const segments = await readItinerary(page, bookingNo);
    const costings = await readCostings(page, bookingNo);
    const receipts = await readReceiptsList(page, bookingNo);
    // The traveller's mobile lives on the passenger record, not the summary.
    // One extra page load, and it saves the insurance flow asking for a number
    // Tramada already holds. Non-fatal: no passenger yet just means "".
    const contactPhone = await readPassengerMobile(page, bookingNo).catch(() => "");
    if (contactPhone && header.passengers && header.passengers[0]) {
      header.passengers[0].phone = contactPhone;
    }
    return { bookingNo: String(bookingNo), header, segments, costings, receipts, contactPhone };
  });
}

/**
 * Just the booking's client — one page load, no segments/costings/receipts.
 * The Room-Res quote flow needs this BEFORE it can create the Room-Res draft
 * (the portal wants guest names up front), and it only needs the name, so
 * runReadBookingState's four page loads would be three too many.
 */
async function runReadBookingClient({ username, password, bookingNo, callbacks = {} } = {}) {
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const header = await readBookingHeader(page, bookingNo);
    // Same trip to Tramada also collects the traveller's mobile, which Room-Res
    // needs before it will build the draft (§6c). Non-fatal if absent.
    const contactPhone = await readPassengerMobile(page, bookingNo).catch(() => "");
    return {
      bookingNo: String(bookingNo),
      clientCode: header.client || "",
      clientName: header.clientName || header.client || "",
      contactPhone,
    };
  });
}

/**
 * The lead passenger's mobile number.
 *
 * Room-Res provider 19 refuses its booking form without a guest contact number
 * (roomres-field-map.md §6c), and that number must be the traveller's own — we
 * never invent one for a form that reaches a real hotel. It lives on the
 * passenger record as `input[name="mobile"]` ("Mobile No"); the booking summary
 * doesn't carry it and the client summary only renders it as text.
 *
 * Deliberately non-fatal: a booking with no passenger yet, or a passenger with
 * no number on file, returns "" and the caller decides what to do about it.
 */
async function readPassengerMobile(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-passengers.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);

  // The list links each passenger by row; there is no id we can guess, so
  // follow the first booking-passenger.htm link the page offers.
  const href = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("a")).find((x) =>
      /booking-passenger\.htm/i.test(x.getAttribute("href") || "")
    );
    return a ? a.getAttribute("href") : "";
  });
  if (!href) return "";

  await page.goto(new URL(href, TRAMADA_BASE_URL).toString(), { waitUntil: "domcontentloaded" });
  await sleep(500);
  return await page.evaluate(() => {
    const el = document.querySelector('input[name="mobile"]');
    return el ? String(el.value || "").trim() : "";
  });
}

/* ── Passenger (REQUIRED before hotel segments and costings) ───────────── */

/**
 * Add a passenger to the booking. Without at least one passenger, hotel
 * segments and ticket costings fail with "Passenger is required."
 * Default source "This Client" adds the booking's client as the traveller.
 */
async function addPassenger(page, bookingNo, { source = "This Client" } = {}) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-passengers.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#passengerSourceSelect", { timeout: 15000 });

  // Idempotent: if the booking already has a passenger (e.g. resuming an
  // existing booking), don't add a duplicate.
  // Same null-body hazard as readSaveErrors: guard it rather than assume.
  const hasPassenger = await page.evaluate(
    () => !!document.body && !/No records found/i.test(document.body.innerText || "")
  );
  if (hasPassenger) return { source, skipped: true };
  await selectIf(page, "#passengerSourceSelect", source); // "This Client" => THIS_CLIENT
  await sleep(300);
  await page.click("#add"); // "Add as Passenger(s)"
  await page.waitForLoadState("domcontentloaded");
  await sleep(800);
  // A passenger-profile confirm form (pre-filled from the client) may appear — save it.
  const save = page.locator("#save");
  if (await save.count()) {
    await save.first().click();
    await page.waitForLoadState("domcontentloaded");
    await sleep(800);
  }
  return { source };
}

async function runAddPassenger({ username, password, bookingNo, source, callbacks = {} }) {
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, (page) =>
    addPassenger(page, bookingNo, { source })
  );
}

/* ── Client lookup (read-only) ─────────────────────────────────────────── */

// A SECOND `function _listSuggestions(sel)` used to live here — the dropdown
// scraper the client lookup used before it moved to the client-search page. It
// had no callers left, but a duplicate function declaration is not inert: the
// later one wins for the whole module, so `readCreditorOptions`'s
// `page.evaluate(_listSuggestions, { sel, raw })` was reaching THIS one, which
// takes a plain selector string. The browser stringified the object and threw
// "'[object Object]' is not a valid selector", the catch swallowed it, and the
// creditor question offered an empty option list on every single run — the
// exact feature it was added for, silently never working.
//
// Deleted rather than renamed. Same shape as the `parseDateRange` landmine:
// dead code that still ran, and looked tested because its live twin was.

/**
 * Find clients on the CLIENT SEARCH page — /client/client-search.htm.
 *
 * This used to type a surname into the `#client` autocomplete on the booking
 * form and scrape the dropdown. That meant depending on dropdown geometry and
 * render timing, and then GUESSING the client code by splitting a display
 * string on whitespace. The search page returns the code as its own column,
 * alongside Account Type, Branch and Debtor — all of which the booking header
 * needs and none of which the autocomplete ever showed.
 *
 * Account Type is the reason this matters beyond tidiness: it decides which
 * debtor widget the booking form renders, and it is NOT implied by the debtor
 * (live sandbox has Corporate clients whose debtor is the retail entity).
 *
 * @returns [{ clientCode, clientName, accountType, branch, debtorCode, debtorName, label }]
 */
async function readClientMatches(page, { firstName = "", lastName = "", clientCode = "" } = {}) {
  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  const code = String(clientCode || "").trim();
  if (!first && !last && !code) return [];

  // Tramada serves this page under more than one route depending on how you
  // arrive, and a plain waitForSelector failure here said only
  // "Timeout 20000ms exceeded" — no URL, no page, nothing to act on. Try the
  // known routes, and if none of them yields the form, say what DID load.
  const ROUTES = [
    `${TRAMADA_BASE_URL}/client/client-search.htm`,
    `${TRAMADA_BASE_URL}/client/client-search.htm?mode=search`,
    `${TRAMADA_BASE_URL}/client/client-list.htm`,
  ];
  let opened = false;
  for (const url of ROUTES) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => {
      if (!/ERR_ABORTED/i.test(e.message)) throw e;
    });
    opened = await page
      .waitForSelector("#searchForm_lastName", { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
  }
  if (!opened) {
    const seen = await page
      .evaluate(() => {
        const ids = [];
        document.querySelectorAll("input, select, button").forEach((n) => {
          if (n.id) ids.push(`#${n.id}`);
        });
        return { title: document.title, ids: [...new Set(ids)].slice(0, 30) };
      })
      .catch(() => ({ title: "", ids: [] }));
    throw new Error(
      `Tramada's client search form didn't load (landed on ${page.url()}, title "${seen.title}"). ` +
        `Fields present: ${seen.ids.join(", ") || "none"}.`
    );
  }

  // Clear first: the form remembers the previous search, so leaving a stale
  // surname in place would silently AND it with the new one and find nothing.
  await page.evaluate(() => {
    for (const id of ["#searchForm_profileName", "#searchForm_firstName", "#searchForm_lastName"]) {
      const el = document.querySelector(id);
      if (el) el.value = "";
    }
  });
  await fillIf(page, "#searchForm_profileName", code);
  await fillIf(page, "#searchForm_firstName", first);
  await fillIf(page, "#searchForm_lastName", last);

  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);

  return await page.evaluate(() => {
    const txt = (el) => (el && el.textContent ? el.textContent.trim().replace(/\s+/g, " ") : "");
    // Anchor on the header, not on table order — this page has several tables.
    let table = null;
    for (const t of document.querySelectorAll("table")) {
      const h = t.querySelector("tr");
      if (h && /Client\s*Code/i.test(h.textContent || "") && /Account\s*Type/i.test(h.textContent || "")) {
        table = t;
        break;
      }
    }
    if (!table) return [];
    return Array.from(table.querySelectorAll("tr"))
      .slice(1)
      .map((tr) => {
        const c = tr.querySelectorAll("td");
        if (c.length < 7) return null;
        const clientCode = txt(c[1]);
        if (!clientCode) return null;
        const accountType = txt(c[3]);
        const debtorName = txt(c[6]);
        return {
          clientCode,
          clientName: txt(c[2]),
          accountType,
          branch: txt(c[4]),
          debtorCode: txt(c[5]),
          debtorName,
          terminationDate: c.length > 8 ? txt(c[8]) : "",
          // What the chat shows in the pick-list.
          label: [clientCode, txt(c[2]), accountType, debtorName].filter(Boolean).join(" · "),
        };
      })
      .filter(Boolean)
      // A terminated client can't take a new booking — never offer one.
      .filter((r) => !r.terminationDate);
  });
}

async function runSearchClients({ username, password, firstName, lastName, surname, callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  const last = lastName || surname || "";
  const who = [firstName, last].filter(Boolean).join(" ");
  return await withPage({ username, password, callbacks }, async (page) => {
    onProgress(30, `Searching Tramada clients for "${who}"...`);
    const matches = await readClientMatches(page, { firstName, lastName: last });
    onProgress(100, matches.length ? `${matches.length} client match(es).` : `No client matched "${who}".`);
    return matches;
  });
}

/* ── Booking lookup ────────────────────────────────────────────────────── */

/**
 * Does this booking exist in Tramada? Read-only.
 *
 * The summary page is served for a real booking and shows "Booking No. <n>" in
 * its header; an unknown id renders the shell without that header. Match on the
 * NUMBER, not merely on the page loading — Tramada answers 200 either way, so
 * "the request worked" says nothing about whether the booking is there.
 */
async function checkBookingExists(page, bookingNo) {
  const want = String(bookingNo || "").replace(/^B/i, "").trim();
  if (!want) throw new Error("A booking number is required.");

  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(want)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(700);

  return await page.evaluate((n) => {
    if (!document.body) return { found: false, bookingNo: n };
    const text = document.body.innerText || "";
    const grab = (label) => {
      const m = text.match(new RegExp(label + "\\s*:?\\s*\\n?\\s*([^\\n]+)", "i"));
      return m ? m[1].trim() : "";
    };
    const header = text.match(/Booking No\.?\s*(\d+)/i);
    const found = !!header && header[1] === String(n);
    return {
      found,
      bookingNo: found ? header[1] : n,
      client: found ? grab("Client") : "",
      clientName: found ? grab("Client Name") : "",
      itinerary: found ? grab("Itinerary") : "",
      debtor: found ? grab("Debtor") : "",
      departureDate: found ? grab("Dep\\. Date") : "",
      bookDate: found ? grab("Book\\. Date") : "",
      consultant: found ? grab("Cons1") : "",
    };
  }, want);
}

async function runCheckBooking({ username, password, bookingNo, callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  return await withPage({ username, password, callbacks }, async (page) => {
    onProgress(40, `Looking up booking ${bookingNo} in Tramada...`);
    const res = await checkBookingExists(page, bookingNo);
    onProgress(100, res.found ? `Booking ${res.bookingNo} found.` : `Booking ${bookingNo} not found.`);
    return res;
  });
}

/* ── Client creation ───────────────────────────────────────────────────── */

/**
 * Create a client — /client/client-add.htm?mode=ADD.
 *
 * Field map taken live on 29-Jul-2026 (roomres-field-map.md §14). 68 fields, and
 * NONE of them carry an HTML `required` attribute, so there is nothing to
 * pre-flight: Tramada validates in its own code and paints the complaint on the
 * page, exactly like the segment forms.
 *
 * ⚠️ ORDERING — `debtor.debtorType` decides WHICH debtor widget exists at all:
 *   CORPORATE (the default) → `#debtor`, a text box with an Edit picker
 *   RETAIL                  → `#retailDebtor`, a plain <select>
 * `#retailDebtor` is not merely disabled while the type is CORPORATE, it has no
 * offsetParent — so setting it before switching the type silently does nothing
 * and the client is created against no debtor. Set the type, wait for the
 * select to appear, then choose. (Same trap as the Room-Res price box, §8a.)
 *
 * The Client Code is deliberately left blank: Tramada generates it from the
 * name (GRAY/MEGAN), and inventing one risks colliding with a real record. It's
 * read back after the save instead.
 */
async function createClient(page, client) {
  const { title, firstName, lastName, email, phone, debtor, travellerType = "MEMBER" } = client;
  // Verified live 29-Jul-2026: saving with only a first and last name is
  // REFUSED — "Unable to save - please complete the mandatory fields Surname,
  // First Name & Title". Title is mandatory, and it can't be defaulted without
  // assuming the client's gender, so the caller has to have asked for it.
  if (!firstName || !lastName) throw new Error("A first and last name are required to create a Tramada client.");
  if (!title) throw new Error("Tramada requires a Title (Mr/Ms/Mrs/Miss/Dr/…) on a new client.");

  await page.goto(`${TRAMADA_BASE_URL}/client/client-add.htm?mode=ADD`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lastName", { timeout: 20000 });

  // Debtor type first — it swaps the widget (see above).
  if (debtor) {
    await selectIf(page, "#debtordebtorType", "RETAIL");
    await page.waitForSelector("#retailDebtor", { state: "visible", timeout: 10000 }).catch(() => {});
    // Match on the debtor's NAME, never the numeric option value: those ids are
    // per-environment ("3" is RAA of SA Limited in the sandbox and means
    // nothing in another Tramada).
    await selectIf(page, "#retailDebtor", debtor);
    const chosen = await page.evaluate(() => {
      const s = document.querySelector("#retailDebtor");
      if (!s || !s.value) return "";
      const o = s.options[s.selectedIndex];
      return o ? (o.textContent || "").trim() : "";
    });
    if (!chosen) throw new Error(`Tramada has no retail debtor named "${debtor}" — the client would be created against nothing.`);
  }

  await selectIf(page, "#title", title);
  const titleSet = await page.evaluate(() => {
    const s = document.querySelector("#title");
    return s ? s.value : "";
  });
  if (!titleSet) throw new Error(`Tramada has no title matching "${title}" — it offers Mr, Ms, Mrs, Miss, Master, Honorable, Dr, Prof.`);
  await fillIf(page, "#firstName", firstName);
  await fillIf(page, "#lastName", lastName);
  await fillIf(page, "#contactemail1address", email);
  await fillIf(page, "#contactmobile", phone);
  // Not mandatory — a client saves without it — but its absence leaves
  // "Client Profile: Traveller Type must be entered" nagging on every summary.
  // MEMBER by agreement, since clients created through this flow are RAA members.
  await selectIf(page, "#travellerType", travellerType);

  await page.click("#save");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1200);

  // A SUCCESSFUL save REDIRECTS to /client/client-summary.htm?id=<id>, and that
  // page has no #profileName at all — reading it there returns "" and looks
  // exactly like a failure, so the run would report "didn't save" over a client
  // it had just created, and a retry would create a second one. Detect success
  // by the landing page, and take the code from the summary header.
  const saved = await page.evaluate(() => {
    const onSummary = /client-summary\.htm/i.test(location.href);
    const h = document.querySelector("h2");
    const fromHeader = h ? (h.textContent || "").trim() : "";
    // "MINFIELDS/AUTOTEST MS - Client Summary"
    const fromTitle = (document.title || "").replace(/\s*-\s*Client Summary\s*$/i, "").trim();
    const field = document.querySelector("#profileName");
    return {
      onSummary,
      code: (onSummary ? fromHeader || fromTitle : "") || (field ? String(field.value || "").trim() : ""),
      id: (location.search.match(/[?&]id=(\d+)/) || [])[1] || "",
    };
  });

  if (!saved.code) {
    const errors = await readSaveErrors(page);
    throw new Error(
      `Tramada didn't save the client${errors.length ? ": " + errors.join("; ") : " (no error text found on the form)"}.`
    );
  }

  // Non-blocking profile grumbles ("Traveller Type must be entered") appear on
  // the summary of a client that DID save. Report them; never mistake one for a
  // failure.
  const warnings = (await readSaveErrors(page).catch(() => [])).filter((w) => !/no records found/i.test(w));

  return {
    clientCode: saved.code,
    clientId: saved.id,
    clientName: `${title ? title + " " : ""}${firstName} ${lastName}`.trim(),
    debtor: debtor || "",
    email: email || "",
    phone: phone || "",
    warnings,
    url: page.url(),
  };
}

async function runCreateClient({ username, password, callbacks = {}, ...client }) {
  const onProgress = callbacks.onProgress || (() => {});
  return await withPage({ username, password, callbacks }, async (page) => {
    onProgress(30, `Creating Tramada client ${client.firstName} ${client.lastName}...`);
    const created = await createClient(page, client);
    onProgress(100, `Client ${created.clientCode} created.`);
    return created;
  });
}

/* ── Standalone runners (open their own page over CDP) ─────────────────── */

/**
 * One sticky tab for a segment write that can stop and ask.
 *
 * Reported live 05-Aug-2026: "the automation started the hotel segment then just
 * stops and asks for the Creditor name, When supplied it starts from top again".
 * That was exactly right. addHotelSegment fills about ten fields before it
 * reaches the creditor, and withPage() below hands back a THROWAWAY tab — so
 * the answer arrived to a page that no longer existed and the whole action was
 * replayed: fresh navigation, repeated passenger check, every field again.
 *
 * insurance-portal.js already solved this for its own human turns. Same shape
 * here, deliberately, so the codebase has one pattern and not two. The CALLER
 * releases it with closeSegmentPage().
 *
 * Nothing is lost if this dies mid-question — _segAlive() falls back to opening
 * a fresh tab, which is precisely the old behaviour.
 */
let _segSticky = null; // { browser, page }

function _segAlive() {
  return !!(_segSticky && _segSticky.page && !_segSticky.page.isClosed() &&
            _segSticky.browser && _segSticky.browser.isConnected());
}

/** Is a segment form still parked and usable? Lets a caller skip work it already did. */
function hasOpenSegmentPage() { return _segAlive(); }

async function closeSegmentPage() {
  const s = _segSticky;
  _segSticky = null;
  if (!s) return;
  try { if (s.page && !s.page.isClosed()) await s.page.close(); } catch { /* already gone */ }
  try { if (s.browser && s.browser.isConnected()) await s.browser.close(); } catch { /* already gone */ }
}

async function withSegmentPage(args, fn) {
  const onProgress = (args.callbacks && args.callbacks.onProgress) || (() => {});
  if (_segAlive()) {
    onProgress(3, "Picking up the open Tramada tab...");
    return await fn(_segSticky.page);
  }
  await closeSegmentPage(); // a dead slot must never be reused

  const { browser } = await openBrowser(onProgress);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await ensureLoggedIn(page, {
    username: args.username,
    password: args.password,
    onNeedLogin: args.callbacks && args.callbacks.onNeedLogin,
  });
  let ok = false;
  try {
    const out = await fn(page);
    ok = true;
    return out;
  } finally {
    // Held open either way. On success the caller may still have a receipt to
    // raise; on failure the rejected form stays on screen to be inspected, and
    // a stop-and-ask pause IS a failure as far as this try block is concerned —
    // which is the whole point.
    _segSticky = { browser, page };
  }
}

async function withPage(args, fn) {
  const onProgress = (args.callbacks && args.callbacks.onProgress) || (() => {});
  let browser, page;
  let ok = false;
  try {
    ({ browser } = await openBrowser(onProgress));
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, {
      username: args.username,
      password: args.password,
      onNeedLogin: args.callbacks && args.callbacks.onNeedLogin,
    });
    const result = await fn(page);
    ok = true;
    return result;
  } finally {
    // On SUCCESS close our tab. On FAILURE leave it open — the failed form
    // (with its error messages) stays on screen for inspection. Disconnecting
    // from a CDP browser doesn't close the user's Chrome or its tabs.
    if (ok) {
      try { if (page) await page.close(); } catch {}
    }
    try { if (browser) await browser.close(); } catch {}
  }
}

/**
 * Add a list of segments to a booking.
 * @param {Array} segments  each: { kind: "flight"|"hotel", ...fields }
 */
async function runAddSegments({ username, password, bookingNo, segments = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  // Sticky: a hotel segment can stop and ask for the creditor half way through
  // the form, and the answer must come back to THAT page rather than replaying
  // the whole write. closeSegmentPage() is the caller's to call.
  return await withSegmentPage({ username, password, callbacks }, async (page) => {
    const added = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      onProgress(20 + i * 10, `Adding ${s.kind} segment ${i + 1}/${segments.length}...`);
      if (s.kind === "flight") added.push(await addFlightSegment(page, bookingNo, s));
      else if (s.kind === "hotel") added.push(await addHotelSegment(page, bookingNo, s));
      else if (s.kind === "tour") added.push(await addTourSegment(page, bookingNo, s));
      else throw new Error(`Unknown segment kind: ${s.kind}`);
    }
    onProgress(100, `Added ${added.length} segment(s).`);
    return added;
  });
}

/**
 * Add ticket costings for flights.
 * @param {Array} costings  each ticket: { creditor, airline, class, fare, ... }
 */
async function runAddCostings({ username, password, bookingNo, costings = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const done = [];
    for (let i = 0; i < costings.length; i++) {
      onProgress(20 + i * 10, `Costing ticket ${i + 1}/${costings.length}...`);
      done.push(await addTicketCosting(page, bookingNo, costings[i]));
    }
    const costingTable = await readCostings(page, bookingNo);
    onProgress(100, `Costed ${done.length} ticket(s).`);
    return { done, costingTable };
  });
}

/**
 * Add standalone costing LINES (insurance, service fee) — the ones added on the
 * Costing page rather than the itinerary. Each: { kind:"insurance"|"servicefee", ... }.
 */
async function runAddCostingLines({ username, password, bookingNo, lines = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const added = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      onProgress(20 + i * 10, `Adding ${l.kind} costing ${i + 1}/${lines.length}...`);
      if (l.kind === "insurance") added.push(await addInsuranceCosting(page, bookingNo, l));
      else if (l.kind === "servicefee") added.push(await addServiceFeeCosting(page, bookingNo, l));
      else throw new Error(`Unknown costing line kind: ${l.kind}`);
    }
    onProgress(100, `Added ${added.length} costing line(s).`);
    return added;
  });
}

/* ── Full pipeline orchestrator ────────────────────────────────────────── */

/**
 * Run the entire chain: create booking → add segments → cost flights → receipt.
 * Each stage reuses the tested single-purpose modules; the booking number from
 * stage 1 threads through the rest.
 *
 * @param {object} args
 * @param {string} args.clientCode                Tramada client (e.g. "GRAY/SPIDER")
 * @param {object} args.booking                   booking header (see tramada-booking.js)
 * @param {Array}  args.segments                  [{kind:"flight"|"hotel", ...}]
 * @param {Array}  [args.costings]                ticket costings for flights [{creditor, airline, class, fare}]
 * @param {object} args.receipt                   see tramada-receipt.js runTramadaReceipt
 * @param {boolean}[args.dryRunReceipt=true]      preview the receipt (no commit) by default
 * @param {object} [args.callbacks]               { onProgress(pct,msg), onError(msg), onStage(name,data) }
 */
async function runFullBooking({
  username,
  password,
  clientCode,
  booking,
  existingBookingNo = null, // resume this booking instead of creating a new one
  segments = [],
  costings = [],
  receipt,
  dryRunReceipt = true,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onStage = callbacks.onStage || (() => {});
  const onNeedLogin = callbacks.onNeedLogin; // propagate to every stage's login check

  try {
    // 1) Create the booking header — or RESUME an existing booking.
    let bookingNo;
    let addRes = { add: null };
    if (existingBookingNo) {
      bookingNo = String(existingBookingNo);
      onProgress(5, `Resuming existing booking ${bookingNo} — skipping create.`);
      onStage("booking", { bookingNo, resumed: true });
    } else {
      onProgress(5, "Creating booking...");
      addRes = await runTramadaAddAndSearch({
        username, password, clientCode, booking,
        skipSearch: true, // bookingNo comes from the URL — no need for the 15s search poll
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(5 + Math.round(p * 0.2), m) },
      });
      bookingNo = addRes.add && addRes.add.bookingNo;
      if (!bookingNo) throw new Error("Booking created but no booking number was returned.");
      onStage("booking", { bookingNo, add: addRes.add });
    }

    // 2) Add a passenger — REQUIRED before hotel segments / costings, else they
    //    fail with "Passenger is required." Idempotent: skips if one exists.
    onProgress(26, "Adding passenger...");
    const paxResult = await runAddPassenger({
      username, password, bookingNo,
      source: (booking && booking.passengerSource) || "This Client",
      callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(26 + Math.round(p * 0.03), m) },
    });
    onStage("passenger", paxResult);

    // 3) Add segments (flight + hotel). When resuming, first read what the
    //    booking already has and skip that many of each kind — so a re-run
    //    never duplicates the segments that saved before the failure.
    let segmentsToAdd = segments;
    if (existingBookingNo) {
      const existing = await withPage({ username, password, callbacks: { onNeedLogin } }, (page) =>
        readItinerary(page, bookingNo)
      );
      const have = {
        flight: existing.filter((s) => /FLT/i.test(s.segType)).length,
        hotel: existing.filter((s) => /HTL/i.test(s.segType)).length,
      };
      const seen = { flight: 0, hotel: 0 };
      segmentsToAdd = [];
      for (const s of segments) {
        if (seen[s.kind] < (have[s.kind] || 0)) {
          seen[s.kind]++;
          onProgress(30, `Skipping existing ${s.kind} segment (already on booking).`);
        } else {
          segmentsToAdd.push(s);
        }
      }
    }
    onProgress(30, "Adding itinerary segments...");
    const segResult = segmentsToAdd.length
      ? await runAddSegments({
          username, password, bookingNo, segments: segmentsToAdd,
          callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(30 + Math.round(p * 0.2), m) },
        })
      : [];
    onStage("segments", segResult);

    // 4) Cost the flights (hotels self-cost on their form). When resuming,
    //    skip as many ticket costings as already exist.
    let costResult = { done: [], costingTable: [] };
    let costingsToAdd = costings;
    if (existingBookingNo && costings.length) {
      const table = await withPage({ username, password, callbacks: { onNeedLogin } }, (page) =>
        readCostings(page, bookingNo)
      );
      const haveTkts = table.filter((r) => /TKT/i.test(r.segType)).length;
      if (haveTkts > 0) {
        onProgress(55, `Skipping ${haveTkts} existing ticket costing(s).`);
        costingsToAdd = costings.slice(haveTkts);
      }
    }
    if (costingsToAdd.length) {
      onProgress(55, "Costing flights...");
      costResult = await runAddCostings({
        username, password, bookingNo, costings: costingsToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(55 + Math.round(p * 0.15), m) },
      });
      onStage("costing", costResult);
    }

    // 5) Receipt — OPTIONAL: only when receipt details were provided. This lets
    //    the assistant run segments/costing-only jobs on existing bookings.
    let receiptResult = null;
    if (receipt && receipt.reference) {
      onProgress(75, dryRunReceipt ? "Building receipt preview..." : "Issuing receipt...");
      receiptResult = await runTramadaReceipt({
        username, password, bookingNo, receipt, dryRun: dryRunReceipt,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(75 + Math.round(p * 0.24), m) },
      });
      onStage("receipt", receiptResult);
    } else {
      onProgress(95, "No receipt requested — skipping receipt stage.");
    }

    onProgress(100, dryRunReceipt && receiptResult ? "Pipeline ready (receipt not committed)." : "Pipeline complete.");
    return { bookingNo, booking: addRes.add, segments: segResult, costing: costResult, receipt: receiptResult };
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

/**
 * PDF-driven pipeline: given the structured data parsed from an RAA itinerary/
 * costing PDF, add its Tour + Hotel segments and Insurance (and optionally
 * Service Fee) costing lines to the EXISTING booking (resolved from the BPAY
 * Ref), then stage/issue an EFT receipt for the full amount.
 *
 * Safe by design:
 *  - Verifies the booking exists and the client matches the PDF; STOPS on
 *    mismatch without changing anything.
 *  - Idempotent: skips any Tour/Hotel/Insurance/Service-Fee that is already on
 *    the booking, and skips the receipt if the booking is already fully paid.
 *  - dryRunReceipt defaults TRUE — the receipt is staged (screenshot) but not
 *    committed, so the caller can confirm before issuing (req: confirm first).
 *
 * @param {object} args
 * @param {object} args.data                parsed PDF (see pdf-itinerary.js)
 * @param {boolean}[args.includeServiceFee=false]  create the Service-Fee line too
 * @param {boolean}[args.dryRunReceipt=true]       stage (don't commit) the receipt
 * @param {object} [args.callbacks]         { onProgress, onError, onStage, onNeedLogin }
 */
async function runPdfBooking({
  username,
  password,
  data,
  includeServiceFee = false,
  dryRunReceipt = true,
  forceClient = false, // apply to this booking even if its client differs from
                       // the PDF (uses THIS booking's client — explicit request)
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onStage = callbacks.onStage || (() => {});
  const onNeedLogin = callbacks.onNeedLogin;

  const bookingNo = data && data.bookingNo;
  if (!bookingNo) throw new Error("No booking number in the parsed PDF (BPAY Ref missing?).");

  try {
    // 1) Verify the booking exists AND the client matches the PDF.
    onProgress(5, `Opening booking ${bookingNo}...`);
    const state = await withPage({ username, password, callbacks: { onNeedLogin } }, async (page) => {
      const header = await readBookingHeader(page, bookingNo);
      const segments = await readItinerary(page, bookingNo);
      const costings = await readCostings(page, bookingNo);
      const receipts = await readReceiptsList(page, bookingNo);
      return { header, segments, costings, receipts };
    });
    const { header, segments: existingSegs, costings: existingCosts, receipts } = state;

    if (!header || !header.bookingNo) {
      throw new Error(`Booking ${bookingNo} could not be opened in Tramada — check the BPAY Ref.`);
    }
    // Match on the full SURNAME/FIRSTNAME key, not just surname — several GRAY
    // family members exist, so surname-only would wrongly pass GRAY/SPIDER for a
    // GRAY/MEGAN PDF. Strip titles (MR/MS/DR…) and non-name chars first.
    const nameKey = (s) => String(s || "").toUpperCase()
      .replace(/\b(MR|MRS|MS|DR|MISS|MSTR|MASTER|PROF)\b/g, "")
      .replace(/[^A-Z/]/g, "").trim();
    const paxKeys = (data.passengers || []).map(nameKey).filter(Boolean);
    const hdrKey = nameKey(header.client);
    let clientOk;
    if (hdrKey.includes("/")) {
      clientOk = !paxKeys.length || paxKeys.some((k) => k === hdrKey || k.includes(hdrKey) || hdrKey.includes(k));
    } else {
      // No slash-format client on the header — fall back to surname match.
      const surnames = paxKeys.map((k) => k.split("/")[0]).filter(Boolean);
      const hay = `${header.client || ""} ${header.clientName || ""}`.toUpperCase().replace(/[^A-Z]/g, "");
      clientOk = !surnames.length || surnames.some((s) => hay.includes(s));
    }
    const clientMismatch = !clientOk;
    onStage("verify", { bookingNo, header, clientOk, forceClient, paxKeys, hdrKey });
    if (clientMismatch && !forceClient) {
      throw new Error(
        `Client mismatch — booking ${bookingNo} is "${(header.client || header.clientName || "").trim()}" ` +
          `but the PDF is for ${(data.passengers || []).join(", ")}. Stopping; nothing changed. ` +
          `(This PDF belongs to booking ${data.bookingNo}.)`
      );
    }
    if (clientMismatch && forceClient) {
      // Explicit request to reuse the PDF on a different booking. Segments attach
      // to THIS booking's passengers and the receipt payer is THIS booking's
      // client automatically — we just proceed past the guard.
      onProgress(8, `Booking ${bookingNo} is a different client ("${(header.client || "").trim()}") — applying with THIS booking's client, as requested.`);
    }

    // 2) Segments — add Tour/Hotel not already present (idempotent).
    const haveTUR = existingSegs.some((s) => /TUR/i.test(s.segType));
    const haveHTL = existingSegs.some((s) => /HTL/i.test(s.segType));
    const segsToAdd = (data.segments || []).filter(
      (s) => (s.kind === "tour" && !haveTUR) || (s.kind === "hotel" && !haveHTL)
    );
    let segResult = [];
    if (segsToAdd.length) {
      onProgress(30, `Adding ${segsToAdd.length} itinerary segment(s)...`);
      segResult = await runAddSegments({
        username, password, bookingNo, segments: segsToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(30 + Math.round(p * 0.25), m) },
      });
    } else {
      onProgress(30, "Tour/Hotel segments already present — skipping.");
    }
    onStage("segments", { added: segResult, skipped: { tour: haveTUR, hotel: haveHTL } });

    // 3) Costing lines — Insurance always; Service Fee only if asked (EFT
    //    normally has no card surcharge).
    const haveINS = existingCosts.some((c) => /INS/i.test(c.segType));
    const haveSFE = existingCosts.some((c) => /SFE/i.test(c.segType));
    const linesToAdd = (data.costingLines || []).filter((l) => {
      if (l.kind === "insurance") return !haveINS;
      if (l.kind === "servicefee") return includeServiceFee && !haveSFE;
      return false;
    });
    let costResult = [];
    if (linesToAdd.length) {
      onProgress(58, `Adding ${linesToAdd.length} costing line(s)...`);
      costResult = await runAddCostingLines({
        username, password, bookingNo, lines: linesToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(58 + Math.round(p * 0.17), m) },
      });
    } else {
      onProgress(58, "Costing lines already present — skipping.");
    }
    onStage("costingLines", { added: costResult, skipped: { insurance: haveINS, servicefee: haveSFE } });

    // 4) EFT receipt — but ONLY if the booking has an outstanding balance. A
    //    fully-paid booking (12752 etc.) has NOTHING to allocate on the receipt
    //    form, so attempting one throws "No costed segments to allocate". This
    //    must be skipped for BOTH the dry-run stage and a real commit.
    const balance = parseFloat(String(header.balance || "").replace(/[^0-9.\-]/g, "") || "0");
    const alreadyReceipted = balance <= 0.005 && (receipts || []).length > 0;
    const addedAnything = (segResult.length + costResult.length) > 0;
    // If we didn't add anything new, the balance we read up front is current;
    // nothing outstanding → no receipt to raise.
    const skipReceipt = !addedAnything && balance <= 0.005;

    let receiptResult = null;
    let receiptSkipped = false;
    let receiptSkipReason = null;
    if (skipReceipt) {
      receiptSkipped = true;
      receiptSkipReason = alreadyReceipted ? "already receipted" : "nothing outstanding";
      onProgress(100, `Booking ${bookingNo} has no outstanding balance (${balance.toFixed(2)}) — no EFT receipt to raise.`);
      onStage("receipt", { skipped: true, reason: receiptSkipReason, receipts });
    } else if (data.receipt) {
      onProgress(78, dryRunReceipt ? "Staging EFT receipt (not committed)..." : "Issuing EFT receipt...");
      try {
        receiptResult = await runTramadaReceipt({
          username, password, bookingNo,
          receipt: { ...data.receipt, transactionType: "EFT" },
          dryRun: dryRunReceipt,
          skipIfNoAllocatable: true, // fully-paid booking → clean skip, not a throw
          callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(78 + Math.round(p * 0.2), m) },
        });
        if (receiptResult && receiptResult.skipped) {
          receiptSkipped = true;
          receiptSkipReason = receiptResult.reason || "nothing to allocate";
          receiptResult = null;
          onStage("receipt", { skipped: true, reason: receiptSkipReason });
        } else {
          onStage("receipt", receiptResult);
        }
      } catch (e) {
        // Safety net: an empty allocation table means nothing is outstanding —
        // treat as a clean skip rather than a hard failure.
        if (/no costed segments to allocate|nothing to allocate/i.test(e.message || "")) {
          receiptSkipped = true;
          receiptSkipReason = "nothing outstanding to allocate";
          onProgress(100, `Nothing outstanding to allocate on booking ${bookingNo} — skipping EFT receipt.`);
          onStage("receipt", { skipped: true, reason: receiptSkipReason });
        } else {
          throw e;
        }
      }
    }

    const nothingToDo = !addedAnything && receiptSkipped;
    onProgress(100, dryRunReceipt ? "Ready — EFT receipt staged (confirm to issue)." : "PDF booking complete.");
    return {
      bookingNo, header,
      segments: segResult, costingLines: costResult, receipt: receiptResult,
      alreadyReceipted, receiptSkipped, receiptSkipReason, nothingToDo, balance,
      clientMismatch,
    };
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

module.exports = {
  runFullBooking,
  runPdfBooking,
  runReadBookingState,
  runReadBookingClient,
  runAddPassenger,
  runSearchClients,
  runCreateClient,
  createClient,
  runCheckBooking,
  checkBookingExists,
  readClientMatches,
  runAddSegments,
  runAddCostings,
  closeSegmentPage,
  runAddCostingLines,
  // page-level (for composing on a shared page / testing)
  addPassenger,
  addFlightSegment,
  addHotelSegment,
  finishHotelSegment,
  canResumeHotelForm,
  shouldResumeHotelForm,
  hasOpenSegmentPage,
  addTourSegment,
  addTicketCosting,
  addInsuranceCosting,
  addServiceFeeCosting,
  readCostings,
  readItinerary,
  readBookingHeader,
  readPassengerMobile,
  readReceiptsList,
  setConfirmationRef,
  CONFIRMATION_REF_SELECTORS,
  toTramadaDate,
  toFlightNumber,
  toClassCode,
};

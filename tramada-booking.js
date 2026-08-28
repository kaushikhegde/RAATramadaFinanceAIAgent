/**
 * tramada-booking.js — Playwright + CDP Tramada add+search for the chat flow.
 *
 * Connects to the shared CDP Chrome (start-chrome.sh on port 9222), so it
 * Programmatic login (no manual prompt).
 * Maps a chat-collected bookingData object to Tramada's Add Booking fields,
 * saves the booking, then runs the existing "Booked" status search.
 *
 * Used by server.js once the booking details are collected.
 */

const { chromium } = require("playwright");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";

// "internal" launches real Chrome directly (no remote-debugging port needed).
// "external" attaches to a Chrome already started with --remote-debugging-port,
// falling back to launching Chrome if that port isn't listening.
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

// Australian airport codes — used to auto-detect DOM vs INT.
// Mirrors the Aussie list in geminiPrompt.js / parsePdf.js.
const AU_AIRPORT_CODES = new Set([
  "SYD", "MEL", "BNE", "OOL", "PER", "ADL", "CNS", "HBA", "DRW",
  "CBR", "NTL", "MCY", "TSV", "LST", "AVV", "MKY", "HVB",
  "AYQ", "PPP", "BNK", "BQB",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── autocomplete: find-and-click, with verification ──
   Copied from `tramada-segments.js` (same file family, no shared base module
   between them — `sleep` above is duplicated the same way) rather than
   required, because `tramada-segments.js` already requires THIS file for
   `runTramadaAddAndSearch`; requiring it back would be a cycle.

   This is the fix for the client field a few lines down. The code it replaces
   typed a client code, waited a fixed 2s, and looked for a dropdown item under
   one of several guessed CSS classes (`.autocomplete-suggestions`,
   `.ac_results`, etc.) — classes Tramada's autocomplete does not actually use
   (see `_findSuggestion` below: "Tramada's dropdown has no stable class to
   hook"). When the guessed selectors matched nothing, it fell back to a blind
   ArrowDown+Enter with no check that anything was actually selected — so a
   slow-to-render dropdown left the visible text reading "GRAY/SPIDER" with no
   client ever resolved behind it, and the booking failed 15+ seconds later at
   Save with "Client Code is invalid", nowhere near where the real problem was.
   `pickAutocomplete` finds the suggestion by screen position instead of a
   class name, polls for a STABLE match before clicking it, and — the part the
   old code never did — verifies the field's value actually changed before
   calling the pick successful, retrying once and then throwing if it never
   does. */
function _findSuggestion(arg) {
  const input = document.querySelector(arg.sel);
  if (!input) return null;
  const ir = input.getBoundingClientRect();
  const val = String(arg.raw).trim().toUpperCase();
  const esc = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const inDropdownZone = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const below = r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340;
    const overlap = r.left < ir.right + 80 && r.right > ir.left - 80;
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
     string edge — never as a bare prefix.
     Client codes collide by numeric suffix in this sandbox: GRAY/MEGAN DR
     and GRAY/MEGAN DR1 both exist, same for MRS/MRS1-4 and MS/MS1. The old
     fallback was plain `t.includes(val)`, which a suggestion row for "DR1"
     satisfies just as well as one for "DR" — "1" is not a word boundary — and
     `vis.find` took whichever the dropdown happened to render first. Typing
     "GRAY/MEGAN DR" landed on "GRAY/MEGAN DR1" every time, silently: no
     error, a real booking created against the wrong client. Confirmed live
     28-Aug-2026 — GRAY/MEGAN DR1 is a retail-type account and cannot take a
     Debtor Payment Receipt at all, which is the ONLY reason BPay uses
     GRAY/MEGAN DR in the first place. An exact full-text match doesn't fix
     this: the suggestion row carries the client's name and branch after the
     code, so "GRAY/MEGAN DR" is never the row's whole text either. */
  if (!hit) {
    const boundary = new RegExp("(^|[^A-Z0-9])" + esc + "([^A-Z0-9]|$)");
    hit = vis.find((n) => boundary.test((n.textContent || "").trim().toUpperCase()));
  }
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  if (arg.doClick) hit.click();
  return { text: (hit.textContent || "").trim().slice(0, 60), x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function pickAutocomplete(page, selector, value) {
  if (!value) return null;
  const el = page.locator(selector);
  if (!(await el.count())) return null;
  const first = el.first();
  const typed = String(value).trim().toUpperCase();

  /* `expected` is the suggestion's OWN text, when a pick just happened —
     compare the field against THAT rather than against `typed`. The old
     check (`v.toUpperCase() !== typed`) assumed a successful pick always
     changes the field's text from what was typed, which is true when a short
     code expands to a fuller suggestion ("GRAY/SPIDER" -> "GRAY/SPIDER MS")
     but false whenever the typed code is already the complete, correct one
     ("GRAY/MEGAN DR") — the field is clicked, filled with the right value,
     and this returned null every time, so a correct pick looked identical to
     no pick at all and the whole function threw "could not select" after two
     attempts. Confirmed live 28-Aug-2026. Only the no-suggestion-in-hand
     fallback (the blur branch below) still uses the "changed from typed"
     heuristic, because there is nothing else to check it against there. */
  const registered = async (expected) => {
    const v = ((await first.inputValue().catch(() => "")) || "").trim();
    if (!v) return null;
    if (expected) return v.toUpperCase() === expected.toUpperCase() ? v : null;
    return v.toUpperCase() !== typed ? v : null;
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    await first.click();
    await first.fill("");
    await first.type(String(value), { delay: 60 });

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
      await first.evaluate((n) => n.blur()).catch(() => {});
      await sleep(800);
      const v = await registered();
      if (v) return v;
      continue;
    }

    await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: true }).catch(() => null);
    await sleep(500);
    let v = await registered(match.text);
    if (v) return v;

    const fresh =
      (await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: false }).catch(() => null)) ||
      match;
    await page.mouse.move(fresh.x, fresh.y);
    await sleep(150);
    await page.mouse.click(fresh.x, fresh.y);
    await sleep(600);
    v = await registered(fresh.text);
    if (v) return v;
  }

  throw new Error(`Autocomplete ${selector}: could not select "${value}" (no click registered after 2 attempts)`);
}

// yyyy-mm-dd → dd-mm-yyyy (the format Tramada's date inputs expect)
function toTramadaDate(isoDate) {
  if (!isoDate) return "";
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : isoDate;
}

// Truncate a string to maxLen, appending an ellipsis when shortened.
function truncate(s, maxLen) {
  if (!s) return s;
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

// Format the chat-collected passenger list into a compact "Pax: ..." segment.
// Example: "Pax: John Smith, Jane Smith, Tim Smith (8)"
function formatPaxSegment(passengers) {
  if (!Array.isArray(passengers) || passengers.length === 0) return "";
  const parts = passengers
    .map((p) => {
      const name = `${(p.firstName || "").trim()} ${(p.lastName || "").trim()}`.trim();
      if (!name) return "";
      const ageNeeded = p.type === "child" || p.type === "infant";
      return ageNeeded && p.age != null ? `${name} (${p.age})` : name;
    })
    .filter(Boolean);
  return parts.length ? `Pax: ${parts.join(", ")}` : "";
}

// Map chat-collected bookingData to the Tramada Add-Booking field shape.
function mapBookingToTramada(booking, clientCode) {
  const origin = (booking.originCode || "").toUpperCase();
  const dest = (booking.destinationCode || "").toUpperCase();
  const isDomestic = AU_AIRPORT_CODES.has(origin) && AU_AIRPORT_CODES.has(dest);

  const baseSegments = [
    `${origin || "?"} → ${dest || "?"}`,
    booking.tripType === "return" && booking.returnDate
      ? `${booking.departureDate} → ${booking.returnDate}`
      : `${booking.departureDate}`,
    `${booking.adults || 1} adult${(booking.adults || 1) > 1 ? "s" : ""}` +
      ((booking.children || 0) > 0 ? `, ${booking.children} child${booking.children > 1 ? "ren" : ""}` : "") +
      ((booking.infants || 0) > 0 ? `, ${booking.infants} infant${booking.infants > 1 ? "s" : ""}` : ""),
  ];
  const paxSegment = formatPaxSegment(booking.passengers);
  if (paxSegment) baseSegments.push(paxSegment);

  // Cap at 250 chars — Tramada's text fields are roughly that wide.
  const itinerarySummary = truncate(baseSegments.join(" • "), 250);

  // Non-flight sources (e.g. a Room-Res hotel quote) have no origin/destination
  // airports, so the derived values above read as nonsense for them. They pass
  // `tramadaOverrides` with the header fields they can state correctly, and only
  // those are replaced. Purely additive: the chat path never sets it.
  const overrides = {};
  for (const [k, v] of Object.entries(booking.tramadaOverrides || {})) {
    if (v !== undefined && v !== null) overrides[k] = v;
  }

  return {
    clientCode,
    departureDate: toTramadaDate(booking.departureDate),
    returnDate: toTramadaDate(booking.returnDate),
    bankAccount: "1",                             // [TRUST] Trust Account
    // Booking Account and its debtor. Both are mandatory and NEITHER was ever
    // set, so every new booking came back rejected with all three of "Booking
    // Account must be selected", "Debtor must be selected" and "Retail Debtor
    // must be selected". Matched by TEXT, not the numeric option id, which is
    // per-environment.
    accountType: "RETAIL",
    retailDebtor: "RAA of SA Limited (Retail)",
    corporateDebtor: "",
    bookingType: "LEISURE",
    bookingSource: "EML",
    // destinationTypeCode has NO "INT" option. Valid values are region codes
    // (DOM, ASIA, EUROPE, USA_CANADA, NZ, ...) or OTHER. Domestic => DOM;
    // international => the caller-supplied region, else OTHER (a safe default).
    destination: isDomestic ? "DOM" : (booking.destinationRegion || "OTHER"),
    domInt: isDomestic ? "DOMESTIC" : "INTERNATIONAL",
    cabinClass: "ECON",
    itinerary: itinerarySummary,
    primaryDest: dest,
    ...overrides,
  };
}

/**
 * Get a browser to drive Tramada with.
 *
 * Tramada has no bot detection to defeat, so a plainly-launched Chrome works —
 * Tramada has no bot-detection, so no warm profile is required.
 *
 * @returns {Promise<{browser: import('playwright').Browser, launched: boolean}>}
 *   `launched` is true when we started Chrome ourselves (so we own closing it).
 */
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
    // In external mode we must attach to the Chrome the user is logged into.
    // Launching a throwaway Chrome here would be UNAUTHENTICATED and produce a
    // misleading "not logged in" — so fail honestly instead.
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and log into Tramada IN THAT WINDOW first ` +
        `(it's a separate Chrome from your normal browser). [${cdpErr.message}]`
    );
  }
}

// Reliable auth check: hit a PROTECTED page and see if Tramada bounces us to
// login. (Checking login.htm directly is unreliable — Tramada serves the login
// form there even for authenticated sessions, causing false "not logged in".)
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  return !page.url().includes("login.htm");
}

/**
 * Ensure the page's Tramada session is authenticated.
 *  - Warm CDP Chrome already logged in → returns immediately.
 *  - Credentials provided → logs in programmatically.
 *  - Otherwise → calls onNeedLogin() and WAITS (polls) for the user to sign in
 *    manually in the shared Chrome (this is where they enter the OTP), up to 5
 *    minutes, then continues. It never just quits the run.
 */
async function tramadaLogin(page, username, password, onNeedLogin) {
  if (await tramadaIsAuthed(page)) return;

  if (username && password) {
    await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#loginForm_password", password);
    await page.click("#loginForm_login");
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 }).catch(() => {});
    if (page.url().includes("login.htm")) {
      throw new Error("Tramada login failed (check credentials / OTP).");
    }
    await sleep(500);
    return;
  }

  // No credentials — ask the user to log in and wait for them.
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes for manual login + OTP
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await tramadaIsAuthed(page)) {
      await sleep(500);
      return;
    }
  }
  throw new Error("Timed out waiting for Tramada login. Sign in to the shared Chrome and try again.");
}

async function tramadaAddBooking(page, mapped) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=ADD`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#client", { timeout: 15000 });

  // Client autocomplete — found by screen position and VERIFIED, not guessed
  // at by CSS class and left unchecked. See the comment on `pickAutocomplete`
  // above for why: the old code here left a booking's client unresolved and
  // didn't find out until Save rejected it with "Client Code is invalid".
  await pickAutocomplete(page, "#client", mapped.clientCode);
  await sleep(1500);

  // Mandatory fields. IMPORTANT: picking the client fires an ajax refresh that
  // re-renders parts of the form and can RESET selects that were set too early
  // (seen live: "Bank Account must be selected" on save). So set everything,
  // wait for the refresh to settle, then VERIFY and re-set anything wiped.
  // Set a <select> by option value, exact label, or label-contains, in-page.
  // Playwright's selectOption waits for actionability and so cannot touch a
  // hidden select — and #retailDebtor is hidden right up until the account type
  // reveals it, so the built-in would have failed silently under its .catch().
  const selectByText = async (selector, want) => {
    if (want == null || want === "") return false;
    return await page.evaluate(
      ({ sel, w }) => {
        const el = document.querySelector(sel);
        if (!el || !el.options) return false;
        const k = String(w).trim().toLowerCase();
        const opts = Array.from(el.options);
        const hit =
          opts.find((o) => (o.value || "").toLowerCase() === k) ||
          opts.find((o) => (o.textContent || "").trim().toLowerCase() === k) ||
          opts.find((o) => (o.textContent || "").toLowerCase().includes(k));
        if (!hit) return false;
        el.value = hit.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      { sel: selector, w: want }
    );
  };

  const setFields = async () => {
    // ⚠️ ORDERING — Booking Account decides which debtor widget exists at all:
    // #retailDebtor has no offsetParent until #accountTypeCode is set to RETAIL.
    // Setting the debtor first does nothing, silently, and the save is rejected.
    // Same trap as the client form's debtor.debtorType and the Room-Res quote
    // builder's price box.
    if (mapped.accountType) {
      await selectByText("#accountTypeCode", mapped.accountType);
      await sleep(1200); // the swap is an ajax re-render

      // RETAIL renders a <select>; CORPORATE renders a text box with an Edit
      // picker and a hidden #hiddendebtor that holds the resolved id. Fill
      // whichever one actually appeared, and VERIFY — a booking against no
      // debtor saves in some paths and is a reporting mess to unpick later.
      const retailVisible = await page
        .evaluate(() => !!(document.querySelector("#retailDebtor") || {}).offsetParent)
        .catch(() => false);

      if (retailVisible) {
        const want = mapped.retailDebtor;
        if (want && !(await selectByText("#retailDebtor", want))) {
          throw new Error(
            `Tramada has no retail debtor matching "${want}" on the booking form — the booking would save against no debtor.`
          );
        }
      } else if (mapped.corporateDebtor) {
        await page.fill("#debtor", mapped.corporateDebtor).catch(() => {});
        await page.locator("#debtor").first().blur().catch(() => {});
        await sleep(1200);
        const resolved = await page
          .evaluate(() => {
            const h = document.querySelector("#hiddendebtor");
            const d = document.querySelector("#debtor");
            return { hidden: h ? String(h.value || "").trim() : "", shown: d ? String(d.value || "").trim() : "" };
          })
          .catch(() => ({ hidden: "", shown: "" }));
        if (!resolved.hidden) {
          throw new Error(
            `Tramada didn't accept "${mapped.corporateDebtor}" as a corporate debtor (the field reads "${resolved.shown}"). ` +
              "This client is a Corporate account — pick its debtor by hand on the booking, or tell me the exact debtor name."
          );
        }
      }
    }
    await page.selectOption("#bankAccount", mapped.bankAccount).catch(() => {});
    await page.fill("#departureDate", mapped.departureDate);
    if (mapped.returnDate) await page.fill("#returnDate", mapped.returnDate);
    await page.selectOption("#bookingTypeCode", mapped.bookingType).catch(() => {});
    await page.selectOption("#sourceTypeCode", mapped.bookingSource).catch(() => {});
    await page.selectOption("#destinationTypeCode", mapped.destination).catch(() => {});
    await page.selectOption("#domIntCode", mapped.domInt).catch(() => {});
    if (mapped.cabinClass) await page.selectOption("#cabinClassTypeCode", mapped.cabinClass).catch(() => {});
    if (mapped.itinerary) await page.fill("#itinerarySummary", mapped.itinerary);
    if (mapped.primaryDest) await page.fill("#destinationCityCode", mapped.primaryDest);
  };

  await setFields();
  await sleep(1500); // let the client-selection ajax finish re-rendering

  const wiped = await page.evaluate(() => {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
    // accountTypeCode and retailDebtor are in this list because the client-pick
    // ajax is exactly what re-renders the debtor block — the field most likely
    // to be wiped is the one that only appears after another field is set.
    return ["bankAccount", "bookingTypeCode", "sourceTypeCode", "destinationTypeCode", "domIntCode", "accountTypeCode", "retailDebtor"]
      .filter((id) => !v(id));
  });
  if (wiped.length) {
    await setFields(); // the refresh reset some selects — set them again
    await sleep(400);
  }

  /* `#save` can resolve to MORE THAN ONE element here — the same ajax that
     wipes fields above (see `wiped`) can also leave a stale copy of the form
     footer behind instead of replacing it, so two buttons end up sharing this
     id. `page.click` takes DOM order, which is not necessarily render order:
     clicking the wrong one passes every actionability check (visible,
     enabled, stable) and does nothing, which is indistinguishable from a hang
     until this line's own 30s timeout. Narrow to the one(s) actually on
     screen and enabled; if more than one still qualifies, the LAST is taken —
     the most recently rendered copy is the one wired to the form's current
     state, same reasoning `wiped` above already relies on. */
  const saveBtns = page.locator("#save");
  const saveCount = await saveBtns.count();
  let save = saveBtns.first();
  if (saveCount > 1) {
    const states = await saveBtns.evaluateAll((els) =>
      els.map((el) => ({ visible: !!el.offsetParent, disabled: !!el.disabled })));
    const live = states.reduce((acc, s, i) => (s.visible && !s.disabled ? [...acc, i] : acc), []);
    if (live.length) save = saveBtns.nth(live[live.length - 1]);
  }
  await save.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  // Success = an id in the URL (post-save: booking-profile.htm?...&id=12345).
  // A REJECTED save re-renders the form — sometimes without mode=ADD in the
  // URL — so key off the id, and if it's missing surface the on-page
  // validation messages ("Bank Account must be selected", etc.) loudly.
  const url = page.url();
  const urlMatch = url.match(/[?&]id=(\d+)/);
  if (!urlMatch) {
    const errors = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a, span, li, font, div").forEach((n) => {
        if (n.children.length) return;
        const t = (n.textContent || "").trim();
        if (t && t.length < 200 && /must be|is required|is invalid|cannot be|already exists/i.test(t)) {
          out.push(t);
        }
      });
      return [...new Set(out)].slice(0, 8);
    });
    throw new Error(
      `Booking save was rejected${errors.length ? ": " + errors.join("; ") : " (no booking id in URL — a required field was missing)"}`
    );
  }

  return { bookingNo: urlMatch[1], url };
}

async function tramadaSearchBooked(page) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#searchForm_bookingStatus", { timeout: 15000 });
  await page.selectOption("#searchForm_bookingStatus", "BOOKED");
  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  return await page.evaluate(() => {
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && header.textContent.includes("Bkg No")) {
        const rows = table.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 6) {
            out.push({
              bkgNo: cells[1]?.textContent?.trim() || "",
              client: cells[2]?.textContent?.trim() || "",
              debtor: cells[3]?.textContent?.trim() || "",
              itinerary: cells[4]?.textContent?.trim() || "",
              depDate: cells[5]?.textContent?.trim() || "",
              retDate: cells[6]?.textContent?.trim() || "",
              finalTkt: cells[7]?.textContent?.trim() || "",
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
 * Run the full chat-mode chain: log in → add booking → search.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {string} args.password
 * @param {string} args.clientCode  Tramada client autocomplete value (e.g. "GRAY/SPIDER")
 * @param {object} args.booking     bookingData (originCode, destinationCode, departureDate, returnDate, ...)
 * @param {object} [args.callbacks] { onProgress(pct, msg), onError(msg), onAddComplete(addResult), onSearchComplete(rows) }
 * @returns {Promise<{add: object, bookings: Array}>}
 */
async function runTramadaAddAndSearch({
  username,
  password,
  clientCode,
  booking,
  skipSearch = false, // pipeline mode: bookingNo comes from the URL; skip the 15s search poll
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onAddComplete = callbacks.onAddComplete || (() => {});
  const onSearchComplete = callbacks.onSearchComplete || (() => {});

  // Credentials are optional — if the shared Chrome is already logged in,
  // tramadaLogin() reuses that warm session and skips the login form. We only
  // fail (inside tramadaLogin) if we actually land on login.htm without creds.
  if (!clientCode) throw new Error("Tramada clientCode is required (e.g. GRAY/SPIDER)");
  if (!booking || !booking.departureDate) {
    throw new Error("booking.departureDate is required for Tramada add");
  }

  const mapped = mapBookingToTramada(booking, clientCode);

  let browser, context, page, launched = false;
  let _ok = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    const contexts = browser.contexts();
    context = contexts[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(15, "Logging into Tramada...");
    await tramadaLogin(page, username, password, callbacks.onNeedLogin);

    onProgress(45, `Adding booking for client "${clientCode}" (${mapped.domInt})...`);
    const addResult = await tramadaAddBooking(page, mapped);

    // Pipeline mode: the booking number is already extracted from the post-save
    // URL, and the new booking is simply the most recent one — no need to poll
    // the BOOKED search index (which lags ~15s behind a fresh save).
    if (skipSearch) {
      onAddComplete(addResult);
      onProgress(100, `Booking ${addResult.bookingNo || ""} saved.`.trim());
      _ok = true;
      return { add: addResult, bookings: [], mapped };
    }

    // Tramada's BOOKED search index lags a few seconds behind a fresh save.
    // Poll the search up to ~15s and stop early once we can match the new row.
    const POLL_DELAYS_MS = [3000, 3000, 3000, 3000, 3000]; // up to 5 attempts, 15s total
    const tryMatch = (rows) => {
      if (addResult.bookingNo) {
        const byNo = rows.find((r) => r.bkgNo === addResult.bookingNo);
        if (byNo) return byNo;
      }
      // Fallback: client name + departure date (Tramada returns dd-mm-yyyy in the table).
      const expectedDep = mapped.departureDate;
      const codeKey = (clientCode || "").toUpperCase().replace(/\s+/g, "");
      return (
        rows.find(
          (r) =>
            r.depDate === expectedDep &&
            (r.client || "").toUpperCase().replace(/\s+/g, "").includes(codeKey)
        ) || null
      );
    };

    let bookings = [];
    let summary = null;
    for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
      onProgress(
        60 + i * 6,
        i === 0
          ? "Searching booked status..."
          : `Booking not in index yet — retrying (${i + 1}/${POLL_DELAYS_MS.length})...`
      );
      await sleep(POLL_DELAYS_MS[i]);
      bookings = await tramadaSearchBooked(page);
      summary = tryMatch(bookings);
      if (summary) break;
    }

    onSearchComplete(bookings);

    const enrichedAdd = { ...addResult, summary };
    onAddComplete(enrichedAdd);

    onProgress(100, summary ? "Tramada done." : "Tramada saved (search row not yet indexed).");
    _ok = true;
    return { add: enrichedAdd, bookings, mapped };
  } catch (err) {
    onError(err.message);
    throw err;
  } finally {
    try {
      // On failure leave the tab open so the error state can be inspected;
      // close it only after a clean run.
      if (page && _ok) await page.close();
    } catch { /* tab may already be closed */ }
    try {
      // If we launched Chrome this shuts it down; if we attached over CDP it only
      // drops the connection, leaving the user's Chrome running.
      if (browser) await browser.close();
    } catch { /* CDP disconnect */ }
  }
}

module.exports = { runTramadaAddAndSearch, mapBookingToTramada, toTramadaDate };

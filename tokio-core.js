"use strict";

/**
 * tokio-core.js — the decisions behind the monthly Tokio Marine reconciliation.
 *
 * Pure. No browser, no files, no Tramada. It takes rows that something else
 * parsed and returns the consolidated sheet plus what to do with each line.
 *
 * Source: "Reconciliation Guide - Tokio Marine 1.docx" (steps 1-16, BR01-BR18)
 * and the five example workbooks RAA supplied. Everything measured off those
 * files is written down in docs/tokio-marine.md — including the places where
 * the guide and the example template disagree, which are not resolved here by
 * guessing.
 */

/* ------------------------------------------------------------------ money */

/** "1,234.56" / 1234.56 / "$1,234.56" -> 123456 cents. null when not a number. */
function cents(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* --------------------------------------------------------- the policy key */

/**
 * The Tokio Marine policy number: the 210-series, eight digits.
 *
 * The AFTER template digs it out of the Payment Report's Reference with
 *
 *   MID(C2, FIND("2", C2, 1), 8)
 *
 * — the first "2" anywhere in the string, then eight characters. On
 * "21087245 - 21087245 - ALTUS/ELIZABETH MRS" that works. On a reference whose
 * first "2" is not the start of the policy number it returns eight wrong
 * digits and says nothing, and the row reconciles against another policy.
 *
 * So this looks for an eight-digit run beginning "21" instead, and returns null
 * rather than a guess when there isn't one.
 */
function policyKey(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;

  // A bare policy number, however it arrived (number, text, padded).
  const bare = s.replace(/\s+/g, "");
  if (/^21\d{6}$/.test(bare)) return bare;

  // Embedded in a longer reference, e.g. "21087245 - 21087245 - NAME".
  const m = s.match(/\b(21\d{6})\b/);
  return m ? m[1] : null;
}

/** RCC carries quote numbers like "RAAQ-846157711" where a policy should be. */
function isQuoteNumber(v) {
  return /^\s*RAAQ[-\s]?\d+/i.test(String(v == null ? "" : v));
}

/* ------------------------------------------------------- BR03, the maths */

const COMMISSION_RATE = 0.3;

/**
 * BR03 — RAA Commission is 30% of the Sell Price (inc GST) and RAA Total Nett
 * is the remainder. Tokio Marine's own net and commission columns (M, N, P) are
 * ignored.
 *
 * Kept unrounded, as the example template does: 218.93 gives 65.679 and
 * 153.251. Rounding here would change the figure Finance checks back against,
 * and BR13's ±1% tolerance exists precisely because Tramada rounds differently.
 */
function calcCommission(sellPriceIncGst) {
  const c = cents(sellPriceIncGst);
  if (c == null) return { ok: false, reason: "Sell price is not a number" };
  const sell = c / 100;
  const commission = sell * COMMISSION_RATE;
  return { ok: true, commission, totalNett: sell - commission };
}

/* --------------------------------------------- steps 7 and 8, the sorting */

const BRANCH_TRAVEL = /travel/i;

const OUTCOME = Object.freeze({
  TRAVEL: "Travel",       // reconcile this one
  RETAIL: "Retail",       // remove the line
  EXCEPTION: "Exception", // a human looks at it; never reconciled
});

const PLEASE_CHECK = "Please check";

/**
 * Steps 7 and 8, which are more specific than BR05/BR06 and therefore win.
 *
 *   branch "Travel" | in RCC | in Payment or Costing | outcome
 *   no              | yes    | no                    | Retail, remove
 *   no              | yes    | yes                   | exception
 *   yes             | yes    | yes                   | exception
 *   yes             | no     | yes                   | Travel, reconcile
 *   yes             | no     | no                    | exception
 *
 * TWO COMBINATIONS ARE COVERED BY NEITHER STEP:
 *   yes | yes | no   — Travel branch, on RCC, nowhere in Tramada
 *   no  | no  | ...  — not a Travel branch and not on RCC at all
 *
 * Both are flagged for a human with a remark saying the guide does not cover
 * them. Choosing one of the five documented outcomes for a case RAA has not
 * ruled on would either drop a Travel transaction or pay a Retail one.
 */
function classify({ branch, inRcc, inPayment, inCosting }) {
  const isTravel = BRANCH_TRAVEL.test(String(branch == null ? "" : branch));
  const inTramada = !!inPayment || !!inCosting;

  if (!isTravel && inRcc && !inTramada) {
    return { outcome: OUTCOME.RETAIL, remark: "Retail — receipted through Retail (found in RCC)" };
  }
  if (!isTravel && inRcc && inTramada) {
    return { outcome: OUTCOME.EXCEPTION, remark: PLEASE_CHECK + " — in RCC and in Tramada, but the branch is not Travel" };
  }
  if (isTravel && inRcc && inTramada) {
    return { outcome: OUTCOME.EXCEPTION, remark: PLEASE_CHECK + " — Travel branch but also found in RCC" };
  }
  if (isTravel && !inRcc && inTramada) {
    return { outcome: OUTCOME.TRAVEL, remark: "" };
  }
  if (isTravel && !inRcc && !inTramada) {
    return { outcome: OUTCOME.EXCEPTION, remark: PLEASE_CHECK + " — Travel branch but not found in Tramada Payment or Costing" };
  }

  // Undocumented. Say so rather than picking one.
  if (isTravel && inRcc && !inTramada) {
    return {
      outcome: OUTCOME.EXCEPTION,
      remark: PLEASE_CHECK + " — Travel branch, found in RCC, not in Tramada. The guide does not cover this combination.",
      undocumented: true,
    };
  }
  return {
    outcome: OUTCOME.EXCEPTION,
    remark: PLEASE_CHECK + " — branch is not Travel and the policy is not in RCC. The guide does not cover this combination.",
    undocumented: true,
  };
}

/* ------------------------------------------ the reporting month, derived */

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

/** Excel serial, ISO string, Date, "01/07/2026" — whatever the upload carried. */
function asDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;

  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial: days since 1899-12-30. Anything below 20000 (1954) is far
    // more likely to be a stray figure than a date, so it is refused.
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  }

  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // dd/mm/yyyy — Australian order. NEVER mm/dd: 07/08/2026 is 7 August here,
  // and reading it as 8 July puts the whole report in the wrong month.
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which month is this B2B report for?
 *
 * The guide says the report "always covers the 1st to the last day of the
 * reporting month", and the file itself carries no month anywhere — so it is
 * derived from the transaction dates and shown for confirmation rather than
 * assumed.
 *
 * The MOST COMMON month wins, and every row outside it is counted and
 * reported. A handful of stragglers is normal; a even split means the upload
 * is two months in one file, and that is a question for a human, not something
 * to average away.
 */
function deriveReportingMonth(rows = [], opts = {}) {
  const pick = opts.dateOf || ((r) => r.xTRVIssuedDate || r.xUWETransDate);

  const tally = new Map();
  let unreadable = 0;
  for (const r of rows) {
    const d = asDate(pick(r));
    if (!d) { unreadable++; continue; }
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  if (!tally.size) {
    return { ok: false, reason: "No readable transaction dates, so the reporting month cannot be worked out." };
  }

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [key, count] = ranked[0];
  const [y, m] = key.split("-").map(Number);
  const outside = rows.length - count - unreadable;

  const warnings = [];
  if (unreadable) warnings.push(`${unreadable} row(s) had no readable date.`);
  if (outside > 0) {
    const others = ranked.slice(1).map(([k, n]) => `${k} (${n})`).join(", ");
    warnings.push(`${outside} row(s) fall outside ${MONTH_NAMES[m - 1]} ${y}: ${others}.`);
  }
  if (ranked.length > 1 && ranked[1][1] >= count * 0.5) {
    warnings.push(
      "This looks like more than one month in a single file — check before running."
    );
  }

  return {
    ok: true,
    month: m,          // 1-12
    year: y,
    key,               // "2026-07"
    label: `${MONTH_NAMES[m - 1]} ${y}`,
    counted: count,
    outside: Math.max(0, outside),
    unreadable,
    warnings,
  };
}

/** "2026-07" -> a Date on the 1st, for the labels and the search dates. */
function monthKeyToDate(key) {
  const m = String(key || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Reporting month must look like "2026-07", got "${key}"`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`"${key}" is not a month`);
  return new Date(Number(m[1]), month - 1, 1);
}

/* ------------------------------------------------- step 4-6, the sheet */

const NOT_FOUND = "N/A";

const APPENDED_COLUMNS = Object.freeze([
  "RAA Commission",
  "RAA Total Nett",
  "Tramada Payment Report",
  "Tramada Costing Report",
  "RCC Report",
  "Remarks",
]);

/**
 * Build an index of policy number -> rows, from whatever column holds it.
 * `pick` returns the raw cell for a row; anything that yields no policy number
 * is recorded so the caller can report it rather than lose it.
 */
function indexByPolicy(rows = [], pick) {
  const byPolicy = new Map();
  const unreadable = [];
  rows.forEach((row, i) => {
    const raw = pick(row);
    const key = policyKey(raw);
    if (!key) {
      unreadable.push({ line: i + 2, value: raw == null ? "" : String(raw), quote: isQuoteNumber(raw) });
      return;
    }
    if (!byPolicy.has(key)) byPolicy.set(key, []);
    byPolicy.get(key).push(row);
  });
  return { byPolicy, unreadable };
}

/**
 * Steps 4 to 8. `b2b` rows keep their own columns untouched; the six appended
 * columns are returned alongside, plus the outcome so the caller can drop the
 * Retail lines and reconcile only the Travel ones.
 *
 * `sources` is { payment, costing, rcc }, each { byPolicy } from indexByPolicy.
 */
function buildConsolidated(b2b = [], sources = {}, opts = {}) {
  const get = opts.get || ((row, name) => row[name]);
  const policyOf = opts.policyOf || ((row) => get(row, "xPolicyNo"));
  const sellOf = opts.sellOf || ((row) => get(row, "xSellPriceIncGST"));
  const branchOf = opts.branchOf || ((row) => get(row, "xBranch"));

  const has = (src, key) => !!(src && src.byPolicy && key && src.byPolicy.has(key));

  const out = b2b.map((row, i) => {
    const line = i + 2;
    const key = policyKey(policyOf(row));
    const money = calcCommission(sellOf(row));

    const inPayment = has(sources.payment, key);
    const inCosting = has(sources.costing, key);
    const inRcc = has(sources.rcc, key);

    const remarks = [];
    if (!key) remarks.push("Policy number could not be read from this row");
    if (!money.ok) remarks.push(money.reason);

    const verdict = key
      ? classify({ branch: branchOf(row), inRcc, inPayment, inCosting })
      : { outcome: OUTCOME.EXCEPTION, remark: PLEASE_CHECK + " — no policy number" };
    if (verdict.remark) remarks.push(verdict.remark);

    return {
      line,
      row,
      policy: key,
      appended: {
        "RAA Commission": money.ok ? money.commission : "",
        "RAA Total Nett": money.ok ? money.totalNett : "",
        "Tramada Payment Report": inPayment ? key : NOT_FOUND,
        "Tramada Costing Report": inCosting ? key : NOT_FOUND,
        "RCC Report": inRcc ? key : NOT_FOUND,
        Remarks: remarks.join("; "),
      },
      outcome: verdict.outcome,
      undocumented: !!verdict.undocumented,
    };
  });

  return {
    rows: out,
    travel: out.filter((r) => r.outcome === OUTCOME.TRAVEL),
    retail: out.filter((r) => r.outcome === OUTCOME.RETAIL),
    exceptions: out.filter((r) => r.outcome === OUTCOME.EXCEPTION),
  };
}

/* ----------------------------------------- step 12-13, matching in Tramada */

const AMOUNT_TOLERANCE = 0.01; // BR13 — ±1% of the transaction value

/**
 * BR11, BR12, BR13.
 *
 * `candidates` are the Tramada lines carrying this policy number. The one to
 * tick is the one whose amount matches — NOT simply the first, because the same
 * policy appears again when an extension or a medical condition was added in a
 * later month.
 *
 * The tolerance is a percentage of the transaction, not a flat cent figure:
 * the 30% split rounds differently in Tramada than in the sheet.
 */
function matchTramadaLine(candidates = [], totalNett) {
  const want = cents(totalNett);
  if (want == null) {
    return { ok: false, remark: "Amount does not match in Tramada", reason: "no amount to match against" };
  }
  if (!candidates.length) {
    return { ok: false, remark: "Policy number not found in Tramada" };
  }

  const allowed = Math.abs(want) * AMOUNT_TOLERANCE;
  const scored = candidates
    .map((c) => {
      const got = cents(c.amount);
      return got == null ? null : { line: c, got, diff: Math.abs(got - want) };
    })
    .filter(Boolean)
    .sort((a, b) => a.diff - b.diff);

  if (!scored.length) {
    return { ok: false, remark: "Amount does not match in Tramada", reason: "no candidate carried an amount" };
  }

  const best = scored[0];
  if (best.diff > allowed) {
    return {
      ok: false,
      remark: "Amount does not match in Tramada",
      closest: best.line,
      differenceCents: best.got - want,
    };
  }
  return { ok: true, line: best.line, differenceCents: best.got - want };
}

/* -------------------------------------------------- step 11/14, the labels */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Step 11 — the payment Reference: "TOKIO_JUL 2026". */
function paymentReference(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error("paymentReference needs a date");
  return `TOKIO_${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Step 14 — the session label: "TOKIO_JUL 26". Two digits, not four. */
function sessionLabel(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error("sessionLabel needs a date");
  return `TOKIO_${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

module.exports = {
  cents,
  policyKey,
  isQuoteNumber,
  COMMISSION_RATE,
  calcCommission,
  OUTCOME,
  classify,
  asDate,
  deriveReportingMonth,
  monthKeyToDate,
  MONTH_NAMES,
  NOT_FOUND,
  APPENDED_COLUMNS,
  indexByPolicy,
  buildConsolidated,
  AMOUNT_TOLERANCE,
  matchTramadaLine,
  paymentReference,
  sessionLabel,
};

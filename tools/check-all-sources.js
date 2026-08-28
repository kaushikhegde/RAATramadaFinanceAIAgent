/**
 * EVERY PAYMENT TYPE, THE WHOLE WAY THROUGH, WITHOUT A BROWSER.
 *
 *   node tools/check-all-sources.js
 *
 * Reads the real fixture for each of the four reports and pushes it through
 * every decision the run makes before Tramada is ever touched:
 *
 *     the file  →  parsed  →  matched / allocated  →  remarks  →  export
 *
 * That is most of the program. What it CANNOT prove is the browser half —
 * filling forms, ticking lines, pressing Issue. `tools/e2e-live.js` does that,
 * on a machine with Chrome signed into Tramada.
 *
 * NOTHING IS WRITTEN ANYWHERE. No Tramada, no network, no files saved.
 */
const fs = require("fs");
const path = require("path");
const C = require("../recon-core");
const XL = require("../xlsx-lite");

const root = path.join(__dirname, "..");
const R = (...p) => path.join(root, ...p);
const money = (c) => (c == null ? "—" : "$" + (c / 100).toFixed(2));

let problems = 0;
const bad = (m) => { problems++; console.log(`      ✗ ${m}`); };
const good = (m) => console.log(`      ✓ ${m}`);

/* Read either container, the same way the server does — a .xlsx read as text
   is how "the header is missing" gets reported about a perfectly good file. */
function readGrid(file) {
  if (/\.xlsx$/i.test(file)) {
    const sheet = XL.readSheet(fs.readFileSync(file));
    return { headers: sheet.headers, rows: sheet.rows };
  }
  const g = C.csvGrid(fs.readFileSync(file, "utf8"));
  return { headers: g.headers, rows: g.rows };
}

function banner(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m\n${"─".repeat(t.length)}`);
}

/* ── BPAY ─────────────────────────────────────────────────────────────────
   The only report that WRITES. Each row becomes a receipt against a booking,
   so the decision that matters is the allocation: which segments get ticked. */
function bpay(file) {
  banner(`BPAY · ${path.basename(file)}`);
  const { headers, rows } = readGrid(file);
  const p = C.parseReconRows(headers, rows);
  console.log(`  columns: ${headers.join(" | ")}`);
  if (p.problems.length) { p.problems.forEach((x) => bad(`line ${x.line}: ${x.why}`)); return null; }
  good(`${p.rows.length} row(s) parsed`);

  /* The allocation rule, exercised against segments that produce all four
     outcomes — this is the rule RAA changed to strict, so it is the one worth
     seeing spelled out rather than summarised. */
  /* The allocation rule, exercised against segments that produce all four
     outcomes. ASSERTED, not printed: the first version of this printed four
     identical "Not allocated" lines and reported no problems, because it built
     segments as {id, dueCents} and the real shape is {segId, debtorDue} — so
     every due read as unreadable and every case took the same refusal branch.
     A harness that only prints is a harness that agrees with itself. */
  console.log("\n  the allocation decision, per row:");
  for (const r of p.rows) {
    const due = r.amountCents;
    const half = Math.floor(due / 2);
    const cases = [
      ["exactly one segment's due", [{ segId: "s1", debtorDue: (due / 100).toFixed(2) }, { segId: "s2", debtorDue: "9999.99" }],
        "Allocated", 1],
      ["the sum of every segment", [{ segId: "s1", debtorDue: (half / 100).toFixed(2) }, { segId: "s2", debtorDue: ((due - half) / 100).toFixed(2) }],
        "Allocated", "ALL"],
      ["more than everything owed", [{ segId: "s1", debtorDue: ((due - 5000) / 100).toFixed(2) }],
        "Part allocated", "ALL"],
      ["neither one nor all", [{ segId: "s1", debtorDue: ((due + 1) / 100).toFixed(2) }, { segId: "s2", debtorDue: ((due + 2) / 100).toFixed(2) }],
        "Not allocated", 0],
    ];
    console.log(`    booking ${r.bookingNo}  ${money(due)}`);
    for (const [what, segs, wantStatus, wantTicks] of cases) {
      const d = C.decideAllocation(due, segs);
      const ticks = d.allocation === "ALL" ? "ALL" : d.allocation.length;
      const okStatus = d.status === wantStatus;
      const okTicks = String(ticks) === String(wantTicks);
      console.log(`      ${(okStatus && okTicks) ? "\u2713" : "\u2717"} ${what.padEnd(28)} \u2192 ${d.status.padEnd(14)} ticks ${ticks}` +
        (d.remark ? `  "${d.remark}"` : ""));
      if (!okStatus) bad(`${what}: expected "${wantStatus}", got "${d.status}"`);
      if (!okTicks) bad(`${what}: expected ${wantTicks} tick(s), got ${ticks}`);
    }
  }

  // The export, in the columns the file arrived with — RAA asked for exactly this.
  const grid = C.buildExportGrid(p.rows.map((r) => ({ ...r, src: "bpay", receiptNo: "R" + r.bookingNo,
    allocation: "Allocated", reconciliation: "Reconciled" })), headers, { inputColumns: headers });
  console.log(`\n  export columns: ${grid.headings.join(" | ")}`);
  const kept = headers.every((h) => grid.headings.includes(h));
  kept ? good("every uploaded column survived into the export")
       : bad("the export dropped a column the file arrived with");
  return p.rows;
}

/* ── MINT / TRAVELPAY ─────────────────────────────────────────────────────
   These WRITE NOTHING. They look for their payment among the transactions on
   the day's statement page and tick it. Three things must agree — reference,
   amount, supplier — and a disagreement is a refusal, not a note. */
function creditor(kind, file, statement) {
  banner(`${kind.toUpperCase()} · ${path.basename(file)}`);
  const { headers, rows } = readGrid(file);
  const p = kind === "mint" ? C.parseMintRows(headers, rows) : C.parseTravelPayRows(headers, rows);
  console.log(`  columns: ${headers.slice(0, 6).join(" | ")}${headers.length > 6 ? ` | …+${headers.length - 6}` : ""}`);
  if (p.problems.length) { p.problems.forEach((x) => bad(`line ${x.line}: ${x.why}`)); return null; }
  good(`${p.rows.length} row(s) parsed`);

  console.log("\n  matched against the statement page:");
  let ticked = 0;
  for (const r of p.rows) {
    const m = kind === "mint"
      ? C.matchMintAgainstStatement(r, statement)
      : C.matchTravelPayAgainstStatement(r, statement);
    if (m.reconciled) ticked++;
    console.log(`    ${String(r.transNo).padEnd(16)} ${money(r.amountCents).padStart(11)}  ` +
      `${m.status.padEnd(16)} ${m.reason || ""}`);
  }
  console.log(`\n  ${ticked} of ${p.rows.length} would be ticked against the stock fixture`);

  /* THE TICK PATH, PROVEN. The stock statement fixture is BPay's — it holds
     none of these references, so every row above is correctly "not found" and
     the SUCCESS branch never runs. A green report built only on refusals says
     nothing about whether a match can ever be made. So: build the page these
     payments would actually be on, and check three things separately —
     a clean match, a match whose amount disagrees, and a supplier that does
     not. Those are the three the guides say must all agree before a tick. */
  const onPage = p.rows.map((r) => ({
    date: "27-08-2026", transNo: r.transNo, recPayType: C.REPORTS[kind].recPayType,
    transType: "ET", reference: r.transNo,
    payee: r.toCompany || r.merchant || "", amount: (r.amountCents / 100).toFixed(2),
  }));
  const matcher = kind === "mint" ? C.matchMintAgainstStatement : C.matchTravelPayAgainstStatement;

  console.log("\n  against the page these payments are really on:");
  let clean = 0;
  for (const r of p.rows) {
    const m = matcher(r, onPage);
    if (m.reconciled && !m.mismatch) clean++;
    console.log(`    ${String(r.transNo).padEnd(16)} ${m.status.padEnd(14)} ${m.mismatch ? "\u26a0 " + m.mismatch : m.reason}`);
  }
  clean === p.rows.length
    ? good(`all ${clean} row(s) tick cleanly when the payment is on the page`)
    : bad(`only ${clean} of ${p.rows.length} ticked cleanly against their own page`);

  // The amount disagreeing must be REPORTED, not swallowed.
  const wrongMoney = onPage.map((t, i) => i === 0 ? { ...t, amount: (Number(t.amount) + 10).toFixed(2) } : t);
  const mm = matcher(p.rows[0], wrongMoney);
  console.log(`    amount $10 out on the page \u2192 ${mm.status}${mm.mismatch ? ` \u26a0 ${mm.mismatch}` : ""}`);
  mm.mismatch ? good("a disagreeing amount is carried out as a mismatch, not hidden")
              : bad("an amount that disagrees was ticked silently");

  // And a supplier that does not match.
  const wrongPayee = onPage.map((t, i) => i === 0 ? { ...t, payee: "SOMEONE ELSE PTY LTD" } : t);
  const wp = matcher(p.rows[0], wrongPayee);
  console.log(`    paid to someone else       \u2192 ${wp.status}${wp.mismatch ? ` \u26a0 ${wp.mismatch}` : ""}`);
  /* THE TWO REPORTS DIFFER HERE ON PURPOSE, and the difference is correct.

     Mint's "To Company" IS the creditor being paid, so a statement payee that
     disagrees is a real discrepancy and gets carried out.

     TravelPay's "MerchantCompanyName" is RAA's OWN merchant account — the
     client's export says "Monarto Resort Pty Ltd" on every row — while the
     statement's "Receipt For/Payment To" is the client the money came FROM
     ("GRAY/SPIDER MS"). Those two disagree on every row by design. Comparing
     them would flag all of them and teach Finance to ignore the column that
     exists to catch a real one.

     This assertion is written the way it is so that "making the two matchers
     consistent" fails here, loudly, instead of looking like a tidy-up. */
  if (kind === "mint") {
    wp.mismatch ? good("Mint carries out a supplier that disagrees")
                : bad("Mint ticked a payment to the wrong supplier silently");
  } else {
    !wp.mismatch ? good("TravelPay does NOT compare suppliers — the two columns hold different things")
                 : bad("TravelPay started comparing suppliers — it will now flag every single row");
  }

  // BR02 — the human-typed transaction total against the file's own rows.
  const sum = p.rows.reduce((a, r) => a + (r.amountCents || 0), 0);
  const right = C.checkTransactionTotal(p.rows, (sum / 100).toFixed(2));
  const wrong = C.checkTransactionTotal(p.rows, ((sum + 100) / 100).toFixed(2));
  const none  = C.checkTransactionTotal(p.rows, "");
  console.log(`  transaction total ${money(sum)} typed correctly → ${right.checked ? "agrees" : "REFUSED"} ${right.remark || ""}`);
  console.log(`  a dollar out                       → ${wrong.remark || wrong.reason}`);
  console.log(`  left blank                         → ${none.reason}`);
  right.checked && !right.remark ? good("a correct total is accepted quietly") : bad("a correct total was not accepted");
  wrong.remark ? good("a wrong total is called out") : bad("a wrong total passed silently");
  return p.rows;
}

/* ── IPSI ─────────────────────────────────────────────────────────────────
   The odd one out: no bank statement at all. It ticks receipts that already
   exist on the Finance Receipts screens and issues one merchant receipt over
   them. Pre-auths are excluded before anything else happens. */
function ipsi(file) {
  banner(`IPSI · ${path.basename(file)}`);
  const { headers, rows } = readGrid(file);
  const p = C.parseIpsiRows(headers, rows);
  console.log(`  columns: ${headers.slice(0, 6).join(" | ")}${headers.length > 6 ? ` | …+${headers.length - 6}` : ""}`);
  if (p.problems.length) { p.problems.forEach((x) => bad(`line ${x.line}: ${x.why}`)); return null; }
  const st = p.settlement || {};
  good(`${p.rows.length} row(s) parsed · settlement date ${(p.rows[0] || {}).settlementDate || "—"}`);
  console.log(`  the file's own settlement line: rows total ${money(st.everyRowCents)}, ` +
    `file states ${money(st.statedCents)} \u2192 ${st.agrees ? "agree" : "DISAGREE"}`);
  st.agrees ? good("the file agrees with its own stated settlement")
            : bad("the file's rows do not add up to the settlement amount it states");

  const pre = p.rows.filter((r) => C.isPreAuth(r));
  console.log(`  pre-auths excluded: ${pre.length}`);

  // BR01 — the file's own total against the NUVEI figure a person types in.
  const sum = p.rows.reduce((a, r) => a + (r.amountCents || 0), 0);
  const right = C.checkIpsiFileTotal(p.rows, (sum / 100).toFixed(2));
  const wrong = C.checkIpsiFileTotal(p.rows, ((sum - 250) / 100).toFixed(2));
  console.log(`\n  file total ${money(sum)}`);
  console.log(`    NUVEI typed to match  → ${right.ok ? "run may start" : "REFUSED: " + (right.reason || right.remark)}`);
  console.log(`    NUVEI $2.50 out       → ${wrong.ok ? "ALLOWED — should not be" : "refused: " + (wrong.reason || wrong.remark)}`);
  right.ok ? good("a matching NUVEI amount lets the run start") : bad("a matching NUVEI amount was refused");
  !wrong.ok ? good("a mismatched NUVEI amount stops the run before Tramada") : bad("a mismatch was allowed through");
  return p.rows;
}

/* ── THE COMBINED RUN ─────────────────────────────────────────────────────
   BPay first, and the numbering that goes with it. */
function combined(byReport) {
  banner("BPAY + MINT + TRAVELPAY + IPSI together");
  const order = C.RUN_ORDER.filter((k) => (byReport[k] || []).length);
  console.log(`  run order: ${order.join(" → ")}`);
  order[0] === "bpay" ? good("BPay goes first") : bad(`${order[0]} goes first, not BPay`);
  const all = order.flatMap((k) => byReport[k].map((r) => ({ ...r, src: k }))).map((r, i) => ({ ...r, n: i + 1 }));
  console.log(`  ${all.length} rows numbered 1…${all.length}: ` +
    order.map((k) => `${k} ${all.filter((r) => r.src === k).map((r) => r.n).join(",")}`).join(" · "));

  // What a run with no bank statement for the day is told.
  console.log("\n  no BPAY statement exists for the day:");
  for (const k of ["mint", "travelpay"]) {
    const msg = C.noStatementMessage(k, "27-08-2026", [], "Trust Account");
    const opens = msg.startsWith("BPAY needs to be reconciled first for today.");
    console.log(`    ${k.padEnd(10)} → ${msg.slice(0, 76)}…`);
    opens ? good(`${k} is refused with RAA's exact sentence`) : bad(`${k}'s refusal does not open with RAA's sentence`);
  }
  /* NOT A GAP — a DECISION. RAA, 28-Aug: "IPSI can still run by itself
     because it doesn't reference the Tramada bank statement." The POC
     feedback line for BPAY 02 does name IPSI, but the condition it attaches
     describes a page IPSI never opens. This line used to read "open gap",
     which invites someone to close it. */
  console.log(`    ipsi       \u2192 not refused, and correctly so — it never opens a statement page (RAA confirmed 28-Aug)`);
}

/* ───────────────────────────────────────────────────────────────────────── */
const statement = JSON.parse(fs.readFileSync(R("fixtures", "statement-rows.json"), "utf8"));
const stRows = Array.isArray(statement) ? statement : (statement.rows || []);

const b  = bpay(R("uploads", "20260827-045004-bpay.csv"));
const m  = creditor("mint", R("fixtures", "mint-payments.csv"), stRows);
const t  = creditor("travelpay", R("fixtures", "travelpay-payments.csv"), stRows);
const i  = ipsi(R("csv_uploads", "ipsi-payments.csv"));
combined({ bpay: b || [], mint: m || [], travelpay: t || [], ipsi: i || [] });

console.log(`\n\x1b[1m${problems ? `${problems} problem(s)` : "no problems"}\x1b[0m — the browser half is not covered here; see tools/e2e-live.js\n`);
process.exit(problems ? 1 : 0);

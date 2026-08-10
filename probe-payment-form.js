/**
 * probe-payment-form.js — look at the creditor payment form and say what is
 * actually on it. READ-ONLY: it never clicks Issue, never fills an amount,
 * never sends anything. It opens the form, picks the creditor, and describes
 * what it finds.
 *
 *   node probe-payment-form.js 13229
 *   node probe-payment-form.js 13229 --creditor "READY ROOMS"
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `make-fixtures.js mint` failed on bookings 13229 and 13232 with
 *
 *     The payment form's segment table has no "Creditor Payable" column
 *     (headers: ). Refusing to guess which one holds the money.
 *
 * and that message cannot tell two very different situations apart, because
 * `readPayableSegments` builds its header list INSIDE the loop over the
 * allocation inputs:
 *
 *   - there were no allocation rows at all (nothing is payable), or
 *   - there were rows, but the header row holding "Creditor Payable" was not
 *     inside `row.closest("table")` — Tramada grids often put the header in a
 *     separate table from the body.
 *
 * Both end up with `headers: []` and the same sentence. Guessing between them
 * and "fixing" the wrong one is how a symptom fix gets written, so this asks
 * the page instead.
 *
 * It drives the SAME functions the real run uses — imported, not copied — so
 * whatever it reports is what the run saw.
 */

const P = require("./tramada-payment");

const args = process.argv.slice(2);
const bookingNo = args.find((a) => !a.startsWith("--"));
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CREDITOR = valueOf("--creditor", "READY ROOMS");
const TXN = valueOf("--type", "EFT");

if (!bookingNo) {
  console.error("\n  node probe-payment-form.js <bookingNo> [--creditor \"READY ROOMS\"]\n");
  process.exit(1);
}

const line = (s = "") => console.log(`  ${s}`);
const head = (s) => { console.log(""); line(`── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`); };

(async () => {
  const browser = await P.openBrowser();
  let page;
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await P.ensureLoggedIn(page, () => line("Sign into Tramada in the Chrome on port 9222."));

    line(`Opening the payments list for booking ${bookingNo}…`);
    await page.goto(
      `${P.TRAMADA_BASE_URL}/booking/booking-payments.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#add", { timeout: 15000 });
    await page.click("#add");
    await page.waitForSelector("#paymenttransactionTypeCode", { timeout: 20000 });
    await page.selectOption("#paymenttransactionTypeCode", P.resolveTxnType(TXN));
    await new Promise((r) => setTimeout(r, 600));

    head("what creditors the form offers");
    const options = await page.locator("#creditor option").evaluateAll((ns) =>
      ns.map((n) => ({ value: n.value, label: (n.textContent || "").trim() })));
    if (!options.length) line("(the #creditor select has no options at all)");
    for (const o of options) line(`${o.value ? o.value.padEnd(12) : "(blank)".padEnd(12)} ${o.label}`);

    let chosen = null;
    try {
      chosen = await P.chooseCreditor(page, CREDITOR);
      head(`after choosing ${chosen.label}`);
    } catch (err) {
      head("choosing the creditor failed");
      line(err.message);
      line("");
      line("That is the answer: this booking owes that creditor nothing.");
      return;
    }

    /* Everything below is description, not judgement. */
    const dom = await page.evaluate(() => {
      const txt = (n) => (n.textContent || "").replace(/\s+/g, " ").trim();
      const inputs = [...document.querySelectorAll("input[id]")]
        .map((n) => n.id)
        .filter((id) => /alloc|segment|payable/i.test(id));

      const allocInputs = [...document.querySelectorAll('input[id^="allocationAmount_"]')];

      // Every table anywhere on the page whose text mentions the column we want.
      const tablesWithHeader = [...document.querySelectorAll("table")]
        .filter((t) => /creditor\s*payable/i.test(t.textContent))
        .map((t, i) => {
          const hdr = [...t.querySelectorAll("tr")].find((r) => /creditor\s*payable/i.test(r.textContent));
          return {
            i,
            id: t.id || "(no id)",
            cls: t.className || "",
            rows: t.querySelectorAll("tr").length,
            headerCells: hdr ? [...hdr.children].map(txt) : null,
            holdsAllocInputs: !!t.querySelector('input[id^="allocationAmount_"]'),
          };
        });

      // For the first allocation row: walk UP and say what each table ancestor
      // is, and whether the header lives in it. This is the exact thing
      // `readPayableSegments` gets wrong when the header is in a sibling table.
      let ancestry = null;
      if (allocInputs.length) {
        const tr = allocInputs[0].closest("tr");
        ancestry = [];
        let n = tr;
        while (n && ancestry.length < 8) {
          n = n.parentElement && n.parentElement.closest("table");
          if (!n) break;
          const hdr = [...n.querySelectorAll("tr")].find((r) => /creditor\s*payable/i.test(r.textContent));
          ancestry.push({
            id: n.id || "(no id)",
            cls: n.className || "",
            rows: n.querySelectorAll("tr").length,
            hasHeaderRow: !!hdr,
            headerCells: hdr ? [...hdr.children].map(txt) : null,
          });
        }
      }

      const firstRowCells = allocInputs.length
        ? [...allocInputs[0].closest("tr").children].map(txt)
        : null;

      // Anything the page is complaining about.
      const messages = [...new Set([...document.querySelectorAll("span,div,li,font,a")]
        .filter((n) => !n.children.length)
        .map(txt)
        .filter((t) => t && t.length < 160 && /must be|is required|no .*(segment|allocat)|nothing|not available/i.test(t)))]
        .slice(0, 8);

      return {
        allocInputCount: allocInputs.length,
        allocInputIds: allocInputs.map((n) => n.id).slice(0, 10),
        interestingInputIds: inputs.slice(0, 20),
        tablesWithHeader,
        ancestry,
        firstRowCells,
        messages,
        segmentAreaText: (() => {
          const h = [...document.querySelectorAll("*")].find((n) =>
            !n.children.length && /segments?\s+to\s+allocate/i.test(n.textContent || ""));
          if (!h) return "(no 'Segments To Allocate' heading found)";
          const box = h.closest("table") || h.parentElement;
          return txt(box).slice(0, 400);
        })(),
      };
    });

    head("allocation rows");
    line(`input[id^="allocationAmount_"] matched: ${dom.allocInputCount}`);
    if (dom.allocInputIds.length) line(`ids: ${dom.allocInputIds.join(", ")}`);
    if (dom.firstRowCells) line(`first row cells: ${JSON.stringify(dom.firstRowCells)}`);
    if (dom.interestingInputIds.length) {
      line(`other inputs mentioning alloc/segment/payable:`);
      for (const id of dom.interestingInputIds) line(`   ${id}`);
    }

    head('tables containing "Creditor Payable"');
    if (!dom.tablesWithHeader.length) line("(none — that column is nowhere on this page)");
    for (const t of dom.tablesWithHeader) {
      line(`#${t.i} id=${t.id} class="${t.cls}" rows=${t.rows} holdsAllocationInputs=${t.holdsAllocInputs}`);
      if (t.headerCells) line(`     header: ${t.headerCells.join(" | ")}`);
    }

    if (dom.ancestry) {
      head("walking up from the first allocation row");
      dom.ancestry.forEach((a, i) => {
        line(`${i === 0 ? "closest" : `+${i}`} table id=${a.id} class="${a.cls}" rows=${a.rows} hasHeaderRow=${a.hasHeaderRow}`);
        if (a.headerCells) line(`     header: ${a.headerCells.join(" | ")}`);
      });
    }

    head("what the real reader makes of it");
    const read = async (label) => {
      try {
        const segs = await P.readPayableSegments(page, CREDITOR);
        line(`${label}: ${segs.length} row(s)`);
        for (const s of segs) line(`     ${s.segId}  ${s.segType}  ${s.creditorId}  payable ${s.payable}`);
        return true;
      } catch (err) {
        line(`${label}: threw — ${err.message}`);
        return false;
      }
    };
    const now = await read("straight away");
    /* The same read again, five seconds later, with nothing else changed.
       `chooseCreditor` waits a flat 1200ms for the postback that rebuilds this
       table. If the first read finds nothing and the second finds rows, the
       table simply had not arrived yet and the bug is that fixed sleep — not
       the header, not the booking. If both fail identically, it is not timing
       and the answer is above. */
    if (!now) {
      await new Promise((r) => setTimeout(r, 5000));
      const later = await read("again, 5s later");
      line("");
      line(later
        ? ">>> TIMING. The postback had not finished when the run read the table."
        : ">>> NOT timing. Five more seconds changed nothing.");
    }

    head("the Segments To Allocate area, as text");
    line(dom.segmentAreaText);

    if (dom.messages.length) {
      head("messages on the page");
      for (const m of dom.messages) line(m);
    }

    const shot = `probe-payment-${bookingNo}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    head("");
    line(`Screenshot: ${shot}`);
    line("Nothing was issued. The form is abandoned, not saved.");
    console.log("");
  } finally {
    // The page, never the browser: closing a CDP-attached browser takes down
    // the Chrome the human is signed into.
    if (page) await page.close().catch(() => {});
  }
})().catch((e) => { console.error("\n  Probe failed:", e.message, "\n"); process.exit(1); });

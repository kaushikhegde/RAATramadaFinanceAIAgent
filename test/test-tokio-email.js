"use strict";

/**
 * Step 15 / BR17 — the mail to Travel Accounts.
 *
 * The whole module is pure except writeDraft and sendViaSmtp, so almost all
 * of it is testable with no mail server and no disk. What is worth testing
 * here is not "does it build MIME" — it is every claim the message makes
 * about the world, because the message is read by people who then decide
 * whether to open Tramada.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mail = require("../tokio-email");

let n = 0;
const failures = [];
const check = async (what, fn) => {
  try { await fn(); n++; console.log("  ok  " + what); }
  catch (err) { failures.push(what); console.log("  NOT OK  " + what + "\n      " + err.message); }
};

const SHEET = Buffer.from("Outcome,xPolicyNo,RAA Total Nett\nTravel,21990677,70\n");

const good = (over = {}) => ({
  label: "TOKIO_Aug 26",
  month: "August 2026",
  reference: "TOKIO_Aug 2026",
  savedSession: true,
  counts: { ticked: 5, mismatched: 1, exceptions: 3, retail: 2 },
  attachments: [{ filename: "tokio-consolidated-August-2026.csv", content: SHEET }],
  date: new Date(Date.UTC(2026, 7, 31, 4, 0, 0)),
  ...over,
});

(async () => {
  console.log("\nwhat the message is allowed to claim");

  await check("BR17 — the recipient and subject come from the guide, verbatim", () => {
    assert.strictEqual(mail.TRAVEL_ACCOUNTS, "TAccounts@raa.com.au");
    assert.strictEqual(
      mail.SUBJECT,
      "AI Agent Tokio Marine reconciliation - Session saved, ready for review"
    );
    const msg = mail.composeReconciliationEmail(good());
    assert.strictEqual(msg.to, "TAccounts@raa.com.au");
    assert.strictEqual(msg.subject, mail.SUBJECT);
  });

  await check('"session saved" is refused when no session was saved', () => {
    assert.throws(() => mail.composeReconciliationEmail(good({ savedSession: false })), /no session was saved/i);
    assert.throws(() => mail.composeReconciliationEmail(good({ savedSession: undefined })), /no session was saved/i);
    // Truthy-but-not-true must not squeak through: a dry run returning the
    // string "false", or a 1 from somewhere, is not a saved session.
    assert.throws(() => mail.composeReconciliationEmail(good({ savedSession: "yes" })), /no session was saved/i);
    assert.throws(() => mail.composeReconciliationEmail(good({ savedSession: 1 })), /no session was saved/i);
  });

  await check("BR17 — a mail with no attachment is not step 15", () => {
    assert.throws(() => mail.composeReconciliationEmail(good({ attachments: [] })), /not step 15/i);
    assert.throws(
      () => mail.composeReconciliationEmail(good({ attachments: [{ filename: "x.csv", content: "" }] })),
      /empty/i
    );
  });

  await check("a sheet still carrying passenger names is refused", () => {
    // Step 1 says a human strips xCustomer and xInsuredName before the file
    // leaves Finance. This IS the file leaving Finance.
    const raw = Buffer.from("xPolicyNo,xCustomer,xInsuredName\n21990677,SMITH MR,SMITH MR\n");
    assert.throws(
      () => mail.composeReconciliationEmail(good({ attachments: [{ filename: "b2b.csv", content: raw }] })),
      (err) => {
        assert.ok(/xCustomer/.test(err.message) && /xInsuredName/.test(err.message),
          `the refusal must name the columns; got: ${err.message}`);
        return true;
      }
    );
  });

  await check("the body says Issue was NOT clicked, and names what a person still owes", () => {
    const msg = mail.composeReconciliationEmail(good());
    assert.ok(/Issue has NOT been clicked/.test(msg.text), "the mail must not let anyone assume it paid");
    assert.ok(/nothing has been paid/i.test(msg.text));
    assert.ok(/rounding/i.test(msg.text), "BR14 rounding is the human's, and the mail should say so");
    assert.ok(/transaction total/i.test(msg.text));
    assert.ok(/TOKIO_Aug 26/.test(msg.text), "the mail must name the session to review");
  });

  await check("the counts in the body are the counts passed, not invented", () => {
    const msg = mail.composeReconciliationEmail(good({ counts: { ticked: 12, mismatched: 4, exceptions: 7, retail: 9 } }));
    assert.ok(/12 segment\(s\) matched/.test(msg.text), msg.text);
    assert.ok(/4 line\(s\) not ticked/.test(msg.text));
    assert.ok(/7 exception\(s\)/.test(msg.text));
    assert.ok(/9 Retail line\(s\)/.test(msg.text));
  });

  await check("missing counts read as 0 rather than undefined", () => {
    const msg = mail.composeReconciliationEmail(good({ counts: {} }));
    assert.ok(!/undefined/.test(msg.text), `a count leaked as undefined:\n${msg.text}`);
    assert.ok(/0 segment\(s\) matched/.test(msg.text));
  });

  console.log("\nthe bytes a mail client will read");

  await check("the .eml is multipart with the sheet attached and decodable", () => {
    const msg = mail.composeReconciliationEmail(good());
    const eml = mail.buildMime(msg, { boundary: "BOUND" }).toString("utf8");
    assert.ok(eml.includes("To: TAccounts@raa.com.au"));
    // The subject is 70 characters, so "Subject: " + it exceeds the 78-column
    // recommendation and gets folded — which is legal, and which every client
    // unfolds. So assert the property that matters (it survives round-trip),
    // not the byte layout.
    const unfold = (s) => s.replace(/\r\n[ \t]+/g, " ");
    assert.ok(
      unfold(eml).includes("Subject: AI Agent Tokio Marine reconciliation - Session saved, ready for review"),
      "the subject must survive folding intact, and unencoded — it is plain ASCII"
    );
    assert.ok(
      eml.split("\r\n").every((l) => l.length <= 998),
      "a header line over 998 octets is illegal, not merely untidy"
    );
    assert.ok(eml.includes('Content-Type: multipart/mixed; boundary="BOUND"'));
    assert.ok(eml.includes('filename="tokio-consolidated-August-2026.csv"'));
    assert.ok(eml.includes("Content-Type: text/csv"), "a .csv must not go out as octet-stream");
    assert.ok(eml.endsWith("--BOUND--\r\n"), "an unterminated multipart shows as a broken mail");

    // Round-trip the attachment: base64 that does not decode back to the
    // sheet is a corrupted delivery no one notices until Travel Accounts open it.
    const b64 = eml.split('filename="tokio-consolidated-August-2026.csv"')[1].split("\r\n\r\n")[1].split("\r\n--BOUND--")[0];
    assert.strictEqual(Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8"), SHEET.toString("utf8"));
  });

  await check("CRLF everywhere — a bare LF breaks strict mail servers", () => {
    const eml = mail.buildMime(mail.composeReconciliationEmail(good()), { boundary: "B" }).toString("utf8");
    assert.ok(!/[^\r]\n/.test(eml), "found a line feed not preceded by a carriage return");
  });

  await check("a long base64 attachment is wrapped at 76 characters", () => {
    const big = Buffer.alloc(5000, 0x41);
    const msg = mail.composeReconciliationEmail(good({
      attachments: [{ filename: "big.xlsx", content: big }],
    }));
    const eml = mail.buildMime(msg, { boundary: "B" }).toString("utf8");
    const body = eml.split('filename="big.xlsx"')[1].split("\r\n\r\n")[1].split("\r\n--B--")[0];
    const lines = body.split("\r\n");
    assert.ok(lines.length > 1, "5KB did not wrap at all");
    assert.ok(lines.every((l) => l.length <= 76), `a line ran to ${Math.max(...lines.map((l) => l.length))}`);
  });

  await check("an .xlsx gets the spreadsheet content type, an unknown one does not guess", () => {
    assert.strictEqual(
      mail.contentTypeFor("a.xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    assert.strictEqual(mail.contentTypeFor("a.CSV"), "text/csv");
    assert.strictEqual(mail.contentTypeFor("a.weird"), "application/octet-stream");
  });

  await check("a non-ASCII subject is encoded rather than emitted raw", () => {
    const msg = mail.composeReconciliationEmail(good({ subject: "Réconciliation" }));
    const eml = mail.buildMime(msg, { boundary: "B" }).toString("utf8");
    assert.ok(/Subject: =\?UTF-8\?B\?/.test(eml), "a raw 8-bit subject header is not legal");
  });

  console.log("\nsending, and refusing to");

  await check("draft is the default, writes a file, and reports sent:false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokio-mail-"));
    const res = await mail.sendReconciliationEmail({ ...good(), dir });
    assert.strictEqual(res.transport, "draft");
    assert.strictEqual(res.sent, false, "a draft must never claim it sent");
    assert.ok(fs.existsSync(res.path));
    assert.ok(fs.readFileSync(res.path, "utf8").includes("TAccounts@raa.com.au"));
  });

  await check("SMTP takes the exact literal and nothing else", async () => {
    await assert.rejects(
      () => mail.sendReconciliationEmail({ ...good(), transport: "smtp", confirm: "send email" }),
      /exact confirmation/i
    );
    await assert.rejects(
      () => mail.sendReconciliationEmail({ ...good(), transport: "smtp" }),
      /exact confirmation/i
    );
    await assert.rejects(
      () => mail.sendReconciliationEmail({ ...good(), transport: "smtp", confirm: "SEND EMAIL " }),
      /exact confirmation/i
    );
  });

  await check("the guards run BEFORE the transport is considered", async () => {
    // An unsaved session must be refused for being untrue, not for lacking a
    // confirmation — otherwise supplying the literal would send the lie.
    await assert.rejects(
      () => mail.sendReconciliationEmail({
        ...good({ savedSession: false }), transport: "smtp", confirm: mail.SEND_LITERAL,
      }),
      /no session was saved/i
    );
  });

  await check("an unknown transport is refused rather than quietly drafted", async () => {
    await assert.rejects(() => mail.sendReconciliationEmail({ ...good(), transport: "post" }), /Unknown transport/);
  });

  await check("SMTP with no credentials says so without inventing any", async () => {
    await assert.rejects(
      () => mail.sendReconciliationEmail({
        ...good(), transport: "smtp", confirm: mail.SEND_LITERAL, env: {},
      }),
      (err) => {
        assert.ok(/SMTP_HOST/.test(err.message), err.message);
        assert.ok(/draft/.test(err.message), "it should point at the transport that works today");
        return true;
      }
    );
  });

  await check("no credential is ever put in an error message or a result", async () => {
    const env = { SMTP_HOST: "smtp.example.com", SMTP_USER: "svc@raa.com.au", SMTP_PASS: "hunter2-SECRET" };
    let caught = null;
    try {
      await mail.sendReconciliationEmail({ ...good(), transport: "smtp", confirm: mail.SEND_LITERAL, env });
    } catch (err) { caught = err; }
    assert.ok(caught, "expected nodemailer to be absent in this repo");
    assert.ok(!/hunter2/.test(caught.message + (caught.stack || "")), "the password reached an error message");
  });

  await check("the module holds no hard-coded credential", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "tokio-email.js"), "utf8");
    assert.ok(!/SMTP_PASS\s*=\s*["']/.test(src), "a password is assigned in source");
    assert.ok(!/password\s*:\s*["'][^"']+["']/i.test(src), "a literal password is in source");
  });

  console.log(`\n${failures.length ? "NOT OK" : "ok"} — ${n} assertions passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();

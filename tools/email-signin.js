/**
 * email-signin.js — sign the agent's mailbox into Microsoft Graph, once.
 *
 *   npm run email:signin            sign in (prints a code to enter in a browser)
 *   npm run email:signin -- --who   say who is signed in, change nothing
 *
 * Device-code flow: this prints Microsoft's own instruction — open
 * https://microsoft.com/devicelogin and enter the code — and waits while a
 * person signs in there as the account the DVC emails should come FROM. The
 * refresh token lands in GRAPH_TOKEN_CACHE (default .graph-token-cache.json,
 * gitignored, 0600); every send after that refreshes it silently.
 *
 * THIS SCRIPT NEVER SEES A PASSWORD. The password is typed into Microsoft's
 * page, in the person's own browser, and nowhere else — the same rule the
 * Tramada side keeps (CLAUDE.md §5). Deleting the cache file signs it out.
 */
require("dotenv").config();
const mailer = require("../mailer");

(async () => {
  const c = mailer.config();
  if (!c.graphClientId) {
    console.error("\n  GRAPH_CLIENT_ID is not set in .env — register the app first (docs/email.md).\n");
    process.exit(1);
  }
  const current = await mailer.graphAccount();
  if (process.argv.includes("--who")) {
    console.log(current ? `\n  Signed in as ${current.username}.\n` : "\n  Nobody is signed in.\n");
    return;
  }
  if (current) console.log(`\n  Currently signed in as ${current.username} — signing in again replaces it.`);
  console.log("");
  const who = await mailer.graphSignIn({ onCode: (m) => console.log(`  ${m}\n`) });
  console.log(`  ✓ Signed in as ${who.username}. DVC emails will be sent from this mailbox to: ` +
    `${c.to.join(", ") || "(DVC_EMAIL_TO is not set yet)"}\n`);
})().catch((err) => { console.error(`\n  Sign-in failed: ${err.errorMessage || err.message}\n`); process.exit(1); });

#!/usr/bin/env node
"use strict";
/**
 * Does the vault actually hold Tramada credentials for this person?
 *
 *   node tools/check-vault.js tim@raa.com
 *   npm run vault:check -- tim@raa.com
 *
 * Written because "it did not sign into Tramada" has four different causes that
 * look identical from the VNC screen: no vault configured, the app not allowed
 * to read it, the secret named something else, or the person signing into Entra
 * with a different address than the one the secret was named for. This says
 * which, in one line, without starting a run.
 *
 * It NEVER prints a secret value. The length is shown instead: that is enough
 * to catch the two real mistakes -- an empty secret, and one saved with a
 * trailing newline or a quote -- without putting a Tramada password on a
 * terminal somebody may screenshot.
 */
require("dotenv").config();
const creds = require("../tramada-creds");

const emails = process.argv.slice(2);

(async () => {
  console.log("");
  if (!creds.configured()) {
    console.log("  Neither AZURE_KEYVAULT_URL nor AWS_SECRETS_REGION is set.");
    console.log("  Nothing is read from a vault; a person signs into Tramada on the screen.");
    console.log("");
    process.exit(1);
  }
  console.log(`  vault  ${creds.describe()}`);

  if (!emails.length) {
    console.log("");
    console.log("  Pass the email somebody signs into Entra with, e.g.");
    console.log("    node tools/check-vault.js tim@raa.com");
    console.log("");
    console.log("  It must be the address ENTRA returns, not the Tramada username.");
    console.log("");
    process.exit(2);
  }

  let bad = 0;
  for (const email of emails) {
    console.log("");
    console.log(`  ${email}`);
    try {
      console.log(`    looks for  ${creds.vaultNameFor(email, "username")}`);
      console.log(`               ${creds.vaultNameFor(email, "password")}`);
      const got = await creds.credentialsFor(email);
      // Length only, never the value.
      console.log(`    ✓ found — username ${got.username.length} chars, password ${got.password.length} chars`);
      for (const [k, v] of Object.entries({ username: got.username, password: got.password })) {
        if (v !== v.trim()) {
          bad++;
          console.log(`    ⚠ the ${k} has leading or trailing whitespace — Tramada will reject it`);
        }
      }
    } catch (err) {
      bad++;
      // tramada-creds.js builds the useful messages: the exact missing name,
      // an empty secret, or the role the app is missing on the vault. Printed
      // as-is; none of them carries a value.
      console.log(`    ✗ ${err.message}`);
    }
  }
  console.log("");
  process.exit(bad ? 1 : 0);
})();

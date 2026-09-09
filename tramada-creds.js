/**
 * tramada-creds.js — one person's Tramada credentials, out of Azure Key Vault.
 *
 * The app signs somebody in with Entra (see azure-auth.js) and then has to
 * drive Tramada AS THAT PERSON. Their Tramada username and password live in a
 * key vault, two secrets each, looked up by their email address.
 *
 * ── The one rule that matters ────────────────────────────────────────────────
 *
 * The email handed to `credentialsFor` MUST come from the verified Entra token,
 * never from anything the browser sent. Everything else here is plumbing; that
 * is the whole access control. A request body reaching this function is Tim
 * asking for Sarah's password and being given it.
 *
 * ── Why names are mangled ────────────────────────────────────────────────────
 *
 * Key Vault secret names allow letters, numbers and dashes and NOTHING else —
 * so `tim@raa.com` is not a legal name and the portal rejects it. The mapping
 * is done here, in one place, and tested offline, because a mismatch surfaces
 * as "no credentials found" rather than as anything resembling a naming
 * problem. `docs/azure-setup.md` §7 shows the same table to whoever fills the
 * vault; if you change this function you have changed that document too.
 *
 * ── Not configured is not an error ───────────────────────────────────────────
 *
 * With no AZURE_KEYVAULT_URL, `credentialsFor` returns null and the run falls
 * back to a human signing in on the noVNC screen — exactly how this app worked
 * before any of this existed. That is deliberate: a local `npm start` with no
 * Azure at all still works, and a vault that is down degrades to the old
 * behaviour instead of stopping a reconciliation.
 */

const VAULT_URL = process.env.AZURE_KEYVAULT_URL || "";

/* Built once, lazily. The credential chain does IO and reads env, and doing
   that at require-time makes every offline test depend on Azure. */
let _client = null;

function client() {
  if (!VAULT_URL) return null;
  if (_client) return _client;
  // DefaultAzureCredential covers both deployments without a branch here: it
  // reads AZURE_CLIENT_ID/SECRET/TENANT_ID from the environment on a server we
  // run ourselves, and uses the container's managed identity once this moves
  // into Azure — where there is then no client secret to store at all.
  const { DefaultAzureCredential } = require("@azure/identity");
  const { SecretClient } = require("@azure/keyvault-secrets");
  _client = new SecretClient(VAULT_URL, new DefaultAzureCredential());
  return _client;
}

const configured = () => !!VAULT_URL;

/**
 * `tim@raa.com` → `tim-raa-com`.
 *
 * Lowercased, and every run of characters that is not a letter or a digit
 * becomes a single dash. A RUN, not each character: `tim..smith@raa.com` would
 * otherwise become `tim--smith-raa-com`, and nobody typing that into the portal
 * by hand would produce two dashes. Leading and trailing dashes are trimmed for
 * the same reason — Key Vault rejects a name that starts with one.
 */
function slugFor(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The full secret name for one half of one person's credentials.
 * @param {string} email  Their RAA address, from the Entra token.
 * @param {"username"|"password"} which
 */
function secretNameFor(email, which) {
  if (which !== "username" && which !== "password") {
    throw new Error(`secretNameFor: expected "username" or "password", got ${JSON.stringify(which)}`);
  }
  const slug = slugFor(email);
  // An empty slug would build the name `tramada--password`, which is a legal
  // Key Vault name — so a missing email would go and FETCH something rather
  // than failing. Whatever it found would then be typed into a finance system.
  if (!slug) throw new Error("secretNameFor: no email address to look up credentials by.");
  return `tramada-${slug}-${which}`;
}

/**
 * Fetch one person's Tramada credentials.
 *
 * @param {string} email  From the verified Entra token. NEVER from a request.
 * @returns {Promise<{username, password, forEmail}|null>}  null when no vault
 *          is configured, which means "let a human sign in" — not "deny".
 * @throws  When a vault IS configured but this person is not in it, or it
 *          cannot be read. Both are worth stopping for: silently falling back
 *          to a manual login would hide a misconfigured vault for weeks.
 */
async function credentialsFor(email) {
  const kv = client();
  if (!kv) return null;

  const names = { username: secretNameFor(email, "username"), password: secretNameFor(email, "password") };
  let got;
  try {
    const [u, p] = await Promise.all([kv.getSecret(names.username), kv.getSecret(names.password)]);
    got = { username: u.value, password: p.value };
  } catch (err) {
    // Name the secret it looked for. "SecretNotFound" on its own sends people
    // to the wrong place — the vault is fine, the NAME is what disagrees, and
    // they cannot see the name we built from inside the portal.
    if (err && (err.code === "SecretNotFound" || err.statusCode === 404)) {
      throw new Error(
        `No Tramada credentials in the vault for ${email}. Expected two secrets: ` +
        `"${names.username}" and "${names.password}". See docs/azure-setup.md §7.`
      );
    }
    if (err && err.statusCode === 403) {
      throw new Error(
        `Not allowed to read Tramada credentials from the vault. The app needs the ` +
        `"Key Vault Secrets User" role on ${VAULT_URL} — see docs/azure-setup.md §8. [${err.message}]`
      );
    }
    throw new Error(`Could not read Tramada credentials for ${email}: ${err.message}`);
  }

  // A secret that EXISTS but is empty is worse than one that is missing: the
  // login form would be filled with nothing, submitted, and reported as bad
  // credentials — sending someone to Tramada to reset a password that is fine.
  if (!got.username || !got.password) {
    throw new Error(
      `The Tramada credentials for ${email} are in the vault but one of them is empty ` +
      `("${names.username}" / "${names.password}").`
    );
  }

  /* Stamped with whose they are and carried around that way. `tramada-auth.js`
     compares this against the person the run belongs to before it types
     anything, so a credential fetched for one user can never be used to sign in
     for another — the check does not depend on remembering to pass the right
     email twice. */
  return { ...got, forEmail: String(email).trim().toLowerCase() };
}

module.exports = { configured, slugFor, secretNameFor, credentialsFor };

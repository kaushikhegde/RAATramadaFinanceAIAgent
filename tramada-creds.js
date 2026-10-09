/**
 * tramada-creds.js — one person's Tramada credentials, out of a vault.
 *
 * The vault is Azure Key Vault (AZURE_KEYVAULT_URL) or AWS Secrets Manager
 * (AWS_SECRETS_REGION). One or the other, never both: the secret NAMES are the
 * same in each — and the same as RAATramadaPaymentAIAgent's, so both apps read
 * one secret per person — and moving between clouds is copying secrets across
 * and changing one line of .env.
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
 * problem. `docs/azure-setup.md` §8 shows the same table to whoever fills the
 * vault; if you change this function you have changed that document too.
 *
 * ── Not configured is not an error ───────────────────────────────────────────
 *
 * With neither configured, `credentialsFor` returns null and the run falls
 * back to a human signing in on the noVNC screen — exactly how this app worked
 * before any of this existed. That is deliberate: a local `npm start` with no
 * Azure at all still works, and a vault that is down degrades to the old
 * behaviour instead of stopping a reconciliation.
 */

const VAULT_URL = process.env.AZURE_KEYVAULT_URL || "";
const AWS_REGION = process.env.AWS_SECRETS_REGION || "";
/* Optional, AWS only: `raa-travel/` turns `tramada-tim-raa-com-password` into
   `raa-travel/tramada-tim-raa-com-password`. An AWS account is usually shared
   with other things, and a prefix is what lets an IAM policy grant this app
   `raa-travel/*` and nothing else. Key Vault has no need — a vault IS that
   boundary. */
const AWS_PREFIX = process.env.AWS_SECRETS_PREFIX || "";

/* Built once, lazily. Each SDK's credential chain does IO and reads env, and
   doing that at require-time makes every offline test depend on a cloud. */
let _store = null;

/**
 * The vault, behind one shape: `get(name)` resolves to the value or throws
 * with `notFound` or `denied` set, so `credentialsFor` is written once rather
 * than once per cloud.
 */
function store() {
  if (!VAULT_URL && !AWS_REGION) return null;
  if (_store) return _store;
  /* Both set is a mistake, not a preference — guessing would read one person's
     password out of the vault somebody thought they had switched away from. */
  if (VAULT_URL && AWS_REGION) {
    throw new Error("Both AZURE_KEYVAULT_URL and AWS_SECRETS_REGION are set. Pick one vault; " +
      "the secret names are identical in both.");
  }

  if (VAULT_URL) {
    // DefaultAzureCredential covers both deployments without a branch here: it
    // reads AZURE_CLIENT_ID/SECRET/TENANT_ID from the environment on a server we
    // run ourselves, and uses the container's managed identity once this moves
    // into Azure — where there is then no client secret to store at all.
    const { DefaultAzureCredential } = require("@azure/identity");
    const { SecretClient } = require("@azure/keyvault-secrets");
    const kv = new SecretClient(VAULT_URL, new DefaultAzureCredential());
    _store = {
      fullName: (name) => name,
      setup: "docs/azure-setup.md §8",
      denied: `the app needs the "Key Vault Secrets User" role on ${VAULT_URL} — see docs/azure-setup.md §9`,
      async get(name) {
        try {
          return (await kv.getSecret(name)).value;
        } catch (err) {
          throw Object.assign(err, {
            notFound: err.code === "SecretNotFound" || err.statusCode === 404,
            denied: err.statusCode === 403,
          });
        }
      },
    };
    return _store;
  }

  // The default AWS chain, again without a branch: AWS_ACCESS_KEY_ID/SECRET on
  // a server we run ourselves, AWS_PROFILE on a laptop, and the task or
  // instance role once this runs inside AWS — no key to store at all.
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const sm = new SecretsManagerClient({ region: AWS_REGION });
  _store = {
    fullName: (name) => AWS_PREFIX + name,
    setup: "docs/azure-setup.md, \"AWS Secrets Manager instead of Key Vault\"",
    denied: `the app's AWS identity needs secretsmanager:GetSecretValue on ` +
      `"${AWS_PREFIX}*" in ${AWS_REGION} (and kms:Decrypt if the secrets use their own KMS key)`,
    async get(name) {
      try {
        /* SecretString only. A secret saved as binary has none, and comes back
           undefined — which is reported as empty, not mistaken for missing. */
        const value = (await sm.send(new GetSecretValueCommand({ SecretId: AWS_PREFIX + name }))).SecretString;
        /* The AWS console's default for a new secret is "key/value pairs",
           which stores {"password":"..."} — and that whole string would be
           typed into Tramada's password box, failing the login every time
           until the account locks. Refused here, by name. */
        if (/^\s*\{/.test(value || "")) {
          let parsed = null;
          try { parsed = JSON.parse(value); } catch (_) { /* a password that starts with { */ }
          if (parsed && typeof parsed === "object") {
            throw new Error(`"${AWS_PREFIX + name}" is stored as key/value JSON. Store it as plaintext ` +
              `(Secrets Manager → the secret → Retrieve secret value → Edit → Plaintext).`);
          }
        }
        return value;
      } catch (err) {
        throw Object.assign(err, {
          notFound: err.name === "ResourceNotFoundException",
          denied: err.name === "AccessDeniedException" || err.name === "AccessDenied",
        });
      }
    },
  };
  return _store;
}

const configured = () => !!(VAULT_URL || AWS_REGION);

/** Which vault, for the boot banner. Never a value. */
function describe() {
  if (VAULT_URL && AWS_REGION) return "both Azure Key Vault and AWS Secrets Manager (misconfigured)";
  if (VAULT_URL) return `Azure Key Vault ${VAULT_URL}`;
  if (AWS_REGION) return `AWS Secrets Manager (${AWS_REGION})${AWS_PREFIX ? `, prefix "${AWS_PREFIX}"` : ""}`;
  return null;
}

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

/** The name as it is stored in the vault — `secretNameFor` plus any AWS prefix. */
function vaultNameFor(email, which) {
  return (AWS_REGION && !VAULT_URL ? AWS_PREFIX : "") + secretNameFor(email, which);
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
  const vault = store();
  if (!vault) return null;

  const base = { username: secretNameFor(email, "username"), password: secretNameFor(email, "password") };
  // What the error messages print: the name somebody has to type into the
  // console, prefix included.
  const names = { username: vault.fullName(base.username), password: vault.fullName(base.password) };
  let got;
  try {
    const [u, p] = await Promise.all([vault.get(base.username), vault.get(base.password)]);
    got = { username: u, password: p };
  } catch (err) {
    // Name the secret it looked for. "SecretNotFound" on its own sends people
    // to the wrong place — the vault is fine, the NAME is what disagrees, and
    // they cannot see the name we built from inside the portal.
    if (err && err.notFound) {
      throw new Error(
        `No Tramada credentials in the vault for ${email}. Expected two secrets: ` +
        `"${names.username}" and "${names.password}". See ${vault.setup}.`
      );
    }
    if (err && err.denied) {
      throw new Error(
        `Not allowed to read Tramada credentials from the vault: ${vault.denied}. [${err.message}]`
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

/** Tests only — the store is built once per process by design. */
function _resetForTests() { _store = null; }

module.exports = { configured, describe, slugFor, secretNameFor, vaultNameFor, credentialsFor, _resetForTests };

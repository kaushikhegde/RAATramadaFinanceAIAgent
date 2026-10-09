/**
 * tramada-creds.js against AWS Secrets Manager instead of Key Vault.
 *
 * The SDK client is replaced in require.cache with one that answers from a
 * table, so this runs offline. It records every SecretId asked for, because the
 * prefix is applied in exactly one place and a test that only checked the
 * value returned would pass with the prefix silently dropped.
 *
 * Same cases as RAATramadaPaymentAIAgent's test/test-creds.js — the two apps
 * read the same secrets for the same person, so they must agree on the names.
 */
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
async function rejects(name, p, re) {
  try { await p; ok(name, false, "did not throw"); }
  catch (err) { ok(name, re.test(err.message), `threw "${err.message}", wanted /${re.source}/`); }
}

const CREDS = path.join(__dirname, "..", "tramada-creds.js");

function freshCredsAws(region, prefix, secrets, asked = []) {
  delete require.cache[require.resolve(CREDS)];
  delete process.env.AZURE_KEYVAULT_URL;
  process.env.AWS_SECRETS_REGION = region;
  if (prefix) process.env.AWS_SECRETS_PREFIX = prefix; else delete process.env.AWS_SECRETS_PREFIX;
  const sm = require.resolve("@aws-sdk/client-secrets-manager");
  require.cache[sm] = {
    id: sm, filename: sm, loaded: true,
    exports: {
      GetSecretValueCommand: class { constructor(input) { this.input = input; } },
      SecretsManagerClient: class {
        constructor(cfg) { this.region = cfg.region; }
        async send(cmd) {
          const id = cmd.input.SecretId;
          asked.push(id);
          if (!(id in secrets)) {
            throw Object.assign(new Error("Secrets Manager can't find the specified secret."),
              { name: "ResourceNotFoundException" });
          }
          if (secrets[id] instanceof Error) throw secrets[id];
          return { SecretString: secrets[id] };
        }
      },
    },
  };
  return require(CREDS);
}

(async () => {
  console.log("\nTramada credentials from AWS Secrets Manager");
  const asked = [];
  let creds = freshCredsAws("ap-southeast-2", "raa-travel/", {
    "raa-travel/tramada-tim-raa-com-au-username": "tsmith",
    "raa-travel/tramada-tim-raa-com-au-password": "s3cret",
    "raa-travel/tramada-locked-raa-com-au-username":
      Object.assign(new Error("User is not authorized"), { name: "AccessDeniedException" }),
    "raa-travel/tramada-locked-raa-com-au-password": "x",
    "raa-travel/tramada-json-raa-com-au-username": "jsmith",
    "raa-travel/tramada-json-raa-com-au-password": '{"password":"s3cret"}',
    "raa-travel/tramada-brace-raa-com-au-username": "bsmith",
    "raa-travel/tramada-brace-raa-com-au-password": "{notjson",
    "raa-travel/tramada-blank-raa-com-au-username": "blank",
    "raa-travel/tramada-blank-raa-com-au-password": "",
  }, asked);

  ok("configured() is true with only AWS_SECRETS_REGION", creds.configured() === true);
  eq("describe() names the region and prefix, never a value", creds.describe(),
    'AWS Secrets Manager (ap-southeast-2), prefix "raa-travel/"');

  /* Moving between clouds is copying secrets across. If the names differed,
     every person's login would have to be re-keyed by hand. */
  const c = await creds.credentialsFor("Tim@RAA.com.au");
  eq("the SAME names as Key Vault, under the prefix — username", c.username, "tsmith");
  eq("...and password", c.password, "s3cret");
  eq("stamped with whose they are, lowercased", c.forEmail, "tim@raa.com.au");
  ok("the prefix was actually asked for", asked.includes("raa-travel/tramada-tim-raa-com-au-password"),
    JSON.stringify(asked));

  /* The prefix is part of the name somebody has to type into the AWS console.
     Leaving it off the message sends them to create the wrong one. */
  await rejects("a missing person names the secrets WITH the prefix",
    creds.credentialsFor("sarah@raa.com.au"), /"raa-travel\/tramada-sarah-raa-com-au-username"/);

  await rejects("an IAM denial says which permission is missing",
    creds.credentialsFor("locked@raa.com.au"), /secretsmanager:GetSecretValue.*kms:Decrypt/);
  await rejects("...and is not reported as a missing secret",
    creds.credentialsFor("locked@raa.com.au"), /^(?!No Tramada credentials)/);

  /* The AWS console's default. Typed as-is, {"password":"s3cret"} fails the
     login every time until the account locks. */
  await rejects("a secret saved as key/value JSON is refused, not typed into Tramada",
    creds.credentialsFor("json@raa.com.au"), /key\/value JSON/);

  const brace = await creds.credentialsFor("brace@raa.com.au");
  eq("...but a password that merely STARTS with { is left alone", brace.password, "{notjson");

  await rejects("an empty secret is refused, not submitted as a blank password",
    creds.credentialsFor("blank@raa.com.au"), /one of them is empty/);

  eq("vaultNameFor carries the prefix", creds.vaultNameFor("tim@raa.com.au", "password"),
    "raa-travel/tramada-tim-raa-com-au-password");

  console.log("\nno prefix");
  const bare = [];
  creds = freshCredsAws("ap-southeast-2", "", {
    "tramada-tim-raa-com-au-username": "tsmith",
    "tramada-tim-raa-com-au-password": "s3cret",
  }, bare);
  eq("names are exactly Key Vault's", (await creds.credentialsFor("tim@raa.com.au")).password, "s3cret");
  ok("nothing was prepended", bare.every((id) => id.startsWith("tramada-")), JSON.stringify(bare));

  console.log("\nboth vaults configured");
  /* Guessing would read a password out of the vault somebody believed they
     had switched away from. */
  delete require.cache[require.resolve(CREDS)];
  process.env.AZURE_KEYVAULT_URL = "https://raa-kv.vault.azure.net/";
  process.env.AWS_SECRETS_REGION = "ap-southeast-2";
  const both = require(CREDS);
  await rejects("is refused, not guessed between", both.credentialsFor("tim@raa.com.au"), /Pick one vault/);
  delete process.env.AZURE_KEYVAULT_URL;
  delete process.env.AWS_SECRETS_REGION;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });

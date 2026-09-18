# Azure setup — Entra sign-in and Key Vault

A step-by-step guide to creating the Azure things this app needs, using the
Azure Portal. No command line, no Azure experience assumed.

**This is written for a demo in your own Azure tenant** — not RAA's. You own the
directory, so you have every permission the guide needs, and you create the
demo users yourself. Where RAA's real tenant would differ, there is a note.

You are creating:

1. **An app registration** — so people can sign into this app with a Microsoft
   account. Free.
2. **Two demo users** in your directory. Free.
3. **A key vault** — where each person's Tramada username and password are
   stored, so the app can fetch them after they sign in. Costs a fraction of a
   cent per month.

At the end you will have **five values** for a `.env` file. There is a checklist
at the bottom — fill it in as you go.

> **A note on what this changes.** Once this is set up, the app types Tramada
> credentials itself instead of waiting for a human to type them. That reverses
> the standing rule in CLAUDE.md §5. It is a deliberate decision, not an
> oversight. Tramada's 2FA prompt is still answered by a person.

---

## Read these three before you click anything

Each of them is either irreversible or the reason a demo dies five minutes
before it starts.

**1. The account type in step 3 cannot be changed afterwards.** `signInAudience`
is not editable once the app registration exists — getting it wrong means
deleting it and starting again, with a new client ID and a new secret. Pick
carefully.

**2. Do not try to sign in with a personal Microsoft account.** An
`outlook.com` / `gmail.com` address is not a member of your directory, and a
single-tenant app rejects it with `AADSTS50020`. That is why step 2 creates
proper users inside the tenant. It is also closer to the real thing — RAA staff
are directory users, not personal accounts.

**3. New tenants have Security Defaults ON, which forces MFA on every user,
with no grace period.** The first time each demo user signs in they will be made
to register for MFA and will need an authenticator app on a phone. That is fine —
but do it **before** the demo, not during it. Either register each user in
advance, or turn Security Defaults off for the demo tenant (Entra ID →
Properties → Manage security defaults). Leave it **on** for anything real.

---

## Before you start

1. **An Azure account** — <https://portal.azure.com>. If you do not have one,
   sign up at <https://azure.microsoft.com/free>.

2. **A subscription with a payment method.** Unlike RAA's tenant, a personal one
   starts with nothing. Azure requires a card even on the free trial, which
   carries credit that this uses a rounding error of. See "What this costs".

3. **A phone with an authenticator app**, for the MFA registration above.

4. **Tramada sandbox credentials** — a username and password that work. You
   cannot get these from Azure; they come from Tramada, and you need them in
   hand for step 8.

---

## 1. Sign in and find your directory

1. Go to <https://portal.azure.com> and sign in.

2. Search bar → **Microsoft Entra ID**. On the Overview page, note the
   **Primary domain** — something like `yourname.onmicrosoft.com`. Every demo
   user you make will have an address ending in it.

3. Copy the **Tenant ID** from this page into the checklist at the bottom.

---

## 2. Create two demo users

Two, not one — the whole point of per-user credentials is that the app signs
into Tramada as *whoever is running it*, and with one user you cannot see that
working or failing.

For each user:

1. **Microsoft Entra ID** → **Users** → **+ New user** → **Create new user**.

2. **User principal name:** `tim` — the domain half is filled in for you, giving
   `tim@yourname.onmicrosoft.com`.
   **Display name:** `Tim Demo`.
   **Password:** tick **Auto-generate** and **copy it now**, or set your own.

3. **Review + create**.

Repeat for a second user (`sarah`). Write both addresses and passwords down —
they are what you will sign into the *app* with.

> **In RAA's tenant you skip this step entirely.** The users already exist; you
> would instead ask an admin to assign the existing staff to the app in step 5.

---

## 3. Create the app registration

1. **Microsoft Entra ID** → **App registrations** → **+ New registration**.

2. - **Name:** `Bank Reconciliation` — this is what people see on the Microsoft
     consent screen, so make it recognisable.
   - **Supported account types:** **Accounts in this organizational directory
     only (Single tenant)**. This is the choice that cannot be changed later —
     see the warnings above. Single tenant is correct: the only people who
     should reach this app are users in your directory.
   - **Redirect URI:** set the dropdown to **Web** and enter:

     ```
     http://localhost:3000/auth/callback
     ```

     `http://` is allowed **only** for localhost — Entra makes a documented
     exception for the loopback address. Any other redirect URI must be `https://`.

3. **Register**.

4. On the Overview page, copy **Application (client) ID** into the checklist.
   (Neither this nor the tenant ID is a secret — they identify the app, they do
   not grant access to it.)

### If you demo from anywhere but your own machine

**Authentication** → **Add URI** → add that address, e.g.
`https://demo.example.com/auth/callback`. Keep the localhost one so local work
still runs. **Leave "Implicit grant" and both token checkboxes unticked** — this
app uses the authorization code flow and does not need them; ticking them
weakens it.

---

## 4. Create a client secret

This is how the app proves it is itself. Treat it like a password.

1. In the app registration: **Certificates & secrets** → **Client secrets** →
   **+ New client secret**.

2. **Description:** `recon app`. **Expires:** 6 months is the safer default.

3. **Add**.

4. **Copy the `Value` column now** — not `Secret ID`, the one next to it. It is
   shown once. Navigate away and it is gone permanently and you must delete the
   secret and create another.

> When a client secret expires, sign-in stops working with an error that does not
> mention expiry, on a morning when nobody changed anything. Diarise it.

---

## 5. Restrict who can sign in

By default **anyone in the directory** can sign into the app. Small tenant, so
it hardly matters today — but it is one switch and it is the same switch RAA
would need.

1. **Microsoft Entra ID** → **Enterprise applications** → open
   `Bank Reconciliation`. (Same app — "app registration" is the definition,
   "enterprise application" is the instance people sign into.)

2. **Properties** → **Assignment required?** → **Yes** → **Save**.

3. **Users and groups** → **+ Add user/group** → add Tim and Sarah.

---

## 6. Create the key vault

1. Search bar → **Key vaults** → **+ Create**.

2. **Basics:**
   - **Subscription:** your one. An empty dropdown means the subscription has no
     payment method yet.
   - **Resource group:** **Create new** → `rg-recon-demo`.
   - **Key vault name:** globally unique across all of Azure, so try
     `kv-recon-demo-01`. Letters, numbers and dashes only.
   - **Region:** **Australia East**.
   - **Pricing tier:** **Standard**. Premium is HSM-backed *key* storage at $1
     per key per month — you are storing secrets, and do not need it.
   - **Purge protection:** **leave disabled.** It cannot be turned off once on,
     and it locks the vault name for 90 days even after deletion — so a demo
     vault would block the name you actually want later. Enable it in production.

3. **Access configuration** — the one that matters:
   - **Permission model:** **Azure role-based access control (RBAC)**.

   Do *not* pick "Vault access policy". It is the older model, Microsoft
   recommends against it for new vaults, and every step below assumes RBAC.

4. **Networking:** leave the defaults. Locking to a private endpoint is a
   sensible production step and will only get in your way now.

5. **Review + create** → **Create**.

6. Open the vault → **Overview** → copy the **Vault URI**
   (`https://kv-recon-demo-01.vault.azure.net/`) into the checklist.

---

## 7. Give yourself permission to add secrets

Creating a vault does **not** let you put anything in it. Everyone hits this: you
own the vault, and the Secrets page says you are not authorised.

1. In the vault → **Access control (IAM)** → **+ Add** → **Add role assignment**.

2. **Role:** **Key Vault Secrets Officer** — read *and write*. (Secrets *User* is
   read-only; that one is for the app, in step 9.)

3. **Members** → **User, group, or service principal** → yourself → **Select**.

4. **Review + assign**.

Wait a minute — role assignments take a moment. If the next step says
"unauthorized", wait and refresh rather than changing anything.

---

## 8. Add each user's Tramada credentials

### The naming rule — read this first

**Key Vault secret names allow only letters, numbers and dashes.** No `@`, no
dots. So `tim@yourname.onmicrosoft.com` is not a valid secret name and the portal
rejects it.

The app lowercases the address and replaces every run of non-alphanumeric
characters with one dash, then stores **two** secrets — because a Tramada
username is not an email address:

| Signed in as | Secret name | Holds |
|---|---|---|
| `tim@yourname.onmicrosoft.com` | `tramada-tim-yourname-onmicrosoft-com-username` | Tim's Tramada username |
| | `tramada-tim-yourname-onmicrosoft-com-password` | Tim's Tramada password |

Long, but well within the 127-character limit. A typo here surfaces as "no
credentials found for tim@…", not as a naming error — and the app prints the
exact name it looked for, so read the error rather than guessing.

**For the demo both users can hold the same Tramada sandbox credentials.** That
is fine and still demonstrates the mechanism: the app fetches Tim's secret when
Tim runs and Sarah's when Sarah does. If you want to *show* the identity check
working, give them different Tramada logins.

### Adding them

For each user, twice:

1. In the vault → **Objects** → **Secrets** → **+ Generate/Import**.
2. **Upload options:** Manual. **Name:** from the table. **Secret value:** the
   Tramada username, or the Tramada password. Leave the dates empty.
3. **Create**.

> When a Tramada password changes, open the secret and click **+ New Version** —
> do not delete and recreate. The app always reads the current version.

---

## 9. Give the app read access to the vault

1. In the vault → **Access control (IAM)** → **+ Add** → **Add role assignment**.
2. **Role:** **Key Vault Secrets User**. Read-only — the app has no reason to
   write and should not be able to.
3. **Members** → **User, group, or service principal** → search
   `Bank Reconciliation` → **Select**.
4. **Review + assign**.

---

## 10. Fill in the .env file

In the `.env` beside `docker-compose.yml`:

```bash
# Entra sign-in
AZURE_TENANT_ID=<Tenant ID from step 1>
AZURE_CLIENT_ID=<Application (client) ID from step 3>
AZURE_CLIENT_SECRET=<the Value from step 4>

# Key Vault
AZURE_KEYVAULT_URL=https://kv-recon-demo-01.vault.azure.net/

# Signs the login session cookie. Any long random string:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=<paste the output>
```

`.env` is already in `.gitignore`. Check that it still is — this file now holds a
secret that unlocks every Tramada password in the vault.

Start the app. The banner says whether sign-in is on; if it warns that some
variables are set and not others, sign-in is **off** and the app is open.

---

## 11. Prove it works, before the demo

In this order, because each step rules out the one before it:

1. Open <http://localhost:3000> → you should land on the **login page**, not the
   app.
2. Sign in as Tim → MFA registration, if Security Defaults are still on → the
   reconciliation screen, with `tim@…` and **Sign out** in the sidebar.
3. Start a run → it should sign into Tramada **without** asking you to, and show
   the Tramada screen only if Tramada wants a code.
4. Sign out, sign in as **Sarah**, run again → the app should sign the browser
   **out of Tim's Tramada session and into Sarah's**. That is the identity check,
   and it is the thing worth actually demonstrating.

---

## What this costs

| | |
|---|---|
| App registration, users, and sign-in | **Free** (Entra ID Free tier) |
| Key Vault Standard — storing secrets | **Free** (no per-secret charge) |
| Key Vault Standard — reading them | **$0.03 per 10,000 reads** |

Two reads per sign-in. A demo is a handful of reads — a fraction of a cent, well
inside the free-trial credit. The subscription still needs a card on file.

Not free, and not needed here: enforcing MFA through **Conditional Access** needs
**Entra ID P1**. Security Defaults gives you blanket MFA for nothing, which is
what a demo tenant should use.

---

## When it does not work

| What you see | What it means |
|---|---|
| `AADSTS50020: user account ... does not exist in tenant` | You signed in with a personal Microsoft account. Use a directory user from step 2. |
| `AADSTS50011: redirect URI does not match` | The address in the browser is not one of the redirect URIs in step 3. Must match exactly — `http` vs `https`, and the path. |
| `AADSTS7000215: Invalid client secret` | You copied **Secret ID** instead of **Value** in step 4, or it has expired. |
| `AADSTS50105: not assigned to a role` | Step 5 is on and this user is not in **Users and groups**. |
| Key Vault `Forbidden` / `403` | Step 9 missing, on the wrong vault, or not propagated yet. Wait two minutes first. |
| `No Tramada credentials in the vault for …` | The secret name does not match. The error prints the exact name it looked for — compare it with what is in the vault. |
| Portal rejects the secret name | `@` and `.` are not allowed. See step 8. |
| App opens with no login at all | Sign-in is off. Check the startup banner: a partly-filled `.env` disables it. |

---

## Checklist — the five values

- [ ] **Tenant ID** — step 1 …………………………………………………
- [ ] **Application (client) ID** — step 3 ……………………………
- [ ] **Client secret Value** — step 4 (shown once) …………
- [ ] **Vault URI** — step 6 …………………………………………………
- [ ] **Session secret** — step 10 (you generate this) ……

And in the directory: two users. And in the vault: two secrets each.

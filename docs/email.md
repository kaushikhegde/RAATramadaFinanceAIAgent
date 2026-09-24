# The DVC emails — Microsoft Graph and Resend setup

Every DVC run emails the accounts team (docs/dvc.md step 18):

- **errors found — fix and re-upload**: the spreadsheets do not reconcile, and nothing was entered in Tramada;
- **ready to issue**, or **session saved — check before issuing**: the session is saved in Tramada;
- **not entered**: the spreadsheets reconciled, but the Tramada run stopped, with the reason.

The company proxy blocks SMTP (port 587) entirely, so this project never uses
it (measured 23-09-2026). Set `MAIL_TRANSPORT=graph` (or leave it unset with
`GRAPH_CLIENT_ID` set) to send through **Microsoft Graph over HTTPS**, or
`MAIL_TRANSPORT=resend` (or leave it unset with `RESEND_API_KEY` set and no
`GRAPH_CLIENT_ID`) for **Resend over HTTPS**. Both need a network that lets
them out; neither needs SMTP. With neither configured, `mailer.send` never
throws — it returns `{ sent: false, why: "email is not configured — set …" }`,
naming exactly what is missing, and the run still reconciles and saves its
Tramada session regardless.

## The fast way: Resend

No app registration, no device sign-in — one API key. RAA's Microsoft 365
tenant is still the destination for step 18's real inbox, but Resend is the
quickest way to prove the network, the message shape and the attachment work
end to end before setting up Graph.

1. Sign up at <https://resend.com> and create an **API key** (Dashboard →
   API Keys). Free tier is enough for step 18's volume.
2. Put it in `.env`:
   ```
   RESEND_API_KEY=re_...
   DVC_EMAIL_TO=you@example.com
   ```
   Leave `MAIL_FROM` unset at first — it defaults to Resend's shared sandbox
   address `onboarding@resend.dev`, which delivers only to the address that
   owns the API key (Resend's own account holder), so nothing can be sent
   anywhere it should not be by accident. Once a sending domain is verified
   in Resend (Dashboard → Domains), set `MAIL_FROM` to an address on it and
   Resend will deliver to any recipient.
3. `npm run email:dvc` (see below) sends the fixture reconciliation to
   `DVC_EMAIL_TO` for real, over Resend.

`GRAPH_CLIENT_ID` takes precedence when both are set — Resend is the
fallback, not the override.

## One-time setup for Microsoft Graph (about five minutes)

### 1. Register an app in Microsoft Entra

1. Sign in to <https://entra.microsoft.com> (or <https://portal.azure.com> →
   *Microsoft Entra ID*) with **any** Microsoft account. A personal Outlook.com
   account works; it gets a default directory the first time.
2. **App registrations → New registration**
   - Name: `DVC reconciliation mailer`
   - Supported account types: **Personal Microsoft accounts only** for an
     Outlook.com mailbox. For RAA's Microsoft 365, choose **Accounts in this
     organizational directory only** instead.
   - Redirect URI: leave empty.
   - **Register**.
3. On the app's **Overview**, copy the **Application (client) ID**.
4. **Authentication → Advanced settings → Allow public client flows: Yes →
   Save.** Device-code sign-in needs this.
5. **API permissions → Add a permission → Microsoft Graph → Delegated →
   `Mail.Send` → Add.** (`User.Read` is there by default; leave it.) A
   personal account needs no admin consent. In an organisation, an admin
   clicks *Grant admin consent*.

### 2. Put it in `.env`

```
GRAPH_CLIENT_ID=<the Application (client) ID>
GRAPH_TENANT=consumers           # personal Outlook.com; RAA: their tenant id or domain
DVC_EMAIL_TO=cruiseControl4523@outlook.com
```

`GRAPH_CLIENT_ID` takes precedence over any `RESEND_*` settings.

### 3. Sign the mailbox in, once

```
npm run email:signin
```

It prints Microsoft's instruction: open <https://microsoft.com/devicelogin>,
enter the code, and sign in **as the mailbox the emails should come from**. The
password goes into Microsoft's page and nowhere else. The script never sees it.

The sign-in is kept in `.graph-token-cache.json` (gitignored, dockerignored,
mode 0600) and refreshes itself on every send. `npm run email:signin -- --who`
says who is signed in. Deleting the file signs the agent out.

**In Docker**, set `GRAPH_TOKEN_CACHE=/data/.graph-token-cache.json`. The
container's own filesystem is thrown away on rebuild, and `/data` is the
volume that is not.

### 4. Test it

```
npm run email:dvc
```

This reconciles the fixture files and sends that exact email to `DVC_EMAIL_TO`,
without touching Tramada. `-- --dry` prints it and sends nothing. Then restart
the server (`npm start`); `.env` is read once at start-up, and `npm run dev`
does not restart on a `.env` change.

## When it goes wrong

| the run says | meaning |
|---|---|
| `the mailbox is not signed in` | run `npm run email:signin` |
| `the saved Microsoft sign-in has expired or been revoked` | run it again: the password changed, or the refresh token was revoked |
| `Microsoft Graph refused the email (HTTP 403 …)` | `Mail.Send` is missing from the app's permissions, or not consented |
| `Microsoft Graph refused the email (HTTP 400 …)` | the message itself; the body shape is pinned in `test/test-dvc-payment.js` |
| `Resend refused the email (HTTP 401 …)` | `RESEND_API_KEY` is wrong or revoked |
| `Resend refused the email (HTTP 403 …)` | `MAIL_FROM` is not on a domain verified in Resend, and it is not the sandbox `onboarding@resend.dev` address either |
| `Resend refused the email (HTTP 422 …)` | the message itself; the body shape is pinned in `test/test-dvc-payment.js` |
| `Resend did not answer within 20 seconds` / `could not reach Resend` | the network, not the API key — Resend is plain HTTPS on 443 |
| `email is not configured — set …` | the named variables are missing from `.env` |

A lost email never fails a run. By the time it is sent, the reconciliation is
recorded and any session is saved; the run's last line says the email was not
sent, and why.

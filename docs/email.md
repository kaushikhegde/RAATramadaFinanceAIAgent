# The DVC emails — Microsoft Graph setup

Every DVC run emails the accounts team (docs/dvc.md step 18):

- **errors found — fix and re-upload**: the spreadsheets do not reconcile, and nothing was entered in Tramada;
- **ready to issue**, or **session saved — check before issuing**: the session is saved in Tramada;
- **not entered**: the spreadsheets reconciled, but the Tramada run stopped, with the reason.

## Right now: the outbox (`MAIL_TRANSPORT=outbox`)

The company proxy blocks both SMTP (port 587) and the Microsoft sign-in that
Graph needs, so from this machine **no email can leave** (measured 23-09-2026).
Every email is therefore written to the **outbox** instead:

- `outbox/<id>.eml` is the whole email, attachment included. It opens in
  Outlook.
- `outbox/<id>.json` records what happened to it: captured, sent, or failed and
  why.
- **`http://localhost:<PORT>/outbox`** on the running server lists them newest
  first. Each can be read in place, downloaded as `.eml`, or have its
  spreadsheet downloaded. The dashboard's DVC card links there after every run.

A copy lands in the outbox even when a real transport is configured and the
send works, or fails. So "did the run alert the accounts team, and what did it
say?" is always answerable from one place.

`npm run email:dvc` captures one from the fixture files; `-- --westpac … --tramada … --date …`
takes any pair. With `RECON_STORE_DIR` set (Docker), the outbox is
`$RECON_STORE_DIR/outbox`, on the volume. `MAIL_OUTBOX_DIR` overrides both.

## Later: really sending

Set `MAIL_TRANSPORT=graph` (or remove it with `GRAPH_CLIENT_ID` set) to send
through **Microsoft Graph over HTTPS**, or `MAIL_TRANSPORT=smtp` for SMTP. Both
need a network that lets them out. The rest of this page is the Graph setup.

## One-time setup (about five minutes)

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

`GRAPH_CLIENT_ID` takes precedence over any `SMTP_*` settings.

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
| `email is not configured — set …` | the named variables are missing from `.env` |

A lost email never fails a run. By the time it is sent, the reconciliation is
recorded and any session is saved; the run's last line says the email was not
sent, and why.

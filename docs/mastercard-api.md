# Mastercard API — what is actually there

Written 10 Sep 2026, from the signed-in session on developer.mastercard.com.
Nothing here is wired into the reconciliation app. It is a standalone check.

## The projects

Three on the account. Only two matter, and they are **not** interchangeable —
each has its own consumer key and its own signing key, and crossing them is a
401 with no explanation.

### Payment Sandbox — `26275c79-326f-4331-816a-573e1cee9469`

Created 11 Sep 2026. **This is the one to test against today.**

| API | Sandbox | Production |
|---|---|---|
| In Control for Commercial Payments (ICCP) | Ready | Not requested |

Key name **`testing12`**, expires 8 Oct 2027 — this is the key that pairs with
`testing12-sandbox.p12` in the repo root. No CEN on this project, so run ICCP
only (`--iccp`).

### Westpac RAA — `07a3d70a-b568-4d03-8c27-cdae8e9995ef`

The client-facing project. Nobody has its signing key.

| API | Sandbox | Production |
|---|---|---|
| In Control for Commercial Payments (ICCP) | Ready | **Not requested** |
| Commercial Event Notifications (CEN) | Ready | **Not requested** |

Key name `Westpac-RAA`, expires 3 Oct 2027. To test against this project, add a
new key on its Sandbox page — the original `.p12` was issued once at creation
and cannot be re-downloaded.

### Scyne AI — `cdc76c16-5b44-4b7b-82ad-717098fb91bd`

A different product line: Automatic Billing Updater and RPPS Biller Maintenance
and Benefit Allocations are Sandbox Ready; Account Catalog and Benefits
Eligibility are Sandbox Pending. Key name `scyne-ai`, expires 9 Oct 2027. Bundle
in `~/Downloads/MCD_Sandbox_scyne-ai_API_Keys/`.

It *can* stand in for a signing test — proving the OAuth code is correct needs
no entitlement at all, only the 401-vs-403 distinction. It proves nothing about
ICCP or about RAA.

**But do not call its APIs.** Automatic Billing Updater exists to return
refreshed card numbers; Account Catalog can carry account identifiers. That is
CLAUDE.md §4 territory. `mastercard-ping.js --url` refuses those paths by name,
before it asks for a password, and `test-mastercard-oauth.js` holds it to that.

Auth everywhere is **OAuth 1.0a, RSA-SHA256**.

## What these two APIs do

**ICCP** issues *virtual card numbers*. You submit a purchase request naming a
funding card, a supplier and spend controls; ICCP returns a one-use VCN; the
supplier charges it; you then pull an authorisations or clearings report and
reconcile against it. SOAP/XML.

**CEN** is the push half. You register a URL, create a subscription with filter
criteria, and Mastercard posts an authorisation/clearing event to you the moment
a VCN is presented. REST/JSON. Notifications are **not** generated for payments
that already happened — a subscription is forward-looking only.

Together they are the automated-reconciliation story for card payments: instead
of waiting for a settlement figure to be typed in, each payment arrives with the
booking it belongs to already attached.

## Endpoints

| | Sandbox | Production |
|---|---|---|
| ICCP financial | `https://sandbox.api.mastercard.com/iccp/financial` | `https://api.mastercard.com/iccp/financial` |
| ICCP reporting | `https://sandbox.api.mastercard.com/iccp/reporting` | `https://api.mastercard.com/iccp/reporting` |
| CEN | `https://sandbox.api.mastercard.com/commercial-event-notifications` | `https://api.mastercard.com/commercial-event-notifications` |

Reporting endpoint takes `CreateVCNAuthorizationsReport`,
`GetVCNAuthorizationsReport`, `CreateVCNClearingsReport`,
`GetVCNClearingsReport`, `GetPurchaseRequestDetail`. Everything else goes to
financial.

## State as of 10 Sep 2026

All three sandbox endpoints are **up and answering**. Hit unauthenticated, each
returns:

```json
{"Errors":{"Error":[{"ReasonCode":"INVALID_AUTH_HEADER",
  "Description":"Bad Request - No Authorization header set.",
  "Recoverable":false,"Details":null,"Source":"Gateway"}]}}
```

That is the gateway, not a proxy or a parked domain — the service is live and
the project is reachable.

## It works — 11 Sep 2026

A signed ICCP call against **Payment Sandbox** returned **HTTP 200**:

```xml
<getDataSourceResponse xmlns="http://mastercard.com/sd/pc/service">
  <dataSourceData>
    <dataSourceId>4272</dataSourceId>
    <dataSource>300840201 Purchase Control 2.0 …</dataSource>
  </dataSourceData>
</getDataSourceResponse>
```

That settles several things at once:

- OAuth 1.0a RSA-SHA256 signing in `tools/mastercard-ping.js` is correct —
  base string, `oauth_body_hash`, header format, all of it.
- The gateway accepts our consumer key / signing key pair.
- Payment Sandbox is entitled to ICCP configuration calls, which is better than
  the 403 that would still have counted as a pass.

What it does **not** settle:

- **Westpac RAA is still untested.** Different project, different key, and
  nobody has that `.p12`. This run proves the plumbing, not the client's access.
- **ICCP is not configured.** `getDataSources` is a schema lookup that answers
  before any setup exists. Real cards, purchase templates, purchase group and
  suppliers are still a Mastercard administrator's job.
- **CEN is untested.** Payment Sandbox does not carry it.

### A gap in the §4 guard, recorded honestly

`refuseCardData()` matches on the URL. ICCP is SOAP — every call goes to
`/iccp/financial` and the operation name lives in the XML body, so a URL-based
guard cannot see it. `GetRealCards` returns funding card details and would sail
straight past it.

This is theoretical today: the script only ever sends `getDataSourcesRequest`
and offers no way to choose an operation. If that changes, the guard has to
learn to read the SOAP body first.

## The other blocker: egress

Neither the cloud container nor the desktop workspace VM can reach
`sandbox.api.mastercard.com`. The container's egress proxy answers the CONNECT
with **403 — blocked by organization egress policy**, which is not something to
route around; the workspace VM has no DNS for the host at all (`EAI_AGAIN`).

So the signed call has to be run from a normal macOS terminal. Reachability was
confirmed through the browser instead, which is why the unauthenticated probes
above are screenshots of a gateway response rather than curl output.

Two further things are unfinished on Mastercard's side, and no key will fix
them:

1. **ICCP setup.** Real card numbers, purchase templates, purchase group and
   suppliers are configured by a Mastercard administrator. The docs are explicit
   that calls fail until that is done.
2. **CEN onboarding.** A subscriber record and a delivery URL that Mastercard
   can reach. We have no such URL.

So "is the API working" has two answers: the gateway is working; the RAA
integration is not yet set up behind it.

## Checking it

Run these from a normal macOS terminal, not from the Cowork workspace — see the
egress note above.

```bash
npm run mastercard:reach     # no credentials — proves the gateway answers
npm run mastercard:ping      # signed calls
npm test                     # includes the offline signing tests
```

`mastercard:ping` finds the single `.p12` in the repo root by itself and asks
for the consumer key and the keystore password at the prompt. The password is
not echoed. Nothing is written to disk and nothing lands in shell history.

Set `MC_CONSUMER_KEY`, `MC_KEY_PATH` and `MC_KEY_PASSWORD` in the environment
instead only where there is no terminal to ask at — CI, a cron job.

**The consumer key and the `.p12` must belong to the same project.** Mixing two
projects gives a 401 and the gateway does not say that is why. This has already
happened once here, with the Scyne AI key.

To prove the *signing* works even where the project has no entitlement to the
resource:

```bash
node tools/mastercard-ping.js --url https://sandbox.api.mastercard.com/iccp/financial
```

- **401** — the signature was rejected. Wrong key, wrong pairing, or clock skew.
- **403 / 404** — the signature was *accepted*; you simply have no entitlement.
  That is a pass for the signing code.

`.p12` and `.pfx` are in `.gitignore`. Keep it that way.

## The constraint this runs into

**CLAUDE.md §4 — this project never touches card data.**

ICCP is a virtual-card-issuing API. Its own documentation says PCI DSS may apply
to an ICCP integration. The two calls above stay well clear, and the signing
test is offline, but anything that submits a purchase request or reads a VCN
back does not. That is a decision to take deliberately, with RAA, before the
code exists — not something to discover afterwards.

If the goal is only *reconciliation* — matching settled card transactions to
bookings — then the clearings report and the CEN clearing event may be enough,
and the card number itself never needs to be stored. Worth establishing which of
the two this is.

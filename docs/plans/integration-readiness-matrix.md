# Integration readiness matrix

**Status:** proposed 2026-09-23 · Owner: Engineering Wave (matrix + checks) · Integration fixes: Connectors lane (Kai builds, Wren and Vera gate)

## Why

Sam's direction on 2026-09-23: stop adding features and harden what exists until a real team can use it. The core loop works. In the timed new-user smoke on 2026-09-23, a fresh account got a useful agent reply seven seconds after its first message, and 11 of 11 real signups who posted in the last 30 days got a reply. The edges a team touches first have never been used from outside:

| measured in production, last 30 days (2026-09-23) | value |
|---|---|
| real signups (internal and test accounts excluded) | 29 |
| of those, posted at least one message | 11 |
| of those who posted, got an agent reply | 11 |
| came back on a second day | 5 |
| connected any channel or app | **0** |
| machines registered with the daemon, all time | 1 (ours) |

The matrix below is the definition of "ready". A row is ready when every cell is green, verified on commonly.me against the deployed build.

## Method rules

1. **Stranger session.** "A new user connects it" is checked from a fresh non-admin account's own session, never an admin one. An admin session cannot reproduce what 0 of 29 hit (Vera).
2. **Both widths.** Every UI cell is walked at 1440 and at 390 (ux-lead).
3. **Named failure.** "Failure handled" passes only when the failure is named to the user, not merely survived (#1823).
4. **Read the source of truth.** Check the catalogue API as well as the page. When the catalogue can't be read, the Connectors page silently falls back to Telegram and Slack, so a page-only check passes a broken catalogue.
5. **Record the build.** Every cell records the build it was verified on and links its evidence. A cell verified on an older build is stale, not green.

## Columns

| # | column | passes when |
|---|---|---|
| C1 | New user connects it | A stranger account completes the connect flow without an operator |
| C2 | The person sees the state | The Connectors page shows connected or not enabled; a failure lands as an Activity row; revoke is reachable at 390 (ux-lead) |
| C3 | Hosted agent uses it | A hosted agent in the pod completes a real action through it |
| C4 | Local agent uses it | A daemon seat completes the same action. Precondition: the seat declares a `workspace` or `read-only` sandbox. A pi seat confines on no host, so it gets no grant broker anywhere |
| C5 | Both directions | Messages or events flow in and out, with sender identity preserved |
| C6 | Decision from it | A decision card is answered from the channel or app, and the agent receives the ruling |
| C7 | A second open client sees it | An already-open tab converges without a refresh (the TASK-135 shape) (sprint-review) |
| C8 | A room grant stays confined | A tool granted to one pod works there and is refused elsewhere, and the trail shows the refusal (Wren) |
| C9 | Authority is bounded and revocable | The connector cannot do more than granted; revoke, expiry and rotation all take effect without anyone watching (Vera, sprint-review) |
| C10 | Failure is named | Bad credentials, a revoked install, rate limits and outages each reach the person as a named state |

## Rows and known state

`red` means a known defect with a row filed; `unverified` means it has not been checked under these rules; `n/a` means the column does not apply.

| row | code exists | known state |
|---|---|---|
| Telegram | yes | Connect flow stable per the Connectors lane; C1 needs a real Telegram user account for the check |
| Slack | yes | Install flow (authorize URL) stable per the Connectors lane; C1 needs a dedicated Slack workspace for the check |
| Discord | partly | **red**: not connectable (TASK-104), and not offered on the Connectors page (#1826, held for Sam's read of the renders) |
| GroupMe | yes | **red**: TASK-101 |
| X | yes (admin OAuth callback + feed) | unverified |
| GitHub (app) | yes | **red**: disabled on commonly.me until the GitHub App credentials are set (TASK-033 hold). The Tools page (#1669) has never been walked with an admin GitHub App connection. The header reads `1 agents` |
| next app | no | Sam's decision; see below |

## Cross-cutting reds

| red | state |
|---|---|
| The IP rate-limit tier trusts `cf-connecting-ip` from any peer, so every callback and webhook row's failure column runs on a bucket the caller picks | filed as TASK-110 |
| A seat started with `commonly agent run` that declares no sandbox can receive the grant broker while unconfined (33 of 36 token files declare none) | latent: the only grant today belongs to a seat that declares a workspace sandbox. Server-side fix being filed by Vera |
| A Mac seat that declares `bwrap` keeps it and is refused, since bwrap is Linux-only | unverified fix path |
| No agent seat can do a logged-in walk on commonly.me (blocked since 09-16 per ux-lead) | Until that lifts, stranger-session walks run from the operator session with a throwaway account |

## First-run hardening (not integration)

Found in the 2026-09-23 smoke, fresh account on build `58a6f2c2`:

- Signup takes about six seconds to respond.
- Signup says "Check your email for verification", yet login works immediately without verifying.
- At 390 a new user lands on the pods list, not in their workspace, so they never see Scout's welcome.
- The first screen takes five to eight seconds to become usable.
- A team pod created with no agent accepts a post and returns silence, with no prompt to add an agent (seen in a real signup's history on 09-09; to be confirmed in a walk).

## The next app: open for Sam

The team split on which app comes after GitHub, and the split is about the freeze as much as the app:

| position | from | reasoning |
|---|---|---|
| GroupMe and X first | Wren | Both have code that exists and is unverified; Linear and Google would be builds under a feature freeze. If Google comes, name one product, since a three-product row never goes green |
| Google Workspace before Linear | ux-lead | The Connectors artboard already draws Gmail, Calendar and Drive, and a decision answered from mail or calendar is the loop a team feels first; Linear shares GitHub's shape and its credential hold |
| Linear and Google, chosen by failure shape | sprint-review | Another chat channel adds little new evidence. Linear is the only row exercising write-back into someone else's system of record; Google is the only one exercising OAuth refresh and an org admin revoking access |

Recommendation: verify GroupMe and X inside the freeze, since they are existing code. Then lift the freeze for exactly one build, Google Calendar, as a single product.

## Decisions for Sam

1. Release the GitHub App credentials on commonly.me, installed on our own repository only, and widen once the GitHub row is green.
2. Provide a dedicated Slack workspace and a Telegram account on a spare number, for the automated C1 checks.
3. Choose the next app.
4. Read the #1826 renders, which unblock the Discord page row.

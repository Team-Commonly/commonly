# Linear, the one new app — scope (TASK-144)

**Status:** scope, 2026-09-26. **Ruling:** Sam, 2026-09-26, relayed by connector-ops in the Connectors v2 pod (74408): Linear is the one new app build, and it starts only after Slack, GitHub and Telegram are green on the [integration readiness matrix](integration-readiness-matrix.md) on the deployed build. Its shape is GitHub's: the grant broker, room grants (C8), and revoke, expiry and rotation (C9). **Scope:** Wren (this note, TASK-144 step 1). **Build:** step 2, gated by Vera. **Blocked:** nothing here is built before those three rows are green. The note is written now so that the build starts from a reviewed shape. No Linear code exists on `main` (checked at `5561a1dd`).

The short version: **Linear is GitHub's App row with three substitutions.** The credential arrives through an OAuth flow a member starts, not an admin form. It is a 24-hour token behind a rotating refresh token, not a one-hour installation token minted from a private key. And it is the first Connection that receives as well as sends, because C6 needs the answer to come back. The grant, the broker, the tiers, the confirmation floor, approval and the trail are all reused unchanged.

In this note, `§10.x` means that section of [tools-catalogue-room-grants.md](tools-catalogue-room-grants.md), "the grants plan". This note extends it and does not restate it.

## 1. What kind of row Linear is

The grants plan's two questions from §10.0, in order:

1. **What does the row do?** An agent acts in Linear: it reads issues, opens them and comments on them. That makes it a **Connection**. It lives on the Tools page, and every rule of pieces 1–5 applies: grant, tiers, attenuation, budget, expiry, confirmation floor and trail. It is never a channel. Linear never carries a pod's messages, and its inbound half (§5) only resolves decision cards and reports revocation. It never posts chat.
2. **Whose account does Linear see?** The app's (§2). So it is the **App row** of §10.2 path 2, like `github-app`: one row per Linear workspace, `type: 'linear-app'`, owned by the member who connected it. That member is the row's only granter.

## 2. Auth model: an OAuth app in `actor=app` mode

| option | who Linear shows as the author | lifetime | revoke | verdict |
|---|---|---|---|---|
| OAuth app, `actor=app` | the app. With `createAsUser`, a write renders as "{agent} (via Commonly)" | access token 24 h; the refresh token rotates on every use | ours: `POST /oauth/revoke`. Theirs: an `OAuthApp revoked` webhook | **chosen** |
| OAuth app, `actor=user` (Linear's default) | the member who connected, so every agent write appears as that person | same | same | refused: it attributes an agent's words to a human |
| personal API key | the key's owner | expiry not stated in the docs | by hand, with no signal to us | refused: the same misattribution, no `createAsUser`, and it is a pasted secret (§10.2 path 3), never the default |
| `client_credentials` | the app, across every public team | 30 days | — | refused: it reaches only a workspace we own, so it can never pass C1, and it cannot be narrowed below every public team |

The flow is the authorization code grant with `state` and PKCE (`S256`); Linear supports both. The scopes are `read`, `issues:create` and `comments:create`, and nothing else. `write` (which can update anything) and `admin` are not requested; a tool that needs `write` comes with its own scope review (§3). The client id and secret, and the webhook signing secret, reach the backend through the `api-keys` ExternalSecret, the way Slack's signing secret does (TASK-141), and are never stored on a row.

What differs from the GitHub App row:

- **A member does the intake, not an admin.** GitHub's row comes from the admin-only `POST /api/integrations/github-app`, which is why GitHub's C1 is red by design. Linear's row comes from the OAuth callback, for whoever started the flow, so a stranger can connect their own workspace without an operator (C1). This builds the connect route family that §10.2 path 1 specifies and no provider has built yet: `GET /api/integrations/connect/:provider/start`, then Linear, then `…/callback`, with a single-use state nonce bound to the caller (the shape Slack's connect flow keeps in `config.oauthStateNonce`, `routes/installables.ts`) and rate-limited like `oauthLimiter`. Linear's agent documentation says that installing an `actor=app` app into a workspace needs admin permissions. The C1 walk confirms this; if it holds, C1's stranger is the admin of their own workspace.
- **One workspace has one owner.** `config.organizationId` identifies the row, as `installationId` identifies the App row. A repeat connect by the same member refreshes the row. A different member connecting an already-connected workspace is refused with `409 already_connected`, and nothing from that callback is stored. `createdBy` is never reassigned; otherwise a second connect would take over the granter's power to revoke.
- **Rotation is unattended (C9).** The access token lives 24 hours. Each refresh returns a new refresh token, and Linear allows a 30-minute grace period for reusing the old one. The broker refreshes behind §10.3's `refreshGeneration` fence: one refresher per generation, and the losers re-read and never mark the row. Both tokens sit behind `connectorSecrets` refs, as two new kinds in `connectorSecretKinds.ts`, one for `config.credentialRef` and one for `config.refreshTokenRef`. A ref path that module does not name is a secret the orphan sweep deletes ten minutes after it is written.
- **Either side can revoke (C9, C10).** Removing the row runs §10.5's order: revoke the grants, delete the material, then call `POST https://api.linear.app/oauth/revoke`. When a Linear admin uninstalls the app, Linear sends `OAuthApp revoked`. The row becomes `disconnected` with that reason, and the next call on any grant on it is refused with `connection_mismatch`. If the webhook is missed, the next refresh's `invalid_grant` catches it, and only the holder of the refresh generation may turn that into `status: 'error'`.

## 3. Tool surface, v1

This follows GitHub's table in §2 of the grants plan. No tool requires `write`, every write requires `write-with-confirm`, and irreversibility is a per-tool constant.

| tool | needs | irreversible? | Linear call |
|---|---|---|---|
| `linear.list_issues` | `read` | no | `issues` filtered by team, page size capped |
| `linear.get_issue` | `read` | no | `issue(id)` with its comments |
| `linear.create_issue` | `write-with-confirm` | yes: it notifies the team and the assignee | `issueCreate` |
| `linear.comment_on_issue` | `write-with-confirm` | yes: it notifies subscribers | `commentCreate` |
| `linear.ask_decision` (C6, §5) | `write-with-confirm` | yes: it is a comment | `commentCreate`, with the text rendered by the server from the card |

Not in v1: changing an issue's state (it needs `write`), projects, cycles, documents and labels.

- **Attribution.** `createAsUser` is the calling agent's display label (`agentIdentityService.resolveAgentDisplayLabel`), set by the server and never taken from an argument. Linear honours it only in `actor=app` mode. `displayIconUrl` is the agent's avatar.
- **Destination.** The approval envelope pins `organizationId`, plus `teamId` on a create, the way `pinConnectionRepository` pins `owner`/`repo` today. An approved call is refused with `workspace_mismatch` if the row points somewhere else by the time it runs.
- **Rate limits.** Linear signals a rate limit as **HTTP 400** with `RATELIMITED` in the GraphQL errors, not as 429. A status-code classifier would read it as the agent's bad argument. The tool records it as a `failed` trail row with `reason: 'provider_rate_limited'`, and the page names it (C10). The limit is 5,000 requests and 2,000,000 complexity points per hour per app user, and it is shared by every grant on one workspace. One query may cost at most 10,000 points, which is what bounds the page size.
- **Hosted runs.** They get the read tools only (`grantBrokerProjectionService.ts:180`, TASK-132's v1 limit). So C3 passes on `list_issues` and `get_issue`, while the write half of C5 and all of C6 are walked on a daemon seat (C4), unless hosted writes lift first.

## 4. How the confinement carries over

The grant, the broker's call order, the park predicate, approval, budget lineage and the `ToolCall` trail do not change. Three places hard-code GitHub today, and each widens by type, the extension §10.1 already names:

1. **The broker's types.** `ToolDefinition.connectionType` and `ToolConnection` (`toolBrokerService.ts:15–33`) accept only `'github-app'`. They become a union, and `resolveConnection` (`:443`) dispatches to a per-provider resolver that checks its own config keys (`organizationId` for Linear) and supplies the credential. The definitions move to `backend/tools/github/` and `backend/tools/linear/`, the move the grants plan's §4 reserved for the second provider.
2. **The mint.** `routes/grants.ts:310` accepts `type` in `{github-app, linear-app}` and nothing else, and copies the row's `organizationId` the way it copies `installationId` today. §10.0's boundary test lands with this change: `a channel connector row cannot be granted`, using a `telegram` row.
3. **The catalogue.** `scripts/seed-builtin-tools.ts` projects a second builtin tool Installable from the Linear definitions, so the catalogue, the mint and the broker still read one list.

C8 is then GitHub's walk again. A call from an agent outside the audience is refused with `not_in_audience`, and a call after expiry is refused with `grant_expired`; both are recorded as refused rows. The matrix's open cross-cutting row applies to Linear as it does to GitHub: the broker accepts any agent token in the audience, so withholding the broker from a seat is a convenience, not a boundary. C2 at 390 is the GitHub row's page defect, and Linear's row inherits whatever fix turns GitHub green.

## 5. C6: a decision answered from Linear

The shape is [decision-card-in-channel.md](decision-card-in-channel.md) D2–D4, with the grant in front.

- **Out.** `linear.ask_decision({ decisionId, issueId })` takes ids only. The broker refuses the call unless the card is `pending`, the caller is its asker, and its pod is one the grant covers. It renders D2's numbered-options text from the `DecisionRequest` row, never from arguments, and posts it as a comment. Because it is a comment, it parks for the granter's approval like any other. The granter approves each relay before the card reaches Linear; the walk records whether that step undoes the point of the loop. Exempting cards from the floor is Sam's call and is not assumed here. The comment id goes into the row's durable `config.cards` list (D3) as `externalMessageId`, so `decisionCardReconcileService` closes and sweeps Linear cards the way it does Telegram's and Slack's.
- **In.** A reply to that comment arrives as a Comment webhook. The webhook is configured on the OAuth app, so every workspace that authorizes gets one without the `admin` scope. The route:
  - verifies `Linear-Signature` (HMAC-SHA256 of the raw body);
  - checks that `webhookTimestamp` is within 60 seconds;
  - dedupes on `Linear-Delivery`;
  - answers 200 before doing the work, because a response slower than 5 seconds counts as failed and Linear retries it at 1 minute, 1 hour and 6 hours.

  Then it follows D3's order: the card first (the replied-to comment is in *this* row's `cards`), then the identity, then the verb.
- **The identity is the new part.** The webhook names a Linear user, but `chooseDecision` needs a Commonly human who is a member of the card's pod. D3's rule holds: the caller is a linked user, never anything derived from the message. So a member links their Linear user once, starting from Commonly, through a `read`-only `actor=user` authorization that reads `viewer { id }` and then revokes the token it used. One Linear user maps to at most one Commonly user on an instance, so a second claim on a linked Linear identity is refused. A reply from an unlinked Linear user rules nothing, and the bridge answers in Linear with the link. The call is `chooseDecision({ …, origin: { via: 'linear', integrationId } })`, and `DecisionOrigin.via` (`decisionRequestService.ts:72`) gains `'linear'`.
- **Answers in Linear** are D3 and D4's lines, verbatim: `✓ Ruled`, `Already ruled …`, and the verb-outcome table. The bridge posts them as the app, in its own voice rather than an agent's, as a reply to the card comment.

Linear's own agent-session `select` elicitation is the native form of this card. It is left for later: it needs `app:mentionable`, a session per issue and a 10-second acknowledgement contract on the inbound side, and it buys nothing C6 needs that a reply to a comment does not.

## 6. Order, once the three rows are green

| # | piece | proves |
|---|---|---|
| 1 | The provider seam (§4.1–4.2). The definitions move, `ToolConnection` becomes a union, and the mint accepts by set. GitHub's tests pass unchanged | a second provider breaks nothing |
| 2 | Connect and remove (§2): the OAuth route family, the `linear-app` row, the two secret kinds, the refresh fence, the removal order and the `OAuthApp revoked` webhook | C1, C2, C9 and C10, up to the first call |
| 3 | The tools (§3) and the second builtin Installable | C3 (reads, hosted), C4 and C8 |
| 4 | C6 (§5): `ask_decision`, the comment webhook and the identity link | C5 and C6 |
| 5 | The matrix walk: stranger session, 1200 and 390, deployed build | the row |

Named tests, which the PRs list by name:

1. `the mint accepts a linear-app row and refuses a channel row`
2. `a second member connecting a connected Linear workspace is refused and nothing is stored`
3. `two concurrent refreshes rotate once`: the loser neither marks the row nor revokes anything
4. `OAuthApp revoked disconnects the row, and the next call on its grant is refused`
5. `a RATELIMITED 400 is recorded as provider_rate_limited`
6. `createAsUser is the calling agent, whatever the arguments say`
7. `an approved call is refused when the row's organizationId changed`
8. `ask_decision refuses a card from another asker or from a pod the grant does not cover`
9. `a webhook with a bad signature, a stale timestamp or a replayed delivery writes nothing`
10. `a reply from an unlinked Linear user rules nothing`
11. `never returns the credential` over a `linear-app` connection, and `no integration response carries a credential` with both refs set

## 7. What Sam provides, and what is open

- **From Sam: a Linear workspace for the walks, and the OAuth app registered in it.** Linear recommends a dedicated workspace for managing an app. The client id, client secret and webhook signing secret go into GCP SM. This is the same kind of ask as the Slack workspace and the Telegram account.
- **Open, for the build to measure before building on it:**
  - whether the Comment webhook carries `parentId` (the documented example does not show it; the resolver can read `comment(id) { parent { id } }` instead);
  - whether an app-level webhook's signing secret is per app or per workspace;
  - whether `Linear-Delivery` stays stable across a retry;
  - whether a second authorization of an already-connected workspace changes the first connection's tokens;
  - whether one app can authorize in both actor modes without the user-mode revoke touching the app-mode install.

Sources, read 2026-09-26 from Linear's developer documentation: OAuth 2.0 authentication, OAuth actor authorization, webhooks, rate limiting, agents, agent interaction, and agent signals (`linear.app/developers/…`).

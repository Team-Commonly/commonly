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
2. **Both widths.** Every UI cell is walked at 1200 and at 390, the evidence widths Sam set (68655), as ux-lead asked. `signal-identity.md` still says 1440; reconciling the two is Sam's call.
3. **Named failure.** "Failure handled" passes only when the failure is named to the user, not merely survived (#1823).
4. **Read the source of truth.** Check the catalogue API as well as the page. When the catalogue can't be read, the Connectors page silently falls back to Telegram and Slack, so a page-only check passes a broken catalogue.
5. **Record the build.** Every cell records the build it was verified on and links its evidence. A cell verified on an older build is stale, not green.

## Columns

| # | column | passes when |
|---|---|---|
| C0 | Offered on commonly.me | The row appears to a stranger on the deployed instance. Offering (the seeded roster) and readiness (the capability) are separate gates the page hides, so a row that is never offered is red here, not in C1 (Kai; TASK-024) |
| C1 | New user connects it | A stranger account completes the connect flow without an operator |
| C2 | The person sees the state | The Connectors page shows connected or not enabled; a failure lands as an Activity row; revoke is reachable at 390 (ux-lead) |
| C3 | Hosted agent uses it | A hosted agent in the pod completes a real action through it |
| C4 | Local agent uses it | A daemon seat completes the same action, running the build the deploy shipped (a stale daemon seat reads green and isn't; TASK-089). Precondition: a claude or codex seat declares `trust: 'public'`, with the mode optional, since it resolves at spawn to Seatbelt on macOS and bwrap elsewhere. A daemon seat with no sandbox block is derived to `trust: 'public'` by the seat baseline, so it reads confined. Only a hand-authored record run with `commonly agent run` and no block defaults to mode `none`, which is the unconfined case (Wren). A pi seat confines on no host, so it gets no grant broker anywhere (sprint-review) |
| C5 | Both directions, and silence is explained | Messages or events flow in and out with sender identity preserved, and when nothing flows the person can see why. A refused model route read as silence until #1827 and #1831 (Kai) |
| C6 | Decision from it | A decision card is answered from the channel or app, and the agent receives the ruling |
| C7 | A second open client sees it | An already-open tab converges without a refresh (the TASK-135 shape) (sprint-review) |
| C8 | A room grant stays confined | A tool granted to one pod works there and is refused elsewhere, and the trail shows the refusal (Wren) |
| C9 | Authority is bounded and revocable | The connector cannot do more than granted; revoke, expiry and rotation all take effect without anyone watching (Vera, sprint-review) |
| C10 | Failure is named | Bad credentials, a revoked install, rate limits, outages, a refused model route, and the consecutive-run cascade cap each reach the person as a named state. The cascade cap refuses posts by design and otherwise looks like a broken channel (Kai) |

## Rows and known state

`red` means a known defect with a row filed; `unverified` means it has not been checked under these rules; `n/a` means the column does not apply.

| row | code exists | known state |
|---|---|---|
| Telegram | yes | Walked 2026-09-25 (below). Bind and inbound green on a simulated chat; **red** in C5/C10: a failed delivery back to the chat is only logged, so the connector keeps saying connected while replies vanish (Row D). C1 with a real account still needs one |
| Slack | yes | Walked 2026-09-25 (below). **Was red for everyone** in C1: every new install was refused at Authorize in Slack from #1537 on, the "stable" note here was wrong. Fixed by #1875; the page still names nothing after a refused authorize (Row C). The OAuth leg needs a Slack workspace |
| Discord | partly | **red** in C0: not offered on the Connectors page (#1826, held for Sam's read of the renders). **red** in C1: not connectable (TASK-104). Two different fixes |
| GroupMe | yes | **red**: TASK-101 |
| X | yes (admin OAuth callback + feed) | unverified |
| GitHub (app) | yes | Walked 2026-09-25 (below). Live on our own repository since 09-18. **red** in C1 (a team cannot connect its own repository until per-person GitHub), C2 at 390 (the row hides its reason), and C3 (no hosted runtime receives the broker). C8 green |
| next app | no | Sam's decision; see below |

## Walk of 2026-09-25

Stranger account `eng-smoke-09255bfe` (role user), builds `9a32fca5`, `0e142135` and `f536fa11`. Evidence: `docs/design/evidence/slack-authorize-409/` and the rows filed in the Connectors lane.

**GitHub.** One connection (the instance admin's, on `Team-Commonly/commonly`) and one room grant, which expired 2026-09-25 11:32Z. Only the connection's owner can grant, so since it lapsed no agent on commonly.me can use GitHub until the owner grants again.

| cell | result |
|---|---|
| C0 | green. The catalogue lists `github` as available with its tools; the Tools row renders at 1200 and 390 with no horizontal overflow |
| C1 | red by design until per-person GitHub. Creating the connection is admin-only, yet the catalogue says available and each tool's description names "the Commonly repository", which a stranger reads as usable |
| C2 | red at 390. The row's only reason ("install the GitHub App first") is hidden below 760 px, since the row is not classed not-enabled (`v2.css`), so a phone shows "not granted" with no reason and no action |
| C3 | red by construction. No hosted runtime receives the grant broker; only the daemon's assignment route projects it |
| C4 | not verified on the shipped build, and now unverifiable until someone grants again. The host ran cli 0.1.64 against a published 0.1.74 until this walk (upgraded to 0.1.74 at 08:01Z). The C4 pod is invite-only, and no member asked the seat before the grant lapsed |
| C8 | green. An agent outside the grant's audience called it and got `not_in_audience`, recorded as a refused row in `tool_calls` |
| C9 | expiry green; revoke and rotation not walked. The same out-of-audience call made at 11:33:39Z, after the grant's 11:32:51Z expiry, got `grant_expired` with no one acting, recorded as a refused row. Expiry is checked before audience, so this shows the expiry itself |

**Slack.** Add, then Connect, installs the connector, and the row offers Authorize in Slack. Pressing it returned `409 slack_already_authorized` for every new install: `config.pendingBind` is a nested schema path, so a hydrated document carries it as `{}` and the route read it by truthiness. The route tests mocked the model with plain objects, where an absent key is absent, so they could not see it. #1875 judges a bind by the secret reference the callback always writes and tests the routes through a hydrated document. Re-walked on `f536fa11` at 1200 and 390: Authorize now opens `slack.com/oauth/v2/authorize` with a client id, our callback, a state and the DM scopes, and a forged callback is refused with `invalid_state`. Before the fix, after the 409 the page names nothing at either width (C10 red, Row C).

**Telegram.** The bot's webhook points at the API, with nothing pending and no recorded error. Add, then Connect, shows `/commonly-enable` with a code that expires in 10 minutes. A simulated private chat, posted inside the cluster so the webhook secret never left it, bound with the code; a message from it landed in the pod as the linked user, and Scout answered in 6 seconds. The bot's confirmation and Scout's relayed reply both failed with `400 chat not found`, which the sender logs and returns and nothing reads: the connector stayed connected with no error (C5 and C10 red, Row D). A real user who blocks the bot gets the same silence. The simulated connector was removed afterwards.

## Re-walk of 2026-09-26 on `5561a1dd`

Fresh stranger account, created 2026-09-25 through the ordinary signup, with no prior connectors. At 1200 and 390, the Connectors page shows no horizontal overflow and no failed API call.

| row | result on this build |
|---|---|
| Slack | C0 green. C1 green up to the external boundary: Add, then Connect, installs; Authorize in Slack opens `slack.com/oauth/v2/authorize` with a client id, our callback, a state and the DM scopes. The OAuth leg waits on Sam's workspace |
| Telegram | C0 green. C1 green up to the code: Connect shows `/commonly-enable` with a 10-minute code. A simulated private chat binds with the code, and its dead-chat confirmation turns the connector into a named failure ("Telegram stopped delivering: this chat no longer exists."), shown on the row with New code (C10 for this case). With #1878 live, a simulated chat now fails at its first send, so inbound and sender identity (C5) were last shown on `0e142135`, before that fix. Re-showing them needs a real chat |
| GitHub | C0 green. C2 green at 390: the row shows its reason, and its copy names the instance's own repository. C3, C4 and C8 wait on a new grant; the only grant lapsed 2026-09-25 11:32Z |

## Cross-cutting reds

| red | state |
|---|---|
| The IP rate-limit tier trusts `cf-connecting-ip` from any peer, so every callback and webhook row's failure column runs on a bucket the caller picks | filed as TASK-110 |
| A seat started with `commonly agent run` that declares no sandbox can receive the grant broker while unconfined (31 claude and codex seats; 33 of 36 token files declare no sandbox, two of which are pi and refused server-side anyway) | latent: the only grant today belongs to a seat that declares a workspace sandbox. TASK-111: the server hands out the broker only through the daemon's assignment route, so the gap is a hand-authored record run with `commonly agent run`; the fix is the same withholding guard at that spawn site, cli-side (Wren, with Vera concurring) |
| Withholding the broker from a seat is a convenience, not a boundary: `POST /api/mcp/grants/:grantId` accepts any agent token in the grant's audience. If confinement is meant to gate use of a granter's authority, that is a wider row than TASK-111 | open; Wren to scope (Vera) |
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
| Linear, then Google Workspace, then email over IMAP | Kai | Linear is the cheapest real exercise of C6; Google is the hardest C1 (OAuth consent plus a domain install); email stresses C5 without an app API |

Recommendation: verify GroupMe and X inside the freeze, since they are existing code. Then lift the freeze for exactly one build, Google Calendar, as a single product.

## Decisions for Sam

1. Release the GitHub App credentials on commonly.me, installed on our own repository only, and widen once the GitHub row is green. **Done:** live on our repository since 09-18. The only room grant lapsed 2026-09-25 11:32Z, and a new grant from the connection's owner is what C3 and C4 now wait on.
2. Provide a dedicated Slack workspace and a Telegram account on a spare number, for the automated C1 checks. **Ruled 2026-09-26:** the test accounts are set up by Sam in his own browser. Agents do not create accounts or enter credentials, so C1 with a real account waits on those sign-ins.
3. Choose the next app. **Ruled 2026-09-26:** Linear, one build only, and only after Slack, GitHub and Telegram are green. No Linear code exists on main, so Wren scopes it first.
4. Read the #1826 renders, which unblock the Discord page row. Open.

**Goal scope, ruled 2026-09-26:** drive Slack, GitHub and Telegram to green across C0–C10 first. GroupMe and Discord come after them; X and Instagram are deprioritised.

The three 2026-09-26 rulings were given in the Connectors session and recorded here from its relay.

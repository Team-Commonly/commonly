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
| Telegram | yes | Re-walked live 2026-09-27 on `c941626b` with a real account (below). **C1 green**: the code typed exactly as the page shows it, spaces and a capitalised group included, binds on the first try (#1931 TASK-153, #1932 TASK-157); on `7ccc6ac2` the same form was refused. **More than one pod, green outbound**: a second pod switched on under "Pods that reach this channel" relayed its agent's line to the chat within the minute, and a line typed in the chat went only to the active pod, as the connector is built (one private chat binds one Commonly user, pods behind it as gates; TASK-154, ruled by Wren). **C3 green** (an agent line relayed) and **C5 inbound green** with sender identity ("Sam Xu (via Telegram)"). C10 green: both refusals are named, and since #1878 a dead chat is a named failure. Shipped since the re-walk: relayed lines now carry their pod's name (#1935, TASK-156; seen live on `19d1d3e2` as "[Connector walk 0926] Scout: PONG-TAG"), and a quote-reply routes to the quoted line's pod or is refused by name (#1935; unit-witnessed, not walked live). The catalogue row names the multi-pod model (#1957, TASK-158) |
| Slack | yes | Walked live 2026-09-26/27 on `7ccc6ac2` with a real workspace (below). **C1, C3 and C5 green**: connect through consent, callback and confirm; a hosted agent's reply relays to Slack; a Slack mention reaches the agent and its answer comes back. C5 inbound was green only after two Slack app settings were fixed during the walk. Red for customers until the app was publicly distributed, which is now done, and the distribution attestation is now true of the running backend: #1929 (TASK-151) removed every `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` read and injection, live on `f5eb5563`. A second authorize on a connected row is refused with 409 `slack_already_authorized` (measured through the API); the refusal copy on the page (#1890, Row C) is still unwalked in the UI. Before #1875 (09-04 to 09-25), every new install was refused at Authorize |
| Discord | partly | **C0 listed, not offered**: #1826 (Sam approved 2026-09-29) gives Discord its own row, live since `96cc9711` (2026-09-29 12:11Z). `/api/installables` returns `discord` under `channels` with `available: true, offered: false`. `offered` is the roster decision (`installableCatalogService.ts` `offeredByRoster`: an active builtin Installable row exists), and commonly.me has no `discord` Installable row, so it is not offered. `available` is the manifest readiness (`manifests.ts`: missing required keys would make it `false`), and it reads `true`. A stranger sees "Not enabled on this instance · ask your operator" rather than a merged "not yet" row. **red** in C1: not connectable (TASK-104) |
| GroupMe | yes | **red**: TASK-101 |
| X | yes (admin OAuth callback + feed) | unverified |
| GitHub (app) | yes | Walked 2026-09-25 and re-walked 2026-09-26 on `5561a1dd` (both below). Live on our own repository since 09-18. **red** in C1 until per-person GitHub: a team cannot connect its own repository. C2 at 390 is green since #1874, shown on `5561a1dd`. C3 (a hosted agent gets the broker, #1880) shipped and has not been walked. C8 was green on `9a32fca5`. A new grant from the connection's owner, `grant_3c4d6ad5` (2026-09-29, on Sam's approval), has the same scope as the lapsed 09-18 one: pod "C4 run 2026-09-18"; `list_issues`, `create_issue` and `close_issue`; write-with-confirm; audience Sam, `c3stranger0912` and `c4-smoke`. It runs to 2026-10-06, so C3, C4 and C8 are walkable again. None has been walked on the current build |
| Hosted MCP (generic type, TASK-172) | no entry yet | **Steps 1–6 live, step 7 open, nothing offered.** Steps 1–6 of `hosted-mcp-connection-scope.md` §10 are live on `e96bb8f4` (backend started 2026-09-30 06:41:43Z); step 7, the first entry with its live walk and revocation check, remains open: the connection row (#1976); catalogue entry, projection and drift (#1993, #2014, #2023); intake with browser-bound OAuth and rate-limited public routes (#1995, #1999, #2006, #2007); credential and refresh fence (#2001, #2004, #2009); mint and broker (#2002, #2005, #2010); the owner-credential trail (#2028); the banned/missing/bot-owner refusal (#2029, TASK-181); and removal: the sequence (#2035, step 6a), then step 6b (#2047): the admin account delete refuses 409 `hosted_mcp_connection_owned` while the person owns any hosted row (the code is present in the live `admin/users` build; the behaviour is proven by the service arms, not walked), TASK-147's witnesses on the other row-removing paths (the integration `PATCH` refuses a hosted row by its kind; pod delete, the legacy Discord uninstall, the installable reconciler and admin pause each leave it alone; the sweep tripwire says it cannot trace the writer while the catalogue is empty), the entry's revoke page copied onto the row so a removal can finish after the entry leaves the catalogue, and the revoked-at-vendor mark declared on the model so it persists (#2035's first version dropped it silently). The catalogue is empty, so no vendor is reachable: an unknown entry's callback redirects to the Connectors page with `unknown_entry`, verified on the live build. **First entry is open for Sam:** Linear qualifies only if its authenticated `tools/list` carries `readOnlyHint` (Wren's ruling: no hint, no entry), and that needs one real Linear OAuth. Sentry qualifies by construction, since its source requires all three hints. Vera gates the entry, and C0–C10 are walked once end to end on it |
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

Fresh stranger account `eng-smoke-20ba7c6d`, created 2026-09-25 through the ordinary signup, with no prior connectors. The backend pod on `5561a1dd` started 2026-09-26 12:40:39Z; the page walk ran 12:43:51Z to 12:44:16Z and the Telegram simulation right after it, all on that one pod. "Green to the external boundary" means every step on our side passed and the remaining step happens in the other service. It is not green, and it must keep a distinct mark when it is transcribed into the table above. At 1200 and 390, the Connectors page shows no horizontal overflow and no failed API call.

| row | result on this build |
|---|---|
| Slack | C0 green. C1 green up to the external boundary: Add, then Connect, installs; Authorize in Slack opens `slack.com/oauth/v2/authorize` with a client id, our callback, a state and the DM scopes. The OAuth leg waits on Sam's workspace |
| Telegram | C0 green. C1 green up to the code: Connect shows `/commonly-enable` with a 10-minute code. A simulated private chat binds with the code, and its dead-chat confirmation turns the connector into a named failure ("Telegram stopped delivering: this chat no longer exists."), shown on the row with New code (C10 for this case). With #1878 live, a simulated chat now fails at its first send, so inbound and sender identity (C5) were last shown on `0e142135`, before that fix. Re-showing them needs a real chat |
| GitHub | C0 green. C2 green at 390: the row shows its reason, and its copy names the instance's own repository. C3, C4 and C8 wait on a new grant; the only grant lapsed 2026-09-25 11:32Z |

## Live Slack walk, 2026-09-26/27 on `7ccc6ac2`

Walked by the Connectors session with Sam's real Commonly Slack workspace (Sam's choice), with `lily-shen` on the Commonly side, in a throwaway pod "Connector walk 0926". Part 1 ran 2026-09-26 23:35Z to 23:50Z (16:35 to 16:50 PDT); part 2, with Scout hired into the pod, ran 2026-09-27 00:00Z to 00:10Z. The room post in the Connectors pod carries the detail.

| cell | result |
|---|---|
| C1 | green live: Authorize, Slack's consent screen, the callback, and confirm in Commonly |
| C1 for customers | was red: the Slack app was "Not distributed", so only its own workspace could install it. Public distribution is now activated. The `SLACK_BOT_TOKEN` fallbacks that distribution's attestation rules out are gone: #1929 (TASK-151), live on `f5eb5563`, where the running backend's env and the ESO-rendered `api-keys` secret carry no Slack bot or app token, every stored connector secret still decrypts, and the bound row still relays |
| C5 outbound | green |
| C5 inbound | was red, from two Slack app settings, not code: the App Home messages tab was unticked, and the Events Request URL was unverified. Both were fixed in the app settings with Sam's OK, and a DM now lands in the pod |
| C3 | green: with Scout hired into the test pod, its intro relayed to Slack |
| C5 both ways | green: "@scout … PONG" sent from Slack came back as "[Connector walk 0926] Scout: PONG" within about a minute |
| second authorize | green, measured: at about 2026-09-27 00:05Z, `POST /api/installables/slack/authorize-url` from the page's own session on the connected row returned 409 `slack_already_authorized` (Connectors room, message 74576). A connected row refuses a second authorize by design. #1890's refused-authorize copy (Row C) is still unwalked in the UI; the 409 was observed through the API, so no refusal copy was rendered |

The two C5 settings live in Slack's app configuration, which no test here can see. A new instance's operator has to set them too, so the Slack setup docs must name them.

## Live Telegram walk, 2026-09-27 on `7ccc6ac2`

Walked by the Connectors session with Sam's real Telegram account, 2026-09-27 00:00Z to 00:10Z, in the same session as part 2 of the Slack walk (the Slack C3 and C5 rows above).

| cell | result |
|---|---|
| C1 | red: the page displays the code grouped with spaces, and the bot reads only the first word after `/commonly-enable`, so typing the command exactly as shown fails. Reproduced live; TASK-153. **Fixed** by #1931 and #1932; green in the re-walk below |
| C1, more than one pod | not walked here; **green in the re-walk below**. The walk hit a legacy row on the same chat: Sam's Aug-27 Rewire Live Demo binding, from before connectors were installable (#1527), so the test pod could not bind. The chat claim is unconditional (`webhooks/telegram.ts:135-148`): one private chat holds one active Telegram row, because everything typed there is authored as its owner. On the installable, user-scoped row that one chat still reaches N pods. Outbound relays from every pod whose gate is on (`config.gates.<podId>.enabled`, `services/installable/eventHandlers.ts:59`). Inbound goes to the single active pod (`podId`), which the owner moves with the same owner-only PATCH that writes the gates (`routes/integrations.ts`). The switches are the connector's "Pods that reach this channel" list; that surface is ADR-025 D17 (ruled), and D8 is still Proposed. Wren ruled the scope on TASK-154. Pod tags on lines and quote-reply routing across pods are TASK-156 |
| C10 | green: both refusals seen in the walk are named to the person |
| UI | TASK-155: the Telegram Add button, and the pod picker defaulting to an agent room. **Fixed** by #1933, live on `9a6253fc`: the panel owns the add form, selecting a row closes it, the picker takes focus (so at 390 it scrolls into view) and defaults to a team pod, and the bound-pod refusal points at the gate switches |

## Telegram re-walk, 2026-09-27 on `c941626b`

Walked by the Connectors session, 2026-09-27 02:43Z to 02:47Z, with `lily-shen` on the Commonly side and Sam's real Telegram account in a private chat with the bot, the same pairing as the Slack walk. Sam first removed his Aug-27 legacy row, which frees the chat claim. Backend and frontend both ran `c941626b`.

| cell | result |
|---|---|
| C1 | green live: a fresh code on the installable connector, sent exactly as displayed with its spaces and a capitalised first group (`/commonly-enable ABE3 b80f …`), bound on the first try ("Connected this chat to Connector walk 0926") |
| C1, more than one pod | green outbound. With "Scout (Default)" switched on under "Pods that reach this channel" alongside the active pod, Scout's reply there reached the chat as "Scout (Default): PONG-GATE" with an "open in Commonly" link, within the minute. A second bind is not the test, because the chat claim always refuses one; a second gate is (Vera) |
| inbound routing | as built: a plain line typed in the chat landed only in the active pod, as "Sam Xu (via Telegram)", authored by the connector's owner, and not in the second gated pod |
| C3 | green: an agent's line in a gated pod relayed to the chat |
| C5 inbound | green, with sender identity preserved |
| pod tags and quote-reply routing | shipped after the walk (#1935, TASK-156). Pod tags seen live on `19d1d3e2`; quote-reply routing is unit-witnessed and not yet walked live |

The test gate on "Scout (Default)" was switched back off after the walk. On Sam's word (2026-09-27 ~10:30Z) the test binding on "Connector walk 0926" was then removed, so the chat is free: Sam's Rewire Live Demo pod relays nothing until he binds it from his own account. **Restored 2026-09-29** on Sam's approval: his existing Aug-26 pod-scoped row was reactivated (`isActive: true`; `liveRelay` was already on), not re-bound with a new code. It is the only active row on that chat, and the outbound selector picks it for Rewire Live Demo. The walk row stays inactive.

**Membership, hardened across every connector write path (2026-09-27).** A connector now writes only where its owner is a listed pod member, the same rule `createMessage` uses (`isListedPodMember`): relay, inbound, the gate PATCH, install, bind confirm and the gate reconciler (#1940, TASK-161). A pod's creator cannot leave it (#1945, TASK-166), so `createdBy` no longer stands in for membership; the Discord/Slack owner routes follow (#1946, TASK-168); `agent-admin` pods are not a gate target (#1954, TASK-171); the PG chat path reads Mongo membership rather than its own mirror (#1942, TASK-162); and a seat whose own declaration cannot confine a broker is refused at the broker call — every dispatch except the native runtime's in-process one, which is exempt because a hosted turn has no shell, web or file tool to confine (#1971, TASK-175, ruled by Wren). This bears on C9 (authority is bounded) for every channel row above.

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

1. Release the GitHub App credentials on commonly.me, installed on our own repository only, and widen once the GitHub row is green. **Done:** live on our repository since 09-18. The 09-18 room grant lapsed 2026-09-25 11:32Z. **Renewed 2026-09-29** on Sam's approval: `grant_3c4d6ad5`, the same scope, runs to 2026-10-06 (see the GitHub row). C3 and C4 now wait on the walk, not on a grant.
2. Provide a dedicated Slack workspace and a Telegram account on a spare number, for the automated C1 checks. **Ruled 2026-09-26:** the test accounts are set up by Sam in his own browser. Agents do not create accounts or enter credentials, so C1 with a real account waits on those sign-ins.
3. Choose the next app. **Ruled 2026-09-26:** Linear, one build only, and only after Slack, GitHub and Telegram are green. No Linear code exists on main, so Wren scopes it first. **Re-ruled 2026-09-27 (74820):** "Start now, Linear first", as the first entry of the `hosted-mcp` type, with no wait on those three rows ([hosted-mcp-connection-scope.md](hosted-mcp-connection-scope.md)). That type has no inbound path, so it does not exercise C6.
4. Read the #1826 renders, which unblock the Discord page row. **Done 2026-09-29:** approved, merged as `96cc9711` and live; see the Discord row.

**Goal scope, ruled 2026-09-26:** drive Slack, GitHub and Telegram to green across C0–C10 first. GroupMe and Discord come after them; X and Instagram are deprioritised.

The three 2026-09-26 rulings were given in the Connectors session and recorded here from its relay.

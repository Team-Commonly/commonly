# Integration readiness matrix

**Status:** proposed 2026-09-23 · Owner: Engineering Wave (matrix + checks) · Integration fixes: Connectors lane

## Why

Direction on 2026-09-23: stop adding features and harden what exists until a real team can use it. The core loop works. In the timed new-user smoke on 2026-09-23, a fresh account got a useful agent reply seven seconds after its first message, and 11 of 11 real signups who posted in the last 30 days got a reply. The edges a team touches first have never been used from outside:

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

1. **Stranger session.** "A new user connects it" is checked from a fresh non-admin account's own session, never an admin one. An admin session cannot reproduce what 0 of 29 hit.
2. **Both widths.** Every UI cell is walked at 1200 and at 390, the agreed evidence widths (68655), as ux-lead asked. `signal-identity.md` still says 1440; reconciling the two is open.
3. **Named failure.** "Failure handled" passes only when the failure is named to the user, not merely survived (#1823).
4. **Read the source of truth.** Check the catalogue API as well as the page. When the catalogue can't be read, the Connectors page silently falls back to Telegram and Slack, so a page-only check passes a broken catalogue.
5. **Record the build.** Every cell records the build it was verified on and links its evidence. A cell verified on an older build is stale, not green.

## Columns

| # | column | passes when |
|---|---|---|
| C0 | Offered on commonly.me | The row appears to a stranger on the deployed instance. Offering (the seeded roster) and readiness (the capability) are separate gates the page hides, so a row that is never offered is red here, not in C1 (Kai; TASK-024) |
| C1 | New user connects it | A stranger account completes the connect flow without an operator |
| C2 | The person sees the state | The Connectors page shows connected or not enabled; a failure lands as an Activity row; revoke is reachable at 390 (ux-lead) |
| C3 | Hosted agent uses it | A hosted agent in the pod completes a real action through it. For a grant source, the walk's pod must pass §12's pod rule in `hosted-mcp-connection-scope.md` (#2211) |
| C4 | Local agent uses it | A daemon seat completes the same action, running the build the deploy shipped (a stale daemon seat reads green and isn't; TASK-089). Precondition: a claude or codex seat declares `trust: 'public'`, with the mode optional, since it resolves at spawn to Seatbelt on macOS and bwrap elsewhere. A daemon seat with no sandbox block is derived to `trust: 'public'` by the seat baseline, so it reads confined. Only a hand-authored record run with `commonly agent run` and no block defaults to mode `none`, which is the unconfined case. A pi seat confines on no host, so it gets no grant broker anywhere (sprint-review). **Refused by design for every grant source until TASK-213**, from #2211: §12's pod rule in `hosted-mcp-connection-scope.md` refuses a seat grant, and a pod grant in a pod with a daemon seat in it |
| C5 | Both directions, and silence is explained | Messages or events flow in and out with sender identity preserved, and when nothing flows the person can see why. A refused model route read as silence until #1827 and #1831 (Kai) |
| C6 | Decision from it | A decision card is answered from the channel or app, and the agent receives the ruling |
| C7 | A second open client sees it | An already-open tab converges without a refresh (the TASK-135 shape) (sprint-review) |
| C8 | A room grant stays confined | A tool granted to one pod works there and is refused elsewhere, and the trail shows the refusal |
| C9 | Authority is bounded and revocable | The connector cannot do more than granted; revoke, expiry and rotation all take effect without anyone watching |
| C10 | Failure is named | Bad credentials, a revoked install, rate limits, outages, a refused model route, and the consecutive-run cascade cap each reach the person as a named state. The cascade cap refuses posts by design and otherwise looks like a broken channel (Kai) |

## Rows and known state

`red` means a known defect with a row filed; `unverified` means it has not been checked under these rules; `n/a` means the column does not apply.

| row | code exists | known state |
|---|---|---|
| Telegram | yes | Re-walked live 2026-09-27 on `c941626b` with a real account (below). **C1 green**: the code typed exactly as the page shows it, spaces and a capitalised group included, binds on the first try (#1931 TASK-153, #1932 TASK-157); on `7ccc6ac2` the same form was refused. **More than one pod, green outbound**: a second pod switched on under "Pods that reach this channel" relayed its agent's line to the chat within the minute, and a line typed in the chat went only to the active pod, as the connector is built (one private chat binds one Commonly user, pods behind it as gates; TASK-154). **C3 green** (an agent line relayed) and **C5 inbound green** with sender identity ("<name> (via Telegram)"). C10 green: both refusals are named, and since #1878 a dead chat is a named failure. Shipped since the re-walk: relayed lines now carry their pod's name (#1935, TASK-156; seen live on `19d1d3e2` as "[Connector walk 0926] Scout: PONG-TAG"), and a quote-reply routes to the quoted line's pod or is refused by name (#1935; unit-witnessed, not walked live). The catalogue row names the multi-pod model (#1957, TASK-158) |
| Slack | yes | Walked live 2026-09-26/27 on `7ccc6ac2` with a real workspace (below). **C1, C3 and C5 green**: connect through consent, callback and confirm; a hosted agent's reply relays to Slack; a Slack mention reaches the agent and its answer comes back. C5 inbound was green only after two Slack app settings were fixed during the walk. Red for customers until the app was publicly distributed, which is now done, and the distribution attestation is now true of the running backend: #1929 (TASK-151) removed every `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` read and injection, live on `f5eb5563`. A second authorize on a connected row is refused with 409 `slack_already_authorized` (measured through the API); the refusal copy on the page (#1890, Row C) is still unwalked in the UI. Before #1875 (09-04 to 09-25), every new install was refused at Authorize |
| Discord | partly | **Not listed since 2026-10-31 (D215).** The Connectors page no longer shows a provider this instance does not offer, unless the person already installed it, so a stranger sees no Discord row at all. The API still reports the entry with `offered: false`. Before that, **C0 listed, not offered**: #1826 (approved 2026-09-29) gives Discord its own row, live since `96cc9711` (2026-09-29 12:11Z). `/api/installables` returns `discord` under `channels` with `available: true, offered: false`. `offered` is the roster decision (`installableCatalogService.ts` `offeredByRoster`: an active builtin Installable row exists), and commonly.me has no `discord` Installable row, so it is not offered. `available` is the manifest readiness (`manifests.ts`: missing required keys would make it `false`), and it reads `true`. A stranger saw "Unavailable here." (the not-connectable line) rather than a merged "not yet" row. **red** in C1: not connectable (TASK-104) |
| GroupMe | yes | **red**: TASK-101 |
| X | yes (admin OAuth callback + feed) | unverified |
| GitHub (app) | yes | Walked 2026-09-25 and re-walked 2026-09-26 on `5561a1dd` (both below). Live on our own repository since 09-18. **red** in C1 until per-person GitHub: a team cannot connect its own repository. C2 at 390 is green since #1874, shown on `5561a1dd`. C3 (a hosted agent gets the broker, #1880) shipped and has not been walked. C8 was green on `9a32fca5`. A new grant from the connection's owner, `grant_3c4d6ad5` (2026-09-29), has the same scope as the lapsed 09-18 one: pod "C4 run 2026-09-18"; `list_issues`, `create_issue` and `close_issue`; write-with-confirm; audience the owner, `c3stranger0912` and `c4-smoke`. It runs to 2026-10-06, so C3, C4 and C8 are walkable again. None has been walked on the current build |
| Hosted MCP (generic type, TASK-172) | yes | **Built and live.** Steps 1–6 of `hosted-mcp-connection-scope.md` §10, and step 8's prerequisites (the client record, expand phase, and the pre-registered client; #2063), are live. The reconnect withdrawal #2069 added to step 3 is built (#2072). A reconnect that brings a different account withdraws the old token at the vendor before our copy is overwritten. When that cannot be done, or the two accounts cannot be compared, the Connectors page points the person to the vendor's revoke page instead (`hostedMcpConnect.ts:554–598`). Since 2026-10-19 an entry's credential may write: a tool that writes is pinned `write`, and each call parks for the connection's owner with its exact arguments (`hosted-mcp-connection-scope.md` §3 and §5). That lifted 76043's bar, that every entry's credential be unable to write. Entries are offered one by one; the rows below walk them |
| Linear (hosted MCP) | yes | **Fresh-account walk 2026-10-15 on `cfe91c21`, green** (connector-ops 77850 and 77962; the build is Deploy Dev's last run before the walk): a new commonly.me account and a new Linear workspace, neither connected before. **C1 green**: connected through the Connectors page. Linear's consent read "Read, Identity", the authorize request asked for `read openid`, and the token response granted `read openid` (`config.grantedScope`). **C3 green in an eligible pod**: a read grant of the 36 pinned tools, made through the grant panel, which offers only Read, in the account's own My Workspace. That pod is private and invite-only, with no bridge and Scout as its only agent, so it passes §12's pod rule in `hosted-mcp-connection-scope.md` (#2211). Scout listed the workspace's one team through the grant, the trail records the call ok, and Scout quoted #2206's untrusted-content marker ahead of the data. #2211 deployed after the walk, and the same call was ok again after it, at 16:22:37Z. The earlier C3 and C4 walks ran in the C4 run pod, which fails that rule: since `ff909fb3` the deployed rule returns `pod_joinable` for both of its grants. Partly walked live 2026-10-01 (the owner's account, Chrome). Before the fresh-account walk, C1 was open: the owner's operator-led connect succeeded on `cf9b6abf`, through CIMD with scope `read openid`, and the row records its client and the Linear subject. That didn't prove a stranger connects unaided, and no stranger had tried. **C2 green at 1440, the rest unwalked**: in the fresh-account walk the grant panel offered only Read. Earlier, on `cf9b6abf` the grant rendered as GitHub, because the catalogue projected 0 Linear tools. #2068 (`207c68d5`) fixed it, and on the deployed `e370fe9b` (its descendant) the row reads Linear, with its mark and the read eye, at 1200. 390, a failure reaching Activity, and revoke reachability are unwalked. Earlier, C3 was green in the C4 run pod: Scout listed the team and three issues through `grant_c6af31b8`; the trail showed the calls ok, with the owner as credential owner. **C4 refused by design** from #2211 (the C4 column), and c4-smoke is now offered no Linear tool. Before that it was green (2026-10-09): c4-smoke, a public local claude seat confined by Seatbelt, called `linear.list_teams` through its broker on `grant_e3a1507b` at 06:12:57Z, and the trail shows it ok. Its daemon started at 06:11:59Z, after global cli 0.1.84 (npm latest) was installed at 06:11:41Z, so it runs the current build. An earlier run on 2026-09-27 didn't count, because that daemon predated the cli it should have been running. The same spawn showed that TASK-228's headers helper works under the public Seatbelt profile. A by-name scan of the spawn's claude process found `COMMONLY_TOKEN_FILE` set and `COMMONLY_AGENT_TOKEN` absent. The rest of #2067's consumer proof is unmeasured: the child processes' environments, and a credential rotation followed by a 401 retry succeeding. **C8 open**: in a pod with no grant, Scout is offered no `linear.*` tools. That's confinement by projection. An attempted out-of-pod call, refused and recorded in the trail, hasn't been made. **C9 open**, now only for whether a revoke takes effect at Linear. Linear's revoke is page-only. The fresh-account walk reached the page: `https://linear.app/settings/account/security`, whose Authorized applications list shows the connection as "MCP · Read · Revoke". #2230 points the entry's page there. Before #2230 the entry named `https://linear.app/settings/security`, which is Linear's workspace admin page. Before that walk, every linear.app settings URL redirected to the old workspace's unfinished welcome flow, so the page had not been reached. C5, C6, C7 and C10 are unwalked |
| Google Calendar (hosted MCP) | yes | **Built, live, not offered.** #2066 (`e370fe9b`) pins the 5 read tools from Google's unauthenticated `tools/list`, with a pre-registered client and `openid` for the account subject. "Not offered" is a **config fact, not a code fact**. The client values arrived on 2026-10-09 (#2111), and the tile was offered until 2026-10-14. OAuth worked, but every tool call failed Google's Developer Preview gate, which is **per Cloud project** (Google named the project in its error on the 2026-10-09 gate test). Since 2026-10-14 `hostedMcp.googleCalendar.enabled` is `false` in values-dev, so the instance holds no client values, the catalogue reports `available: false`, and the page shows "not enabled on this instance" with no Connect. Flip the flag once the project is enrolled and an enrolled `list_calendars` call succeeds. Waiting on the owner: a Workspace seat on the domain and Developer Preview enrollment for the connectors project. The OAuth client already exists in a project of its own (a revoke withdraws every scope a person granted the project) |
| Atlassian (hosted MCP), writes in #2328 | yes (writes since #2328) | **Deployed, hidden on commonly.me since #2530.** The live build (`19de6035d`, 2026-10-24) carries every change below. `hostedMcp.hiddenEntries` in values-dev leaves the entry out of the catalogue and refuses every connect with `unknown_entry`, a reconnect included (`hostedMcpConnect.ts:251`). **C1 blocked on staging** (2026-10-23, `876870378`, #2536): the site's MCP-server-domain allowlist does not include the staging origin, and only a site admin can add it. The entry pins six Jira and Confluence reads. In a 2026-10-22 walk C3 was red: every call failed with "tools/list could not be verified", which TASK-263 attributed to our client never opening an MCP session. #2397 opens one for each list and call; the C3 re-check after its deploy belongs to TASK-263. #2328 adds five named writers: `update_confluence_content`, `create_jira_issue`, `edit_jira_issue`, `transition_jira_issue` and `add_or_edit_jira_issue_comment`, the last marked irreversible. Each is pinned `write`, so every write parks for the connection's owner with its exact arguments, and runs only under the definition it parked under (#2378). The entry now requests write scopes, so a row connected before #2328 holds a token that cannot write, and its owner must reconnect, which the hide refuses until it is lifted. **C4 refused by design** (the C4 column). The walk's checks are below |
| Sentry (hosted MCP), #2329 | yes (#2329) | **Deployed. Hidden on commonly.me from #2530, and offered again by the connect-and-read unhide** (still open on TASK-308: C6, and three C9 arms: the 12 `write-with-confirm` tool bounds, whether `get_sentry_resource` is offered without `url`, and a revoke taking effect). While hidden, #2649 and #2658 gave it a walk exception for one account; that key left the allowlist overlay with the unhide. **C0, C1 and C2 green on staging, each with a part #2536 did not record** (2026-10-23, `876870378`). Staging has no agent runtime, so C3, C6 and C9 were not walked there. **C3 green on commonly.me except the page comparison** (2026-10-25, `c9c0d71c1`): a hosted agent read through a pod grant, and the trail records the call ok. **C9's "cannot do more than granted" green for a read grant**: the agent was offered the 11 reads and no write tool. Whether a revoke takes effect, at Sentry included, is not walked, and neither is C6 (the commonly.me walk below). #2329 pins 11 named reads and `update_issue`, an irreversible write that parks for the connection's owner with its exact arguments. `get_sentry_resource` is pinned without the vendor's `url` argument, and the vendor's dispatcher, its catalogue and Seer are left out, as ruled in the PR thread. The client is CIMD, and the entry requests five scopes, four of them write. **C4 refused by design** (the C4 column). The walk's checks are below |
| next app | no | Open decision; see below |

## Staging connector walk — 2026-10-23 on `876870378`

Walked `staging.commonly.me` with a non-admin walk user in an invite-only pod whose only agent was Scout. Staging has no agent runtime or LiteLLM, so no agent can call a tool. The Sentry connection was walked there; the Atlassian walk was blocked by the vendor's allowlist. Both remain hidden in production until the corresponding production spot walk passes.

| connector | cell | result |
|---|---|---|
| Sentry | C0 | **PASS** — listed |
| Sentry | C1 | **PASS** — connect, consent with only the Inspect and Triage groups, callback back to staging, and connection row written |
| Sentry | C2 | **PASS** — read granted to the walk pod with 11 tools, then revoked |
| Sentry | C3, C6, C9 | **NOT WALKED** — staging has no agent runtime or LiteLLM, so no agent can call a tool |
| Atlassian | C1 | **BLOCKED** — the site's MCP-server-domain allowlist does not include the staging origin; a site admin is needed. Not walked and hidden in production |

### Findings from the staging walk

| finding | status |
|---|---|
| Staging has no agent runtime, so tool-call columns cannot be walked there | observed limitation |
| The grant panel labels the agent by its `instanceId`, not its display name | observed UI finding |
| A callback error page is unhelpful | TASK-405, P1 |
| Staging `BACKEND_URL` had been set to production, so staging CIMD advertised production's callback | fixed by #2529 |
| Staging had no connector key ring | fixed by #2533 |
| Sentry's Authorized Apps page lists the hosted-MCP client as `mcp.sentry.dev`, not "Commonly (Sentry)"; vendor-side revocation there is per client and cuts every Sentry-MCP session on the account | Commonly disconnect is the supported per-token revoke path: it calls the vendor's RFC 7009 `revocation_endpoint` before deleting the row; staging removal returned 200 |

## Sentry walk on commonly.me — 2026-10-25 on `c9c0d71c1`

Walked 2026-10-25 from 04:15Z to 04:16Z and recorded on TASK-485, with the first attempt on TASK-490. The live build was `c9c0d71c1` (#2658), from Deploy Dev's 00:34Z run; the next run started at 10:57Z. It descends from `4bc63222`, so it carries everything the walk checks below depend on. Sentry is still hidden on commonly.me. A hidden entry's walk exception lets the accounts it names see and connect it (#2649) and mint its grants (#2658). Sentry's names one operator account (values-dev). So the connection and the grant are that account's, the walk was not a stranger session (Method rule 1), and C0 to C2 are not re-recorded here. The pod (`6ad18344`) is invite-only, and the hosted agent `walk-agent` runs on the native engine. Every grant mint applies §12's pod rule in `hosted-mcp-connection-scope.md` (`outsiderGrantPodRefusal`, `backend/routes/grants.ts:396` at `c9c0d71c1`), and the broker re-reads it on every list and call. So the grant's mint and its ok call each show the pod passed the rule.

Evidence: TASK-485's notes on the board record the grant, the agent's call, the trail's one row and the revoke. The trail itself is `GET /api/grants/:grantId/calls` (`backend/routes/grants.ts:530` at `c9c0d71c1`), and only an account that can view the pod can read it (`canViewPod`, `backend/routes/grants.ts:521`). TASK-485 records no file, so nothing in the repo holds this walk's evidence.

| cell | result |
|---|---|
| C3 | **green except the page comparison.** `grant_d8b399a9` is a `read` pod grant of the 11 reads, with audience `walk-agent` and a two-hour expiry. Woken by a message in the pod, the agent called `find_organizations`, and its turn reports the organization returned. The trail, the broker's call log, shows that one call, `sentry.find_organizations`, outcome ok. Unverified: whether the answer matches Sentry's own pages, which TASK-485 does not record |
| C9, cannot do more than granted | **green for a read grant.** The agent's turn listed exactly the 11 reads as its `sentry_*` tools and reported no create, update or resolve tool. So neither `update_issue` nor the vendor's dispatcher, its catalogue or Seer was offered. Unverified: the 12 tools under `write-with-confirm`, and whether `get_sentry_resource` was offered without `url` |
| C9, a revoke takes effect | **open.** The grant was revoked at 04:16:08Z, and the record has no call after the revoke, so it does not show the revoke taking effect. Not walked on commonly.me: a parked `update_issue` refused with `grant_revoked` after its grant's revoke, and a disconnect's revocation at Sentry, with what Sentry's Authorized Applications page shows afterwards |
| C6 | **not walked.** It needs a `write-with-confirm` grant, with one `update_issue` approved and one declined |

| finding | status |
|---|---|
| A first grant in the same pod, `grant_22d0c9eb`, named an explicit empty audience, so the agent's turn at 01:00Z was offered no Sentry tool. It first read as an engine defect (TASK-490). The cause was the audience, which named nobody | #2661 refuses an explicit empty pod-grant audience at mint with `400 invalid_audience` (`docs/runbooks/connector-grant-audience.md`), deployed by Deploy Dev's 10:57Z run (`cf4164499`) |

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
| Slack | C0 green. C1 green up to the external boundary: Add, then Connect, installs; Authorize in Slack opens `slack.com/oauth/v2/authorize` with a client id, our callback, a state and the DM scopes. The OAuth leg waits on the owner's workspace |
| Telegram | C0 green. C1 green up to the code: Connect shows `/commonly-enable` with a 10-minute code. A simulated private chat binds with the code, and its dead-chat confirmation turns the connector into a named failure ("Telegram stopped delivering: this chat no longer exists."), shown on the row with New code (C10 for this case). With #1878 live, a simulated chat now fails at its first send, so inbound and sender identity (C5) were last shown on `0e142135`, before that fix. Re-showing them needs a real chat |
| GitHub | C0 green. C2 green at 390: the row shows its reason, and its copy names the instance's own repository. C3, C4 and C8 wait on a new grant; the only grant lapsed 2026-09-25 11:32Z |

## Live Slack walk, 2026-09-26/27 on `7ccc6ac2`

Walked by the Connectors session with the owner's real Commonly Slack workspace, with an operator account on the Commonly side, in a throwaway pod "Connector walk 0926". Part 1 ran 2026-09-26 23:35Z to 23:50Z (16:35 to 16:50 PDT); part 2, with Scout hired into the pod, ran 2026-09-27 00:00Z to 00:10Z. The room post in the Connectors pod carries the detail.

| cell | result |
|---|---|
| C1 | green live: Authorize, Slack's consent screen, the callback, and confirm in Commonly |
| C1 for customers | was red: the Slack app was "Not distributed", so only its own workspace could install it. Public distribution is now activated. The `SLACK_BOT_TOKEN` fallbacks that distribution's attestation rules out are gone: #1929 (TASK-151), live on `f5eb5563`, where the running backend's env and the ESO-rendered `api-keys` secret carry no Slack bot or app token, every stored connector secret still decrypts, and the bound row still relays |
| C5 outbound | green |
| C5 inbound | was red, from two Slack app settings, not code: the App Home messages tab was unticked, and the Events Request URL was unverified. Both were fixed in the app settings with the owner's OK, and a DM now lands in the pod |
| C3 | green: with Scout hired into the test pod, its intro relayed to Slack |
| C5 both ways | green: "@scout … PONG" sent from Slack came back as "[Connector walk 0926] Scout: PONG" within about a minute |
| second authorize | green, measured: at about 2026-09-27 00:05Z, `POST /api/installables/slack/authorize-url` from the page's own session on the connected row returned 409 `slack_already_authorized` (Connectors room, message 74576). A connected row refuses a second authorize by design. #1890's refused-authorize copy (Row C) is still unwalked in the UI; the 409 was observed through the API, so no refusal copy was rendered |

The two C5 settings live in Slack's app configuration, which no test here can see. A new instance's operator has to set them too, so the Slack setup docs must name them.

## Live Telegram walk, 2026-09-27 on `7ccc6ac2`

Walked by the Connectors session with the owner's real Telegram account, 2026-09-27 00:00Z to 00:10Z, in the same session as part 2 of the Slack walk (the Slack C3 and C5 rows above).

| cell | result |
|---|---|
| C1 | red: the page displays the code grouped with spaces, and the bot reads only the first word after `/commonly-enable`, so typing the command exactly as shown fails. Reproduced live; TASK-153. **Fixed** by #1931 and #1932; green in the re-walk below |
| C1, more than one pod | not walked here; **green in the re-walk below**. The walk hit a legacy row on the same chat: an Aug-27 Rewire Live Demo binding, from before connectors were installable (#1527), so the test pod could not bind. The chat claim is unconditional (`webhooks/telegram.ts:135-148`): one private chat holds one active Telegram row, because everything typed there is authored as its owner. On the installable, user-scoped row that one chat still reaches N pods. Outbound relays from every pod whose gate is on (`config.gates.<podId>.enabled`, `services/installable/eventHandlers.ts:59`). Inbound goes to the single active pod (`podId`), which the owner moves with the same owner-only PATCH that writes the gates (`routes/integrations.ts`). The switches are the connector's "Pods that reach this channel" list; that surface is ADR-025 D17 (ruled), and D8 is still Proposed. The scope was ruled on TASK-154. Pod tags on lines and quote-reply routing across pods are TASK-156 |
| C10 | green: both refusals seen in the walk are named to the person |
| UI | TASK-155: the Telegram Add button, and the pod picker defaulting to an agent room. **Fixed** by #1933, live on `9a6253fc`: the panel owns the add form, selecting a row closes it, the picker takes focus (so at 390 it scrolls into view) and defaults to a team pod, and the bound-pod refusal points at the gate switches |

## Telegram re-walk, 2026-09-27 on `c941626b`

Walked by the Connectors session, 2026-09-27 02:43Z to 02:47Z, with an operator account on the Commonly side and the owner's real Telegram account in a private chat with the bot, the same pairing as the Slack walk. The owner first removed an Aug-27 legacy row, which frees the chat claim. Backend and frontend both ran `c941626b`.

| cell | result |
|---|---|
| C1 | green live: a fresh code on the installable connector, sent exactly as displayed with its spaces and a capitalised first group (`/commonly-enable ABE3 b80f …`), bound on the first try ("Connected this chat to Connector walk 0926") |
| C1, more than one pod | green outbound. With "Scout (Default)" switched on under "Pods that reach this channel" alongside the active pod, Scout's reply there reached the chat as "Scout (Default): PONG-GATE" with an "open in Commonly" link, within the minute. A second bind is not the test, because the chat claim always refuses one; a second gate is |
| inbound routing | as built: a plain line typed in the chat landed only in the active pod, as "<name> (via Telegram)", authored by the connector's owner, and not in the second gated pod |
| C3 | green: an agent's line in a gated pod relayed to the chat |
| C5 inbound | green, with sender identity preserved |
| pod tags and quote-reply routing | shipped after the walk (#1935, TASK-156). Pod tags seen live on `19d1d3e2`; quote-reply routing is unit-witnessed and not yet walked live |

The test gate on "Scout (Default)" was switched back off after the walk. On the owner's word (2026-09-27 ~10:30Z) the test binding on "Connector walk 0926" was then removed, so the chat is free: the owner's Rewire Live Demo pod relays nothing until they bind it from his own account. **Restored 2026-09-29** on the owner's approval: the existing Aug-26 pod-scoped row was reactivated (`isActive: true`; `liveRelay` was already on), not re-bound with a new code. It is the only active row on that chat, and the outbound selector picks it for Rewire Live Demo. The walk row stays inactive.

**Membership, hardened across every connector write path (2026-09-27).** A connector now writes only where its owner is a listed pod member, the same rule `createMessage` uses (`isListedPodMember`): relay, inbound, the gate PATCH, install, bind confirm and the gate reconciler (#1940, TASK-161). A pod's creator cannot leave it (#1945, TASK-166), so `createdBy` no longer stands in for membership; the Discord/Slack owner routes follow (#1946, TASK-168); `agent-admin` pods are not a gate target (#1954, TASK-171); the PG chat path reads Mongo membership rather than its own mirror (#1942, TASK-162); and a seat whose own declaration cannot confine a broker is refused at the broker call — every dispatch except the native runtime's in-process one, which is exempt because a hosted turn has no shell, web or file tool to confine (#1971, TASK-175). This bears on C9 (authority is bounded) for every channel row above.

## Walk checks: Atlassian writes and Sentry

What a walk checks for the two entries above: C1, C3, C6, C8 and C9 for Atlassian writes, and C0 to C3, C6 and C9 for Sentry. C4 is refused by design for both until TASK-213, so it is not walked. The staging walk of 2026-10-23 (above, #2536) filled the cells staging can reach. Staging has no agent runtime, so a cell that needs an agent to call a tool waits for a walk on commonly.me. #2536 keeps both entries hidden there until that walk passes; the values-dev comment that hides them (#2530) still says a staging walk. A hidden entry refuses every connect, a reconnect included, and every new root grant, from every account but those its walk exception names (#2649, #2658; `docs/runbooks/hosted-mcp-hidden-entry-walks.md`). Sentry's commonly.me walk (above) ran that way, with the hide in place. Each result reads `unverified` until a walk replaces it with what it saw and a link to the evidence. Method rules 1 and 2 hold: a stranger account's own session, and every UI cell at 1200 and 390. #2536 does not record which widths it walked.

**A staging green is not a commonly.me green.** Ready means green on commonly.me against the deployed build, so a cell that passes here is recorded as green on staging. Like "green to the external boundary", it keeps that mark when it is copied into the rows above, and it turns green when the same check passes on commonly.me (Method rule 5).

**Record the build.** Everything the walk depends on is on `main` by `4bc63222`, so a build from that commit or later carries all of it. The staging walk's `876870378` does, and so does commonly.me's `19de6035d` (2026-10-24). A cell whose check needs a change the build lacks is `unverified` on that build, not red:

- #2328 and #2329, the entries walked;
- #2397, which opens an MCP session for each list and call; without it every Atlassian call fails (TASK-263);
- #2378 (TASK-247), so a parked call runs only under the definition it parked under. A mismatch is refused with `definition_digest_mismatch`, which the walk cannot provoke against a vendor it does not control;
- #2178 (TASK-210), so the seat learns how a parked call ended.

**C6 for a hosted write.** This type has no inbound path, so no card is answered from the vendor. Here C6 reads as the parked call's card: the connection's owner answers it in Commonly, and the seat receives the ending as `approval.resolved`: `ran`, `failed`, `refused`, `declined` or `expired`, with its code when it has one. An approved call also posts a receipt in the pod that names the approver, the agent, the tool and the ending.

**The walk's grants need an eligible pod.** Every source counts as outsider-writable today, and the mint applies §12's pod rule in `hosted-mcp-connection-scope.md` to every grant (`routes/grants.ts:389`, #2211). So each grant is a pod grant, in a pod that is private, invite-only and unbridged, with every agent in it running inside the backend. For an entry with a write tool, the grant panel offers `read` and "read and write, ask first" (`write-with-confirm`), never unattended `write` (`V2ConnectorTools.tsx:381–386`).

**Atlassian writes (#2328).**

| cell | what the walk checks | result |
|---|---|---|
| C1 | The site's admin first allows the instance's API origin under MCP server domains, as the entry's connect notice asks. A fresh connect then shows Atlassian's consent for the Jira and Confluence write scopes, and the row's `config.grantedScope` holds them. A row connected before #2328 holds no write scope; record whether the page tells its owner to reconnect, and whether a reconnect gains write | **blocked on staging** (2026-10-23, `876870378`, #2536): the allowlist does not include the staging origin. Unverified on commonly.me |
| C3 | In an eligible pod, a hosted agent calls a writer through a `write-with-confirm` pod grant, such as `create_jira_issue`. The call parks, and the card shows the connection's owner its exact arguments. Once approved it runs once, the trail records it ok, and the issue is there when read in Jira | unverified |
| C6 | The owner approves one parked write and declines another. The approved one ends `ran` and its receipt appears in the pod; the declined one ends `declined` (`approval_declined`) without running. The seat receives each ending once as `approval.resolved`, and the trail records each under its card's `approvalId`. A card nobody answers expires after 24 hours, or sooner if its grant ends first (the panel's shortest grant is 7 days), and the sweep then ends it `expired` (`approval_expired`) within five minutes; record it if the walk spans one | unverified |
| C8 | The grant's tools are offered in its pod and not in a second pod the same agent is in. A call against the grant from outside its pod or audience is refused with its code and recorded in the trail | unverified |
| C9 | Bounded: only the five writers are offered, never the vendor's `createConfluenceContent`; a `read` grant refuses a writer; the mint refuses plain `write` with `write_requires_confirm`; the comment tool is marked irreversible. Revocable: revoking a grant leaves its parked cards open; approve one afterwards, and it is refused when it runs, ending `refused` (`grant_revoked`) for the seat and in the pod's receipt. Record whether the card still offers Approve after the revoke. After a revoke on the Connectors page, record whether the connection has left Atlassian's connected apps page, the entry's revoke page. Rotation: if the walk outlasts the access token, a later call succeeds through a refresh | unverified |
| C4 | Refused by design until TASK-213 | refused by design |

**Sentry (#2329).**

| cell | what the walk checks | result |
|---|---|---|
| C0 | A stranger sees the Sentry row on the Connectors page at 1200 and 390, and the catalogue API lists `sentry` with its tools (Method rule 4) | **green on staging except the widths** (2026-10-23, `876870378`, #2536): #2536 does not record whether it walked 1200 and 390 |
| C1 | A stranger connects without an operator, through the CIMD client. At Sentry's consent, select the Triage Issues skill, as #2329 asks. The authorization then appears on Sentry's Authorized Applications page, and the row's `config.grantedScope` records what Sentry granted | **green on staging except the scope** (#2536): consent with only the Inspect and Triage groups, and the row written. Sentry lists the authorization as `mcp.sentry.dev`. Unverified: `config.grantedScope`, which #2536 did not record |
| C2 | The page shows the row connected. A failed call lands as an Activity row that names the failure. Revoke is reachable at 390 | **green on staging except the Activity row** (#2536): a read grant of the 11 reads, made in the walk pod and revoked. Unverified: the Activity row for a failed call, which needs an agent's call, and revoke at 390 |
| C3 | In an eligible pod, a hosted agent completes a read through a pod grant, such as `find_projects`. The trail records it ok, and the answer matches what Sentry's own pages show | **green on commonly.me except the page comparison** (2026-10-25, `c9c0d71c1`, TASK-485): `find_organizations` through `grant_d8b399a9`, a `read` pod grant, and the trail records it ok. Unverified: whether the answer matches Sentry's own pages, which TASK-485 does not record |
| C6 | Through a `write-with-confirm` grant, `update_issue` parks, and the card shows the owner its exact arguments. The owner approves one call and declines another. Only the approved one changes the issue in Sentry: it ends `ran` with a receipt in the pod, and the other ends `declined` (`approval_declined`). The seat receives each ending once as `approval.resolved` | unverified |
| C9 | Bounded: the 12 pinned tools are the only ones offered, without the dispatcher, its catalogue or Seer, and `get_sentry_resource` is offered without a `url` argument. Revocable: an `update_issue` call parked before its grant is revoked, then approved, ends `refused` (`grant_revoked`) without changing the issue. A disconnect on the Connectors page calls Sentry's revocation endpoint before deleting the row. Record what Sentry's Authorized Applications page shows afterwards: it lists the client as `mcp.sentry.dev`, and removing it there cuts every Sentry-MCP session on the account (#2536) | **Bounded: green for a read grant on commonly.me** (2026-10-25, `c9c0d71c1`, TASK-485). The agent was offered the 11 reads and no other Sentry tool. Unverified: the 12 tools under `write-with-confirm`, `get_sentry_resource` without `url`, and every revocable check. On staging the disconnect's revocation call returned 200 (#2536) |
| C4 | Refused by design until TASK-213 | refused by design |

## Cross-cutting reds

| red | state |
|---|---|
| The IP rate-limit tier trusts `cf-connecting-ip` from any peer, so every callback and webhook row's failure column runs on a bucket the caller picks | filed as TASK-110 |
| A seat started with `commonly agent run` that declares no sandbox can receive the grant broker while unconfined (31 claude and codex seats; 33 of 36 token files declare no sandbox, two of which are pi and refused server-side anyway) | latent: the only grant today belongs to a seat that declares a workspace sandbox. TASK-111: the server hands out the broker only through the daemon's assignment route, so the gap is a hand-authored record run with `commonly agent run`; the fix is the same withholding guard at that spawn site, cli-side. Moot until TASK-213: from #2211 such a seat can use no grant (§12 of `hosted-mcp-connection-scope.md`) |
| Withholding the broker from a seat is a convenience, not a boundary: `POST /api/mcp/grants/:grantId` accepts any agent token in the grant's audience. If confinement is meant to gate use of a granter's authority, that is a wider row than TASK-111 | closed until TASK-213: from #2211 no daemon seat can use any grant (§12 of `hosted-mcp-connection-scope.md`). Since #1971 (TASK-175) the broker list and call also refuse a seat whose declaration cannot confine it (toolBrokerService.ts:786, :1132) |
| A Mac seat that declares `bwrap` keeps it and is refused, since bwrap is Linux-only | unverified fix path |
| No agent seat can do a logged-in walk on commonly.me (blocked since 09-16 per ux-lead) | Until that lifts, stranger-session walks run from the operator session with a throwaway account |

## First-run hardening (not integration)

Found in the 2026-09-23 smoke, fresh account on build `58a6f2c2`:

- Signup takes about six seconds to respond.
- Signup says "Check your email for verification", yet login works immediately without verifying.
- At 390 a new user lands on the pods list, not in their workspace, so they never see Scout's welcome.
- The first screen takes five to eight seconds to become usable.
- A team pod created with no agent accepts a post and returns silence, with no prompt to add an agent (seen in a real signup's history on 09-09; to be confirmed in a walk).

## The next app: open

The team split on which app comes after GitHub, and the split is about the freeze as much as the app:

| position | from | reasoning |
|---|---|---|
| GroupMe and X first | connectors lane | Both have code that exists and is unverified; Linear and Google would be builds under a feature freeze. If Google comes, name one product, since a three-product row never goes green |
| Google Workspace before Linear | ux-lead | The Connectors artboard already draws Gmail, Calendar and Drive, and a decision answered from mail or calendar is the loop a team feels first; Linear shares GitHub's shape and its credential hold |
| Linear and Google, chosen by failure shape | sprint-review | Another chat channel adds little new evidence. Linear is the only row exercising write-back into someone else's system of record; Google is the only one exercising OAuth refresh and an org admin revoking access |
| Linear, then Google Workspace, then email over IMAP | Kai | Linear is the cheapest real exercise of C6; Google is the hardest C1 (OAuth consent plus a domain install); email stresses C5 without an app API |

Recommendation: verify GroupMe and X inside the freeze, since they are existing code. Then lift the freeze for exactly one build, Google Calendar, as a single product.

## Decisions for the owner

1. Release the GitHub App credentials on commonly.me, installed on our own repository only, and widen once the GitHub row is green. **Done:** live on our repository since 09-18. The 09-18 room grant lapsed 2026-09-25 11:32Z. **Renewed 2026-09-29** on approval: `grant_3c4d6ad5`, the same scope, runs to 2026-10-06 (see the GitHub row). C3 and C4 now wait on the walk, not on a grant.
2. Provide a dedicated Slack workspace and a Telegram account on a spare number, for the automated C1 checks. **Ruled 2026-09-26:** the test accounts are set up by the owner in their own browser. Agents do not create accounts or enter credentials, so C1 with a real account waits on those sign-ins.
3. Choose the next app. **Ruled 2026-09-26:** Linear, one build only, and only after Slack, GitHub and Telegram are green. No Linear code exists on main, so it is scoped first. **Re-ruled 2026-09-27 (74820):** "Start now, Linear first", as the first entry of the `hosted-mcp` type, with no wait on those three rows ([hosted-mcp-connection-scope.md](hosted-mcp-connection-scope.md)). That type has no inbound path, so it does not exercise C6.
4. Read the #1826 renders, which unblock the Discord page row. **Done 2026-09-29:** approved, merged as `96cc9711` and live; see the Discord row.

**Goal scope, ruled 2026-09-26:** drive Slack, GitHub and Telegram to green across C0–C10 first. GroupMe and Discord come after them; X and Instagram are deprioritised.

The three 2026-09-26 rulings were given in the Connectors session and recorded here from its relay.

# Tools in the Connectors page: one grant, one call, one trail — the plan

**Ruling:** Sam, 2026-09-11 (Connectors v2 pod, message 67407): option A, *Two lists*. Build the page and the tool support underneath it. **Lead:** Wren (sequence, ADR text, design review). **Builder:** Kai. **Verifier:** Vera. **Page gate:** UX Lead at 1440 and 390. **Spec review:** Sam. **Source brief:** Sam 67372 (the Cursor plugin catalogue study) and the 1 September Connections brief as Sam relayed it in 67401. **ADR text:** the 2026-09-11 amendment to [ADR-001](../adr/ADR-001-installable-taxonomy.md) (PR #1658), which this plan sequences and does not restate. **Rule carried over from the connectors-v2 spec:** the page never renders a control the server does not enforce, and never a number the server does not count — so a tool row appears only when the catalogue returns a tool Installable, and the trail draws only rows the broker wrote.

This is the order the pieces land in, what each one is, what proves it, and what the kernel has today for each — the same shape [`connectors-page-signal-diff.md`](connectors-page-signal-diff.md) used for the restyle.

## 1. The order, and why it changed

Sam's review note on order is taken: **one first-party tool works end to end in a room — grant, call, trail, approval — before the generic manifest parser.** The parser was first in the sequence I posted on 2026-09-11 (67387), because it was the smaller unblocked piece. It is smaller, and it proves nothing on its own: a catalogue whose rows cannot be called is a list. The parser's contract is now frozen in ADR-001 §1–§2 and does not move by going later; the call path is the part whose design is still only words, so it goes first.

| # | piece | owner | size (mine; Kai confirms) | proves |
|---|---|---|---|---|
| 0 | ADR-001 amendment — `McpServer`, manifest rules, `RoomGrant` | Wren, PR #1658 | open; Vera gates §3 | the vocabulary every row below uses |
| 1 | The grant record — model, mint, attenuate, revoke-with-cascade | Kai | 2–3 d | a grant can be narrowed and killed, and the server is the one deciding |
| 2 | The broker — a Commonly-hosted MCP server per grant, the trail row, and the first-party GitHub tool Installable | Kai | 4–6 d | an agent calls a real tool through a grant it never holds, and the room can read who did what |
| 3 | Approval for irreversible scopes — `write-with-confirm` through the existing `propose-action` consent path (`ApprovalAction`) | Kai | 1–2 d | a person with authority consents before the broker executes; nothing new is invented for it |
| 4 | The page — the Tools list with per-member rows first, then the grant aside and the trail; option A | Kai builds, UX Lead gates | 3–4 d | the page draws what the server enforces at the time it draws it, and only that |
| 5 | The manifest parser — `.claude-plugin` / `.cursor-plugin` → Installable, with the validation in ADR-001 §1–§2 | Kai | 2–3 d | a third-party server becomes a catalogue row |
| 6 | Per-person Connections — GitHub OAuth (and Gmail after it) as the credential a member grants | unsized | — | the "granted by {member}" row when the member is not the admin |
| 7 | HTTP hook endpoint + CLI hooks-config writer | Kai | 5–7 d ingress/claim only | ADR-028 claims enforced at `PreToolUse`; separate lane, unchanged from 67387 |

Pieces 1 → 2 → 3 are strictly ordered. **4 is not gated on the broker** (Sam 67413): per-member installs ship before it, so the Tools list ships first with per-member rows — "installed by you · your agents may use it" — from the catalogue's existing `InstallableInstallation` rows, and room-grant rows, the aside's grant, and the trail appear as 1–3 land. The page work can start the day this plan merges. 5 has no dependency on 1–4 and goes after them only because there is one builder; a second builder takes it in parallel. 6 and 7 are after the slice and not in this sprint.

## 2. The first-party tool is GitHub, and why not Gmail

The slice needs a credential the server already holds so the broker has something to execute with on day one. `backend/services/githubAppService.ts` already mints short-lived installation access tokens for the Commonly GitHub App, server-side, never handed to an agent. That is the broker's credential source with no new OAuth app, no verification queue, and no secret material in a row. Gmail needs a Google OAuth client, consent screen review, and refresh-token storage before the first call can happen; it is the right second tool and the wrong first one.

The **Connection** for the slice is therefore the instance's GitHub App installation, owned by the admin who installed the app. The grant to a room is made by that admin. This exercises every field of the grant and every step of the call path; the one thing it does not exercise is a *member's own* credential as the Connection, which is piece 6. Sam's sentence "one real Gmail or GitHub grant proves the whole design" holds for the design of the grant and the call; the per-person Connection layer is proved when 6 lands.

The GitHub tool Installable ships as `source: 'builtin'` with one `McpServer` component (ADR-001 §1), `transport: 'http'`, and a hand-written `enabledTools`:

| tool | `writeMode` needed | irreversible? |
|---|---|---|
| `list_issues`, `get_issue`, `get_pull_request`, `list_pull_request_files` | `read` | no |
| `comment_on_issue` | `write` | no — a comment can be edited or deleted |
| `create_issue`, `merge_pull_request` | `write-with-confirm` | yes — a merge cannot be unmade; an issue creates notifications that cannot be recalled |

No manifest is parsed for it. It is the row the page shows first and the fixture every test in 1–3 runs against.

## 3. The grant record (piece 1)

The shape is ADR-001 §3 as amended, and this section names only what the builder has to decide beyond the shape. Sam's 67407 restates the object as `{connection, room, allowed agents, tool allow-list, write mode, budget, expiry, granted by}`; the ADR's `RoomGrant` carries each of those (`connectionId`, `target`, `audience`, `tools`, `writeMode`, `budget`, `expiresAt`, and `grantedBy` derived from the Connection) plus `parentGrantId` and `brokerId`.

**Vera's two constraints are requirements (Sam 67407), and each is a server check, not a convention:**

- **Attenuation is computed at mint, by the server.** A delegating agent *requests* a child grant with `{parentGrantId, tools?, writeMode?, budget?, expiresAt?}`; the server loads the parent and refuses unless `tools ⊆ parent.tools`, `writeMode` no stronger than the parent's (narrowest to widest: `read`, then `write-with-confirm`, then `write` — a child may add the confirm, never remove it), `budget ≤ parent.budget`, `expiresAt ≤ parent.expiresAt`, and `audience ⊆ parent.audience`. Any field the request omits inherits the parent's value. The child is minted by the server from the checked values; the request body is never copied to the row. (Vera 67402.)
- **Revocation cascades.** Revoking a grant sets `revokedAt` on it and on every descendant in the same write. A child cannot outlive its parent because its `expiresAt` was capped at mint. (Vera 67403.)

**Named tests** — these are the acceptance instrument for the piece, and the PR lists them by name:

1. `mints a child only with tools ⊆ parent` — a request naming a tool the parent lacks is refused with the tool named.
2. `mints a child only with writeMode no stronger than parent` — `write` under a `write-with-confirm` parent is refused; the reverse is allowed.
3. `caps child expiry at parent expiry` — a later `expiresAt` is clamped, not refused, and the row carries the parent's value.
4. `revoking the root revokes every descendant` — three levels deep; after the root revoke, a broker call on each descendant answers `grant_revoked`.
5. `audience is snapshot ∩ current members` — a member removed from the pod after the grant gets `not_in_audience` from the broker; a member added after the grant gets the same until the granter adds them.
6. `a grant without expiresAt is refused`.

**Where:** `backend/models/RoomGrant.ts`, `backend/services/roomGrantService.ts` (mint / attenuate / revoke / `effectiveAudience`), routes under `/api/grants` (human JWT for mint and revoke; the attenuate verb takes the agent runtime token via `dualAuth`, like reactions do). The Connection for the slice is a row on the existing `Integration` model with `provider: 'github-app'` and no `podId`, following ADR-025's folded D8 (user-scoped, `linkedUserId` the admin); no new Connection model until piece 6 needs one.

## 4. The broker (piece 2)

**Decision: the broker is an MCP server the backend hosts, one URL per grant, authenticated by the agent's own runtime token.** Not a separate service, not a sidecar, not a token the agent carries. Reasons, in order of weight:

1. **Attribution is the auth, not a field.** The agent connects with `${COMMONLY_AGENT_TOKEN}`; the broker resolves the agent from it, checks the agent is in the grant's effective audience, and writes the trail row with that identity. There is no "grant token" the agent could leak or an injected agent could forge, because there is no second credential.
2. **It is already the shape ADR-008 declares.** An `McpServer` component projects to one `environment.mcp[]` entry: `{ name, transport: 'http', url: '${COMMONLY_API_URL}/api/mcp/grants/<grantId>', headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' } }`. Both placeholders are the two that `MCP_PLACEHOLDERS` in `backend/routes/agentBinding.ts` already lets through (#1598), so no daemon or adapter change is needed for an agent to reach it — the daemon writes the same `mcp-config.json` it writes today.
3. **The ledger is Postgres, the broker is stateless, so it can sit on the spot pool** (ADR-015). The one long-lived thing — the GitHub App token refresh — already lives in `githubAppService`.

**What it does per call**, in order: authenticate the agent → load the grant → refuse if revoked, expired, or the agent is outside `audience ∩ pod.members` → refuse if the tool is not in `tools` → refuse if the tool's required `writeMode` exceeds the grant's → if the tool is irreversible and the grant is `write-with-confirm`, park it (piece 3) → decrement `budget` → execute with the server-held credential → write the trail row → return the result. Every refusal also writes a trail row with `outcome: 'refused'` and the reason code, because a room reading the trail should see what agents *tried*.

**The trail row** is the "attributed event to the room's record" in Sam's 67407 and what the aside's trail reads:

```typescript
ToolCall {
  callId: string;
  grantId: string;            // and, denormalised for the page: podId, installationId
  agentUserId: string;        // from the runtime token — never from the request body
  tool: string;
  argsDigest: string;         // sha256 of the canonical args; args themselves are not stored in v1
  at: Date;
  outcome: 'ok' | 'refused' | 'pending_approval' | 'failed';
  reason?: string;            // refusal code, or the provider's error class
  approvalId?: string;        // piece 3 — the ApprovalAction row
  durationMs?: number;
}
```

Args are digested and not stored, deliberately: a Gmail search string or an issue body is the content the granter did not consent to have copied into Commonly's own store, and the page's trail needs *who, what tool, when, what happened* — not the payload. Recording payloads is the same follow-on the hook lane already carries separately (+2–3 d there), and it is not folded in here either.

**Named tests:**

1. `writes one trail row per call with the agent from the token` — a request body carrying a different `agentUserId` is ignored and the token's identity is written.
2. `refuses a tool outside the allow-list and records the refusal`.
3. `refuses a call from an agent outside the effective audience`.
4. `refuses after revoke` — the same connection that succeeded a moment ago answers `grant_revoked` on the next call, no restart.
5. `never returns the credential` — a snapshot test on every tool's result shape, so no future tool can leak the installation token by returning provider headers.
6. `budget exhausts` — `calls: 3` allows three and refuses the fourth with `budget_exhausted`.

**Where:** `backend/services/toolBrokerService.ts`, `backend/routes/mcpGrants.ts` (the Streamable HTTP transport from `@modelcontextprotocol/sdk` mounted under `/api/mcp/grants/:grantId`, agent auth via `agentRuntimeAuth`), `backend/models/ToolCall.ts`, `backend/tools/github/` for the first-party tool implementations against `githubAppService`. The builtin Installable registers beside the other first-party apps.

## 5. Approval for irreversible scopes (piece 3)

Sam ruled "reuse the existing decision request rather than inventing a new approval object" (67407). The existing object is **`ApprovalAction`, reached through `propose-action`** (`backend/routes/agentsRuntime.ts`, `approvalActionService`) — not `DecisionRequest`. Vera's 67410 is the reason and it is the tool's own contract on main: `commonly_request_decision` is "advisory coordination only, never approval or authority to act … use propose-action for side effects that need consent." Gating an irreversible write on an advisory card would let a ruling the tool promises is non-binding authorise the action. `propose-action` is the consent path that already executes with a human's authority, has a two-state resolve (`approved` / `declined`) with an atomic transition, an `expiresAt`, and a card the shell already renders.

So: the broker, on an irreversible tool under a `write-with-confirm` grant, calls `proposeAction` with a new `actionType: 'tool_call'` (the enum today is `create_pod` and `connect_local_agent`), `params: { grantId, callId, tool, argsDigest }`, `summary` rendered by the tool implementation (never raw args), and **`ownerUserId` = the granter** — the Connection's owner — so the existing "only the owner can decide this" check is exactly the right check without a new one. The trail row is written with `outcome: 'pending_approval'` and the `approvalId`. The MCP call returns `{ status: 'pending_approval', approvalId }` to the agent immediately; an MCP call does not block on a human.

On `approved`, `resolveApproval`'s existing dispatch gains one branch: `tool_call` hands back to `toolBrokerService`, which re-checks revoke, expiry and audience **at execution time**, executes, writes a second trail row with the real outcome and the same `approvalId`, and posts one system line in the room: `"{human} approved {agent}'s {tool} · done"`. On `declined` or expiry the second trail row says so and nothing runs. The agent learns the outcome the way any room member does. Nothing new is invented: the row, the card, the resolve, and the relay of cards to Telegram/Slack (#1569) all exist.

**Named tests:** `parks an irreversible call as an ApprovalAction owned by the granter and returns pending_approval`; `executes on approved and writes the second trail row`; `does not execute on declined`; `does not execute if the grant was revoked between propose and approve`; `an approval past expiresAt never executes`.

## 6. The page (piece 4) — option A, so the spec can be built from here

The channels list stays exactly as it is on main. Under it, in the same container grammar (dot, 20px ink glyph, display name, two-line middle, mono when, one action):

| state | dot | line 1 | line 2 | when | action |
|---|---|---|---|---|---|
| granted, used in the last 10 min | cobalt, pulsing | **GitHub** {what it does} · granted to **{room}** by **{member}** | `{agents} may use it · {what asks first}` | `granted {rel}` | Manage (bordered) |
| granted, quiet | cobalt, solid | same | same | same | Manage |
| granted, expired or revoked | hollow `#98a2b3` | same | `expired {rel}` / `revoked by {member} {rel}` | `granted {rel}` | Grant again (ink) |
| installed per member (before the broker, and after it for a member's own install) | cobalt, solid | **GitHub** {what it does} · installed by **you** | `your agents may use it · nothing is shared with the room` | `installed {rel}` | Manage (bordered) |
| not yet granted | dashed `#98a2b3`, name muted | {what the tool does} | `read, or read and write` | `not granted` | Add (ink) |

Heading **Tools**, count in mono (`2 granted · 3 more`), a search field and a category segment on the same line. `{agents}` is the effective audience rendered as display labels via `resolveAgentDisplayLabel`; `{what asks first}` is the list of irreversible tools under a `write-with-confirm` grant, or `nothing asks first` under `read`. `granted {rel}` reads the grant's `createdAt`; "used in the last 10 min" reads the newest trail row's `at`.

The aside for a selected tool is the grant: who granted it and when it ends; the agents allowed; what it can do (the `tools` allow-list grouped by `writeMode`); what asks a person first; **Change access** (bordered; opens the same form Add uses, pre-filled — a change is a new grant and a revoke of the old one, because `tools` is never widened in place) and **Revoke** (bordered, two-click confirm, as Disconnect does today). Under that the trail: one line per `ToolCall`, `{agent} · {tool} · {outcome}` with mono `{rel}`, newest first, and three counts in display 22 + mono 11: **calls**, **refused**, **awaiting a person**. The counts are `COUNT(*)` on `ToolCall` by outcome for the grant; nothing is estimated.

The Add form: a `writeMode` segment (`read` / `read and write, ask first` / `read and write`), an agent multi-select defaulting to every agent in the room, an expiry select (7 days default, 30, 90 — never "no expiry", because the server refuses it), and ink **Grant**. It opens in the aside, as the connect form does.

**Pins for `v2-layout-invariants.test.ts`:** the Tools list reuses the connector row grid (`200px minmax(0, 1fr) 200px 120px`) — the test's existing pin covers it if the row class is shared, which it should be; one new pin: the trail line uses `var(--v2-text-muted)` mono and no `--v2-success` / `--v2-warning` / `--v2-danger`, so an outcome never becomes a coloured word.

**390:** as the channels list — two lines per row, aside stacked under, `scrollWidth` 390 is the gate.

**Gate:** UX Lead, screenshots at 1440 and 390 from the deployed page with one granted GitHub row (live, from a real grant on dev), one not-yet row, and a trail with at least one `ok`, one `refused`, and one `pending_approval` line. The `pending_approval` line has to come from a real parked call with a real card in the room, not a seed.

## 7. The manifest parser (piece 5)

The contract is ADR-001 §1–§2 as amended and Kai's 67390/67395/67399; nothing is added here. Tests by name, from the ADR's build sequence: the `writeOnly`-literal refusal, the `default`/`writeOnly` exclusion, the `source` scheme/host allow-list (`https://github.com` only in v1), subpath escape rejection (`..` and absolute), the non-40-character pin. First cut reads a local root and never fetches; the SHA-freeze at install is the second cut. The GitHub tool from piece 2 is the fixture the parser's output is diffed against: parsing a `.claude-plugin` that declares the same server must produce the same `McpServer` component the builtin declares by hand, or one of them is wrong.

## 8. What the kernel does not have, named

| the page shows | the kernel has | call |
|---|---|---|
| a tool row | `Installable` with no `mcp-server` component type | ADR-001 amendment (PR #1658) + the builtin GitHub Installable (piece 2) |
| "granted to {room} by {member}" | `InstallableInstallation.grantedScopes: string[]` — capability scopes at install, no audience, no expiry, no owner | `RoomGrant` (piece 1); `grantedScopes` stays for what it is and is not reused for this |
| "{agents} may use it" | pod membership | effective audience `audience ∩ pod.members` (piece 1) |
| the trail, and the three counts | nothing records tool calls; `ChannelVerdict` records relay verdicts, which is the right *pattern* and the wrong table | `ToolCall` (piece 2) |
| "what asks a person first" | `ApprovalAction` with two action types, neither for a tool; `DecisionRequest` is advisory by contract | `actionType: 'tool_call'` on `ApprovalAction` (piece 3) |
| a member's own Gmail or GitHub as the credential | `Integration` rows for Telegram/Slack/Discord; `githubAppService` for the App | the App is the slice's Connection; per-person OAuth is piece 6 |
| a third-party tool row | no parser | piece 5 |
| the agent reaching the tool at all | ADR-008 `mcp[]` + the `MCP_PLACEHOLDERS` guard | exists; the broker URL is a placeholder-only entry, no adapter change |

## 9. Open questions, and who rules

- **`write` above or below `write-with-confirm` in the attenuation order.** This plan says a child may *add* the confirm and never remove it, so `write-with-confirm` is narrower than `write`. If Sam reads "write mode" as a single axis where confirm is a separate flag, the record gains `confirmIrreversible: boolean` and the order question disappears. Wren's recommendation: keep it one field, narrower-with-confirm, because a form with one segment is what the mock draws.
- **Budget unit.** Calls per window in v1, because the broker can count calls before it can price them. Cost becomes possible once the trail carries `durationMs` and a provider cost, and is not in this sprint.
- **Who can mint a room grant on a Connection they do not own.** Nobody, in v1: `grantedBy` is the Connection's owner, full stop. An admin granting *their* App installation to a room is the slice; a member granting *their* Gmail is piece 6; an admin granting *someone else's* Gmail is refused.

# Connector result cards — design note (D145)

**Status:** design, 2026-10-27. Docs only; no code changes. **Gate:** Vera.
**Owner of the decision:** CTO (connector lane), per Cofounder D77. This note recommends; it does not rule.
**Scope:** how a connector tool result (first case: a Linear issue) becomes a card in a pod, and which of two options to build.

## Question

Two options were weighed in the 2026-10-27 launch research brief (internal, not in this repo):

- **(a)** Thesys OpenUI renders a payload that the broker composes.
- **(b)** Fixed React cards on the existing ADR-020 D3 payload path.

Invariants the design must keep:

1. The model never emits UI.
2. The agent passes only a tool-call id.
3. Credentials and raw vendor responses stay server-side.
4. A card renders only the fields its catalogue entry pins.

## Correction to the launch research: the OpenUI path already ships

The launch brief says there is no OpenUI code in the repo. That is wrong for `main` at `origin/main` (checked 2026-10-27):

- `backend/services/uiCardValidation.ts` validates agent-authored `openui@1` source against a pinned catalogue (`commonly.ui`, rev 1, 15 components). It enforces a 32 KB cap, a 2,048-node expansion budget, and a catalogue hash.
- `backend/routes/agentsRuntime.ts` (the agent message writer, around line 1601) calls `validateAgentCardPayload` before any agent post. The Scout native post tool uses the same validator.
- `frontend/src/v2/cards/V2UICard.tsx` renders the source with `@openuidev/lang-core` and the OpenUI React runtime.
- `docs/api/agent-ui-cards.md` documents the agent envelope `{kind:'ui', lang:'openui@1', source}`.

This was added in #2675 and is documented in `docs/api/agent-ui-cards.md`.

**This conflicts with invariant 1.** Today an agent (the model) writes the UI source. That is the path the research said should not exist for connector results. It is acceptable for Scout's own content, but it is not a connector card design. The CTO needs to rule on it before any connector card lands. The options are:

- narrow the agent envelope so it cannot carry connector-derived data, or
- keep it as-is for agent-authored content and state that connector cards use a separate, server-written kind.

Whichever is chosen, the server's agent writer already refuses every envelope `kind` other than `ui` (`validateAgentCardPayload`), so a new server-written kind such as `tool-card` cannot be forged by an agent. That property should be kept and tested.

## Option (a): OpenUI renders a broker-composed payload

The broker composes an OpenUI program from the tool result, and the browser renders it.

- **Invariant 1:** holds only if the server writes the source. The model stays out of it.
- **Invariant 2:** holds. The agent would pass only a call id.
- **Invariant 3:** at risk. OpenUI's `Query(tool, args)` bindings run tool calls from the browser (per the research brief, "these functions run in the browser"). A connector card must not give the browser a tool path. The binding would have to be disabled, and the catalogue must not expose one.
- **Invariant 4:** holds if the catalogue has no free-text or passthrough props.
- **Cost:** low on the render side, because the runtime and catalogue already exist. The value of OpenUI is streaming and model-composed layout, and a Linear issue card needs neither.
- **Vendor exposure:** the Thesys product line is commercial and its branding is unverified in the research brief. The open-source renderer is MIT.

## Option (b): fixed React cards on the ADR-020 D3 payload path

The broker composes a typed `tool-card` payload. A small set of React components renders it.

- **Invariant 1:** holds by construction. No model output reaches the renderer.
- **Invariant 2:** holds. The agent sends `{callId}` in metadata. The server looks up the broker record, checks it belongs to the calling agent, the pod, and an active grant, then attaches the payload.
- **Invariant 3:** holds. The mapper runs server-side and writes only its allowlisted output. The raw response and the credential are never stored in the payload.
- **Invariant 4:** holds. Each card type has a fixed prop set in code. Unknown fields are dropped. An unknown card type falls back to the text `content`.
- **Cost:** no new dependency. It reuses the payload column, the `messageCardUpdated` event, and the approval-card renderer pattern.

## Recommendation

**Build (b).** Connector results are deterministic data, not layouts a model should compose. (b) satisfies all four invariants by construction, and (a) needs its browser tool bindings disabled to do the same. Keep OpenUI out of the connector path. Do not add a dependency until a use case needs model-composed layout.

**Two conditions:**

1. The CTO rules on the existing agent-authored OpenUI envelope (above) before the first connector card ships, so the two paths are not confused in review.
2. The server test suite includes an arm asserting that an agent cannot write a `tool-card` kind, mirroring the existing `kind !== 'ui'` refusal.

## Design sketch for (b)

1. **Mapper.** One allowlisted mapper per tool, for example `linear.get_issue` to `{identifier, title, state, assignee, priority, url}`. Fields are strings or enums. URLs are restricted to the connector's known hosts. The mapper tolerates added vendor fields and returns null on any missing required field, which falls back to text.
2. **Attach rule.** Server only. Input is a call id. The grant and pod checks reuse the room-grant semantics in [hosted-mcp-connection-scope.md](hosted-mcp-connection-scope.md). Visibility is the whole pod, so the attach rule must confirm the pod is allowed to see the connector's data.
3. **Snapshot label.** Each card shows the fetch time, because it is a snapshot.
4. **Renderer.** `V2ToolCard` switches on `card` type with design-system tokens. No iframe, no HTML from any source.
5. **Retention.** Cards copy connector fields into the pod message store. That store has a 30-day expiry in PG. Note this in the card's privacy line.

## Build estimate

The Linear slice is about **3 to 5 working days**. It is larger than one PR, so split it:

- **PR 1 (backend, about 2 days):** broker call-id lookup, grant and pod check, Linear mapper, `tool-card` attach, refusal tests (agent cannot write the kind, wrong agent, wrong pod, unknown call id, a field outside the allowlist).
- **PR 2 (frontend, about 1.5 to 2 days):** `V2ToolCard` with one `linear-issue` card, a presence test in `frontend/src/v2/__tests__/v2-layout-invariants.test.ts`, and a real-browser check at 390 and 1440 px (CLAUDE.md rule 9).

Not shippable in the 10-28 launch. After the freeze, review, press, deploy and a consumer-side check follow the usual order.

## Not decided here

- The disposition of the agent-authored OpenUI envelope (CTO).
- Whether a Thesys commercial relationship is wanted at all. It is not needed for (b).
- Other connectors' mappers (Sentry, Airtable). They follow the Linear slice.
- MCP Apps (`ui://` resources). Defer until a vendor we use publishes one. The research brief found no evidence that Linear, Sentry or Airtable do.

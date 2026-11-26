# Agent-authored UI cards

The agent runtime message writer accepts an additive UI card envelope. Kernel
approval, decision and handoff payloads remain server-composed; agent requests
cannot write their kinds through this surface.

```json
{
  "content": "A readable text fallback for clients without the UI renderer.",
  "messageType": "card",
  "payload": {
    "kind": "ui",
    "v": 1,
    "lang": "openui@1",
    "catalogId": "commonly.ui",
    "catalogRev": 3,
    "catalogHash": "sha256:b2d601737b88addd13814a962dead835f5a6b72381ae8dc215a0ff79c641b9f6",
    "source": "root = Text(\"Hello\")"
  }
}
```

Send to `POST /api/agents/runtime/pods/:podId/messages`, using the existing
pod-authorized runtime token and freshness rules. The bot API-token message
route uses the same validator. A payload on a non-card message is refused.
Both agent routes allow only `text` and `card`; omitting the type keeps the
existing text default. Agent requests cannot post `system` messages.

`commonly_post_message` accepts `messageType` and `payload` alongside its required
`content`. The native hosted post tool uses the same schema and validator
before its internal service write. This change does not attach run provenance;
TASK-499 will add trusted runtime stamping separately from model arguments.
The CLI takes a JSON envelope
and uses the active profile token, which must be a `cm_agent_` runtime token.
A device token from `commonly login` receives HTTP 401 without a human-writer
fallback:

```sh
commonly pod send <podId> 'A readable text fallback.' --payload '{"kind":"ui","v":1,"lang":"openui@1","catalogId":"commonly.ui","catalogRev":3,"catalogHash":"sha256:b2d601737b88addd13814a962dead835f5a6b72381ae8dc215a0ff79c641b9f6","source":"root = Text(\"Hello\")"}'
```

Cards are sent only through the validated agent writer. Unlike the existing
plain-text login fallback, a refused card is never retried on the human message
endpoint. Server refusals return HTTP 400 with `code: invalid_ui_card`; correcting
the source is required before retrying.

## Write boundary

- `catalogId`, `catalogRev` and `catalogHash` are required and must match the
  supported revision manifest. Unknown IDs/revisions and mismatched hashes return
  HTTP 400 with an explicit reason; the server never stamps a missing tuple.
- Envelope version is exactly `v: 1`, language is exactly `openui@1`. Additional
  client fields (including a claimed `runId`) are refused.
- The whole JSON envelope, serialized in UTF-8, must be at most 32,768 bytes.
- Content must contain a nonempty text fallback after agent content sanitization.
- `@openuidev/lang-core` 1.0.1 parses the source against the Commonly catalogue.
  It must produce a complete root without unresolved references or prop errors.
- Before materialization, a memoized reference-graph pass rejects cycles, more
  than 2,048 expanded AST nodes across all statements, or expansion depth over
  128. Repeated references are charged for every use, including dormant code.
- Every statement is inspected, including unreachable statements. Unknown
  component calls, Query, Mutation, Run, custom functions, reactive expressions,
  duplicate definitions, prototype keys, over 256 statements and over 64 nested
  bracket levels are refused.
- Only catalogue components and the `Action` / literal HTTPS `OpenUrl` constructs
  are permitted, plus `@ToAssistant("…")` from revision 3 (see *Acting buttons*).
  The renderer owns the HTTPS hostname allowlist and gets no tool
  provider. Server parsing never executes a tool or an action.
  Bare `Action` / `OpenUrl` / `ToAssistant` references discarded by expression
  parsing are refused, including in declarations that the root does not reference.

## Revisions

The server and the renderer accept three revisions, each selected by its full
tuple. Agents write revision 3, the one the MCP `commonly_get_ui_card_catalogue`
tool serves; a stored revision 1 card renders as before.

| rev | adds | written by |
|---|---|---|
| 1 | the catalogue below | agents (earlier MCP releases) |
| 2 | `Source(connector, fetchedAt)` | the server only, when it stamps a connector card; an agent-written Source is refused |
| 3 | `Progress`, `BarChart`, `LineChart` (with `Series`) and an acting `Button` | agents |

Revision 3 is revision 1 plus the new components appended, so revision 1 props
keep their positions. It does not include Source.

## Catalogue v3: progress and charts

Prop names follow OpenUI's own design-system examples, so a model that learned
OpenUI writes cards this catalogue accepts. `@openuidev/react-lang` 1.1.1 is
runtime-only and ships no components. OpenUI's charts live in
`@openuidev/react-ui`, which needs react-lang 1.2 or later and about 35 more
dependencies, so Commonly draws its own SVG charts in v2 tokens.

- `Progress(value, label?)`: `value` is 0 to 100, `label` is at most 60 characters.
- `BarChart(labels, series, variant?, xLabel?, yLabel?)`: 1 to 24 labels of at
  most 24 characters, 1 to 4 `Series`, `variant` is `grouped` or `stacked`, axis
  labels are at most 40 characters.
- `LineChart(labels, series, xLabel?, yLabel?)`: the same, without `variant`.
- `Series(category, values)`: a name of at most 24 characters and one number per
  label. A series whose value count differs from the label count is refused.

Each chart also renders its numbers as a visually hidden table for screen readers,
and lines after the first are dashed so no series is told apart by colour alone.

## Acting buttons

`Button("Ship it", Action(@ToAssistant("Ship it")), as?)` lets a person answer the
agent from the card. `Action([@ToAssistant("Ship it")])` is accepted too. A card's
Buttons together are one choice, like a decision card's options:

- The click posts the choice as the person's own reply in the thread, so the
  choice must equal the label they read, with no leading or trailing spaces and
  no `@` (a mention would wake other agents in the clicker's name). A Button's
  action must be exactly one `ToAssistant` step; a link is a `Link`, not a Button.
- 2 to 4 Buttons per card, with choices distinct ignoring case.
- OpenUI's second `context` argument is refused, so a card carries no hidden
  text to its agent.
- `ToAssistant` is allowed only as the one step of an `Action`, and only under
  revision 3. `as` is `button` or `primary`, and a primary Button counts toward
  the one primary per card.

The first person to click settles it. The click goes to
`POST /api/activity/cards/:messageId/choose` with `{ value }` (human JWT only).
The server reloads the stored card, holds it to the write rules again, and accepts
only a value the card offers, from a person who is a listed member of the pod.
It then opens a `DecisionRequest` on the card's message and rules it through the
same `chooseDecision` path a decision card uses: the choice is posted as a reply
in the card's thread, and the agent that posted the card gets one
`decision.ruled` event carrying the value as `pick`. A second click returns 409
with the standing choice. `GET /api/activity/cards/:messageId/choice` returns it
for rendering. No attention item is queued, because the card in the thread is
already the ask. The ruling does appear in the Activity decision history.

The `content` fallback should still say what the choices are, so a reader without
the renderer can reply in text.

## Catalogue v1

Visual components: Card, Text, List, Steps, DiffSummary, TaskStatus, KeyValue,
Table, Badge, Link and RunTrace. Step, File, Pair and Col are positional helper
components, accepted only in their declared slots and never as visual roots.
There is no Stack component; Card children stack.

Lang-core reports basic prop errors but does not enforce all JSON Schema bounds.
The write boundary also validates its materialized tree with Ajv 8.20.0 (MIT),
using the same catalogue's complete constraints. Examples proving the gap and
its guard are in `uiCardValidation.test.js`; see AX audit entry 85.

Additional presentation checks enforce at most one active Step, at most two
button links and one primary link, text-only inline links and a total Text body
of 600 characters. Table row width must match its columns. Link destinations
must be credential-free HTTPS; the renderer further restricts hostnames.

The canonical serializable catalogue is `backend/config/uiCardCatalogue.json`.
TASK-498 generates the frontend copy and checks drift because the backend and
frontend images have separate Docker build contexts. Names and positional prop
order are part of the stored contract. The immutable revision tuple is in
`backend/config/uiCardCatalogueRevision.json`. `catalogHash` is `sha256:` plus the
lowercase SHA-256 of `JSON.stringify` applied to the parsed catalogue, preserving
property insertion order. A fixed revision-1 order/hash test fails if any schema
or prop order changes. Never update that revision in place: a changed schema
requires a new revision and a reader that explicitly supports it. TASK-498 will generate a byte-identical frontend manifest copy and select its
renderer by the full tuple. Unsupported tuples must show the required text
fallback with an unsupported note, never the current catalogue as a guess.

The parser is MIT licensed. Installation telemetry was disabled for the local
install (`npm install --ignore-scripts`); its runtime telemetry is opt-in and is
not enabled by this feature. Operators can set `OPENUI_TELEMETRY_DISABLED=1` for
all install/runtime telemetry. The backend image sets this opt-out before
installing dependencies. No cloud parser or devtools are used.

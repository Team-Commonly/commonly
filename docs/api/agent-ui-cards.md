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
    "catalogRev": 1,
    "catalogHash": "sha256:bb8b4de07f90c06ee48f254d86478b5bd347c738b3e86cf65e2f32e26534db57",
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
commonly pod send <podId> 'A readable text fallback.' --payload '{"kind":"ui","v":1,"lang":"openui@1","catalogId":"commonly.ui","catalogRev":1,"catalogHash":"sha256:bb8b4de07f90c06ee48f254d86478b5bd347c738b3e86cf65e2f32e26534db57","source":"root = Text(\"Hello\")"}'
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
- Every statement is inspected, including unreachable statements. Unknown
  component calls, Query, Mutation, Run, custom functions, reactive expressions,
  duplicate definitions, prototype keys, over 256 statements and over 64 nested
  bracket levels are refused.
- Only catalogue components and the `Action` / literal HTTPS `OpenUrl` constructs
  are permitted. The renderer owns the HTTPS hostname allowlist and gets no tool
  provider. Server parsing never executes a tool or an action.
  Bare `Action` / `OpenUrl` references discarded by expression parsing are refused,
  including in declarations that the root does not reference.

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
requires a new revision and a reader that explicitly supports it. The frontend
generates a byte-identical manifest copy and chooses its renderer by the full
tuple. Unsupported tuples show the required text fallback with an unsupported
note, never the current catalogue as a guess.

The parser is MIT licensed. Installation telemetry was disabled for the local
install (`npm install --ignore-scripts`); its runtime telemetry is opt-in and is
not enabled by this feature. Operators can set `OPENUI_TELEMETRY_DISABLED=1` for
all install/runtime telemetry. The backend image sets this opt-out before
installing dependencies. No cloud parser or devtools are used.

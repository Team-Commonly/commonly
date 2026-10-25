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
    "source": "root = Text(\"Hello\")"
  }
}
```

Send to `POST /api/agents/runtime/pods/:podId/messages`, using the existing
pod-authorized runtime token and freshness rules. The bot API-token message
route uses the same validator. A payload on a non-card message is refused.

`commonly_post_message` accepts `messageType` and `payload` alongside its required
`content`. The native hosted post tool uses the same schema and validator
before its internal service write. Its run provenance is supplied by the
trusted runtime, separately from model arguments. The CLI takes a JSON envelope:

```sh
commonly pod send <podId> 'A readable text fallback.' --payload '{"kind":"ui","v":1,"lang":"openui@1","source":"root = Text(\"Hello\")"}'
```

Cards are sent only through the validated agent writer. Unlike the existing
plain-text login fallback, a refused card is never retried on the human message
endpoint. Server refusals return HTTP 400 with `code: invalid_ui_card`; correcting
the source is required before retrying.

## Write boundary

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
order are part of the stored `openui@1` contract; incompatible changes need a
new envelope/language version and reader compatibility.

The parser is MIT licensed. Installation telemetry was disabled for the local
install (`npm install --ignore-scripts`); its runtime telemetry is opt-in and is
not enabled by this feature. Operators can set `OPENUI_TELEMETRY_DISABLED=1` for
all install/runtime telemetry. The backend image sets this opt-out before
installing dependencies. No cloud parser or devtools are used.

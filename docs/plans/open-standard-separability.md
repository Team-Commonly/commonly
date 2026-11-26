# Open standard: which pieces stand alone

**Status:** plan, 2026-11-26. Measured against `main` at `dd061a3bf`.
**Context:** Sam's 2026-11-26 direction makes Commonly an open standard for agents from any vendor working
alongside people. Agents are meant to join through ACP (the Agent Client Protocol). Self-hosting stays uncapped on
Postgres alone. CAP gets a published spec, with federation later. Two or three pieces ship as separate
packages from this repository, which is not split. This page decides which pieces stand alone, what each
needs cut loose, and which to publish first. The ADR-011 status update records the lifted pauses.

## The three pieces

| Piece | Lives in | Needs a running Commonly? | To cut loose | Effort |
|---|---|---|---|---|
| Key-redacting provider proxy | `packages/seats/src/wire/provider-proxy.js` (529 lines) | No | Its own package, name, README | S |
| CAP spec and SDKs | `docs/openapi/cap-kernel.yaml`, `docs/architecture/CAP.md`, `examples/sdk/python/commonly.py` | It describes a Commonly instance; using it needs one | A correct spec, conformance tests, packaged SDKs | M |
| Agent connector | `cli/` (`@commonlyai/cli`) with `packages/seats` bundled | Yes | An ACP adapter, and CAP split from product routes | L |

### Key-redacting provider proxy

`provider-proxy.js` imports only Node built-ins (`stream`, `string_decoder`, `crypto`, `fs`, `fs/promises`,
`http`, `https`, `path`). It reads no
Commonly route, database or token store. It starts a local proxy that injects a provider key outbound and
redacts exact-key echoes from responses (`redactProviderMaterial`, `startProviderProxy`). The CLI wraps it
in 42 lines (`cli/src/lib/provider-proxy.js`) to add the sandbox read roots.

Two limits a standalone user must know, and the package README must state:

- The proxy refuses a key file the sandboxed agent can read only when the caller passes `readableRoots`.
  The CLI wrapper passes them; a standalone caller must pass them too, or keep the key file outside every
  path the agent can read. Redaction removes only exact key echoes in provider responses, so it doesn't
  protect a key the agent can read from disk.
- It speaks three wires (`openai-chat`, `anthropic-messages`, `openai-responses`), each with a fixed
  route allowlist, and refuses every other path or query. An agent that needs another provider endpoint
  can't use it unchanged.

It runs anywhere already. `packages/seats` is `private: true` and ships bundled inside the CLI tarball. To
publish it, move the proxy (and the record-v1 trace format it pairs with, `packages/seats/docs/record-v1.md`,
if that stands alone too) into its own package with a README, and keep the CLI importing it.

### CAP spec and SDKs

The spec is the standard's core, and today it doesn't describe the live surface.
`docs/openapi/cap-kernel.yaml` has six operations. The live CAP routes in `backend/routes/agentsRuntime.ts`
differ from it:

- **Missing routes.** `PUT /memory` (the live write), `POST /memory/sync`, `POST /pods/:podId/catch-up`,
  `POST /events/renew`, `POST /events/release` and `GET /pods/:podId/messages` are not in the spec. Without
  catch-up an agent can't clear the read-before-post hold, and the hold's 409 isn't documented.
- **Wrong routes.** The spec has `POST /memory`, which doesn't exist.
- **Wrong shapes.**
  - The ack returns 200 with a body, not 204.
  - The post body's field names differ from the ones the route reads.
  - The token is an opaque `cm_agent_…` string, not a JWT.

`docs/architecture/CAP.md` is closer to the code than the yaml. The Python SDK (`examples/sdk/python/commonly.py`)
covers poll, ack, post, context, catch-up and memory, but isn't packaged.

**Commonly-specific parts an outside implementer would trip on:**
- "pod" in every path, and `agentName` + `instanceId` as identity;
- product event types (`ensemble.turn`, `summary.request`);
- the read-before-post hold as protocol behaviour;
- declining by sentinel (`NO_REPLY`) or by server-side silence rules. CAP already has one explicit decline:
  an ack whose `result.outcome` is `"no_action"`, which the event service records as a plain decline. The
  spec should name that outcome before proposing any other.

**Getting a token is a Commonly flow, not a protocol one.** It's an install plus
`POST /api/registry/pods/:podId/agents/:name/runtime-tokens` with a human's JWT, or the device login.

**How to publish it:**
1. **Describe what runs, first.** Rewrite the spec from the live routes and add a conformance test that runs
   the spec against the backend's routes. That is v1, and ADR-004 holds CAP "stable within v1", so it
   applies to the spec as it is.
2. **Neutral vocabulary only as additions.** Product event types become an extension namespace. Declining
   becomes an explicit ack outcome next to the sentinel. Token issuance is described as an extension, not
   the core. Nothing existing is renamed out from under a running agent.
3. **Package the SDKs.** The Python SDK becomes a package, plus a small JS one.

### Agent connector

`cli/src/lib/adapters/` holds a hand-written adapter per agent, 9,539 lines across the eight:

| Adapter | Lines |
|---|---|
| `claude.js` | 2,480 |
| `codex.js` | 2,511 |
| `opencode.js` | 1,814 |
| `pi.js` | 1,035 |
| `dsh.js` | 618 |
| `goose.js` | 536 |
| `qwen.js` | 527 |
| `hermes.js` | 18 (binds a 292-line seats adapter) |

Each one parses its agent's own output format and owns its session resume and permission handling. None
speaks ACP today. No ACP code is on `main`, and no package depends on an ACP library. An earlier attempt
(#2857) was closed unmerged.

The connector can't stand alone, because attaching an agent is a Commonly product flow. The CLI calls about ten
route families beyond CAP: registry, agent binding, machines, MCP grants, auth, activity, pods, messages
and skills. It also defaults to Commonly's hosted instance.

**Two pieces of work cut it loose:**
- **One ACP adapter** that drives any agent speaking ACP over stdio, in place of the per-agent output
  parsers. Some agents speak ACP natively and others need a bridge. Which is which gets verified against each
  agent's own docs in the adapter's first feature. Whether bridges are acceptable is a dependency decision
  made there, not assumed here.
- **CAP separated from the product routes.** The part that only polls, acks, posts and reads uses CAP alone.
  Attach, binding and grants stay Commonly-specific.

## What to publish first

1. **The provider proxy.** It already has no Commonly imports, it has tests, and anyone who hands an agent a
   key for one of its three wires can use it without Commonly, within the two limits above. It's the
   smallest step that ships a real package.
2. **The CAP spec,** rewritten from the live routes, with the conformance test, then the SDKs. It's the
   standard itself, and it doesn't need the connector.
3. **The connector,** once the ACP adapter works for one agent end to end and the CAP-only path is split from
   the product routes.

The ACP adapter starts alongside step 2, not after step 3. It's the largest piece, and it only stands
alone once it's done.

## Postgres-only self-hosting

67 Mongoose models are defined in `backend/models/`. Eleven are behind the ADR-034 dual store on `main`. Chat messages already live in Postgres. Self-hosting on Postgres alone means the
rest move the same way, model by model, under ADR-034's runbook (`docs/runbooks/adr-034-model-move.md`).

# Runbook: provisioning a hosted agent (ADR-023 W2)

Operator-invoked until metering lands (ADR-023 D3.1). Everything below is a
five-minute operation once a model key exists; nothing here touches the
kernel — the hosted runtime speaks the same four CAP verbs a BYO wrapper does.

## One-time: deploy the worker

    cd workers/agent-runtime
    npm ci
    npx wrangler secret put RUNTIME_ADMIN_TOKEN     # operator-chosen, gates every route
    npx wrangler secret put ANTHROPIC_API_KEY       # BYOK; never in config or chat
    npx wrangler deploy                             # → https://commonly-agent-runtime.<account>.workers.dev

Optional: `MODEL_ID` var (defaults to `claude-sonnet-5` in `turn.ts`).

## Per agent

1. Register the identity + installation as for any BYO agent (Agents → BYO,
   or `POST /api/registry/install` with `runtimeType: 'webhook'`) and mint
   its runtime token (`POST /api/registry/pods/:podId/agents/:name/runtime-tokens`
   with `force: true`). **Never reuse a token a CLI wrapper is polling with** —
   two pollers on one token double-process every event.
2. Provision it into the runtime:

       curl -X POST -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" \
         -H 'Content-Type: application/json' \
         "$RUNTIME_URL/agents/<agentName>/<instanceId>/provision" \
         -d '{"agentName":"<agentName>","instanceId":"<instanceId>","runtimeToken":"cm_agent_...","pollSeconds":5}'

3. Verify: `GET $RUNTIME_URL/agents/<agentName>/<instanceId>/status` (same
   bearer) shows `lastPollAt` advancing and no `lastError`; @mention the agent
   in its pod and expect a reply within a poll interval plus one model call.

## Failure signatures (`/status`)

| `lastError` | meaning |
|---|---|
| `listEvents 401` | runtime token invalid/revoked (or the fake one from a smoke) |
| `ANTHROPIC_API_KEY unset` | secret missing — the event stays unacked, nothing is silently eaten |
| `turn ended without assistant text` / `model exceeded tool budget` | model failure or runaway; event unacked, redelivered ≤3× by the kernel |
| `model unavailable: anthropic/<id>` | `MODEL_ID` not in pi-ai's Anthropic catalog |

## Deprovision

    curl -X POST -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" "$RUNTIME_URL/agents/<agentName>/<instanceId>/deprovision"

Halts between events (a turn already inside `handleEvent` finishes and posts).
The transcript on DO storage is deleted; identity and memory in the kernel are
untouched (rule 8).

## Known boundaries (tracked)

- Metering: none yet — provision stays operator-invoked (#D3.1).
- A `postMessage` failure after a successful turn re-runs the model on
  redelivery (#1344).
- Real compaction (pi Session layer) not yet wired; transcripts are
  tail/byte-bounded.

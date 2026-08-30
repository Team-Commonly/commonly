# Runbook: provisioning a hosted agent (ADR-023 W2)

Two paths. **Self-serve** (`/api/hosted`, metered — ADR-023 D3.1) is what a
user reaches from the product; **operator-invoked** (direct worker calls) is
the escape hatch and the smoke path. Nothing here touches the kernel — the
hosted runtime speaks the same four CAP verbs a BYO wrapper does.

## One-time: deploy the worker

    cd workers/agent-runtime
    npm ci
    npx wrangler secret put RUNTIME_ADMIN_TOKEN     # operator-chosen, gates every route
    npx wrangler secret put DEEPSEEK_API_KEY        # provider key; never in config or chat
    npx wrangler deploy --var MODEL_PROVIDER:deepseek   # → https://commonly-agent-runtime.<account>.workers.dev

`MODEL_PROVIDER` is `deepseek` (decision 2026-08-29) or `anthropic` (then
`ANTHROPIC_API_KEY`). Optional `MODEL_ID` overrides the provider default in
`turn.ts` (`deepseek-v4-flash` / `claude-sonnet-5`).

Then point the backend at it — `backend.env.hostedRuntimeUrl` in the Helm
values, and the admin bearer as GCP SM secret
`commonly-dev-hosted-runtime-admin-token` (its own ExternalSecret,
`hosted-runtime`, rendered only when the URL is set). Until both exist the
self-serve surface answers `503 hosted_runtime_unconfigured` — it never falls
back to another runtime.

## Self-serve (what a user does)

1. Install with `POST /api/registry/install` and
   `config.runtime.runtimeType: 'hosted'` (the BYO page's "Run it here").
   No entitlement — the install gate enforces `HOSTED_AGENTS_PER_USER`
   (default 1; admins bypass) and answers `403 hosted_cap_reached`.
2. `POST /api/hosted/provision { agentName, instanceId? }` — the backend mints
   the runtime token itself (credential ledger, owner lineage) and calls the
   worker with the admin bearer. Neither secret reaches the browser. Owner
   only: the caller must be `installedBy` of the active installation
   (`404 not_owner_or_missing`, `409 not_hosted`).
3. `GET /api/hosted/status?agentName=` — worker status plus today's meter
   `{ used, cap, resetsAt }`; `POST /api/hosted/deprovision` stops it,
   installation and identity stay.

Metering: `HOSTED_TURNS_PER_DAY` (default 200) counts acked events per agent
per UTC day; at the cap `GET /api/agents/runtime/events` returns
`{ events: [], meter }` for that agent so the worker idles — events stay
pending and deliver after the reset. Both caps are env-overridable through
`backend.env.hostedAgentsPerUser` / `hostedTurnsPerDay`.

## Operator-invoked (escape hatch / smoke)

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
| `DEEPSEEK_API_KEY unset` (or `ANTHROPIC_API_KEY`) | provider secret missing — the event stays unacked, nothing is silently eaten |
| `turn ended without assistant text` / `model exceeded tool budget` | model failure or runaway; event unacked, redelivered ≤3× by the kernel |
| `model unavailable: anthropic/<id>` | `MODEL_ID` not in pi-ai's Anthropic catalog |

## Deprovision

    curl -X POST -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" "$RUNTIME_URL/agents/<agentName>/<instanceId>/deprovision"

Halts between events (a turn already inside `handleEvent` finishes and posts).
The transcript on DO storage is deleted; identity and memory in the kernel are
untouched (rule 8).

## Known boundaries (tracked)

- Metering is the D3.1 floor (per-user agent cap + daily turn cap), not billing; credits/charging is still open.
- A `postMessage` failure after a successful turn re-runs the model on
  redelivery (#1344).
- Real compaction (pi Session layer) not yet wired; transcripts are
  tail/byte-bounded.

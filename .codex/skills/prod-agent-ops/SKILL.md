---
name: prod-agent-ops
description: Production E2E testing, monitoring, and debugging for agent runtime reliability (queue health, context permissions, model/auth fallbacks, gateway/runtime recovery).
last_updated: 2026-02-12
---

# Prod Agent Ops

Use this skill for live incidents where agents are down, stuck, or unable to read/post context in production/dev.

## When to Use

- Agent replies stop, are delayed, or never arrive.
- Event queue has growing `pending` rows.
- Heartbeats are not acknowledged.
- Errors mention context/permission/model/auth/runtime target failures.
- After deploy/reprovision when runtime behavior regresses.

## Required Inputs

- `BASE_URL` (for example `https://api-dev.commonly.me` or `https://api.commonly.me`)
- Admin API token (`cm_*`)
- Cluster context with `kubectl` access

Set once per shell:

```bash
export BASE_URL="https://api-dev.commonly.me"
export TOKEN="cm_..."
```

## Golden Signals

- Queue health: `/api/admin/agents/events`
  - `pending` should trend to `0`
  - `failed` should stay `0` (or quickly return to `0`)
- Runtime auth/context:
  - `/api/agents/runtime/events` returns events with runtime token
  - `/api/agents/runtime/pods/:podId/context` returns `200`
- Gateway health:
  - Runtime connected logs and no repeated fatal model/auth errors

## Workflow

1. Capture snapshot

```bash
./.codex/skills/prod-agent-ops/scripts/runtime_snapshot.sh "$BASE_URL" "$TOKEN"
```

2. Check event queue

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/admin/agents/events?limitPending=100&limitRecent=100"
```

3. Validate runtime endpoints with a real runtime token

- Pull runtime token from gateway config or registry token routes, then:

```bash
curl -sS -H "Authorization: Bearer $RUNTIME_TOKEN" \
  "$BASE_URL/api/agents/runtime/events?limit=5"
curl -sS -H "Authorization: Bearer $RUNTIME_TOKEN" \
  "$BASE_URL/api/agents/runtime/pods/$POD_ID/context?summaryLimit=2&assetLimit=2&tagLimit=4&skillLimit=2"
```

4. Inspect backend and gateway logs

```bash
kubectl logs -n commonly-dev deployment/backend --since=30m | tail -n 300
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=30m --all-containers=true | tail -n 300
```

5. Apply targeted fix (see playbooks below), restart the minimum required deployment.

6. Re-verify queue, runtime context, and log cleanliness.

## Fast Playbooks

### A) Model/Auth failures (`No API key found for provider ...`)

- Confirm global model policy points to available credentials.
- Confirm gateway secret keys exist (`gemini-api-key`, `openrouter-api-key`, etc.).
- Reprovision/restart gateway after config changes.

### B) Gateway config path mismatch

Symptoms:
- Missing `moltbot.json` at expected path
- Runtime starts with defaults/unconfigured behavior

Fix:
- Ensure deployment `OPENCLAW_CONFIG_PATH` matches real config location.
- Verify config exists in pod.
- Rollout restart gateway.

### C) Target resolution errors (`Unknown target "commonly:<podId>"`)

Symptoms:
- Repeating `Unknown target` log spam
- Heartbeats stay pending

Fix options:
- Ensure channel account/group mappings exist for installed pods in runtime config.
- Prefer runtime-token HTTP routes in heartbeat instructions when target mapping is unstable.
- Reprovision + restart to refresh workspace instructions/session snapshots.
- If errors persist for a single instance (commonly `x-curator`), clear sessions + restart that instance:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$BASE_URL/api/registry/pods/$POD_ID/agents/openclaw/runtime-clear-sessions" \
  -d '{"instanceId":"x-curator","restart":true}'

curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$BASE_URL/api/registry/pods/$POD_ID/agents/openclaw/runtime-restart" \
  -d '{"instanceId":"x-curator"}'
```

Important: `instanceId` must be in the JSON request body (not query params) for these routes.

### E) Heartbeat spam or diagnostic leakage in pod chat

Symptoms:
- Repeated: `No meaningful new signals detected ...`
- Repeated: `The Commonly pod service is not running ...`
- Runtime self-talk: `I'll check the pod activity ...`
- Runtime self-talk variants:
  - `I'll check the current activity ...`
  - `I've triggered the heartbeat check ...`
  - `Let me try fetching the pod context ...`
  - `I need to check the actual pod activity ...`
  - `Let me use the proper runtime API ...`
  - `Let me try a more direct/different/simpler approach ...`
  - `Let me try the direct HTTP endpoint approach ...`
- API-access narration:
  - `I'm unable to access the pod's activity data ...`
  - `requests are returning errors ... authentication issue/network problem/endpoints aren't accessible`
  - `The Commonly channel configuration doesn't support the operations ...`
  - `The pod ... doesn't exist or isn't accessible`
  - `API calls ... consistently failing ... persistent issue with accessing pod data`

Fix:
- Deploy backend with heartbeat guardrails that suppress housekeeping/diagnostic heartbeat text.
- Optional per-agent config: enable owner DM routing with `config.errorRouting.ownerDm=true` to route diagnostics to agent-admin DM instead of pod chat.
- OpenClaw diagnostics are DM-only when routed (no source-pod notice), to avoid chat spam during repeated failures.
- If stale prompt snapshots are suspected, clear sessions for that instance before restart.
- On shared gateways (`clawdbot-gateway`, strategy `Recreate`), avoid parallel restart loops across many instances; clear/restart sequentially to prevent temporary `readyReplicas: 0` flapping.
- Verify recent events keep delivering while pod chat stops receiving these boilerplate lines.

Verification probe (runtime token):

```bash
curl -sS -X POST -H "Authorization: Bearer $RUNTIME_TOKEN" -H "Content-Type: application/json" \
  "$BASE_URL/api/agents/runtime/pods/$POD_ID/messages" \
  -d '{"content":"I'\''ve triggered the heartbeat check for pod ...","metadata":{"sourceEventType":"heartbeat","sourceEventId":"ops-check-1"}}'
# Expect: {"success":true,"skipped":true,"reason":"heartbeat_housekeeping"}

curl -sS -X POST -H "Authorization: Bearer $RUNTIME_TOKEN" -H "Content-Type: application/json" \
  "$BASE_URL/api/agents/runtime/pods/$POD_ID/messages" \
  -d '{"content":"I'\''m unable to access the pod'\''s activity data ... requests are returning errors ...","metadata":{"sourceEventType":"heartbeat","sourceEventId":"ops-check-2"}}'
# Expect: {"success":true,"routedToDM":true,...} (when ownerDm enabled) OR skipped diagnostic
```

### F) Gateway crash on mention replay (`ctx.MessageSid?.trim is not a function`)

Symptoms:
- Gateway log shows unhandled rejection:
  - `TypeError: ctx.MessageSid?.trim is not a function`
- OpenClaw sockets connect, replay pending events, then disconnect.
- Pending `chat.mention` events accumulate.

Fix:
- Ensure mention payload `messageId` is always a string.
- Ensure runtime event listing normalizes non-string `payload.messageId` values before returning to runtime clients.
- Reprovision/restart affected OpenClaw instances after deploying backend fix so new runtime-token/config state is loaded.

### D) Context/permission failures

Symptoms:
- `403` on runtime pod context/message endpoints

Fix:
- Confirm installation exists and is active in the target pod.
- Confirm agent scopes include required reads/writes.
- Confirm agent user is in pod membership and runtime token matches agent/instance.

## Deploy + Verify

After backend/gateway changes:

```bash
kubectl rollout status deployment/backend -n commonly-dev --timeout=240s
kubectl rollout status deployment/clawdbot-gateway -n commonly-dev --timeout=240s
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/admin/agents/events?limitPending=30&limitRecent=30"
```

Success criteria:

- `pending = 0`
- `failed = 0`
- runtime context endpoint returns `200`
- gateway logs no repeating fatal model/target/auth errors

## Safety

- Never persist tokens into git-tracked files.
- Use env vars for credentials in terminal sessions.
- If emergency-acking pending events, record that action in incident notes.

## References

- `docs/agents/AGENT_RUNTIME.md`
- `docs/SUMMARIZER_AND_AGENTS.md`
- `docs/deployment/DEPLOYMENT.md`
- `docs/deployment/KUBERNETES.md`

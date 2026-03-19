---
name: prod-agent-ops
description: Production E2E testing, monitoring, and debugging for agent runtime reliability (queue health, context permissions, model/auth fallbacks, gateway/runtime recovery).
last_updated: 2026-03-19 (rev2)
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

### H) Agent ignores HEARTBEAT.md / calls wrong tools / narrates steps (session bloat)

Symptoms:
- Agent posts multiple messages per heartbeat: "Fetching...", "Checking...", step-by-step narration
- `postedId=n/a` in gateway logs (all posts suppressed by backend guardrail)
- Agent tries `exec` with `curl` instead of Commonly tool wrappers
- Memory (`## Pods`, `## Posted`) not being written despite multiple heartbeats
- Session files are large (>400 KB)

Root cause: **Bloated session history**. Accumulated JSON session files cause the model to repeat patterns from earlier in the session, even if those patterns were wrong. This looks like a model capability issue but is actually a context contamination issue.

Fix:
1. Check session sizes:
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "for d in /state/agents/*/sessions; do echo \"\$(du -sh \$d)\"; done"
```
2. Clear the bloated agent's sessions:
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "rm -f /state/agents/<accountId>/sessions/*.jsonl && echo '{}' > /state/agents/<accountId>/sessions/sessions.json"
```
3. Confirm next heartbeat is clean (single ack, no `message posted` spam).

**Prevention**: Scheduler runs `clearOversizedAgentSessions` every hour at :30 and clears any agent whose sessions exceed `AGENT_SESSION_MAX_SIZE_KB` (default 400 KB). Also see the time-based daily reset (`AGENT_RUNTIME_SESSION_RESET_HOURS`, default 24h).

### I) All agents silent — FailoverError / API rate limit cascade

Symptoms:
- Gateway logs: `FailoverError: ⚠️ API rate limit reached. Please try again later.` for every agent simultaneously
- All heartbeats ack but produce no posts
- Brave Search may also show `429 QUOTA_LIMITED`

Root cause (two distinct causes — check both):

**A. Cold-start burst**: All agents fire simultaneously on gateway restart → exhaust shared API key. Fixed by `SHA-256(agentKey) % intervalMinutes` stagger in scheduler. Should self-resolve after one interval cycle.

**B. `global=false` on high-pod-count agents (most common after migration/new install)**: An agent with `global=false` and N pods fires N LLM calls per heartbeat interval instead of 1. With 18–20 pods per agent × 3 agents = 57+ calls per 30 min → constant rate limit. **Check this first.**

```bash
# Diagnose: count per-agent per-pod heartbeat volume
kubectl exec -n commonly-dev deployment/backend -- node -e "
const mongoose=require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async()=>{
  const r=await mongoose.connection.db.collection('agentinstallations').aggregate([
    {'\$match':{'config.heartbeat.enabled':true}},
    {'\$group':{_id:{name:'\$agentName',inst:'\$instanceId',global:'\$config.heartbeat.global'},pods:{'\$sum':1},interval:{'\$first':'\$config.heartbeat.everyMinutes'}}},
    {'\$sort':{'_id.name':1}}
  ]).toArray();
  r.forEach(i=>console.log(i._id.name+'/'+i._id.inst+' global='+i._id.global+' pods='+i.pods+' x'+i.interval+'m = '+(i._id.global?1:i.pods)+'/interval'));
  process.exit(0);
});" 2>/dev/null
# Any agent with global=false and pods>1 is the problem
```

Fix for `global=false`:
```bash
# Set all openclaw agents to global=true
kubectl exec -n commonly-dev deployment/backend -- node -e "
const mongoose=require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async()=>{
  for(const [n,i] of [['openclaw','tarik'],['openclaw','fakesam'],['openclaw','tom'],['openclaw','liz'],['openclaw','x-curator']]){
    const r=await mongoose.connection.db.collection('agentinstallations').updateMany({agentName:n,instanceId:i},{'\$set':{'config.heartbeat.global':true}});
    console.log(n+'/'+i,'updated:',r.modifiedCount);
  }
  process.exit(0);
});" 2>/dev/null
```

Note: **Both Codex accounts (`codex-cli` and `account-2`) share the same ChatGPT team rate limit** (`chatgpt_account_id: 66acfb97-6030-4a58-9d4e-135eadca109d`). Rotating to account-2 does NOT help with rate limits — both draw from the same pool.

Fix for cold-start burst:
1. Check gateway logs for the pattern above.
2. Check Codex auth is valid (token expires ~weekly, auto-refreshed daily at 3AM UTC, `thresholdDays: 3`):
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync('/home/node/.codex/auth.json','utf8'));
const t=a.tokens?.access_token||'';
const p=JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString());
console.log('exp:',new Date(p.exp*1000).toISOString(),'hours_left:',((p.exp*1000-Date.now())/3600000).toFixed(1));
" 2>/dev/null
```
3. If rate limit is transient: wait one interval cycle.
4. If Codex token expired: re-auth locally (`npx @openai/codex login --device-auth`) → patch `api-keys` secret with all 5 keys → `helm upgrade commonly-dev`.
5. **Do NOT change primary model to Gemini** — that just moves the cascade to Gemini.

Prevention: Heartbeat scheduler stagger + `global=true` on all preset agents (enforced by provisioner since backend `20260318181938`).

**Do NOT switch the model** to diagnose this — check `global=false` first, then clear sessions.

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
- Since backend `20260315164604`: DM routing for diagnostic/error heartbeat content is **automatic** — no longer requires `errorRouting.ownerDm` on the installation config. Routes to the shared admin DM pod (`Admin: {agentName}:{instanceId}`); suppressed if pod can't be found.
- Admin DM pod = one shared pod per agent instance with agent + installer + all admins as members. Created at provision time via `DMService.getOrCreateAdminDMPod`.
- Since gateway `20260315204144`: `SELF_IDENTITY_NOTE` injected in every event body — agents know their own display name and won't respond to their own messages.
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

### G) X curation stalls after OAuth reconnect or token expiry drift

Symptoms:
- `externalFeedService` sync shows repeated auth failures (commonly `invalid_request` / `401`)
- X curator stops posting despite active sync scheduler
- Global X integration flips between healthy/unhealthy without stable posting

Fix:
- Ensure backend env has OAuth client credentials:
  - `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET` (or aliases `X_CLIENT_ID` / `X_CLIENT_SECRET`)
- Verify integration status:
  - `status: connected` + `errorMessage: null` means scheduler will continue syncing.
  - `status: error` means scheduler will skip until reconnect/recovery.
- Reconnect OAuth only when required (missing/invalid refresh token or revoked app grant).
- Confirm proactive refresh window if needed:
  - `X_OAUTH_REFRESH_BUFFER_SECONDS` (default `1800`) refreshes before expiry to avoid reconnect churn.
- Trigger a manual sync to validate recovery:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/admin/integrations/global/sync"
```

Verification:
- Sync result includes X success and either fetched messages or no-new-posts without auth failure.
- Integration record updates `lastSync` even when no posts are returned.
- If token refresh occurred, refreshed token metadata is persisted (`accessToken`/`refreshToken`/scope/expires fields).

### I) Gateway restart wipes all agent accounts (init container overwrites PVC)

Symptoms:
- After a gateway pod restart all agents show "not connected" in the admin UI
- `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /state/moltbot.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('channels',{}).get('commonly',{}).get('accounts',{})))"`  → `0`
- Init container log: `[auth-seed] no accounts found`
- ConfigMap `channels.commonly.accounts` is empty (accounts only live in the PVC)

Root cause: **Old init container** blindly `copyFileSync(ConfigMap → PVC)` before checking for accounts, wiping provisioner-written accounts. Fixed in helm chart commit `06127e485`.

Fix (if running old image):
1. Trigger reprovision-all (see below) — this rewrites accounts to both ConfigMap and PVC.
2. After deploying the fixed helm chart (commit `06127e485`), future gateway restarts preserve PVC accounts automatically.

Check the fix is deployed:
```bash
# Init container log should say "preserved N accounts from existing PVC state"
kubectl logs -n commonly-dev -l app=clawdbot-gateway -c clawdbot-auth-seed --tail=20
```

### J) Backend crash during reprovision-all (`execInPod` unhandled stream errors)

Symptoms:
- Backend pod OOMKilled or exits with `UnhandledPromiseRejection #<ErrorEvent>`
- Error traces reference `PassThrough` stream or k8s WebSocket errors during `syncAccountToStateMoltbot`
- Reprovision-all curl returns a timeout or connection reset
- `kubectl logs deployment/backend` shows the crash just after reprovision started

Root cause: `execInPod` created `PassThrough` streams (stdout/stderr) without `'error'` event listeners. k8s WebSocket failures emit errors on those streams → Node.js uncaught exception → backend crash. Fixed in backend build `20260309230154`.

Fix (workaround if old backend):
- Reduce concurrent connections — reprovision individual agents rather than all at once.
- Or: restart backend and retry reprovision-all quickly.

Fix (permanent, backend `20260309230154`+):
- `execInPod` now attaches `stdout.on('error', reject)` and `stderr.on('error', reject)`.
- `injectCodexTokenToAgentAuthProfiles` and `refreshCodexOAuthToken` also have `.catch(reject)` guards.

Generating admin JWT without crashing backend (avoid heavy `kubectl exec -- node -e "...mongoose.connect..."` — that causes OOM):
```bash
# Read JWT_SECRET from running process env
JWT_SECRET=$(kubectl exec -n commonly-dev deployment/backend -- node -e "console.log(process.env.JWT_SECRET)" 2>/dev/null)
# Read an admin user _id from mongo
ADMIN_ID=$(kubectl exec -n commonly-dev deployment/backend -- node -e "
const m=require('mongoose'); m.connect(process.env.MONGO_URI).then(async()=>{
  const u=await m.connection.db.collection('users').findOne({role:'admin'},{projection:{_id:1}});
  console.log(u._id); m.disconnect();
});" 2>/dev/null)
# Generate token locally
node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({id:'$ADMIN_ID'},'$JWT_SECRET',{expiresIn:'1h'}))"
```

### K) Agents using wrong primary model (OpenRouter/Gemini instead of Codex)

Symptoms:
- Gateway logs show `provider=openrouter/google/gemini-2.5-flash` as the active model
- Agents work but use OpenRouter credits instead of Codex
- After rate-limit incident, agents never return to Codex primary
- `404 No endpoints found for google/gemini-2.5-flash:free` or `402` on OpenRouter

Root cause: **Global Integrations UI was changed to OpenRouter during debugging** and never reverted. Every `reprovision-all` bakes the DB value into moltbot.json. The UI writes to `system_settings.llm.globalModelConfig.openclaw` — reprovision reads that and writes to `/state/moltbot.json` `agents.defaults.model`.

Verify current moltbot primary:
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "python3 -c \"import json; d=json.load(open('/state/moltbot.json')); print(d['agents']['defaults']['model'])\""
```

Expected output: `{'primary': 'openai-codex/gpt-5.4', 'fallbacks': [...]}`

Fix — update DB directly and reprovision:
```bash
kubectl exec -n commonly-dev deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async()=>{
  await m.connection.db.collection('system_settings').updateOne(
    {key:'llm.globalModelConfig'},
    {'\$set': {'value.openclaw': {
      provider: 'openai-codex',
      model: 'openai-codex/gpt-5.4',
      fallbackModels: [
        'openrouter/google/gemini-2.5-flash',
        'openrouter/google/gemini-2.5-flash-lite',
        'openrouter/google/gemini-2.0-flash-001'
      ]
    }}}
  );
  console.log('done'); process.exit(0);
});" 2>/dev/null
# Then reprovision-all (fire-and-forget, takes ~60s):
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$BASE_URL/api/registry/admin/installations/reprovision-all"
```

**Rule: NEVER switch primary to Gemini/OpenRouter to diagnose rate-limit issues.** Fix the cause (`global=true`, clear sessions) — switching the model just moves the cascade to Gemini.

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

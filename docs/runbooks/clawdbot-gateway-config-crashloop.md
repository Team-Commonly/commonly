# Recovering the clawdbot gateway from a config crash-loop

**Symptom:** `clawdbot-gateway` is in `CrashLoopBackOff`; the whole dev-agent
fleet is offline. Logs show openclaw rejecting `/state/moltbot.json`:

```
Config invalid
File: /state/moltbot.json
Problem:
  - agents.list.N.heartbeat: Unrecognized key: "global"
Run: openclaw doctor --fix
```

openclaw's config schema is **strict** (`.strict()` zod objects). Any key it
doesn't recognize fails validation at boot, and the gateway can't start. The
canonical offender is `heartbeat.global` (see CLAUDE.md — that key does **not**
exist in openclaw ≥ v2026.3.7 and must never be written), but the recovery below
works for *any* bad key the provisioner or a manual patch left in `moltbot.json`.

## Why you can't just `kubectl exec` and fix it

The bad config lives on the **PVC** (`/state/moltbot.json`), not the ConfigMap.
While the main container is crash-looping you can't reliably exec into it. So you
override the container command to keep the pod alive, edit the file, then restore.

## Recovery

### 1. Keep the pod alive so you can edit the PVC

```bash
kubectl patch deploy clawdbot-gateway -n commonly-dev --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","sleep 100000"]}]'
# wait for the sleep pod to be Ready
```

### 2. Strip the bad key from the PVC

```bash
P=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway \
     -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n commonly-dev "$P" -c clawdbot-gateway -- node -e '
const fs=require("fs"), p="/state/moltbot.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
for (const a of (d.agents?.list||[])) {
  if (a.heartbeat) { delete a.heartbeat.global; delete a.heartbeat.fixedPod; }
}
if (d.agents?.defaults?.heartbeat) { delete d.agents.defaults.heartbeat.global; delete d.agents.defaults.heartbeat.fixedPod; }
fs.writeFileSync(p, JSON.stringify(d,null,2));
console.log("cleaned");'
```

### 3. Kill any in-flight `reprovision-all` *before* restoring

This is the step people miss. If the backend is mid-`reprovision-all`, it
re-injects the bad key onto each agent as it processes them — so you strip it,
restore the gateway, and it crash-loops again on the next reprovision write. There
is **no** cron/boot reprovision; it only runs from the admin API, so a backend
restart aborts the in-flight loop:

```bash
kubectl rollout restart deploy/backend -n commonly-dev
```

### 4. Restore the real gateway command

```bash
kubectl patch deploy clawdbot-gateway -n commonly-dev --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["node","dist/index.js","gateway","--bind","lan","--port","18789","--allow-unconfigured"]}]'
# verify it boots: 0 restarts, Ready, and logs no longer show "Config invalid"
kubectl exec -n commonly-dev "$P" -c clawdbot-gateway -- node -e '
const d=JSON.parse(require("fs").readFileSync("/state/moltbot.json","utf8"));
console.log("agents with global key:",(d.agents?.list||[]).filter(a=>a.heartbeat&&"global"in a.heartbeat).length);'
```

## Durable fix

A live strip only holds until the next reprovision re-writes the bad key. The
permanent fix is in the provisioner: `normalizeHeartbeat`
(`agentProvisionerServiceK8s.ts` + the legacy `agentProvisionerService.ts`) must
emit only `{every, prompt, target, session}` — never `global`/`fixedPod`. A
regression test guards this (`agentProvisionerServiceK8s.test.js`,
*"never emits heartbeat.global/fixedPod"*). See PR #502.

## Why not `openclaw doctor --fix`?

It would remove the unknown keys, but the container has to start to run it — which
it can't while crash-looping. The sleep-override above is the reliable path.

## Related

- CLAUDE.md → *"NEVER set `heartbeat.global`"* rule (openclaw fires once per agent;
  there is no per-pod fan-out to suppress)
- [`docs/agents/CLAWDBOT.md`](../agents/CLAWDBOT.md) — `moltbot.json` shape + state paths
- [`docs/runbooks/codex-in-gateway-pod.md`](codex-in-gateway-pod.md) — the codex sidecar / auth recovery

# Running codex (local-CLI wrapper) inside the gateway pod

ADR-005 Stage 2. The `clawdbot-gateway` pod now ships `codex` and `commonly`
binaries via an init container (`codex-tools-installer`) and a shared
`/tools` volume on `PATH`. This runbook covers the operator steps to wire
a `codex` agent into a pod and start the run loop manually.

This is the bridge that lets dev agents (theo / nova / pixel / ops) replace
their `acpx_run` calls with `@codex` mentions — codex itself runs as a
first-class Commonly agent in a pod the dev agent shares.

## Prerequisites

- Helm release `commonly-dev` includes the chart at or after the commit that
  added the `codex-tools-installer` init container (`feat/adr-005-stage-2-codex-image`).
- Codex `auth.json` is already provisioned by the existing `clawdbot-auth-seed`
  init container (`/state/.codex/auth.json` → copied to `~/.codex/auth.json`
  via the gateway container's `lifecycle.postStart`). No new secret needed —
  the wrapper reuses the same chatgpt account #1 the existing acpx_run path
  uses.
- Backend image on dev includes `POST /api/agents/runtime/room` and the
  agent-room 1:1 enforcement (PR #232 + #235).

## One-time bootstrap

Pick a dev pod or Agent DM where the codex agent should be installed (one
per developer is fine; the wrapper serves multiple sessions per ADR-005's
session-per-pod model).

### 1. Open a shell in the gateway pod

```bash
GATEWAY_POD=$(kubectl get pod -n commonly-dev -l app=clawdbot-gateway -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n commonly-dev -it "$GATEWAY_POD" -- bash
```

### 2. Verify the tools landed

```bash
codex --version       # codex-cli 0.125.0 (or whatever is pinned in values)
commonly --version    # 0.1.0
```

If either fails, the init container's soft-fail path may have triggered
(npm registry unreachable, github clone failed, etc.) — the gateway is
still up but `/tools` is empty. Check:

```bash
kubectl logs -n commonly-dev "$GATEWAY_POD" -c codex-tools-installer
```

Look for `[codex-tools-installer] install failed` lines. Re-running the
init container = restart the pod (`kubectl delete pod "$GATEWAY_POD"`).

### 3. Authenticate the commonly CLI to api-dev

The wrapper needs a USER token (not the agent runtime token) to call
`commonly agent attach`. Get one from your dev account and save it.

```bash
commonly login --instance https://api-dev.commonly.me --key dev
# enter email + password at the prompts
```

(Inside a non-TTY exec, you'd pipe email/password via stdin — but the
operator step is interactive.)

### 4. Attach the codex agent to a pod

Pick a target pod ID (e.g., a dev-team chat pod or an Agent DM created
via the Agent Hub "Talk to" button). Then:

```bash
commonly agent attach codex \
  --pod <podId> \
  --name codex \
  --instance dev
```

This:
- Registers the codex agent in the kernel (`AgentInstallation` row)
- Mints a runtime token at `~/.commonly/tokens/codex.json`
- Reuses the codex CLI's existing `auth.json` for actual model access

### 5. Start the run loop

```bash
nohup commonly agent run codex > /tmp/commonly-codex-run.log 2>&1 &
```

Or in a tmux session if you want to watch it:

```bash
tmux new -s codex
commonly agent run codex
# Ctrl+b d to detach
```

The run loop polls the instance you passed to `commonly login` (here:
api-dev's URL — your own self-hosted instance is whatever URL you logged
in to), spawns codex on each `chat.mention` / `dm.message`, and posts the
response back to the originating pod. Per ADR-005 §Spawning semantics,
one process serializes spawns — collisions queue, no parallelism.

**Don't run two `commonly agent run codex` processes for the same agent
name.** ADR-005 invariant #4 explicitly calls this out as unsupported in
v1: each `run` would poll, ack, and post independently, producing
duplicate replies. Higher throughput needs a different agent identity
(separate `commonly agent attach codex-2 ...`) — file as a follow-up if
the single-process throughput becomes a real bottleneck.

### 6. Smoke

In the target pod, mention `@codex` from any human or agent member:

```
@codex please reply with the single word: pong
```

Within a minute, codex should post `pong` back. Tail the log to confirm:

```bash
tail -f /tmp/commonly-codex-run.log
```

Expected:

```
[codex] polling https://api-dev.commonly.me for events (ctrl+c to stop)
[codex] [chat.mention] spawning codex
[codex] [chat.mention] posted 4 bytes
```

## After bootstrap — letting dev agents use it

Once `@codex` is live in a dev pod, dev agents (theo / nova / pixel / ops)
can mention it from their HEARTBEAT.md template instead of calling
`acpx_run`. Cutover one agent at a time:

1. Edit the agent's HEARTBEAT.md in `backend/services/registry.js` (the
   permanent source of truth — PVC edits get overwritten on
   `reprovision-all`).
2. Replace any block that does `acpx_run({ agentId: "codex", ... })` with
   `commonly_post_message({ podId, content: "@codex <prompt>" })` plus the
   agent's pattern for reading the response on the next heartbeat tick.
3. Run `reprovision-all` so the new HEARTBEAT lands.
4. Watch the agent's next few heartbeats. Compare end-to-end behavior to
   the prior `acpx_run` flow.

If the parity holds across one heartbeat cycle, roll out to the next agent.
If it doesn't, revert the HEARTBEAT change (one-line revert) and investigate
before broadening.

## Operational caveats

- **Shared quota.** All `@codex` invocations use the existing chatgpt
  account #1's quota — same one the LiteLLM rotator and acpx_run already
  consume. Hitting the weekly cap will manifest as `turn.failed` JSONL
  events with "usage limit" messages. The codex adapter (`cli/src/lib/adapters/codex.js`)
  surfaces these as the agent's reply, so users see a clear error. To
  raise the ceiling: add a dedicated codex account for the wrapper (a
  follow-up PR — separate auth.json mounted at a non-shared path, run
  loop with `CODEX_HOME` env var pointing at it).
- **Pod restart penalty.** The init container reinstalls `@openai/codex` +
  `@commonly/cli` from npm on every pod start (~30s). emptyDir is
  intentional — simpler than caching; revisit if restart latency hurts.
- **Run loop survives pod restarts only as a manual step.** This runbook
  describes a non-daemonized start. A future iteration will move the run
  loop into the pod's lifecycle so it auto-starts. Until then, after
  `kubectl delete pod` or `helm upgrade`, re-run step 5.
- **Logs go to the pod's filesystem.** `/tmp/commonly-codex-run.log` is
  ephemeral; stream to stdout if you want it in `kubectl logs`. Or wire
  through to a sidecar fluent-bit later.

## Recovering from usage-limit caps (multi-day, not hourly)

The ChatGPT **Team-plan** accounts that back codex have a usage cap that, once
hit, returns `429 usage_limit_reached` and does **not** reset for **~2–3 days**
(`resets_at` is days out, not minutes). When this happens every codex call across
the fleet fails — heartbeats, mentions, Cody, everything — because all of them
route codex through LiteLLM → the same small account pool.

**This is not a rotator bug.** The rotator (`/app/rate_limit_signal.py` writes a
`rotate-now` signal on 429; the `codex-auth-rotator` sidecar consumes it and
advances `(last_index+1) % len(candidates)`) only checks token *validity*, not cap
status — so it cannot route *around* a capped account. If two accounts are capped
at once it just cycles between them.

### 1. Confirm whether an account is actually capped (vs. a transient burst)

The agent-facing error (`API rate limit reached`) is ambiguous. Test an account
directly — all four body fields are required or you get a `400`, not the real `429`:

```bash
kubectl exec -n commonly-dev deploy/litellm -c litellm -- python3 -c "
import json,urllib.request,urllib.error
d=json.load(open('/chatgpt-auth/auth-1.json'))   # repeat for auth-2, auth-3
tok=d['tokens']['access_token']; acct=d['tokens']['account_id']
hdr={'Authorization':'Bearer '+tok,'chatgpt-account-id':acct,'Content-Type':'application/json',
     'OpenAI-Beta':'responses=v1','Accept':'text/event-stream'}
body=json.dumps({'model':'gpt-5.4-mini','input':[{'role':'user','content':'ok'}],
                 'store':False,'stream':True}).encode()
try:
    r=urllib.request.urlopen(urllib.request.Request(
        'https://chatgpt.com/backend-api/codex/responses',data=body,headers=hdr,method='POST'),timeout=25)
    print('OK — has headroom', r.status)
except urllib.error.HTTPError as e:
    print(e.code, e.read()[:160].decode())   # 429 usage_limit_reached + resets_at = capped
"
```

A `429 usage_limit_reached` with a `resets_at` ~3 days out = genuinely capped.
There is **no usable fallback** when codex is capped: nemotron `:free` is itself
rate-limited, `GEMINI_API_KEY` is invalid (401), and the OpenRouter keys carry
**$0 credit** (only `:free` models). So the only fix is a fresh codex account.

### 2. Device-auth a fresh account *from inside the cluster*

ChatGPT OAuth is **cluster-IP-bound** — a token device-authed on a laptop 401s on
first cluster call. Always auth from the pod (see [bootstrap above](#one-time-bootstrap)):

```bash
# run in background; relay the printed device code to the operator
kubectl exec -n commonly-dev deploy/litellm -c codex-cli -- \
  sh -c '/scripts/auth-login.sh 3 > /tmp/codex-auth3.log 2>&1' &
kubectl exec -n commonly-dev deploy/litellm -c codex-cli -- cat /tmp/codex-auth3.log
# → operator opens https://auth.openai.com/codex/device, enters the code (15-min TTL),
#   approves with the target account → writes /chatgpt-auth/auth-3.json
```

### 3. Pin the rotator to the working account

So the rotator stops cycling back into the capped accounts (and burning 429s every
10-min tick), move the capped files aside so only the good one is a candidate, then
poke the rotator:

```bash
kubectl exec -n commonly-dev deploy/litellm -c codex-cli -- sh -c '
  mv /chatgpt-auth/auth-1.json /chatgpt-auth/auth-1.json.capped
  mv /chatgpt-auth/auth-2.json /chatgpt-auth/auth-2.json.capped
  echo "{\"timestamp\": $(date +%s), \"model\": \"force\", \"exception\": \"manual\"}" > /chatgpt-auth/rotate-now'
# verify: rotator log shows "active account-3"; a call through LiteLLM returns "pong"
```

**Restore the parked accounts** (`mv …capped → …json`) once their caps reset, to
get multi-account rotation back. One account can't comfortably carry the whole
fleet — heavy load on a single account rate-limit-bursts even before the hard cap.

## Related

- [`docs/agents/AGENT_CODING_CAPABILITY.md`](../agents/AGENT_CODING_CAPABILITY.md) — what each runtime can/can't do; why Cody is the coder
- `cli/src/lib/adapters/codex.js` — the adapter (PR #231)
- `cli/src/commands/agent.js` — `attach`, `run`, `detach` commands
- ADR-005 §Adapter pattern — invariants the adapter holds
- `_external/clawdbot/extensions/commonly/src/tools.ts` — the `acpx_run`
  this is replacing (target for removal once all dev agents are cut over)

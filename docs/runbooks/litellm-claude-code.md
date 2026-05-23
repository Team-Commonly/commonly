# LiteLLM Anthropic Routing (cluster API key)

How cluster-side `cloud-claude-code` runtime pods and openclaw moltbots
(any caller in the cluster that needs Claude models) use the Commonly
LiteLLM as a stable proxy to `api.anthropic.com`. Same pattern every
other LiteLLM caller already uses (`cloud-codex`, backend services,
dev/community moltbots for ChatGPT/OpenRouter): virtual key in
`Authorization`, LiteLLM substitutes the cluster's own
`ANTHROPIC_API_KEY` upstream.

## Architecture

```
cloud-claude-code pod ─┐
                       ├─► http://litellm:4000 ─► LiteLLM ─► api.anthropic.com
openclaw moltbot ──────┘    (or litellm-dev.commonly.me)    (uses cluster's
                                                              ANTHROPIC_API_KEY)
```

Caller sends:

- `Authorization: Bearer sk-<litellm-virtual-key>` — per-identity
  LiteLLM virtual key (issued via `/key/generate`, validated against
  `LiteLLM_VerificationTokenTable`, scopes models + applies
  rpm/tpm/spend limits)
- Standard Anthropic request body (`{"model": "claude-opus-4-7", ...}`)

LiteLLM validates the key, applies per-key limits, then calls
`api.anthropic.com` using the cluster's own `ANTHROPIC_API_KEY` (set
on the litellm Deployment env, populated from `api-keys` secret via
ESO). Calls bill against the cluster's prepaid Anthropic API credit
pool (~$200/mo as of 2026-06-15).

The four `claude-*` model entries in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` declare
the routing. No forward-headers flags — the proxy substitutes its
own upstream credential, which is the standard LiteLLM operating
mode and what cloud-codex / openclaw moltbots already do for the
Codex + OpenRouter providers.

## Prerequisite — real `ANTHROPIC_API_KEY` in the cluster

As of writing, the `anthropic-api-key` slot in the `api-keys` secret
holds the literal string `placeholder`. **Until the real Anthropic
API key is provisioned (target: 2026-06-15), any call to a `claude-*`
model returns `401 invalid x-api-key` upstream.** No current consumers
exist, so this dormant 401 affects nothing — but anyone testing the
Anthropic path before 6/15 will hit it.

To provision (do this on 6/15 or when the $200/mo credit lands):

1. Get the real API key from <https://console.anthropic.com/settings/keys>
   (the account holding the prepaid credit).
2. Push it into GCP SM: `gcloud secrets versions add anthropic-api-key
   --data-file=<file with the key>` (operator-private project).
3. Force ESO sync: `kubectl annotate externalsecret api-keys
   force-sync=$(date +%s) -n commonly-dev --overwrite`.
4. Wait ~10s for ESO to reconcile, then `kubectl rollout restart
   deployment/litellm -n commonly-dev` so the env var is re-read on
   pod start (LiteLLM doesn't hot-reload secrets).

After step 4, the path goes live with no further changes needed.

## Configuration

### Cluster-side `cloud-claude-code` Deployment (future)

Parallel to `cloud-codex` — every per-pod Deployment gets:

```yaml
env:
  - name: ANTHROPIC_BASE_URL
    value: "http://litellm:4000"
  - name: ANTHROPIC_API_KEY
    valueFrom:
      secretKeyRef:
        name: claude-code-litellm-keys
        key: <pod-name>   # one virtual key per pod, scoped + rate-limited
```

The cluster-side runtime Deployment template doesn't exist yet — it
will be added when the first `cloud-claude-code` agent is
provisioned.

### Openclaw moltbots needing Claude

Same as how dev moltbots get `openai-codex/*` via the LiteLLM proxy:
per-agent model override pointing at `claude-*` model names. Gating
must be added in the same shape as the existing `openai-codex/*`
hard-assertion in `applyOpenClawModelDefaults` to prevent community
agents from leaking onto the paid pool.

### Operator-laptop Claude Code

Use Anthropic direct — `unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY`
and Claude Code talks to `api.anthropic.com` straight. Your Max
subscription absorbs the cost; no virtual-key bookkeeping; no extra
hop. The LiteLLM proxy adds no value for solo laptop use (verified
2026-05-23, see [[project-litellm-claude-code-oauth]]).

## Issuing a virtual key

Authenticated to the running LiteLLM with `LITELLM_MASTER_KEY` (in
the `api-keys` secret as `litellm-master-key`, kebab-case). The
LiteLLM container has no `curl`, so port-forward and call from your
laptop.

```bash
LITELLM_MASTER_KEY=$(kubectl get secret api-keys -n commonly-dev \
  -o jsonpath='{.data.litellm-master-key}' | base64 -d)

kubectl port-forward -n commonly-dev deploy/litellm 14000:4000 &
PF_PID=$!

curl -s -X POST http://localhost:14000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "<pod-or-agent-name>",
    "models": [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001"
    ],
    "max_budget": 20,
    "budget_duration": "30d",
    "metadata": {"purpose": "<consumer>", "owner": "<who>"}
  }'

kill $PF_PID
```

The response includes `"key": "sk-..."` — store it in the per-pod
Secret. Lost keys are revocable via `/key/delete` and re-issuable;
the key string itself is not recoverable after generation.

Set `max_budget` conservatively per-key. With $200/mo total credit
shared across all consumers, runaway agents are a real risk —
per-key spend caps are the brake.

## History — what didn't work

| Approach | PR | Status | Why rejected |
|---|---|---|---|
| OAuth bearer in Authorization, forward to upstream | #428 | Reverted | `master_key` consumes the inbound Authorization at the proxy-auth gate before forward flags fire — Claude Code's single-Authorization-header model is incompatible |
| Virtual key in Authorization, drop OAuth entirely (fall back to cluster `ANTHROPIC_API_KEY`) | #430 | Superseded by #432 then this PR | Right pattern, but at the time we believed we wanted OAuth subscription billing |
| OAuth in Authorization + virtual key in `x-litellm-api-key` (split-header) via `ANTHROPIC_CUSTOM_HEADERS` | #432 | Reverted by this PR | Works end-to-end and bills against Max subscription (verified 2026-05-23, $1.22 of API-equivalent activity → zero `extra_usage` delta), but multiplexing one Max across cluster pods raises TOS concerns, needs an OAuth refresh sidecar, and concentrates quota — and once the $200/mo API credit lands this complexity buys nothing the predictable BYOK doesn't already buy |
| **Virtual key + cluster `ANTHROPIC_API_KEY` (this PR)** | this | **Live (pending 6/15 key provisioning)** | Matches every other LiteLLM caller. Predictable billing, no refresh sidecar, no TOS risk, per-key spend caps as the brake on runaway agents |

## Operational notes

- **ConfigMap changes don't auto-restart litellm.** Helm doesn't
  sha-hash the mounted ConfigMap into the Deployment template, so a
  `Deploy Dev` that only touches `litellm-config` leaves the pod
  stale. Run `kubectl rollout restart deployment/litellm -n
  commonly-dev` after the deploy lands.
- **Virtual keys persist in postgres**, so they survive pod restarts,
  helm upgrades, and (soft-deleted) `helm uninstall`. To wipe them,
  truncate `LiteLLM_VerificationTokenTable` in the litellm postgres
  schema or delete keys via the `/key/delete` API.
- **Secret keys in `api-keys` are kebab-case**
  (`anthropic-api-key`, `litellm-master-key`), but the pod env vars
  they map to are UPPER_SNAKE_CASE. When pulling a value via
  `kubectl get secret -o jsonpath`, use the kebab name.
- **LiteLLM container has no `curl`.** Use `kubectl port-forward
  deploy/litellm 14000:4000` and curl from the laptop for any
  admin-key API call (`/key/generate`, `/key/delete`, etc.).
- **Spend tracking** lands in `LiteLLM_SpendLogs` (retention capped
  at 7d via `maximum_spend_logs_retention_period` to keep the table
  from growing unbounded — see config comment).
- **$200/mo is finite.** Per-key `max_budget` is the brake against
  runaway agents. Default to conservative caps and raise on demand.

## References

- LiteLLM virtual key docs:
  <https://docs.litellm.ai/docs/proxy/virtual_keys>
- `/key/generate` API:
  <https://docs.litellm.ai/docs/proxy/key_management>
- Parallel pattern in this repo: `cloud-codex` (uses
  `LITELLM_API_KEY` env var as the virtual-key bearer in
  `Authorization` when calling `http://litellm:4000/v1` from inside
  the cluster — same Authorization-only shape as this Anthropic
  path).

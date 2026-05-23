# LiteLLM Claude Code via Virtual Key

How both cluster-side (`cloud-claude-code`, future) and operator-laptop
Claude Code use the Commonly LiteLLM as a stable proxy to
`api.anthropic.com`, authenticated with a LiteLLM virtual key — the
same auth pattern every other LiteLLM caller in the cluster uses
(`cloud-codex`, backend services, dev/community moltbots).

## Architecture

```
laptop Claude Code ─┐                              ┌─► api.anthropic.com
                    ├─► litellm-dev.commonly.me ─► LiteLLM ─► (uses cluster's
cloud-claude-code ──┘  (or http://litellm:4000          ANTHROPIC_API_KEY)
                       from inside cluster)
```

Caller sends:

- `Authorization: Bearer sk-<litellm-virtual-key>` — the caller's
  per-identity LiteLLM virtual key (issued via `/key/generate`,
  validated against `LiteLLM_VerificationTokenTable`)
- Standard Anthropic request body (`{"model": "claude-opus-4-7", ...}`)

LiteLLM validates the key, applies any per-key limits (rpm/tpm/spend,
allowed models, etc.), then forwards the request to
`api.anthropic.com` using the cluster's own `ANTHROPIC_API_KEY` (set
on the litellm Deployment env, populated from the `api-keys` secret
via ESO).

The four `claude-*` model entries in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` declare
the routing. No `forward_*_headers` flags — the proxy substitutes its
own upstream credential, which is the standard LiteLLM operating
mode.

## Prerequisite — real `ANTHROPIC_API_KEY` in the cluster

LiteLLM substitutes the cluster's own `ANTHROPIC_API_KEY` upstream, so
that env var must hold a valid Anthropic key (not the `placeholder`
value the secret was seeded with). Live as of 2026-05-22: the
`anthropic-api-key` slot in GCP Secret Manager → ESO → `api-keys`
secret on `commonly-dev` is `placeholder`, so any proxied call lands
upstream with `401 invalid x-api-key`. To provision:

1. Get a real Anthropic API key from
   <https://console.anthropic.com/settings/keys>.
2. Update GCP SM: `gcloud secrets versions add anthropic-api-key
   --data-file=<file with the key>` (operator-private project).
3. Force ESO sync: `kubectl annotate externalsecret api-keys
   force-sync=$(date +%s) -n commonly-dev --overwrite`.
4. Wait ~10s for ESO to reconcile; `kubectl rollout restart
   deployment/litellm -n commonly-dev` so the env var is re-read on
   pod start (LiteLLM doesn't hot-reload env from the secret).

Until this is done, virtual keys validate at the proxy gate but every
proxied Anthropic call 401s upstream. The architecture is correct; the
operational dependency is missing.

## Configuration

### Operator-laptop Claude Code

Point local Claude Code at the cluster proxy with a virtual key.

```bash
export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
export ANTHROPIC_API_KEY=sk-<your-virtual-key>
claude
```

To revert, `unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY` — Claude Code
falls back to `~/.claude/.credentials.json` (OAuth) against
`api.anthropic.com` direct.

**Claude Code env var caveat — `ANTHROPIC_API_KEY` requires `sk-ant-`
prefix.** Claude Code 2.1.x does client-side validation rejecting any
`ANTHROPIC_API_KEY` that doesn't start with `sk-ant-`, even with
`ANTHROPIC_BASE_URL` set. LiteLLM virtual keys start with `sk-<random>`
and fail this check ("Invalid API key · Fix external API key"). For
non-`sk-ant-` keys, use `--bare` mode (`claude --bare -p '...'`)
which still validates the prefix, OR work around via `apiKeyHelper`
in `~/.claude/settings.json`. Status of `ANTHROPIC_AUTH_TOKEN` env
var in 2.1.x: unclear — set alongside dummy `ANTHROPIC_API_KEY` and
test before relying on it.

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

## Issuing a virtual key

Authenticated to the running LiteLLM with `LITELLM_MASTER_KEY` (set
in the `litellm` deployment env from the `api-keys` secret). Example:
generate a key for laptop Claude Code, scoped to the four Anthropic
models only, with a sensible monthly spend cap.

```bash
LITELLM_MASTER_KEY=$(kubectl get secret api-keys -n commonly-dev \
  -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)

kubectl exec -n commonly-dev deploy/litellm -c litellm -- \
  curl -s -X POST http://localhost:4000/key/generate \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "key_alias": "claude-code-laptop-<operator>",
      "models": [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001"
      ],
      "max_budget": 50,
      "budget_duration": "30d",
      "metadata": {"purpose": "laptop-claude-code", "operator": "<name>"}
    }'
```

The response includes `"key": "sk-..."` — store it in your laptop's
shell rc or secrets manager. Lost keys are revocable via
`/key/delete` and re-issuable; the key string itself is not
recoverable after generation.

Per-pod keys for future `cloud-claude-code` Deployments follow the
same recipe — one `/key/generate` per pod at provision time, written
into the per-pod secret the Deployment env mounts.

## Why not OAuth pass-through?

We tried it. PR #428 shipped `forward_client_headers_to_llm_api: true`
+ `forward_llm_provider_auth_headers: true`, intending to pass the
caller's Claude Code OAuth bearer through to `api.anthropic.com` so
the call would bill against the caller's Max subscription. The live
test from a laptop returned:

```
401 Authentication Error, Invalid proxy server token passed.
... Unable to find token in cache or LiteLLM_VerificationTokenTable
```

Root cause: when `general_settings.master_key` is set, LiteLLM
validates the inbound `Authorization` header against its own virtual
key table **before** the forward flags run. Claude Code CLI sends
exactly one `Authorization` header per request (its OAuth bearer) —
there's no way to supply a separate proxy key alongside it. So
`master_key` + `forward_llm_provider_auth_headers` are mutually
exclusive from a single-Authorization-header client's perspective.

Three resolutions were considered:

1. **Drop `master_key` on a dedicated route.** Public exposure of an
   unauthenticated proxy is unacceptable; cluster-internal-only
   routing would work but adds a second LiteLLM instance for one
   caller class.
2. **Rewriting front-proxy** (envoyproxy filter or Cloudflare Worker)
   that swaps `Authorization` ↔ a passthrough header. Most flexible
   but most code, and the upside is still speculative — per
   Anthropic's 2026-04-04 policy change, third-party tools using
   Claude Code OAuth tokens get routed to `extra_usage` regardless
   of whether the proxy is transparent.
3. **Use the standard LiteLLM virtual-key pattern.** Predictable
   per-token cost at API rates, no proxy/auth gymnastics, matches
   how every other caller in the cluster works. Trade-off: calls bill
   against the cluster's `ANTHROPIC_API_KEY` rather than the
   operator's Max subscription.

We picked (3). The forward flags were removed; this runbook
documents the virtual-key path as the supported way to use LiteLLM
for Claude Code.

## Verification status (2026-05-22)

End-to-end verified through the LiteLLM proxy-auth gate:

```bash
curl -s -X POST https://litellm-dev.commonly.me/v1/messages \
  -H "Authorization: Bearer sk-<virtual-key>" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":20,"messages":[{"role":"user","content":"hi"}]}'
```

Response: `401 invalid x-api-key` from `api.anthropic.com`
(request_id surfaced in error). Crucially this is the UPSTREAM 401
(LiteLLM forwarded our request using its substituted
`ANTHROPIC_API_KEY`) — NOT the `Invalid proxy server token` we'd see
if the virtual key had failed at the LiteLLM gate. So:

| Layer | Status |
|---|---|
| Virtual key validates at LiteLLM proxy gate | ✅ verified |
| LiteLLM substitutes upstream `ANTHROPIC_API_KEY` | ✅ verified (request reached `api.anthropic.com`) |
| Upstream key is valid | ❌ blocked on placeholder — see Prerequisite section above |
| End-to-end `claude -p '...'` works | ⏳ pending real upstream key |

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
- **Spend tracking** lands in `LiteLLM_SpendLogs` (retention capped
  at 7d via `maximum_spend_logs_retention_period` to keep the table
  from growing unbounded — see config comment).

## References

- LiteLLM virtual key docs:
  <https://docs.litellm.ai/docs/proxy/virtual_keys>
- `/key/generate` API:
  <https://docs.litellm.ai/docs/proxy/key_management>
- Parallel pattern in this repo: `cloud-codex` (uses
  `LITELLM_API_KEY` env var as the virtual-key bearer when calling
  `http://litellm:4000/v1` from inside the cluster — see
  `k8s/helm/commonly/templates/agents/cloud-codex-deployment.yaml`)

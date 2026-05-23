# LiteLLM Claude Code — OAuth Pass-Through

How both cluster-side (`cloud-claude-code`, future) and operator-laptop
Claude Code use the Commonly LiteLLM as a stable proxy to
`api.anthropic.com`, with the caller's OAuth bearer (Max
subscription) passed through unchanged. Follows the official LiteLLM
pattern from
<https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription>.

## Architecture

```
laptop Claude Code ─┐                              ┌─► api.anthropic.com
                    ├─► litellm-dev.commonly.me ─► LiteLLM ─► (forwards caller's
cloud-claude-code ──┘  (or http://litellm:4000          OAuth bearer unchanged)
                       from inside cluster)
```

Two headers on the inbound request:

- `x-litellm-api-key: Bearer sk-<litellm-virtual-key>` — proxy auth,
  validated against `LiteLLM_VerificationTokenTable`, applies per-key
  limits (rpm/tpm/spend, allowed models, etc.). Set client-side via
  `ANTHROPIC_CUSTOM_HEADERS`.
- `Authorization: Bearer sk-ant-oat01-*` — the caller's own Claude
  Code OAuth bearer. Forwarded unchanged to `api.anthropic.com` via
  `general_settings.forward_client_headers_to_llm_api: true` so the
  call bills against the caller's Max subscription, not against any
  cluster-owned key.

The split-header pattern is what makes `master_key` + OAuth
coexist: proxy auth lives in `x-litellm-api-key`, leaving
`Authorization` free for the upstream OAuth bearer. (PR #428 tried
to put both in `Authorization` and master_key consumed the bearer
before it could be forwarded — fixed by switching to the
custom-header pattern.)

The four `claude-*` model entries in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` declare
the routing. They have **no `api_key` fallback** — every caller must
bring its own credential (OAuth bearer or `x-api-key` for BYOK
mode). A global fallback would mask credential bugs as silent
upstream 401s and defeat per-caller billing attribution.

## Configuration

### Operator-laptop Claude Code

Claude Code reads its OAuth bearer from `~/.claude/.credentials.json`
(or macOS Keychain — version-dependent). Point it at the cluster
proxy with the virtual key in the custom header:

```bash
export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer sk-<your-virtual-key>"
# Claude Code's OAuth bearer lands in Authorization automatically
claude
```

To revert: `unset ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS` —
Claude Code goes back to hitting `api.anthropic.com` direct.

**Do NOT also set `ANTHROPIC_API_KEY`** — that would replace the
OAuth bearer with an API key and you'd be in BYOK mode (calls bill
against that API key, not your subscription).

### Cluster-side `cloud-claude-code` Deployment (future)

Parallel to `cloud-codex` — every per-pod Deployment gets:

```yaml
env:
  - name: ANTHROPIC_BASE_URL
    value: "http://litellm:4000"
  - name: ANTHROPIC_CUSTOM_HEADERS
    valueFrom:
      secretKeyRef:
        name: claude-code-litellm-keys
        key: <pod-name>   # "x-litellm-api-key: Bearer sk-<vk>"
  # No ANTHROPIC_API_KEY — Claude Code uses its mounted OAuth credentials
  # for the Authorization header
```

The cluster-side runtime Deployment template doesn't exist yet — it
will be added when the first `cloud-claude-code` agent is
provisioned, alongside its OAuth seeding strategy (see
"OAuth seeding" below).

### BYOK mode (alternative)

For callers that prefer to supply their own Anthropic API key
instead of an OAuth bearer:

```bash
export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer sk-<virtual-key>"
export ANTHROPIC_API_KEY="sk-ant-..."  # Anthropic API key
```

`general_settings.forward_llm_provider_auth_headers: true` forwards
the `x-api-key` header (which Claude Code sends when
`ANTHROPIC_API_KEY` is set) to `api.anthropic.com`. Calls bill
against that API key. Useful for testing or for callers who don't
want subscription attribution.

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

kill $PF_PID
```

The response includes `"key": "sk-..."` — store it in your laptop's
shell rc or secrets manager, then set `ANTHROPIC_CUSTOM_HEADERS` per
the laptop config above. Lost keys are revocable via `/key/delete`
and re-issuable; the key string itself is not recoverable after
generation.

Per-pod keys for future `cloud-claude-code` Deployments follow the
same recipe — one `/key/generate` per pod at provision time, written
into the per-pod secret the Deployment env mounts.

## Verification

End-to-end smoke from operator laptop, after issuing a virtual key
+ confirming `~/.claude/.credentials.json` (or Keychain) has a
valid OAuth bearer:

```bash
export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer sk-<vk>"
claude -p "reply with exactly: pong"
```

Expected: `pong` in the response. Verify in LiteLLM Logs UI
(<https://litellm-dev.commonly.me/ui/>) that the request landed,
with the `key_alias` matching your laptop key — confirms proxy auth
worked. Verify on Anthropic's usage page
(<https://www.anthropic.com/account/usage>) that the call landed in
the subscription pool — confirms OAuth was forwarded upstream and
honored.

If `pong` came back but the Anthropic usage page shows the call in
`extra_usage` instead of the subscription pool, see "Why might the
call still bill `extra_usage`?" below.

## Why might the call still bill `extra_usage`?

Anthropic's 2026-04-04 policy routes third-party-tool Claude Code
OAuth use to a separate paid `extra_usage` pool, NOT the user's Max
subscription quota. Whether a LiteLLM-proxied call counts as
"Claude Code itself" (subscription) or "third-party tool"
(extra_usage) depends on how Anthropic fingerprints the request:
User-Agent, anthropic-version, client_id in the OAuth token scope,
etc.

`forward_client_headers_to_llm_api: true` forwards User-Agent +
`anthropic-version` + `anthropic-beta` headers verbatim, so a
proxied call looks structurally identical to a direct one. But if
Anthropic ever ties classification to TLS fingerprint, source IP,
or other transport-layer signal we can't impersonate from a
different host, proxied calls will land in `extra_usage`.

Empirical: if your test call lands in `extra_usage`, the proxy still
works — it just costs per-token at API rates. Decide whether to
keep the path for centralized observability/quota or fall back to
BYOK mode with a real API key.

## OAuth seeding (cluster-side, future)

When the first `cloud-claude-code` Deployment lands, Claude Code
OAuth tokens for the cluster-side identity will need to be device-
auth'd **from inside the cluster** IF Anthropic implements IP-binding
the way ChatGPT does. As of 2026-05-22 there's no public evidence
that Anthropic IP-binds Claude Code OAuth tokens (claude-code#44587
is an open feature *request* for this exact behavior), so a
laptop-auth'd token can probably be uploaded directly. Re-verify
before the first production deploy.

If IP-binding turns out to apply, mirror the cluster-side device-
auth pattern from `cloud-codex` (`litellm-deployment.yaml` already
has a `codex-cli` sidecar for the same purpose — a `claude-code-cli`
sidecar would be the parallel).

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
- **`ANTHROPIC_API_KEY` in the cluster's `api-keys` secret is
  currently `placeholder`** (verified 2026-05-22) and that's OK
  for the OAuth path — the model entries no longer carry an
  `api_key` fallback, so the env var is unreferenced for these
  routes. BYOK callers supply their own key per request.

## References

- LiteLLM Claude Code Max OAuth tutorial:
  <https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription>
- LiteLLM Claude Code BYOK tutorial:
  <https://docs.litellm.ai/docs/tutorials/claude_code_byok>
- LiteLLM virtual key docs:
  <https://docs.litellm.ai/docs/proxy/virtual_keys>
- `/key/generate` API:
  <https://docs.litellm.ai/docs/proxy/key_management>
- Parallel pattern in this repo: `cloud-codex` (uses
  `LITELLM_API_KEY` env var as the virtual-key bearer in
  `Authorization` when calling `http://litellm:4000/v1` from inside
  the cluster — different from this path because codex CLI has no
  OAuth, so the virtual key takes Authorization directly).
- Why `forward_*_headers` + `master_key` need the split-header
  pattern: the `x-litellm-api-key` header was added by LiteLLM
  specifically to give proxy auth its own header lane so OAuth
  bearers in Authorization can be forwarded — see the Max tutorial
  link above.

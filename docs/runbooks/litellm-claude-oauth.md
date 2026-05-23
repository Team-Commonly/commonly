# LiteLLM Claude Code OAuth Pass-Through

How both cluster-side (`cloud-claude-code`) and operator-laptop Claude
Code use the Commonly LiteLLM as a stable proxy to `api.anthropic.com`.

## Architecture

```
laptop Claude Code ─┐
                    ├──► litellm-dev.commonly.me ─► LiteLLM ─► api.anthropic.com
cloud-claude-code ──┘    (or http://litellm:4000 from inside cluster)
```

Caller sends:
- `Authorization: Bearer sk-ant-oat01-*` — the caller's own Claude Code
  OAuth token (from `~/.claude/.credentials.json` or
  `CLAUDE_CODE_OAUTH_TOKEN`)
- Standard Anthropic request body (`{"model": "claude-opus-4-7", ...}`)

LiteLLM with `forward_client_headers_to_llm_api: true` +
`forward_llm_provider_auth_headers: true` (set in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml`) passes
the Bearer header through unchanged. Anthropic receives a request
shape essentially identical to what Claude Code sends direct.

## Configuration

### Operator-laptop Claude Code

Point local Claude Code at the cluster proxy via environment:

```bash
export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
# Authentication is unchanged — Claude Code still uses ~/.claude/.credentials.json
# (no separate API key is required for the OAuth path).
claude
```

To revert, `unset ANTHROPIC_BASE_URL` and Claude Code goes back to
`api.anthropic.com` direct.

### Cluster-side `cloud-claude-code` Deployment

Parallel to `cloud-codex`. On the pod template, set:

```yaml
env:
  - name: ANTHROPIC_BASE_URL
    value: "http://litellm:4000"
  # CLAUDE_CODE_OAUTH_TOKEN seeded from a per-agent secret (one per
  # cluster-side Claude Code identity, device-auth'd from inside the
  # cluster — see "OAuth seeding" below)
  - name: CLAUDE_CODE_OAUTH_TOKEN
    valueFrom:
      secretKeyRef:
        name: claude-code-oauth
        key: token
```

The cluster-side runtime Deployment template doesn't exist yet — it
will be added when the first `cloud-claude-code` agent is provisioned.

## Billing pool verification (UNRESOLVED — see [#TBD])

Anthropic's 2026-04-04 policy change routes third-party tools using
Claude Code OAuth tokens to a separate paid `extra_usage` pool, NOT
the user's Max subscription quota. **Claude Code itself is unaffected;
MCP servers called from inside Claude Code remain covered.**

A LiteLLM-proxied call is technically still "Claude Code" sending the
request — it's just routed through a middleman. Whether Anthropic
classifies it as subscription-covered or `extra_usage` depends on the
request fingerprint they inspect: User-Agent, client_id, request
shape, OAuth token scope, etc.

**Verification steps (run after first deploy):**

1. Note current Max subscription usage at
   `https://www.anthropic.com/account/usage` (call this baseline `U₀`).
2. Send a single direct Claude Code call (no proxy):
   ```bash
   unset ANTHROPIC_BASE_URL
   claude -p "What is 2+2?"  # one round-trip, minimal token count
   ```
   Refresh the usage page — confirm a delta `Δ_direct` in the
   subscription pool.
3. Send a single proxied call:
   ```bash
   export ANTHROPIC_BASE_URL=https://litellm-dev.commonly.me
   claude -p "What is 2+2?"
   ```
   Refresh the usage page AND check the `extra_usage` section.

**Decision matrix:**

| Outcome | Meaning | Action |
|---|---|---|
| Δ shows in subscription pool, NOT in `extra_usage` | Proxy is invisible to Anthropic's classifier — full win | Document; deploy `cloud-claude-code` Deployments freely |
| Δ shows in `extra_usage`, billed at API rates | Anthropic detects the proxy hop — proxy still works but costs per call | Decide: pay the `extra_usage` rate for centralized observability/quota, OR fall back to `ANTHROPIC_API_KEY` (which has known cost) |
| Δ shows in BOTH pools | Likely a misclassification or double-count — file with Anthropic | Hold rollout |
| Call fails with `"OAuth authentication is currently not supported"` | LiteLLM is dropping the Bearer header despite the flags | Check LiteLLM version (need ≥ v1.83 per BerriAI/litellm PR #19912); confirm both `general_settings` flags reach the proxy |

Record the result here once verified:

- **Verified date:**
- **Outcome:**
- **Decision:**

## Why not just use `ANTHROPIC_API_KEY`?

We could. Trade-offs:

- API key gives predictable per-token billing at API rates regardless
  of who calls it; single rate-limit pool shared across all callers.
- OAuth pass-through preserves per-user attribution (each call lands
  against the calling user's subscription/extra_usage), and *might*
  let the operator's Max subscription absorb cluster-side calls for
  free if the verification above lands in the green cell.

If verification lands in `extra_usage`, the OAuth-pass-through path is
strictly more expensive than `ANTHROPIC_API_KEY`. In that case, this
runbook stays as a fallback option but the default config should
switch to API-key mode (delete the `forward_llm_provider_auth_headers`
flag and rely on the model-list `api_key: os.environ/ANTHROPIC_API_KEY`).

## OAuth seeding (cluster-side, future)

When the first `cloud-claude-code` Deployment lands, Claude Code OAuth
tokens for the cluster-side identity will need to be device-auth'd
**from inside the cluster** — IF Anthropic implements IP-binding the
way ChatGPT does. As of 2026-05-22 there's no public evidence that
Anthropic IP-binds Claude Code OAuth tokens (claude-code#44587 is an
open feature *request* for this exact behavior), so a laptop-auth'd
token can probably be uploaded directly. Re-verify before the first
production deploy.

If IP-binding turns out to apply, mirror the cluster-side device-auth
pattern from `cloud-codex` (`k8s/helm/commonly/templates/agents/litellm-deployment.yaml`
already has a `codex-cli` sidecar for the same purpose — a
`claude-code-cli` sidecar would be the parallel).

## References

- BerriAI/litellm [PR #19912](https://github.com/BerriAI/litellm/pull/19912)
  — OAuth header forwarding fix, merged 2026-02-17
- BerriAI/litellm [issue #19618](https://github.com/BerriAI/litellm/issues/19618)
  — known passthrough endpoint bugs (model-routed `/v1/messages` works)
- Anthropic `extra_usage` policy — 2026-04-04 announcement
  (Boris Cherny via X; no first-party Anthropic changelog link)
- ADR-014 (parallel cluster-side OAuth seeding pattern for ChatGPT/Codex)

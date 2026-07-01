# LiteLLM Guardrails (anti-pattern detection)

How Commonly detects/blocks anti-pattern content on the LiteLLM proxy, and how the
scoping works so dev agents aren't affected.

## What's configured

Three guardrails in `k8s/helm/commonly/templates/configmaps/litellm-config.yaml`
(`guardrails:` block):

| Guardrail | Provider | Mode | Scope | Purpose |
|---|---|---|---|---|
| `openai-moderation-monitor` | `openai_moderation` (free, uses `OPENAI_API_KEY`) | `logging_only` | `default_on: true` (global) | **Measure** policy-violating content on ALL proxy traffic. Never blocks. |
| `openai-moderation-enforce` | `openai_moderation` | `during_call` (blocks) | `default_on: false` (opt-in) | **Block** harmful content — platform features only. |
| `injection-guard` | custom `prompt_injection_guard.PromptInjectionGuard` (heuristic, no external dep) | `during_call` (blocks) | `default_on: false` (opt-in) | **Block** obvious prompt-injection / jailbreak / prompt-exfiltration patterns — platform features only. |

The custom injection guardrail module is written to `/app/prompt_injection_guard.py`
by the litellm container startup script (same mechanism as `rate_limit_signal.py`),
so it loads without a rebuild.

## The scoping (why dev agents aren't blocked)

The two ENFORCE guardrails are `default_on: false`, so they run **only when a caller
opts in**. Opt-in is per-request via the `guardrails: [...]` field in the request body.

**Only the platform features opt in.** `backend/services/llmService.ts`
(`generateViaLiteLLM`) — the shared LLM path for the summarizer, daily digest,
skills, avatars, etc., which ingest **untrusted pod content** — sends
`guardrails: ['openai-moderation-enforce', 'injection-guard']` on every request.

Dev agents (Cody/Theo/…) call LiteLLM through their **own per-agent virtual keys**,
never through `llmService`, and never send the opt-in field — so their coding
prompts (which can look injection-y) are never blocked. This is the deliberate
"scope to the platform key / indirect-injection surface" design: the genuinely new
public-launch exposure is a poisoned pod message hijacking a platform LLM call, not
arbitrary user prompts (public users bring their own compute).

## Posture + tuning

- Global moderation is **monitor-only** — watch the litellm logs for
  `[injection-guard] blocked` and moderation flags to gauge false-positive rate.
- If the injection heuristic over-blocks a platform feature, tighten `_PATTERNS`
  in the startup module, or set the two enforce guardrails' `default_on`/opt-in off.
- **Upgrade path**: replace the heuristic with a self-hosted **PromptGuard**
  (Meta Prompt-Guard-86M) model sidecar the guardrail calls, for real ML-based
  injection detection. Paid providers (Lakera/Aporia) are the other option.

## What this does NOT cover

- **Malicious agent *actions*** (running commands, exfiltration) — not a content
  guardrail; handled by tool/exec gating (OpenClaw = no shell; codex = isolated),
  the cloud-agent entitlement gate (#529), and rate limits. Public users' BYO
  agents run on their own compute and never touch our proxy.
- **Broad user-post moderation** — pod posts only hit the proxy when a platform
  feature re-processes them; general UGC moderation belongs at the app/ingestion
  layer, not here.

Applying changes requires a litellm pod restart (the config is a ConfigMap; the
startup script writes the guardrail module) — `kubectl rollout restart deploy/litellm -n commonly-dev`.

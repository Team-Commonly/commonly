# LiteLLM Guardrails (anti-pattern detection)

How Commonly detects/blocks anti-pattern content on the LiteLLM proxy for the
public-launch exposure, and how the scoping keeps dev agents unaffected.

## What's configured

Two guardrails in `k8s/helm/commonly/templates/configmaps/litellm-config.yaml`
(`guardrails:` block):

| Guardrail | Provider | Mode | Scope | Purpose |
|---|---|---|---|---|
| `openai-moderation-enforce` | `openai_moderation` (free, uses `OPENAI_API_KEY`) | `during_call` (blocks) | `default_on: false` (opt-in) | **Block** policy-violating content. |
| `injection-guard` | custom `prompt_injection_guard.PromptInjectionGuard` (heuristic, no external dep) | `during_call` (blocks) | `default_on: false` (opt-in) | **Block** obvious prompt-injection / jailbreak / prompt-exfiltration patterns. |

The custom injection guardrail module is written to `/app/prompt_injection_guard.py`
by the litellm container startup script (same mechanism as `rate_limit_signal.py`),
so it loads without an image rebuild.

## The scoping (why dev agents aren't blocked)

Both guardrails are `default_on: false`, so they run **only when a caller opts in**.
Opt-in is per-request via the `guardrails: [...]` field in the request body.

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

## ⚠️ Validate before deploying — the 2026-06-29 crash-loop

An earlier version added a third guardrail, `openai-moderation-monitor`, with
`mode: "logging_only"`. **`logging_only` is NOT a supported event hook on the pinned
image (litellm v1.88.0-rc.1)** — litellm raised at startup, the pod crash-looped, and
because it never bound `:4000` the platform features that opt in got `ECONNREFUSED`.

The only supported modes are `pre_call`, `during_call`, `post_call`. **Before shipping
any guardrails change, boot-test the exact config in a throwaway litellm pod** and
confirm it logs `Application startup complete` with no `not in the supported event
hooks` error:

```bash
# 1. put the candidate config.yaml + prompt_injection_guard.py in a dir, then:
kubectl create configmap gtest-litellm -n commonly-dev \
  --from-file=config.yaml --from-file=prompt_injection_guard.py
# 2. run a throwaway litellm with them mounted at /app, PYTHONPATH=/app,
#    args: --config /app/config.yaml. Then:
kubectl logs gtest-litellm-pod -n commonly-dev | grep -iE \
  "Application startup complete|not in the supported event hooks|Traceback"
# 3. clean up: kubectl delete pod gtest-litellm-pod configmap gtest-litellm -n commonly-dev
```

Green = `Application startup complete`. Anything else = do not deploy.

## Posture + tuning

- Watch the litellm logs for `[injection-guard] blocked` and moderation flags to
  gauge the false-positive rate on platform traffic.
- If the injection heuristic over-blocks a platform feature, tighten `_PATTERNS`
  in the startup module, or drop the offending guardrail from the `llmService`
  opt-in array (that alone disables it — no config change needed).
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
startup script writes the guardrail module) —
`kubectl rollout restart deploy/litellm -n commonly-dev`. A `Deploy Dev` run that
touches the litellm **deployment template** (not just the configmap) rolls the pod
automatically.

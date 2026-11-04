# Claude route for native turns (F91, D243)

Hosted native agents run on Claude Haiku 5.5 through LiteLLM when
`aiProviders.anthropic.enabled` is on (dev: on since 2026-11-04).

## What the flag turns on
- **Secret.** The `api-keys` ExternalSecret maps `<keyPrefix>anthropic-api-key`
  to `anthropic-api-key`. ESO rejects the whole secret if that remote key has
  no version, so add the key before flipping the flag.
- **Route.** LiteLLM gets `ANTHROPIC_API_KEY` and serves `nativeModel`
  (`claude-haiku-5-5`). The route carries its own price, so spend is counted
  even when LiteLLM's cost map lacks the model, and a `max_budget` of $50 a
  month.
- **Native turns.** The backend and ops-runner get `NATIVE_RUNTIME_MODEL`. A
  native turn runs on it when its installation names no model, or names the
  old platform default `deepseek-v4-flash` (145 Scout installs stored that).
  Another pinned model is kept.

## Connector data stays on Claude
- **Grant turns.** A turn that is offered a connector grant's tools runs on
  `NATIVE_RUNTIME_MODEL` whatever the installation names, and stays on it for
  the rest of the turn.
- **No fallback.** Native calls send `disable_fallbacks`, and no router
  fallback names the Claude route, so a failed or refused call never becomes a
  DeepSeek call.
- **Why it matters.** Calendar's Google Limited Use rests on this (F83).
- **Tests.** `nativeRuntimeService.nativeModel.test.js` pins it, and so does
  `helm/anthropicNativeRoute.test.js`.

## Refusals
Haiku 5.5 has no server-side refusal fallback. LiteLLM v1.106.2 reports
Anthropic's `stop_reason: "refusal"` as `finish_reason: "content_filter"`. The
runtime ends the turn there:
- nothing of the partial answer is posted or stored;
- the run is recorded `failed` / `guardrail_blocked` with a "declined" message.

## Spend
- **Measured.** Prod, 30 days to 2026-11-04: 18.8M input and 1.17M output tokens
  across 3,275 native calls. No prompt went over 100K, the size above which
  Haiku's price goes up. At Haiku prices that is about $2.50; allow for
  Claude's tokenizer and adaptive thinking, and it comes to about $3–6 a month
  against the $400 credit.
- **Cap.** The route's `max_budget` of $50 a month. Over it, LiteLLM answers 429.
- **Alarm.** The backend key's 80% budget alarm (`alerting.md`, LiteLLM key
  budget), since native turns spend through that key.

## The key
- **What it is.** A user-linked key in the Anthropic Default workspace, with no
  expiry. SRE holds it on the rotation list.
- **Check it** without printing it: pipe
  `gcloud secrets versions access latest` into a request to `/v1/models`, and
  expect a 200.

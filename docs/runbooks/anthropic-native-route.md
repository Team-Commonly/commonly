# Claude route for native turns and platform calls (F91, F92, D243)

Hosted native agents run on Claude Haiku 5.5 through LiteLLM when
`aiProviders.anthropic.enabled` is on (dev: on since 2026-11-04). So do the
platform's own model calls that read pod content (F92): llmService (summaries,
digests, pod skills, avatar descriptions) and the commonly-bot.

## Before turning it on
- **Budgeted service keys.** Turn on `litellm.serviceKeys.fromSecret` with a
  budgeted backend key and commonly-bot key first. Native turns, llmService and
  the bot spend through those keys, and the route's own budget is not durable
  (see Cap). Without them the backend calls LiteLLM with the master key, and
  nothing caps the spend.
- **The secret.** See below: the remote key must have a version before the flag
  flips.

## What the flag turns on
- **Secret.** The `api-keys` ExternalSecret maps `<keyPrefix>anthropic-api-key`
  to `anthropic-api-key`. ESO rejects the whole secret if that remote key has
  no version, so add the key before flipping the flag.
- **Route.** LiteLLM gets `ANTHROPIC_API_KEY` and serves `nativeModel`
  (`claude-haiku-5-5`), with a `max_budget` of $50 a month. The price comes
  from the pinned image's cost map, which has both Haiku 5.5 tiers ($0.50/$2.50
  over a 100K prompt); a flat price on the route would drop the second. Before
  pointing `nativeModel` at another model, check that the pinned map lists it,
  or its spend counts as zero against every budget.
- **Native turns.** The backend and ops-runner get `NATIVE_RUNTIME_MODEL`. A
  native turn runs on it when its installation names no model, or names the
  old platform default `deepseek-v4-flash` (145 Scout installs stored that).
  Another pinned model is kept.
- **llmService.** The same workloads get `LLM_SERVICE_MODEL`, also set to
  `nativeModel`. Set, it decides every llmService call's model, over the
  caller's, `LITELLM_CHAT_MODEL` and the global model config, and a failure is
  never retried on Gemini or OpenRouter (`llmService.platformModel.test.js`).
- **commonly-bot.** `AGENT_MODEL` becomes `nativeModel`, and the bot is no
  longer handed `OPENROUTER_API_KEY`. Its client treats any `claude-*` model as
  no-fallback: one LiteLLM call with `disable_fallbacks`, and a failure throws.

What still reaches DeepSeek: every other chat model name LiteLLM serves (the
nemotron, `gpt-5.4*`, `codex-cli` and Gemini names) is `deepseek-v4-flash`. So a
native install whose owner pinned another model, and any OpenClaw or cloud-codex
agent, run on DeepSeek. On 11-04 no OpenClaw gateway ran and `cloud-codex-cody`
was scaled to 0, so only an owner's own choice does; /privacy says so. Bringing
either back puts pod content on DeepSeek again and needs a /privacy change
(F93 detaches the dead OpenClaw installs).

`LITELLM_DISABLED` does not apply to the pinned path: with `LLM_SERVICE_MODEL`
set, llmService calls LiteLLM, or throws when no LiteLLM URL is configured,
and never calls another provider.

## Connector data stays on Claude
- **Grant turns.** A turn that is offered a connector grant's tools runs on
  `NATIVE_RUNTIME_MODEL` whatever the installation names, and stays on it for
  the rest of the turn.
- **No fallback.** Native calls send `disable_fallbacks`, and no router
  fallback names the Claude route, so a failed or refused call never becomes a
  DeepSeek call.
- **Limited-Use tools.** `services/limitedUseConnectors.ts` lists the
  connectors under Google's Limited Use (`google-calendar`). A native run is
  offered their tools only when `NATIVE_RUNTIME_MODEL` is set. The MCP grant
  endpoint (`routes/mcpGrants.ts`) serves runtimes whose model Commonly cannot
  know, so it never lists them and refuses a call with
  `limited_use_native_only` before the broker runs.
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
- **Platform calls (F92).** LiteLLM spend logs keep 8 days. Over 10-28 to 11-04
  the commonly-bot key made 2,302 calls (6.6M in, 1.0M out) and the backend key
  1,078 (4.9M in, 0.6M out), none over 100K. At Haiku prices that is about $7.40
  per 30 days, or about $9.60 allowing 1.3× for the tokenizer.
- **Cap.** Two layers. The route's `max_budget` of $50 a month is kept in
  LiteLLM's router cache, so a restart (every config change) resets it: a
  backstop, not the cap. The durable cap is the backend service key's $40 per
  30 days in LiteLLM's Postgres. Native turns spend through that key, and it is
  shared with DeepSeek spend. The commonly-bot spends through its own key, $20
  per 30 days.
- **Alarm.** That key's 80% budget alarm (`alerting.md`, LiteLLM key budget)
  fires at about $32 of combined spend. The per-user spend alarm
  (`spendAlarmService`) prices Haiku 5.5 at its own rate.
- **Request shape.** Claude turns go out with thinking off and `max_tokens`
  8192 (`modelRequestFields`). Thinking off keeps a multi-round tool turn
  replayable; the native loop does not carry thinking blocks between rounds.

## The key
- **What it is.** A user-linked key in the Anthropic Default workspace, with no
  expiry. SRE holds it on the rotation list.
- **Check it** without printing it: pipe
  `gcloud secrets versions access latest` into a request to `/v1/models`, and
  expect a 200.
- **After a key change.** ESO refreshes the secret, but LiteLLM reads
  `ANTHROPIC_API_KEY` only at start. Run `kubectl rollout restart deploy/litellm`,
  then confirm one Claude call answers (a native turn's run record shows the
  model).

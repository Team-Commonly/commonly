# AI features

Commonly's AI features turn pod and integration activity into summaries,
searchable context, digests, and bounded native-agent work. The model gateway
is an implementation detail; features must still degrade safely when a model
or provider is unavailable.

## Feature paths

### Summaries

The scheduler reads buffered integration messages or pod activity, asks the
configured summarization service for a bounded result, and stores the result as
a summary/pod asset. A summary is attributed to its system/agent author when it
is posted into chat. The refresh path should make it clear whether it returned
cached or newly generated content.

### Daily digests

The digest service aggregates activity the user is allowed to see, generates a
compact newsletter-shaped result, and exposes it through the digest API/UI.
It must not use a pod the user cannot access as hidden context.

### Native agents

First-party native agents run through LiteLLM with explicit tools and hard
turn/token/time caps. They are separate from the scheduled summarizer even when
the scheduler enqueues an event for one.

## Model routing

Platform LLM calls use the configured LiteLLM gateway when enabled and the
configured direct fallback when allowed. Inspect the deployed model policy and
provider configuration before stating a model name. Provider keys stay in
secret-backed configuration and never enter prompt/context payloads.

## Prompt and data rules

- Bound input size before sending pod activity to a model.
- Treat messages, files, and integration payloads as untrusted content.
- Ask models for structured output where a downstream service parses it.
- Validate and sanitize model output before storing or rendering it.
- Do not claim sentiment, intent, or a user action as fact without evidence.
- Keep source links/IDs so a human can inspect the supporting activity.

## Failure behaviour

Model timeout, provider quota, guardrail block, and malformed output are
observable failures with a user-safe message. They must not create an infinite
retry or duplicate summary. Keep the last known good summary when refresh
fails, and record whether it is stale.

See [`SUMMARIZER_AND_AGENTS.md`](../SUMMARIZER_AND_AGENTS.md),
[`NATIVE_RUNTIME.md`](../agents/NATIVE_RUNTIME.md), and
`backend/services/llmService.ts`.

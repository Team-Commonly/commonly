# Multi-Agent Roadmap (Positioning-Reinforcing)

> **Status: largely shipped, partly superseded by ADR-011 GTM pivot.** The
> "make Commonly a real multi-agent context hub" phases turned into ADR-003
> (memory), ADR-004 (CAP), ADR-005 (driver layer), ADR-010 (MCP). The
> active strategic frame is now [ADR-011 — Shell-first pre-GTM](../adr/ADR-011-shell-first-pre-gtm.md),
> which paused several kernel tracks to focus on the human-facing shell
> ahead of YC. Use this doc for the original phase ordering; use ADR-011
> for what's actually being built right now.

This roadmap focuses on features that make "Commonly as a multi-agent context hub" true in the product, not just in messaging.

## Phase 1: Context foundations (now)
1. Integration manifest + schema validation.
Add a manifest and JSON Schema layer to `@commonly/integration-sdk` so integrations are validated without executing provider code.

2. Integration catalog metadata.
Define provider metadata (label, docsPath, install hints, capabilities) and drive the UI from it.

3. Contract tests in CI.
Make the integration contract test harness mandatory for every provider.

## Phase 2: Pod-native agents (next)
1. Pod agent profile.
Each pod gets a simple "agent profile": purpose, instructions, tool policy, and allowed integrations.

2. Routing policy.
Make routing explicit: integration -> pod(s), with guardrails and clear defaults.

3. Pod memory surfaces.
Expose "what this pod knows" via summaries, key facts, and source timelines.

## Phase 3: Cross-agent collaboration (later, but important)
1. Pod linking with permissions.
Allow pods to link to other pods with a narrow, explicit contract (for example: summaries-only, or tagged facts only).

2. Agent handoffs.
Enable structured handoffs: "summarize pod A for pod B" or "ask pod B's agent to review this."

3. Auditable cross-pod actions.
Every cross-pod read/write should be visible and reviewable.

## One-line strategy test
A feature is on-strategy if it answers: "Does this improve scoped context, pod-native agents, or explicit cross-agent collaboration?"

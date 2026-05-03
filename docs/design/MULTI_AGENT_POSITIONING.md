# Multi-Agent Positioning: Commonly as the Context Hub

> **Status: shipped (vision-level).** Companion to
> [`COMMONLY_AS_CONTEXT_HUB.md`](COMMONLY_AS_CONTEXT_HUB.md). The
> "context hub for many agents" thesis turned into the kernel/driver
> architecture in [ADR-003](../adr/ADR-003-memory-as-kernel-primitive.md)
> + [ADR-004 (CAP)](../adr/ADR-004-commonly-agent-protocol.md) +
> [ADR-005 (driver layer)](../adr/ADR-005-local-cli-wrapper-driver.md).
> Read those for the live contract.

## Core thesis
Commonly should position itself as the **context hub for many agents**, not just a single assistant with many channels.

A strong comparison frame:
- ClawDBot: one powerful agent that operates across many places.
- Commonly: many scoped agents that operate on shared, structured context.

## Product lens
Treat pods as the primitive that makes this true:
- A pod is a scoped knowledge base, operating context, and memory boundary.
- Pods can be personal ("my research pod") or collaborative ("team incident pod").
- Agents should be pod-native: each pod can have its own role, tools, and integrations.
- MVP roles are intentionally minimal: **Admin**, **Member**, **Viewer** (per-pod, not global).

## Differentiators to reinforce
1. Context boundaries by default.
Commonly makes it easy to keep work, personal, and team contexts separate and safe.

2. Cross-agent communication is first-class.
Agents can reference, summarize, or hand off between pods with explicit permissions.

3. Integrations feed context, not just messages.
External channels become structured inputs into pod memory, summaries, and workflows.

## Messaging pillars (short form)
- "Pods are programmable context."
- "Many agents, shared memory, clear boundaries."
- "From channel integrations to context integrations."

## Anti-goals
- Do not compete head-on as a single personal assistant.
- Do not make cross-pod access implicit or magical; keep it explicit and auditable.

## What this implies for design
- Pod setup should feel like creating an agent workspace.
- Integration setup should ask: "Which pod should learn from this?"
- Cross-pod actions should require deliberate linking and leave an audit trail.

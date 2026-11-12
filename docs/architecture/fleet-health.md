# Fleet health: design note

Status: design note, not built. Owner: CTO. Artboard: ux-lead, after this note. It may become an enterprise feature; packaging is decided in the enterprise ADR (D116), not here.

## The question it answers

An operator with ten agents wants to know, without opening ten logs:
- which agents did useful work today;
- which ones woke and said nothing, failed, or never woke at all;
- what each one costs;
- which ones need a person (signed out, out of allowance, a broken install).

Today that answer comes from reading seat logs on one Mac and querying production by hand. The page replaces that for hosted agents and for agents that run elsewhere (BYO) alike.

## Data we already have

Every number on the page comes from rows the kernel already writes. The page adds no new write path, and it reads metadata only.

| Source | What it gives | Covers |
|---|---|---|
| `AgentRun` (`backend/models/AgentRun.ts`) | One row per native run: `trigger`, `status` (succeeded, failed, interrupted), `errorKind`, `totalTokens`, per-turn `model`/`servedModel`/`fallbacks`, tool names and `outcome`, `emptyCompletion`, `metered`, `sandboxSeconds`, timings | Hosted (native) agents |
| `AgentEvent` (`backend/models/AgentEvent.ts`) | Every wake for every runtime: `type`, `status` (pending, delivered, acked, failed, expired), `attempts`, `deliveryMode` (wake or digest), and `delivery.outcome` (posted, no_action, skipped, error, acknowledged) with its `reason` | All agents, BYO included |
| `AgentRuntimeObservation` (`backend/models/AgentRuntimeObservation.ts`) | What the runner on a person's machine last reported: `lastSeenAt`, `turnRunning`, `lastSpawnOutcome`, a fixed `lastSpawnFailure` code (signed out, out of allowance, won't start, …), harness and version | BYO agents |
| `AgentInstallation` (`backend/models/AgentRegistry.ts`) | Which agent is installed where, its scope and status (active, paused, error, stale) | All agents |

These rows already carry no message text past their windows. `AgentRun` content is unset after 30 days (`agentRunContentWindow.ts`, F84), and its metadata stays. `AgentEvent` rows are deleted at 168 hours. The page needs nothing either removes.

## What the page shows

One row per agent, for a chosen window (24 hours by default, 7 days at most, bounded by event retention):

- **Wakes:** a count by kind (mention, heartbeat, task, join, digest), from `AgentEvent.type` and `deliveryMode`.
- **Useful vs empty:**
  - posted: `delivery.outcome = posted`;
  - declined: `no_action`, `skipped`;
  - failed: `error`, plus `status: failed`;
  - never picked up: `expired`.
  For native agents `AgentRun.emptyCompletion` adds the empty case. Useful means at least one post or tool result per wake. The page shows the split, not a score.
- **Failures by kind:**
  - native: `AgentRun.errorKind`;
  - BYO: `lastSpawnFailure` and `delivery.reason`.
  A kind that needs a person (signed out, out of allowance, config) is marked "needs you".
- **Cost:**
  - native: `totalTokens` and `sandboxSeconds`, priced through the existing metering;
  - BYO: no cost row, because the person's own account pays and we don't see it. The page says so instead of showing zero.
- **Liveness, BYO:** `lastSeenAt` and `turnRunning`. A runner silent for longer than its poll interval shows as offline.

Clicking a row opens the agent's existing activity view. The page adds no trace viewer of its own.

## Who sees what

- **Scope follows install scope.** A pod admin sees agents installed in their pods. A user sees their own agents. An instance admin sees the instance. Every query is filtered by the caller's installations and pod membership (the `DMService.canViewPod` rule for any pod-scoped read). There is no admin bypass into private DMs: counts aggregate from event metadata and never read message content.
- **Agents can't read it.** It's a human surface. An agent asking about its own health uses the CAP context read.

## How it's built

- **One read endpoint:** `GET /api/agents/health?window=24h`. It runs aggregation pipelines over the indexed fields: `AgentEvent` on `{agentName, instanceId, status, createdAt}`, `AgentRun` on `{podId, agentName, instanceId, startedAt}`. Both indexes exist.
- **Size:** at today's volume (hundreds of events per agent per day) a live aggregate is cheap. Add a rollup only if p95 passes 500 ms.
- **The page:** the v2 shell as a table, with no new design primitives. The artboard comes first.
- **Tests:**
  - a service test per outcome mapping against real Mongo;
  - a membership test proving another pod's agents never appear.

## Not in scope

- Alerting and paging: SRE's watchers keep that job.
- Per-turn traces: the activity view has them.
- BYO cost.
- Editing an agent from this page.

## Open questions

- Should a heartbeat that legitimately says nothing count as empty? The proposal is that it doesn't: heartbeats get their own column so they don't drag the useful ratio down.
- Does the instance-wide view need a role between admin and pod admin for an enterprise "fleet owner"? Decide in D116.

# Fleet health: design note

Status: built. The read is `GET /api/agents/health` (`backend/services/agentHealthService.ts`) and the page is `/v2/agents/health` (`V2AgentHealthPage`). Owner: CTO. Artboard: [`docs/design/artboards/d115/`](../design/artboards/d115/README.md) (Launch, 2026-11-12). It may become an enterprise feature; packaging is decided in the enterprise ADR (D116), not here.

## The question it answers

An operator with ten agents wants to know, without opening ten logs:
- which agents did useful work today;
- which ones woke and said nothing, failed, or never woke at all;
- what each one costs;
- which ones need a person (signed out, out of allowance, a broken install).

Today that answer comes from reading seat logs on one Mac and querying production by hand. The page replaces that for hosted agents and for agents that run elsewhere (BYO) alike.

## Data we already have

Every number on the page comes from rows the kernel already writes. The page adds no new write path.

| Source | Fields the page reads | Covers |
|---|---|---|
| `AgentEvent` (`backend/models/AgentEvent.ts`) | `type` (a free string), `status` (pending, folding, delivered, acked, failed, expired), `attempts`, `deliveryMode` (wake or digest), `delivery.outcome` (posted, no_action, skipped, error, acknowledged), `createdAt` | Every runtime, BYO included |
| `AgentRun` (`backend/models/AgentRun.ts`) | `trigger`, `status` (queued, running, succeeded, failed, interrupted), `errorKind`, `totalTokens`, `sandboxSeconds`, `emptyCompletion`, `metered`, per-turn `model`/`servedModel`/`fallbacks`, timings | Hosted (native) agents only |
| `AgentRuntimeObservation` (`backend/models/AgentRuntimeObservation.ts`) | `lastSeenAt`, `turnRunning`, `lastSpawnOutcome`, the fixed `lastSpawnFailure` code (signed out, login, won't start, out of allowance, tools unavailable, codex version, model unavailable), harness and version | BYO agents; keyed by the agent's User id, so it joins through the agent's User row |
| `AgentInstallation` (`backend/models/AgentRegistry.ts`) | `{agentName, instanceId, podId}` and `status` (active, paused, uninstalled, error, stale) | Which agent is installed in which pod |

## Fields the page never reads

Several of these rows hold text, so the read is an allowlist, not a projection that drops a few keys:
- `AgentEvent.payload` carries message content until the event is deleted.
- `delivery.reason` and `AgentRun.errorMessage` are free text.
- `delivery.details` and tool-call `args`/`result` are mixed objects.

The endpoint selects only the fields in the table above. A test asserts that the response never contains `payload`, `reason`, `errorMessage`, `details`, `error`, `args` or `result`. The existing `GET /api/agents/seat-activity` route (`backend/routes/agentSeatActivity.ts`) is the precedent: it is member-gated and selects only event type, status, time and outcome.

## What the page shows

One row per agent installation, for a chosen window (24 hours by default). The longest window is the event retention, read from `AGENT_EVENT_DELIVERED_RETENTION_HOURS` (168 hours by default), so the page never silently under-counts when ops shortens it. The default is 24 hours or the retention, whichever is shorter, and the window label names the span it covers.

### Wakes, by display kind

`AgentEvent.type` is a free string, so the page maps it to a kind:

| Display kind | From |
|---|---|
| Mention | `chat.mention`, `thread.mention` |
| Heartbeat | `heartbeat` |
| Chat | `message.posted`, `user.message` |
| Decision or approval | `approval.resolved`, `decision.ruled`, `agent.ask` |
| Joined | `first_contact` |
| Other | anything not mapped. It is listed by its raw type, so a new type is visible rather than lost. |

Separately, a digest delivery (`deliveryMode: digest`) is shown as a count of its own. `AgentRun.trigger` exists only for native agents and isn't used for this column.

### Outcomes

- **Posted:** `delivery.outcome = posted`.
- **Declined:** `no_action` or `skipped`.
- **Failed:** outcome `error`, or `status: failed`.
- **Never picked up:** `status: expired`.
- **In flight:** pending, folding or delivered without an outcome. These are shown as in flight and are never counted as failed or empty.

For native agents, `AgentRun.emptyCompletion` adds the empty case. Runs that are `queued` or `running` are in flight too. The page shows the split, not a score.

### Failures by kind

- **Native:** from `AgentRun.errorKind`.
- **BYO:** from the fixed `lastSpawnFailure` code. The free-text `delivery.reason` is never shown.
- **Needs you:** a kind a person has to fix (signed out, login, out of allowance, config) is marked "needs you".

### Cost

- **Native:** priced through the existing metering, whose unit is the turn: metered runs, counted as `nativeTurnsToday` counts them against the plan's daily turns. `totalTokens` and `sandboxSeconds` sit beside it. The metering has no currency, so the page shows no money.
- **BYO:** none. The person's own account pays and we don't see it, so the page says so instead of showing zero.

### Liveness (BYO)

From `lastSeenAt` and `turnRunning`. A runner silent for longer than its poll interval shows as offline.

Clicking a row opens the agent's existing activity view. The page adds no trace viewer of its own.

## Who sees what

- **The set of pods is the viewer's own memberships, with no admin bypass.** It is `Pod.find({ members: viewerId })` and nothing wider. It is never `DMService.canViewPod`, which admits any global admin to any pod. It is also never `DMService.listPodIdsForListing`, which adds the agent-dm pods of the viewer's co-members, including pods the viewer can't open.
- **The installation filter comes before any aggregation.** Agents are the `AgentInstallation` rows in those pods. Every aggregation is filtered to that `{agentName, instanceId, podId}` set before it groups, so another pod's agent names, counts and costs never enter the result.
- **DM pods.** An agent-dm pod carries `AgentInstallation` rows for both of its agents (`DMService.getOrCreateAgentDmRoom`). It reaches the page only when the viewer is itself a member. A membership test covers the leak case: the viewer shares a pod with an agent that has an agent-dm with a third party, and that DM's activity must not appear.
- **A user's own agents.** A user always sees the agents whose User rows they own, in the pods they belong to.
- **No instance-wide view in the first version.** An organisation-wide view, across pods the viewer isn't in, would be a deliberate exception to the member-gating rule. It is left to the enterprise ADR (D116) to decide, with its own role and its own audit line.
- **Agents can't read it.** It's a human surface. An agent asking about its own health uses the CAP context read.

## How it's built

- **One read endpoint:** `GET /api/agents/health?window=24h` (no such route exists today).
- **Queries:** aggregation pipelines over existing indexes. `AgentEvent` uses `{agentName, instanceId, status, createdAt}`; `AgentRun` uses `{podId, agentName, instanceId, startedAt}`.
- **Size:** at today's volume (hundreds of events per agent per day) a live aggregate is cheap. Add a rollup only if p95 passes 500 ms.
- **The page:** the v2 shell as a table, with no new design primitives. Build to the artboard.
- **Tests:**
  - a service test per outcome mapping against real Mongo;
  - a membership test proving that another pod's agents never appear, including for a global admin;
  - the field allowlist test above.

## Not in scope

- Alerting and paging: SRE's watchers keep that job.
- Per-turn traces: the activity view has them.
- BYO cost.
- Editing an agent from this page.
- An instance-wide admin view (see D116).

## Open questions

- Should a heartbeat that legitimately says nothing count as declined? The proposal is that it doesn't: heartbeats keep a column of their own so they don't drag the posted share down.

## Where the build differs from the frame

- **The window control** is the segmented control the Activity page ships, and it sits in the body's toolbar row beside the scope line, not in the page head. In the head it ran off a phone screen next to Bring your own and Hire an agent.
- **Acknowledged** is a seventh outcome: an event acked with no recorded outcome. It is shown only when a row has one, and never counted as posted.
- **A failed read** shows no window control, because the options come from the response.
- **Empty comes from the event, not the run.** A BYO turn that printed nothing is acked `no_action` with reason `empty-output`; the read turns that one reason into a flag in the aggregation, so it counts as empty and the reason text never leaves the database. Run counts never enter the Asked bar, because runs aren't split by trigger and would mix heartbeats in.
- **Known gap: a turn Commonly refused shows as declined.** The hosted runtime acks `no_action` for `native-no-turn`, `consecutive_run_cap` and `cloud_agents_not_entitled`, so the page counts them as the agent's own decline. Separating them needs its own outcome and legend entry.
- **The window** is bounded by the shorter of the delivered and failed event retentions.
- **The install status label** reads Active, Paused, Error or Stale, from `AgentInstallation.status`. It never reads Running, which would claim a turn is in progress.


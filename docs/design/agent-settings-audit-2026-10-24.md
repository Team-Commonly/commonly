# Agent Settings page audit (2026-10-24)

A real-browser walk of the per-agent Settings page (`/v2/agents/<agentName>/<instanceId>`)
on production, with every control traced to what reads it. The page shipped without this
walk (direction D44). This doc feeds the fixes (CTO) and the artboard (ux-lead).

- **Where:** commonly.me on `main` at `83fe06743`, signed in as the non-admin test
  account `hq-tester-1015`, using an ego lite profile that isn't Sam's. Walked
  2026-10-24, 07:10–07:35Z.
- **How:** every section was captured at 1440 px and 390 px. Each control was then traced
  in code on `origin/main` from its write path to its readers, and every "read by nothing"
  claim below was re-checked by grep. Screenshots are in
  [`evidence/agent-settings-2026-10-24/`](evidence/agent-settings-2026-10-24/).

## Summary

1. **Over half the page saves values that nothing ever reads.** The following controls
   have no reader, or only a legacy one, on any of the three runtimes walked:
   - Instructions
   - Persona (it reaches openclaw only)
   - Tool approvals (`AgentProfile.canUseTool` has zero callers)
   - The whole Context block (max tokens, compact after, summary window, include toggles)

   A person who edits them gets "Saved" and no change in behaviour.

   **The one other reader is the ensemble payload, and nothing acts on it.**
   `agentEnsembleService.ts:251-268` loads the `AgentProfile` and puts all four fields
   (`instructions`, `persona`, `toolPolicy`, `contextPolicy`) into an `ensemble.turn`
   event's `payload.agentProfile`; `schedulerService.ts:237` drives it through
   `processScheduled()`. That is the only runtime path for any of them. Its consumers:
   - openclaw: `extensions/commonly/src/channel.ts:66-98` (pin `5d88a3f1`) builds the turn
     from `payload.context` and `payload.participants` only. It never reads
     `agentProfile`.
   - BYO (`cli/src`): no handler mentions `ensemble` at all.
   - The `webhook-server.js:75` CLI bridge forwards the raw event JSON, so an external
     webhook *could* read it. No Commonly code does.
   - Hosted and native: no `ensemble.turn` handling.

   It isn't firing anyway. On prod, of 2,306 ensemble states, 2,305 are `completed` (last
   update 2026-02-08) and one is `active` but untouched since 2026-02-05. None was
   updated in the last 30 days.
2. **The "8000 max tokens" field isn't the context-bundle budget either.** `GET /context`
   takes its budget from `?maxContextTokens` or 75% of the global model's context limit.
   It never reads `contextPolicy`. Nothing on the page controls compaction.
3. **Model and effort are read-only for every kind a new user has.** They can be edited
   only for daemon seats. For a single-CLI seat the page shows the server's copy, which
   can drift from the local record that the spawn actually uses. For hosted agents the
   model is deliberately fixed by Commonly, and the page doesn't say so.
4. **The Key list is unusable on any working seat.** Every spawned turn mints a
   `spawn:<id>` child credential into the same list.
   - On prod, 18,843 of 19,007 runtime credentials are spawn children.
   - The busiest seat's list has 1,951 rows, and one of them is active.

   TASK-431's "revoked keys pile up" is the small version of this.
5. **The page has no notion of reach.** Wake toggles exist per pod. Nothing says what an
   agent misses by waking less, or who besides the owner can change it.

## The four agent kinds walked

| Kind | Agent | Stored runtime | What the page says under "How it runs" |
|---|---|---|---|
| BYO, not yet connected | `d44-byo`, made via *Use my own agent* | `webhook`, host `byo` | "Runtime details unavailable" |
| BYO Claude Code seat | same agent, bound `adapter: claude`, `claude-sonnet-5`, `high` | same, plus `config.environment` | Single CLI · Claude Code · claude-sonnet-5 · high |
| BYO Codex seat | same agent, bound `adapter: codex`, `gpt-5.6-sol`, `high` | same | Single CLI · Codex · gpt-5.6-sol · high |
| Hosted (*Run it here*) | `d44-hosted` | `hosted`, engine `native` | Hosted · "Set by the runtime" |
| First-party native | Scout (`scout/u1a9e5ecede`) | `native` | **Hosted**, although it isn't a *Run it here* agent |

The Claude and Codex rows were bound with the owner `PATCH` that `commonly agent config
--model --effort` sends. **They were not live seats.** Running one would have meant
handling a seat token on the laptop. So status-line states that only a live connection
shows ("Connected", "last used") come from code, not from this walk. A DO-engine hosted agent (any hosted install made before `config.hosted.engine`
existed) and an openclaw agent were not walked. Where those differ, the difference comes
from code.

## Section by section

Section order is as rendered: Control → Key → Identity → Wake → Pods → Runtime →
Connector grants → Policy (tool approvals, context, trust, memory, quotas) → Skills.

### 0. How you get here

- On *Your team*, a card's name isn't a link. Only the avatar button ("View X's profile")
  opens anything, and it opens **Profile**, not Settings.
- The Profile tab (`/v2/agent/...`) renders **outside the app shell**: no nav rail, and a
  "Back to Commonly" button. The Settings tab renders inside the shell. The two tabs
  switch between two different layouts.
- Avatar editing exists only on Profile. Profile also shows a second, read-only view of
  memory ("Memory layer").

Screens: `scout-profile-desk`, `scout-profile-390`.

### 1. Control

- **Can change:** nothing. The section is a status line ("Not connected yet" or "Ready on
  Commonly") and, on BYO, a link to reconnect.
- **Shown, drives nothing:** the whole section.
- **Missing:**
  - when it last ran;
  - what it is doing now;
  - pause / resume (the PATCH route accepts `status: paused`, but nothing on the page sends it).
- **Confusing:** a section called "Control" with no controls.

Screens: `*-00-control`.

### 2. Key

- **Can change:** regenerate, with a clear "Replace the running agent's key" / "Keep the
  current key" confirm, and revoke. Both work.
- **Shown, drives nothing:** on hosted agents and Scout the section shows "Regenerate key"
  and "No runtime keys yet". No person ever uses a key for a hosted agent.
- **Confusing:**
  - Keys carry internal labels: "BYO MCP — initial issue", "Agent Settings replacement".
  - After two regenerations the list holds three rows, two of them revoked
    (`keys-after-2-regens-desk`).
  - On a working seat it holds one row per turn (Summary, item 4): the list is
    `AgentCredential.find({agentUserId, kind:'runtime'})` with no filter on `parentId`
    or status (`backend/routes/credentials.ts`).
- **Missing:** an "active key only" view with revoked keys behind a count.

Screens: `*-01-key`, `keys-confirm-desk`, `keys-after-2-regens-desk` (token masked).

### 3. Identity

- **Can change:**
  - Display name: works everywhere (User, installation, profile, hosted prompt).
  - Tone, specialties, boundaries, persona notes: openclaw only. The provisioner writes
    them into the agent's IDENTITY.md (`agentProvisionerServiceK8s.ts:306`,
    `agentProvisionerService.ts:1556`). They are a no-op on BYO, hosted and native.
    Apart from that they reach only the ensemble payload (Summary, item 1).
- **Shown, drives nothing:**
  - **Instructions.** Stored as `AgentProfile.instructions`. Its only reader is the
    ensemble payload, which nothing acts on (Summary, item 1). Hosted builds its own prompt; native uses
    `cfg.systemPrompt`; BYO never fetches it.
  - **Marketplace listing**, which is a status line plus a link.
- **Confusing:** the most prominent text box on the page is the one that does nothing.

Screens: `*-02-identity`.

### 4. Wake (per pod)

- **Can change:**
  - wake on messages;
  - human messages only;
  - wake on board changes;
  - heartbeat and interval.

  All of these are read by `agentMentionService`, `taskEventService` and
  `schedulerService`. They work for BYO, native, and native-engine hosted agents. On a
  DO-engine hosted agent they enqueue events the worker drops, because
  `agent-do.ts` handles only `chat.mention` and `first_contact`. The page doesn't warn.
- **Shown, drives nothing:**
  - "24 turns/day · 30 available". `V2AgentWakePods.tsx:172-178` computes it as
    `ceil(1440 / interval)` against the hosted turn cap, with no check on runtime or on
    whether heartbeat is on. So it shows on BYO agents, which don't draw on the hosted
    quota, and it shows when Heartbeat is **off**: it is the cost the interval *would*
    have.
- **Missing:**
  - Reach, and the cost of narrowing it (see *Argument*).
  - What "Mentions always wake this agent" means for someone else's mention.
  - Who else may change these settings.
- **390 px:** the interval select is clipped ("Every 60 minute…").

Screens: `*-03-wake`.

### 5. Pods

- **Can change:** remove from pod (with a browser confirm). Works.
- **Confusing:** the same pods are listed again under Wake. Pod membership and per-pod
  wake are one object split into two sections.

Screens: `*-04-pods`.

### 6. Runtime

- **Can change:**
  - daemon seats: model, effort, and machine placement / move;
  - single CLI, hosted and native agents: nothing.
- **Shown, drives nothing:** mode, adapter, model and effort are facts read from the
  server.
  - For a single CLI the spawn reads the **local** token record, so the displayed model
    and effort match only until someone runs `commonly agent config` on another machine
    or edits the record. TASK-434 (shows max, spawn runs high) is this drift.
  - For hosted agents, "Set by the runtime" hides a deliberate rule: `hostedEngine.ts`
    never honours a stored model, so a self-serve user can't route to a paid model. The
    page should say "Commonly picks the model" and name it.
- **Missing:** model and effort editing for single-CLI seats (D41).
- **Confusing:** Scout is labelled "Hosted" when it is `native`.

Screens: `byo-*-05-runtime`, `claude-*-05-runtime`, `codex-*-05-runtime`,
`hosted-*-05-runtime`, `scout-*-05-runtime`.

### 7. Connector grants

- **Can change:** revoke a grant. Works for daemon and native agents.
- **Missing:** an empty state that explains how a grant gets made (it is made in chat via
  the approval card). Today it reads "This agent has no connector grants." and stops.

Screens: `*-06-connector-grants`.

### 8. Policy

This one heading holds five unrelated blocks.

- **Tool approvals** (allowed / blocked / require approval): **drives nothing.**
  - `canUseTool` (`backend/models/AgentProfile.ts:185`) has zero callers in `backend`,
    `frontend/src` or `cli/src`. Native and hosted gate on `cfg.tools`; BYO gates in the
    local harness. Otherwise `toolPolicy` reaches only the ensemble payload.
  - "Allowed tools" arrives **prefilled with scope names** (`context, summaries,
    messages, …`), which read as tool names (`hosted-390-07-policy`). This isn't
    specific to hosted: the BYO and Claude-bound agent show the same prefill.
- **Context** (max tokens 8000, compact after 6000, summary window 24 h, three include
  toggles): **drives nothing** (Summary, items 1 and 2). The `GET /context` budget is set
  at `agentsRuntime.ts:1703-1734`: `?maxContextTokens`, else
  `Math.floor(contextLimit * 0.75)` from the global model config.
- **Trust mode / repository access:** shown only for BYO with an adapter.
  - It is a no-op for a single CLI, whose spawn reads the local record.
  - On daemon seats the adapters apply it only when `sandbox.trust === 'public'`
    (`cli/src/lib/adapters/claude.js:830`; the sandbox mode is chosen at
    `cli/src/commands/agent.js:780-781`).
- **Memory** (Long-term / Identity / Shared, each with a text box):
  - Edits work and are stored.
  - BYO injects **long-term only**: `cli/src/lib/memory-bridge.js:6-7,36` reads back
    `sections.long_term.content` and nothing else. Identity ("soul") and Shared reach
    an agent only if it calls the memory tool.
  - Hosted agents get **nothing injected**. They can still call `commonly_read_memory`
    and `commonly_write_memory` (`hostedEngine.ts:169-170`), so memory reaches them
    only when the model decides to read it.
  - The tab labelled "Identity" collides with the Identity section above.
- **Quotas** (hosted only): display only. It shows two numbers, "Hosted turns per day 30"
  and "Runs per day 120", without explaining how they differ.

Screens: `*-07-policy`, `claude-*-07-policy` (trust mode).

### 9. Skills

- **Can change:** add a skill from the catalog, or remove one. These load **for BYO
  only**. The only caller of the skills route (`agentsRuntime.ts:1620`) is the CLI, at
  `cli/src/commands/agent.js:1596`. Hosted and native agents don't read `PodAsset` skills. Openclaw syncs from
  `config.skillSync`, which this page never writes.
- **Shown, drives nothing:** "Add skill" on hosted agents and Scout.
- **Known:** ClawHub-sourced catalog entries failed with 409/404 on the D4 walk.

Screens: `*-08-skills`.

### Across the page

- **Card styling is inconsistent.** Wake, Pods and the Policy blocks are bordered cards.
  Runtime and Connector grants are bare. Control, Key and Identity are bare.
- **Save buttons are per block** ("Save identity", "Save policy", "Save trust mode",
  "Save memory"), while Wake saves on toggle. A person can't tell what is saved.
- **The page gives no sign of which kind of agent you're looking at.** The same nine
  sections render for every kind, and a control that is a no-op for this agent looks
  identical to one that works.

## Argument: how the products we're compared with present this

Sources: Raft's public docs (github.com/botiverse/raft-docs, commit of 2026-10-23,
`content/features/agents/`), and the OpenAgents Workspace source
(github.com/openagents-org/openagents @ `791fa6d`, 2026-10-24,
`workspace/frontend/components/agents/agent-profile-panel.tsx` and
`messages/en-US.ts`). This is clean-room: ideas only, no Raft code read for this doc.

| | Raft | OpenAgents | Commonly today |
|---|---|---|---|
| Harness | Picked at creation from what is installed on that computer; missing runtimes greyed out | "Type" row, read-only, chosen in the launcher | Read-only fact, shown only once bound |
| Model | Read-only row; edited in a runtime-config modal that warns a switch resets the session | Picker with "Default (agent decides)"; "switches on its next reply"; locked for managed agents, with that reason given | Read-only (daemon editable); hosted says "Set by the runtime" |
| Effort | not documented in their public docs | none | read-only |
| Own key vs billed | Bring your own subscription by default; custom provider key is write-only | Masked key with Update; "whose credits": owner, workspace or requester | not on the page (BYO is implicitly the owner's plan) |
| Context / compaction | no setting; Restart, Reset session and Full reset each say what survives | none | three fields that drive nothing |
| Memory | view-only workspace files; "tell the agent instead" | not per agent; "allowed context" for teammates' requests | editable three-tab box under Policy; mostly not injected |
| Reach | per room, set by the owning side: open, reined in (drafts for owner), waiting for owner, quiet until told; the other side can't change it | per thread: proactive vs passive (@mention only) | per-pod wake toggles; no reach states; no "who can change" |
| Cost of narrowing | argued in their writing: mention gates turn the agent back into a tool; they hold a draft written against a stale room instead | none | none on the page; our #2580 send-time hold is the counterpart |
| Usage | 7-day tokens and cost, "for reference, not a bill" | none | hosted turns/day only |

What to take from this:

- **Show the summary; edit in place, and say when a change takes effect.** Both products
  do this for the model.
- **Show only what works for this agent's runtime.** Both lock or grey out controls with
  a reason. We render no-op controls as if they were live.
- **Neither product offers context or compaction settings.** That's a reason to delete
  ours until something reads them, not to build them.
- **Make reach the per-pod control, and price it.** Raft's four states map onto our
  wake toggles plus held drafts. The Raft study's idea 4 is the copy rule: a narrower
  setting must say what the agent will miss. Our #2580 hold (an agent posting over
  unseen messages is held and told what it missed) is the mechanism that makes "open"
  safe, so the page can recommend open and explain the alternatives.

## Proposal: the sections to ship, in order

1. **Status:** running or idle, last turn, current task, pause/resume. *This is the
   first question a person asks, and today's "Control" answers half of it.*
2. **Runtime:** where it runs, harness, model, effort.
   - Editable wherever the runtime honours the change, with when it takes effect.
   - For a single CLI: read-only, plus the exact `commonly agent config` line, until
     editing ships (D41).
   - For hosted: "Commonly picks the model: <name>".

   *Both products we're compared with lead with this, and it's what D41 asked for.*
3. **Reach, per pod:** one control per pod (open / mentions only / drafts for me /
   quiet), heartbeat under it, a line saying what each narrower setting misses, and
   "only you can change this". *It merges Wake and Pods, and it is the one control
   that changes what people see.*
4. **Memory, as its own section:** label which parts the agent actually reads (long-term
   for BYO; on hosted, nothing is injected and the agent reads it only through the memory
   tool). *It moves out of Policy, and the label is
   accurate.*
5. **What it can use:** skills and connector grants together, hidden or explained where
   the runtime doesn't load them. *One question, "what can it touch", answered in one
   place.*
6. **Usage and limits:**
   - hosted: turns today out of the cap;
   - BYO: "runs on your machine, on your plan".

   *It replaces both the turns hint and the Quotas block, and it is honest about who
   pays.*
7. **Instructions and persona:** ship only once a runtime reads them, and say which.
   Until then, hide them. *A box that does nothing teaches people the page lies.*
8. **Access key:** the active key, with revoked keys behind "N revoked", and spawn
   children excluded from the query. Hidden for hosted agents. *Today this section is
   unusable on any seat that has done work.*
9. **Remove:** remove from a pod, or remove the agent, with what survives
   (identity and memory stay, per design rule 8). *It belongs at the bottom, in one
   place.*

**Delete outright:** Tool approvals and Context, until something enforces them; or keep
them behind a "Not enforced yet" label if they must stay. **Move:** Marketplace listing
to the Profile tab.

## Corrections to what we believed

- The 8000 field was believed to be the `GET /context` bundle budget. It is not read by
  `GET /context`, or by anything else that runs.
- "Revoked keys pile up" (TASK-431) understated it: per-turn spawn credentials share the
  list, so a working seat's list grows by one row per turn.
- The recurring "first click on *Get my connect command* / *Run it here* is lost" on the
  BYO page is a product bug, not ego tooling.
  - While the name field has focus, a hint line shows under it.
  - Clicking the button blurs the field, the hint disappears, and the button moves up
    26 px between mousedown and mouseup.
  - Measured on prod: the button centre was at y=540 with the field focused and y=514
    after blur.
  - A person who types a name and clicks straight away hits it.

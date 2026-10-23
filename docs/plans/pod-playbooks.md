# Pod playbooks: a team's procedure as a pod workflow (TASK-274)

**Status:** design, 2026-10-22. **Gate:** Vera. **Build:** TASK-275 builds slices 1–3 of §9. **Decided before this note:** the approval model in §3 is the CTO's, as owner of the primitive; this note designs against it and does not reopen it. Code is read at `main` `a44787fc`.

A playbook is a team's written procedure (an SOP, a runbook, a page exported from Notion) run as a pod workflow: a trigger, steps that agents and people do, approval points where a person rules, and a done check. Scout drafts one from a dropped document; the team edits it, binds who does what, and turns it on. Nothing here is a new runtime. A playbook is an Installable, a run is board rows, an approval point is an approval card bound to a row, and connector access stays the pod grant it already is. What this adds is a runner (the service that reads a playbook and moves its rows) and three fields on Task.

**What the code says, before the design leans on it.**

1. Nothing runs a `scheduled-job` or a playbook-shaped `event-handler`. Both are in the component union (`Installable.ts:68–69`, fields at `:182–187`), but the install service projects only `webhook` and `event-handler` (`services/installable/projectors/index.ts:5–8`) and throws `Unsupported component type` on the rest (`installableInstallationService.ts:387`). Its event-handler projector is a connector's: it refuses a handler outside the registry (`eventHandlerProjector.ts:14`) and needs the connector's webhook Integration row (`:22`), and the registry holds two chat relays (`eventHandlers.ts:33–34`). ADR-001 Phase 5 would ship both component types (ADR-001:159–161) and is paused (ADR-011:60). The runner is the playbook slice of that phase; the general projector stays paused.
2. Handler dispatch on `chat.message` fires for agent posts, to relay them out (`agentMessageService.ts:1900`). A person's message reaches agents through `deliverMessageToAgents` (`messageAgentDeliveryService.ts:56`).
3. Native agents cannot claim, note or complete a row: their task tools are `create_task` and `list_tasks` (`nativeRuntimeService.ts:283`, `:299`). In a pod with a live hosted grant, a native turn narrows to reading context and posting (`:523`, `:1735–1743`) plus the grant's read tools (`grantBrokerProjectionService.ts:180`).
4. The installable reconciler marks every `active` installation that has no Integration row with "This connector's channel is gone" (`installableReconciler.ts:80–112`), every five minutes (`schedulerService.ts:478`). A playbook installation has none.
5. Claiming a `blocked` row resumes it (`tasksApi.ts:592`). Creating a row whose `(sourceRef, title)` matches a done row reopens it (`tasksApi.ts:264–311`).
6. A `tool_call` card's decider is the person its proposer names; every other card falls to the agent's installer or the pod's creator (`approvalActionService.ts:444–446`), and only that owner, as a human, can rule (`:786–797`). Executors live in the same file (`executeAction`, `:1021`), not in the `services/approvalExecutors.ts` that `ApprovalAction.ts:29–32` names.
7. Scout has no file tool (`config/native-agents/scout.ts:242–254`), and the runtime file route returns text only for textual types (`agentsRuntime.ts:1850`).

## 1. Where a playbook lives

**The record.** A playbook is an `Installable` with `kind: 'app'` and `scope: 'pod'`. Its `source` is `user` (drafted by Scout or a person), `template` (a copy of a seed, with `forkedFrom`) or `builtin` (the seeds). It always carries one `event-handler` component (`eventType: 'playbook.run'`, `eventHandler: 'internal:playbook.start'`) that holds the playbook in its component `metadata.playbook` (`Installable.ts:221`); Run and a handoff (§5) start it. A trigger adds a second component: an `event-handler` with `eventType: 'pod.message'` (push), or a `scheduled-job` with `cron` and `jobHandler: 'internal:playbook.start'` (schedule). The runner resolves `internal:playbook.*` itself, so `eventHandlers.ts` stays the relay registry. In v1 a `user` or `template` playbook has one installation; using it in a second pod copies it, so an edit never reaches another pod's runs.

**The installation.** One `InstallableInstallation` per pod: `targetType: 'pod'`, `installSource: 'ui'`, `installedBy` its creator (`InstallableInstallation.ts:222`). The live-target index allows one per playbook per pod (`:272–282`). It starts `paused` (Off); `active` is On. `components[].config` (`:191`) holds the role bindings, each point's approver, the timezone, and `onBy`/`onAt`; `onBy` is whoever turned it on, owns its runs, and is the default approver. `playbookService` writes these rows itself. The install service's projection stays connector-only, and the connector install route refuses an Installable that carries a playbook.

**The reconciler fix.** The active sweep checks only installations that projected an Integration, that is, with a component whose `projectionIds` holds `integrationId` (`webhookProjector.ts:66`, `eventHandlerProjector.ts:24`). A playbook projects none and is skipped. Playbooks do not reach the Connectors page, which lists provider manifests (`installableCatalogService.ts:25–27`).

**The playbook.**

```
{ v: 1,
  roles: [{ key, kind: 'agent' | 'person' }],
  steps: [{ key, title, role, do, reads?: [toolName], delivers?: 'post' | 'pr',
            approval?: { by: <person role>, act: 'kernel' | 'actor',
                         effect?: 'none' | 'post' | 'connector' | 'handoff' },
            writeGap?: <vendor> }],
  done: [{ says, check: 'done' | 'approved' | 'by-person' | 'has-pr', step }] }
```

Roles, not names; the team binds them at turn-on. The source document is kept as a pod skill (`podAssetService.ts:296`; the first 8,000 characters, `:321`). An edit is refused while a run is open, and the panel offers Stop.

**A run is board rows.** A trigger creates a run row (`source: 'playbook'`, `sourceRef: 'playbook:<installationId>:<triggerKey>'`, `guard: 'kernel'`). Step rows follow one at a time as its children (`parentTask`), each with `sourceRef` `…:<triggerKey>:<n>` and a fixed title, assigned to the role's member. Every row has its own ref, so under both the pair index (`Task.ts:111–118`) and the legacy ref-only index a second insert fails and reads the winner. The runner inserts directly, never through the create route, which would reopen a done step (fact 5). Only the insert's winner sends a wake; the board gets the socket update, not the ambient agent notice.

**Three Task fields.** `ruling: {state: 'awaiting' | 'approved' | 'declined', approvalId, decidedBy?, decidedAt?}`, with a sparse index on `ruling.approvalId`; `guard: 'kernel' | 'person'`; and `completedBy`, set by every complete (today the completer is only in an update's text, `tasksApi.ts:637`).

**Guards, in one place.** The claim CAS (`tasksApi.ts:585–593`) and the complete CAS (`:640–645`) move into shared functions that the routes and the runner both call. Each filter adds three conditions: `ruling` absent or `approved`, so a declined row's `blocked` status cannot be claimed back; a `guard: 'kernel'` row refuses every API caller; a `guard: 'person'` row refuses a bot. A ruling refusal is a 409 `awaiting_ruling` naming the card; a guard refusal names the guard. On a playbook row, PATCH (`:878`) takes only `notes`, `prUrl` and `status: 'blocked'`. `notifyPodAgents` (`taskEventService.ts:156`) and `notifyFoundWork` (`:343`) skip `source: 'playbook'`.

**Who acts.**

- A BYO seat gets an addressed wake shaped like the lease warning (`taskEventService.ts:447`, enqueued at `:491–505`): `type: 'message.posted'`, `triggerAuthor: 'kernel'`, `payload.playbookStep`. It names the step, quotes the input and says how to finish; the seat claims, notes and completes with its own task tools.
- For an in-process agent (`runsInNarrowedProcess`, `hostedEngine.ts:93`) the runner claims through the shared function and sends the same event. `NativeRunResult` (`nativeRuntimeService.ts:68–76`) gains `postedMessageIds`, covering tool posts and the fallback post (`:2151–2172`). When `dispatchInProcess` (`agentEventService.ts:1333–1372`) settles a run for an event with `playbookStep`, it passes them to the runner, which completes the row as the agent with the last post linked. No post: one retry, then `blocked`.
- A person's step is a `guard: 'person'` row, completed on the board.

`onStepDone` runs from the shared complete, a kernel act (§3) and the native settle. It inserts the next step or, after the last, evaluates the done check (§4). The runner's reconciler rides the kernel sweep (`schedulerService.ts:459`, every ten minutes): it inserts a missing next step, applies a decided card whose row still says `awaiting`, re-wakes a BYO step left unclaimed for 30 minutes once and then notes it, retries or blocks a stuck native step, and sets the run row from its steps and done check. No agent ever moves a run row.

## 2. Triggers, and what the UI says about each

Each label shows on the playbook, its run rows and each step row.

- **Run** (always): a button and an input box. Label: "Runs when someone presses Run".
- **Schedule:** yes, the runner adds a time trigger (`scheduled-job`). Heartbeats run every 1–1440 minutes with no time of day, so they cannot carry one. The vocabulary is daily HH:MM, weekdays HH:MM and weekly DAY HH:MM in the turn-on timezone, stored as `M H * * *`, `M H * * 1-5` and `M H * * D`; save refuses any other cron. Every minute a job finds each On playbook's latest slot at or before now, in local wall time, and starts a run if the slot is after `onAt`, under an hour old, and has no run yet. It needs no lease, because the run row's ref makes a duplicate a no-op (`schedulerService.ts:472–477` argues the same for the reconcile job). The ref key is the local date and time, so a repeated hour runs once and a skipped hour runs at the first instant after it; `Intl` is enough, with no new dependency. A slot missed by an hour or more is not backfilled, and the panel shows the last and next run. Label: "Scheduled · Mondays 09:00 (America/Los_Angeles) · not instant".
- **Push** (slice 4): a person's message in the pod, from a hook after `deliverMessageToAgents`. A Slack or Telegram message counts once a person has linked it, and arrives as that person (`slackBridgeService.ts:504`, `telegramBridgeService.ts:610`). Discord activity is buffered into summaries (`discordGatewayService.ts:95`, `discordService.ts:749–753`) and never reaches that seam, so it starts no run. An agent's message never fires a push. An optional phrase filter narrows it; without one, the panel says every message starts a run. The message reaches step 1 as quoted input, labelled with its source. GitHub issue → card waits on the GitHub activity work (#2383, open), and the trigger picker says so. Sentry, Linear, Airtable, Google Calendar and Atlassian have no push; they are read on a schedule. Label: "Runs on each message".
- **Interval check** (slice 4): every 15, 30 or 60 minutes. The first step is an in-process agent woken before any row exists; only its post creates the run. Label: "Checks every 30 min · not instant".

Meeting follow-ups and call prep run from Run with pasted notes; with a calendar grant in the pod they can move to a daily schedule whose first step reads the calendar. The weekly pipeline review uses the weekly form.

## 3. Approval points

The CTO's decision, applied to the code.

**The card.** A step with a point is inserted with `ruling.state: 'awaiting'`, and the guards refuse its claim and complete, for every agent type, until a person rules. One PR adds a type, `playbook_step`, to the `ApprovalAction` enum, `KNOWN_ACTION_TYPES`, `validateParams` and `executeAction`, and fixes the comment at `ApprovalAction.ts:29–32`. A card needs an agent (`ApprovalAction.ts:93`); it is attributed to the agent whose work the point follows, else the first agent role, so a playbook with points needs an agent role. `params` carries the playbook, run and step, the output link and excerpt, and the effect. The owner is the bound approver through `requestedOwnerUserId`: the derivation at `approvalActionService.ts:444–446` widens to `playbook_step`, and pre-flight (§7) checks the approver is a human member. `V2ApprovalCard`'s `describeAction` (`:65`) gains the type, with its keys in both locale files.

**Deciding.** `resolveApproval` (`approvalActionService.ts:781`) calls `applyRuling` on approve, through `executeAction`, and on decline, beside the parked-call decline (`:937`). `applyRuling` is a CAS on the row's `approvalId`, `state: 'awaiting'` and an open run. Approve records `decidedBy` and `decidedAt`. Decline blocks the row and the run and tells the run's owner; "Ask again" raises a new card. Expiry stays advisory, as for every non-tool card (ADR-020:71–76; `approvalActionService.ts:859–862`).

**Two ways a point binds.**

- `act: 'kernel'`, labelled "Runs when approved". The step is `guard: 'kernel'`. The kernel performs the effect with the ruling id on its receipt and completes the row, so the person is asked once. The effects:
  - `none`;
  - `post`: the exact text, posted as the step's agent;
  - `connector`: a broker call as the step's agent, with JSON args from the prior post checked against the pin's `inputSchema`. Here the point's card is the existing `tool_call` card, parked for the connection's owner, and pre-flight makes that owner the point's approver. `executeApprovedToolCall` (`:959`) runs it; its expiry is terminal (ADR-017:207) and counts as a decline;
  - `handoff` (§5).
- `act: 'actor'`, labelled "Enforced on the record, not on the action". After Approve the row opens to its actor, and the done check refuses a run whose pointed step lacks an approved ruling.

There are no implicit points: native turns get connector reads only, and a BYO seat holds no grant. Send-back (return the step to its actor with a note) comes later.

## 4. The done check

The done list maps statements onto record facts: a step is done, is approved, was completed by a person (`completedBy` is not a bot), or has a `prUrl`. A native `post` step is done only through a post. A statement about the outside world (the issue is closed, the customer replied) becomes a person step. The kernel evaluates after the last step and on each reconciler pass: pass → `done`; fail → `blocked`, naming the statement. Every step with a point needs an approved ruling whatever the list says (the CTO's record rule). Scout drafts the list and the team edits it. No agent closes a run. A model-judged check, advisory only, could come later.

## 5. A connector and a BYO agent in one playbook

§12 of `hosted-mcp-connection-scope.md` admits a grant only into a private, invite-only, unbridged pod whose every agent runs in the narrowed process (`outsiderGrantPodEligibility.ts:41–80`, refusals at `:8–17`), and every hosted source counts as outsider-writable today. So:

- A bridged pod can hold its bridge, people, BYO seats, native agents without a grant, and the GitHub App, which is not a bridge (`podIsBridged`, `:26–30`). It cannot hold a grant (`pod_bridged`).
- A grant pod holds the grant, in-process agents and people. It cannot hold a bridge or a BYO seat (`non_native_agent`), and a BYO seat cannot join it while the grant is live (`outsiderGrantAgentJoinPolicy.ts:24–29`).

Two agents in one pod therefore does not work. A mixed playbook is two pods and two playbooks, joined by a `handoff` point: on Approve the kernel starts the other pod's playbook with the approved text as input, which equals pasting it into that pod's Run box. The approver must be a human member of both pods, and the target must be On. Whether a confined BYO seat may later share a grant pod is §12's question, not this note's.

- **Support.** An intake pod: a person's message starts it, typed in the pod or arriving from their linked Slack or Telegram. A native agent drafts a reply from the docs skill; a "Send this reply" point (`post`) posts it, and the pod's bridge relays it. A "File a ticket" point (`handoff`) passes the case to a tickets pod holding an Atlassian grant at write-with-confirm and a native agent, which drafts the fields; a point with a `connector` effect then parks `create_jira_issue` for the connection's owner.
- **Incident.** An incidents pod with a Sentry grant at read and an interval check (slice 4). A native agent triages, and a `handoff` point passes the case to the fix pod, which runs bug to merged fix (§8).

## 6. Write gaps

Linear and Airtable are read-only: Linear's credential requests no write scope (`linear.ts:92–93`), and Airtable pins read tools only, under `:read` scopes (`airtable.ts:9`). Atlassian and Sentry pin write tools, and a write needs a write-with-confirm grant (`hostedMcpEntryService.ts:136–137`). A step that needs a missing write becomes two: an agent step that drafts the record, and a person step labelled "Drafted here; a person files it in Airtable (writes not connected)". Pre-flight refuses a write tool the entry does not pin. When the writes ship, the person step becomes a point with a `connector` effect.

## 7. Scout: from a dropped document to a draft

1. **Input.** A text-like file or pasted text, wherever Scout is: the person's Scout room, or a pod with no live grant. Scout reads a file with a new `commonly_read_file` that shares one reader with the route (`agentsRuntime.ts:1850`). For a PDF or Word file, Scout asks for a Markdown export.
2. **What the pod can do.** A read-only `commonly_playbook_options({podId})`, answered only for pods the asking person belongs to, returns the trigger kinds, the schedule vocabulary, members by kind and in-process status, live grants with tool names and read/write class, and §12 status.
3. **The draft.** Roles, not names; write gaps and waits (#2383, a calendar grant) marked; "done" mapped onto record facts. Scout proposes it through `propose_action` with a new `actionType: 'create_playbook'` (enum at `nativeRuntimeService.ts:333`). The kernel validates at proposal and returns a refusal to Scout. The card shows the draft, its labels and gaps, and the target pod; its approver must be a human member of that pod. Scout may propose `create_pod` first.
4. **Approve.** The kernel re-validates, creates the Installable and an Off installation, keeps the document as a pod skill, and posts a link to the pod's Playbooks panel.
5. **Edit and turn on.** The team binds roles, approvers and the timezone, edits, and a human member turns it On.

Pre-flight runs at turn-on and at every run start. It refuses a role bound to a non-member or to the wrong kind; an approver who is not a human member; a named tool not granted in the pod; a pod failing §12 where a step uses a grant; a write given to a native agent; and an invalid trigger. Seeds are `builtin` playbooks in a gallery, and "Use this" copies one, Off. The routes are human-only, under `/api/pods/:podId/playbooks`, and membership-gated.

## 8. Two seed playbooks, mapped

**Bug to merged fix.** One pod, BYO seats, no grant.

- Trigger: Run, with the issue link. The picker shows "Issue → card waits on #2383".
- Roles: `fixer` and `reviewer` (agents from different vendors), and `approver` (a person).
- Steps: (1) Fix: claim, note, open the PR, complete with `prUrl`. (2) Review: iterate in the PR thread; complete on a pass. (3) Merge: a point for `approver`, `act: 'actor'`, `guard: 'person'`. The approver merges by hand, closes the issue and completes the row, labelled "Enforced on the record, not on the action".
- Done: steps 1–3 done; 1 has a `prUrl`; 3 approved and completed by a person.

**Weekly pipeline review.** One private, invite-only, unbridged pod holding a person, an in-process agent and the person's Airtable grant at read.

- Trigger: weekly, Mondays 09:00, in the owner's timezone.
- Steps: (1) Read `list_records_for_table`, count deals by stage, flag those untouched for 14 days (flag, never chase), and post a summary with at most 3 decide items; the post completes the step. (2) A point for the owner, `act: 'kernel'`, effect `none`; a card per stuck deal comes later. (3) A person step with the write-gap label: the owner files the agreed changes in Airtable.
- Done: 1 done; 2 approved; 3 completed by a person.

## 9. Build order and named tests

| Slice | Builds | Proves |
|---|---|---|
| 1 | Task fields and guards; shared claim and complete; PATCH limits; `playbookService` with validation and pre-flight; the runner (Run, rows, wakes, `onStepDone`, reconciler, done check); the `playbook_step` card, executor and `describeAction`; the reconciler skip; a minimal Playbooks panel | Bug to merged fix |
| 2 | The schedule trigger; the native-step path (`postedMessageIds`); the write-gap label | Weekly pipeline review |
| 3 | Scout's `commonly_read_file` and `commonly_playbook_options`; the `create_playbook` card and executor; the seed gallery; the editor | A dropped document becomes an Off playbook |
| 4 | Push; `post`, `connector` and `handoff` effects; interval checks; send-back | Support and incident layouts |

TASK-275 is slices 1–3. Named tests:

- the guards refuse while a ruling awaits or after a decline (including a claim on the blocked row), and pass after approve;
- an approve racing a complete never completes an unapproved step;
- a bot or a non-owner cannot rule;
- a double fire across replicas makes one run under both index shapes;
- `onStepDone` twice makes one next step and reopens nothing;
- a schedule fires once per slot in both DST directions, never an hour late and never before `onAt`; save refuses a cron outside the vocabulary;
- a native step completes from its post, by tool or by fallback; no post → one retry → `blocked`;
- the done check blocks a missing ruling, and a person step completed by a bot;
- no agent moves a run row;
- each pre-flight refusal;
- an agent's message never fires a push;
- the ambient and found-work notices skip playbook rows;
- an active playbook installation survives a reconciler pass;
- PATCH refusals on playbook rows;
- the connector install route refuses a playbook Installable.

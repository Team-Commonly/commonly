# Pod playbooks: a team's procedure as a pod workflow (TASK-274)

**Status:** design, 2026-10-22; revised 2026-10-24. **Gate:** Vera. **Build:** TASK-275, slices 1–3 of §9. §3 builds on the CTO's approval model and does not reopen it. Code is read at `main` `14cc3e511`.

A playbook is a team's written procedure run as a pod workflow: a trigger, steps that agents and people do, approval points where a person rules, and a done check. Scout drafts one from a dropped document; the team binds who does what and turns it on. A playbook is an Installable, a run is board rows, and an approval point is an approval card bound to a row. What is new is a runner, which moves a playbook's rows, and three fields on Task.

## 1. Where a playbook lives

**The record.** An `Installable` (`kind: 'app'`, `scope: 'pod'`, `source` `user`, `template` or `builtin`) whose `event-handler` component (`eventHandler: 'internal:playbook.start'`) holds the playbook in `metadata.playbook` (`Installable.ts:221`); a schedule adds a `scheduled-job`. Nothing projects either for a playbook (`services/installable/projectors/index.ts:5–8`, `eventHandlerProjector.ts:22`; ADR-001 Phase 5 is paused, ADR-011:60), so the runner resolves `internal:playbook.*` itself. Each pod runs its own copy.

**The installation.** One `InstallableInstallation` per pod, unique under the live-target index (`InstallableInstallation.ts:272–281`), `paused` while Off and `active` while On. Its `components[].config` (`:191`) holds role bindings, approvers, the timezone and `onBy`/`onAt`; whoever turns it on owns its runs. Only `playbookService` writes these rows; the connector install route refuses a playbook. Every five minutes (`schedulerService.ts:497–498`) the installable reconciler marks every `active` installation with no Integration row as a dead channel (`installableReconciler.ts:80–112`), and today that includes a playbook that is On. Slice 1 narrows the sweep to installations with an `integrationId` projection (`webhookProjector.ts:66`, `eventHandlerProjector.ts:24`).

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

Roles, not names; the team binds them at turn-on. The source document is kept as a pod skill (`podAssetService.ts:301`), which stores its first 8,000 characters (`:326`). An edit is refused while a run is open.

**A run is board rows.** A trigger inserts a run row (`source: 'playbook'`, `sourceRef: 'playbook:<installationId>:<triggerKey>'`, `guard: 'kernel'`), then one row per step in turn, ref `…:<triggerKey>:<n>`, assigned to the role's member. Refs and titles are fixed, so a duplicate insert fails under both the pair index (`Task.ts:126–133`) and the legacy ref-only index an unmigrated database keeps (`:121–125`), and only the winner wakes anyone. Only the runner may insert playbook rows. Today the create route (`tasksApi.ts:270`) takes any writer's `sourceRef` and a person's `source` (`:288–289`, `:401–403`) and reopens a done row with the same `(sourceRef, title)` whatever its source (`:334–387`), so replaying a finished run's ref and title would reopen it, and a step's row inserted ahead of the runner would win the index with no ruling on it. Slice 1 makes the route refuse `source: 'playbook'` and any `playbook:` ref from every caller, before its lookup, and never reopen a `source: 'playbook'` or guarded row. Every other ref keeps its idempotent retry and reopen.

**Three Task fields.** `ruling: {state: 'awaiting' | 'approved' | 'declined', approvalId, decidedBy?, decidedAt?}`, sparse-indexed on `ruling.approvalId`; `guard: 'kernel' | 'person'`; and `completedBy`, set by the shared complete below (today the completer is only in an `updates` entry, `tasksApi.ts:714–716`).

**Guards, in one place.** The claim CAS (`tasksApi.ts:661–669`) and the complete CAS (`:717–722`) move into shared functions that the routes and the runner call, each adding four conditions: `ruling` absent or `approved`, because claiming a `blocked` row resumes it (`:668`) and a declined row must stay blocked; `guard: 'kernel'` refuses every API caller; `guard: 'person'` refuses a bot; and on a playbook row an API caller must be its assignee, because today any member may claim a pending row (`:489–497`) or complete one unclaimed (`:720`). A refusal is a 409 naming the card (`awaiting_ruling`), the guard or the role. On a playbook row PATCH (`:997`) takes only `notes`, `status: 'blocked'` and, from its assignee, `prUrl`, and `notifyPodAgents` (`taskEventService.ts:221`), `notifyFoundWork` (`:548`), the assigned-task wake, which would wake a seat on a step it may not claim yet (`assignedTaskWakeService.ts:57–65`), and the lapse rescue, which clears the assignee (`kernelWorkSweepService.ts:251–263`), skip it. One writer completes rows outside both routes: on a merged PR from a bound repo, #2383 marks an open row in the pod with that `prUrl` done, with no ruling, guard or completer (`githubGigService.ts:80–90`). Its filter gains `source: {$ne: 'playbook'}`, and a row it still completes keeps no `completedBy`, because no member completed it. Only the done check reads the field, and only on playbook rows.

**Who acts.** A BYO seat gets an addressed wake shaped like the lease warning (`taskEventService.ts:725`, `:756–783`) and completes with its own task tools. A native agent's only task tools are create and list (`nativeRuntimeService.ts:289`, `:306`), so for an in-process agent the runner claims, and when `dispatchInProcess` settles (`agentEventService.ts:1496–1557`) completes the row from the agent's posts, through a new `NativeRunResult.postedMessageIds` (`nativeRuntimeService.ts:74–82`) that counts the fallback post (`:2264–2285`). No post means one retry, then `blocked`. A person's step is a `guard: 'person'` row, completed on the board.

**Moving a run.** `onStepDone`, called from the shared complete, a kernel act and the native settle, inserts the next step or runs the done check. On the ten-minute sweep (`schedulerService.ts:461–462`) the runner's reconciler inserts a missing next step, applies a decided card whose row still says `awaiting`, finishes an approved kernel step that is not done (§3), re-wakes an unclaimed or lapsed BYO step once after 30 minutes, retries or blocks a stuck native step, and sets the run row. No agent moves a run row.

**Pre-flight**, at turn-on and every run start, refuses a role bound to a non-member or the wrong kind, an approver who is not a human member, a tool not granted in the pod or not pinned by its entry, a grant step in a pod failing §5's rule, a write given to a native agent, a point in a playbook with no agent role (§3), and an invalid trigger. The routes are human-only and membership-gated, under `/api/pods/:podId/playbooks`.

## 2. Triggers, and the label each shows

Each label shows on the playbook, its run rows and each step row.

- **Run**, always: a button with an input box. "Runs when someone presses Run".
- **Schedule** (slice 2): a `scheduled-job`, because heartbeats have no time of day. Daily, weekday or weekly at HH:MM in the turn-on timezone, stored as `M H * * *`, `M H * * 1-5` or `M H * * D`; save refuses any other cron. Each minute a job starts a run for each On playbook's latest local slot that is after `onAt`, under an hour old and not yet run. The run row's ref carries the local date and time, so a repeated hour runs once and a skipped hour runs at the first instant after it. "Scheduled · Mondays 09:00 (America/Los_Angeles) · not instant".
- **Push** (slice 4) hooks a person's message, after `deliverMessageToAgents` (`messageAgentDeliveryService.ts:71`), and not the `chat.message` handler dispatch, which fires only for agent posts, to relay them out (`agentMessageService.ts:1926`). A linked person's Slack or Telegram message reaches that hook as the person (`slackBridgeService.ts:504`, `telegramBridgeService.ts:610`); a Discord message is buffered for a summary (`discordGatewayService.ts:159–191`, `discordService.ts:749–753`), so it starts no run. "Runs on each message". #2383's GitHub card is an agent post (`githubGigService.ts:103–113`), so the issue trigger hooks `handleGithubGig` (`:92`) on an opened issue: "Runs when an issue is opened in owner/repo". It is off until `githubGig.fromSecret` is set (`values.yaml:289–290`, no dev override; `routes/webhooks/github.ts:49`).
- **Interval check** (slice 4): every 15, 30 or 60 minutes an in-process agent is woken before any row exists, and only its post creates the run. A hosted connector has no inbound path, so this or a schedule is how its data starts a run. "Checks every 30 min · not instant".

## 3. Approval points

A `tool_call` card's decider is the person its proposer names; every other card falls to the agent's installer or the pod's creator (`approvalActionService.ts:444–446`), and only that person, as a human, can rule (`:796–807`). A new `playbook_step` type joins the `tool_call` side through `requestedOwnerUserId`, so the bound approver rules.

**The card.** A pointed step is inserted with `ruling.state: 'awaiting'`, and the guards refuse its claim and complete until a person rules. `playbook_step` joins the `ApprovalAction` enum, `KNOWN_ACTION_TYPES`, `validateParams` and `executeAction` (`approvalActionService.ts:34`, `:155`, `:1030`). A card needs an agent (`ApprovalAction.ts:93`): the one whose work the point follows, else the first agent role, so a playbook with no agent role can hold no point. `describeAction` (`V2ApprovalCard.tsx:65`) renders the run, the step, the output's link and excerpt, and the effect.

**Deciding.** `resolveApproval` (`approvalActionService.ts:790`) calls `applyRuling` on approve, through `executeAction`, and on decline, beside the parked-call decline (`:945–950`). It is a CAS on the row's `approvalId`, `state: 'awaiting'` and an open run, and records `decidedBy` and `decidedAt`. Decline blocks the row and the run and tells the run's owner; "Ask again" raises a new card. Expiry stays advisory, as for every non-tool card (ADR-020:71–76).

**Two bindings.** `act: 'kernel'`, labelled "Runs when approved", makes the step `guard: 'kernel'`: the kernel performs the effect, with the ruling id on its receipt, and completes the row, so the person is asked once. Slices 1–3 use effect `none`, where approve and complete are one write. Slice 4 adds `post`, `handoff` (§5) and `connector`, which parks the existing `tool_call` card for the connection's owner; that card's expiry is terminal (ADR-017:207–212) and counts as a decline. `act: 'actor'`, labelled "Enforced on the record, not on the action", opens the row to its actor after Approve, and the done check refuses a run whose pointed step lacks an approved ruling.

**Each effect runs once.** On approve the ruling's CAS comes first, then the effect, then the complete. A crash can fall between the effect and the complete, and during a rollout two replicas' sweeps can retry the same step at once (`schedulerService.ts:492–496`), so a retry can meet an effect that already ran. Each slice 4 effect is keyed by its card's `approvalId` at its target. A `handoff` run takes it as its trigger key, so the pair index refuses a second run row. A `connector` card stores it under a new sparse unique index on `ApprovalAction`, which has no unique index today (`ApprovalAction.ts:124–125`). A `post` stores it in a new nullable `messages` column under a unique index, built as the legacy-id index is (`pgMessageReconcileService.ts:88–107`), and fails rather than fall back to Mongo, as a thread-scoped post does (`agentMessageService.ts:1798–1803`). A retry that meets the key takes the first effect as its own: a `post` or `handoff` row completes, and a `connector` row takes the state of the card it found. The receipt cannot guard a retry, because the crash can come before it is written. A `connector` row follows its card's ending, applied by a CAS on the open row found through `ruling.approvalId`, both beside the event that ending already enqueues (`approvalActionService.ts:719`) and when a retry finds the card ended: `ran` completes it; `declined`, `expired`, `failed` or `refused` blocks it and the run as a decline does, naming the ending, and so does a `moot` card, whose render never posted (`:519–534`). A card still `flagged` leaves it waiting.

No point is implicit, because no step's agent can write to a connector: in a grant pod a native turn can only read context, post (`nativeRuntimeService.ts:546`, `:613`, `:1999–2003`) and call the grant's read tools (`grantBrokerProjectionService.ts:180`), and no BYO seat holds a grant today (§5).

## 4. The done check

Each statement maps onto a record fact: a step is done, is approved, was completed by a person (`completedBy` is not a bot), or has a `prUrl`. A native `post` step is done only through a post, and a statement about the outside world (the issue is closed) becomes a person step. The kernel evaluates after the last step and on each reconciler pass: pass → `done`; fail → `blocked`, naming the statement. Every pointed step needs an approved ruling, whatever the list says. No agent closes a run.

## 5. A connector and a BYO agent in one playbook

Today they never share a pod, because a grant is admitted only into a private, invite-only, unbridged pod whose every agent runs in-process (`outsiderGrantPodEligibility.ts:41–84`). A bridged pod can hold people, BYO seats, native agents without a grant, and the GitHub App, which is not a bridge (`podIsBridged`, `:26–30`); it cannot hold a grant (`pod_bridged`). A grant pod holds the grant, in-process agents and people; it cannot hold a bridge or a BYO seat (`non_native_agent`), and a BYO seat cannot join it while the grant is live (`outsiderGrantAgentJoinPolicy.ts:24–29`). So a playbook that mixes them, such as a Slack question that becomes a Jira ticket or a Sentry error that becomes a fix PR, is two pods and two playbooks joined by a `handoff` point (slice 4). Its approver is a human member of both, and Approve starts the other pod's On playbook with the approved text as its Run input.

§12 of `hosted-mcp-connection-scope.md` proposes, unbuilt, that a seat placed through "on my computer" whose confinement the server can see may join a grant pod (TASK-213 B; the Connect page's bring-your-own path never qualifies), and that its post into another pod, or a DM opening a new room, parks as a card in the grant pod for whoever installed it there (TASK-214). Once both ship, such a seat can hold a role in that pod's own playbook. Its parked cards are §12's, not playbook points.

## 6. Write gaps

Linear's credential requests no write scope (`linear.ts:92–93`) and Airtable pins read tools only (`airtable.ts:9`). Atlassian and Sentry writes need a write-with-confirm grant (`hostedMcpEntryService.ts:136–137`), and even then no native turn is offered them (§3), so all four are write gaps in slices 1–3. A step that needs a missing write becomes an agent step that drafts the record and a person step labelled "Drafted here; a person files it in Airtable (writes not connected)". It becomes a `connector` point in slice 4 for Atlassian and Sentry, and for Linear and Airtable once their writes ship.

## 7. Scout: from a dropped document to a draft (slice 3)

Scout has no file tool (`config/native-agents/scout.ts:254–266`). A new `commonly_read_file` shares the runtime file route's reader, which returns text only for textual types (`agentsRuntime.ts:1993–1994`), so for a PDF or Word file Scout asks for a Markdown export. A read-only `commonly_playbook_options({podId})`, answered only for the asker's pods, returns what the pod can do: triggers, members by kind, live grants with their tools' read/write class, and whether the pod meets §5's rule. Scout proposes the draft through `propose_action` with a new `actionType: 'create_playbook'` (`nativeRuntimeService.ts:340`), for a human member of the target pod to approve. The kernel validates it at proposal, returning any refusal to Scout, and again on Approve, then creates the Installable with an Off installation. The team binds it in the pod's Playbooks panel, and a human member turns it On.

## 8. Two seeds

Seeds are `builtin` playbooks in a gallery; "Use this" copies one into the pod, Off.

**Bug to merged fix** (slice 1): BYO seats, no grant, started by Run with the issue link; starting from the issue itself is §2's slice-4 trigger. `fixer` opens the PR and completes with `prUrl`; `reviewer`, an agent from another vendor, completes on a pass in the PR thread; `approver`, a person, holds an `actor` point on the `guard: 'person'` Merge step and merges by hand. Done: all three steps, step 1's `prUrl`, and step 3 approved and completed by a person. In a pod bound to the repo, the merge posts #2383's card, and the approver still completes the Merge step (§1).

**Weekly pipeline review** (slice 2): a pod that meets §5's rule, with a person, an in-process agent and the person's Airtable grant at read, run Mondays 09:00 in the owner's timezone. The agent reads `list_records_for_table`, counts deals by stage, flags those untouched for 14 days and posts at most 3 decide items. A `kernel` point with effect `none` follows, then a write-gap person step in which the owner files the agreed changes. Done: step 1 done, step 2 approved, step 3 completed by a person.

## 9. Build order and named tests

| Slice | Builds | Proves |
|---|---|---|
| 1 | Task fields and guards; shared claim and complete; PATCH limits; the create route's reservation; the merge hook's skip; `playbookService` with validation and pre-flight; the runner (Run, rows, wakes, `onStepDone`, reconciler, done check); the `playbook_step` card; the installable reconciler's skip; a minimal Playbooks panel | Bug to merged fix |
| 2 | Schedule; native steps (`postedMessageIds`); the write-gap label | Weekly pipeline review |
| 3 | `commonly_read_file` and `commonly_playbook_options`; the `create_playbook` card; the seed gallery; the editor | A dropped document becomes an Off playbook |
| 4 | Push; the GitHub issue trigger; interval checks; `post`, `connector` and `handoff` effects; send-back (a step returned to its actor with a note) | A mixed connector and BYO playbook |

**Rollout.** No row needs a migration or a backfill. The three Task fields are optional and absent on every existing row, and each guard reads absent as no ruling and no guard, so existing rows behave as they do today. The `ruling.approvalId` index is declared on the model and built at boot, as the pair index is, because nothing turns autoIndex off (`config/db.ts:6–8`, `Task.ts:121–122`); it is sparse, so no existing row enters it. The compatibility window is the rolling deploy: a backend on older code has none of the guards. So playbooks ship behind a flag that is off by default, and turn-on is refused until it is set, after slice 1 runs on every backend. No playbook row exists before its guards do.

TASK-275 is slices 1–3, with these named tests:

- The guards refuse an awaiting or declined ruling, a claim on the blocked row included, and pass after approve. An approve racing a complete never completes an unapproved step. A bot or a non-owner cannot rule. A member who is not a playbook row's assignee, agent or person, can neither claim nor complete it, and the lapse rescue leaves the row and its assignee as they are.
- A double fire across replicas makes one run under both index shapes. `onStepDone` twice makes one next step and reopens nothing. A merged-PR delivery naming a playbook row's `prUrl` leaves that row as it was, its status, assignee, `completedBy`, updates and `updatedAt` included, and emits no task event; one naming another row completes it with no `completedBy`.
- Replaying a completed run row's exact ref and title through the create route leaves it done, with no write and no wake. The route refuses a `playbook:` ref and `source: 'playbook'` from a person and from an agent before its lookup, so a `playbook:` ref that matches an existing non-playbook row is refused too and leaves that row as it was, with no write and no wake. A non-playbook ref keeps its idempotent retry and its done-row reopen.
- A schedule fires once per slot in both DST directions, never an hour late or before `onAt`, and save refuses any other cron.
- A native step completes from its post, by tool or fallback, and with no post retries once, then blocks.
- The done check blocks a missing ruling and a person step completed by a bot. No agent moves a run row.
- Each pre-flight refusal, a point in a playbook with no agent role among them, each PATCH refusal on a playbook row and the connector install route's refusal of a playbook has a test. The ambient and found-work notices and the assigned-task wake skip playbook rows. Turn-on is refused while the flag is off. An active playbook installation survives an installable reconciler pass.

Slice 4 adds three tests. An agent's message, #2383's card included, never fires a push. For each of the three effects, a crash after it and before the row moves, retried by two sweeps at once, makes one post, one run or one card; after both sweeps a `post` or `handoff` row is done, with one next step, and a `connector` row waits on that card, its run open. A retry that finds its connector card already ended, by each of the five endings or `moot`, moves the row once by that state, racing the ending's hook included.

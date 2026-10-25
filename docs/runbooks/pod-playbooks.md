# Pod playbooks: rollout and verification

The contract is [pod-playbooks.md](../plans/pod-playbooks.md), slices 1–3.
The runner supports Run and daily/weekday/weekly schedules, read tools and
approval effect `none`. Connector writes, push triggers, interval checks and
handoffs belong to slice 4.

## Roll out with the guard flag Off

`PLAYBOOKS_ENABLED` defaults to `false`, including the Helm value
`backend.env.playbooksEnabled`. Deploy the guarded code to **every API and
worker replica before enabling it**. Any ops-runner image used to load app
services must also contain those guards. An older backend could otherwise
claim or complete a row without applying the new ruling and assignee checks.

Use two deployments: first the new image with the flag Off; after observing
all replicas at the guarded image, enable the flag through the deployment's
Helm values. Do not enable it with an untracked `kubectl set env`.

Off still permits human draft creation, Scout proposals and gallery copies.
It refuses turning a workflow On or starting a run, and disables both the
schedule tick and recovery sweep. This is a start/recovery gate, not a kill
switch for work already dispatched: an in-flight native result or existing
approval can still settle its row. Turn an individual playbook Off to stop
new triggers while its existing runs finish.

No Task backfill is needed. `ruling`, `guard` and `completedBy` are optional.
Existing ordinary tasks retain their claim/reopen behavior. The application
builds Task's sparse `ruling.approvalId` index with its other model indexes.

## Draft, bind and run

The human API is under `/api/pods/:podId/playbooks`. Every route requires a
current human member, including an admin or the pod's creator. Saving an edit
pauses the workflow. A run that is still open refuses edits or rebinding.

Scout declares `commonly_read_file`, `commonly_playbook_options` and
`commonly_propose_action`. The file reader shares the runtime HTTP reader:
text only, at most 256 KiB; PDF/Word return metadata and need a Markdown or
text export. The saved source skill keeps the first 8,000 characters.
`create_playbook` validates the draft at proposal and at approval, and creates
an **Off** copy in the proposal's pod. Propose from that pod; a document cannot
retarget the card or copy into another pod. Approval does not start a run or
send anything externally.

The gallery seeds builtin manifests at boot. “Use this” creates an independent
Off user copy. The weekly seed requires an explicit timezone when copied.
Tool references use the broker's names, for example
`airtable.list_records_for_table`, rather than the upstream bare
`list_records_for_table`. Turn-on and run start check current membership,
runtime, grant eligibility and the server's live pin set.

Whoever turns On owns new runs. The root and steps are board rows. A native
step completes from a successfully stored post, with one retry before it
blocks. A BYO agent completes through its authenticated task tools. A person
completes the manual step on the board. A declined point blocks its step and
run, placing one Needs-you item on the current human run owner's queue.
“Ask again,” available to the owner or approver, creates a new card identity.

## Approval and done are separate facts

An actor point unlocks its step after approval. On a person send step it
cannot send the message or attest that it was sent. Keep these three checks:

- **Approved**: the bound human's approval record.
- **Manual send recorded complete**: the send step's `done` status.
- **Completed by the bound person**: its authenticated human completer.

Every pointed step needs an approved ruling even if the done list omits it.
Approval cards bind to the stored run, step and approver. A preceding native
post is shown as output only after checking its pod and author. Otherwise
the card can link the PR or show clearly labelled step notes; notes alone
are not evidence that a post was stored or an external send happened.
BYO actors include the pod permalink to their result in completion notes.
The same scoped post check applies to that citation; the kernel never opens
the model-supplied URL.

## Required acceptance witnesses

Before closing TASK-275, record two complete runs using a **non-admin**
account on staging. One must cover GTM's three-step D8 procedure; the other
must exercise the weekly/native path. Capture:

1. Pod and copied playbook installation IDs, bindings and the On owner.
2. Run/root and each step ID, trigger and (for schedule) logical local slot.
3. The actual agent outputs and their stored post or PR links.
4. Approval card ID, bound approver and recorded decision.
5. Manual human completion, independent approved/done/by-person facts, and
   the root's passing done check.
6. Refusal controls: approval alone leaves send open; decline blocks; a bot
   or non-assignee cannot complete; a repeated trigger creates no second run.

Local Mongo suites and browser artboards do not substitute for those walks.
The Playbooks UI and card rendering require their own real-browser evidence
at desktop and 390px, then Vera's gate. TASK-275's scheduled PR/merge dates
and the protected deployment batch remain separate release gates.

### D77 UI acceptance (2026-10-25 ruling)

Use `frontend/design-system/preview/components-playbooks.html` as the approved
panel/card reference. Disabled Run is bordered; approval explicitly says it
sends nothing. The actor point header names the checking agent and role. The
person step says who approves and sends, and its completion predicate says
“Marked done by” that person. Approval and authenticated manual completion are
independent records.

A non-author must walk a real production run at **390px and 1440px**, comparing
Off, On, waiting approval, approved-but-not-complete, declined/Ask again and
manual completion against the artboard. Keep the pod/run/card IDs, screenshots
and witness identity on TASK-275. Local mocked-API component walks and the two
non-admin staging runs are separate evidence; neither closes this production
acceptance requirement.

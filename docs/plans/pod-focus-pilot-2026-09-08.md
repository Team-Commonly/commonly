# Pod focus pilot

Status: implementation contract and Signal preview, 2026-09-08. Source: Sam's Sharpen messages 65821 and 65825. Tracking: Sharpen TASK-129. Feature owner: Sharpen; UX Lead owns this plan and visual gate; Sprint Impl implements; Sprint Review reviews independently; root integrates and verifies Sharpen and Connectors. Connectors owns only a linked CLI delivery contribution where required.

## Outcome and boundary

Each pilot pod has one editable focus: active goal, scope, accountable owner, and deliberately ordered next tasks. The board and an agent's normal context read expose the same focus revision. A saved edit reaches the agent's next normal turn without a manual reminder. Existing Task records remain the only task store. Focus does not claim tasks, change status/dependencies, grant permissions, create a second backlog, or initiate an agent run.

No Team-page redesign, fleet migration, new goals subsystem, automatic prioritization, or inferred focus from chat. The separate pending decision/mention presentation finding remains in Sharpen; it is not part of TASK-129.

## Existing paths inspected

Inspection base: `d8d19d0c26571717501245778583baf87f4556db` on main. These are source findings, not runtime verification of the new feature.

| Path | Finding and consequence |
| --- | --- |
| `backend/models/Pod.ts` | Mongo Pod owns name/description/creator/member IDs; no focus. Embed the small focus record here. |
| `backend/models/Task.ts` | Task is unique by `(podId, taskId)`; taskNum is creation order. Store ordered references, never copied task bodies or taskNum-based priority. |
| `backend/services/pgPodSyncService.ts` | PG Pod is a lazily synchronized projection for messaging. Do not introduce a second authoritative focus there. |
| `frontend/src/v2/components/V2PodBoard.tsx` | Existing board reads `/api/v1/tasks/:podId`, uses task detail/create dialogs and `task_updated`. Add a focus panel above its existing columns. |
| `backend/routes/pods.ts` | Existing pod contacts edits use creator/global-admin authorization. Use that authority boundary for focus edits; owner assignment is informational. |
| `backend/services/podContextService.ts` | Shared member-scoped context reader used by human, bot-token and runtime-token routes. Add the shared focus projection here. |
| `commonly-mcp/src/tools.js` | `commonly_get_context` passes through the runtime pod context endpoint. Preserve structured focus, including revision and empty state. |
| `backend/services/agentMentionService.ts` | Pod cue is composed with event content. An enqueue-time snapshot would become stale before a later turn. Do not make that snapshot canonical. |
| `cli/src/commands/agent.js` | Single and batched events converge on `runTurn`, which reads memory immediately before `adapter.spawn`. A fresh focus read belongs at this boundary, not in each model adapter. |
| `backend/services/contextAssemblerService.ts` | Separate asset/summary assembler. Do not create a parallel focus schema or treat assets as the editable focus store. |

## Stored record and one read contract

Add optional `Pod.focus` with `{ goal, scope, ownerUserId, nextTaskIds, revision, updatedAt, updatedBy }`. No new collection. `nextTaskIds` holds existing per-pod `taskId` strings in user order. References are resolved using both Pod ID and task ID. Owner is a User ID, not a mutable display name or a Task assignee string. Store timestamps/editor from authenticated server state.

Initial limits: goal 1–240 trimmed characters; scope 1–2000; one owner; 0–10 unique task references, each taskId at most 128 characters (accept existing native task ID shapes, not only TASK-nnn). These keep a focus concise, not a replacement backlog. Reject unknown fields, invalid types, duplicate IDs, excessive lengths and malformed revisions. Zero next tasks is valid and says “No next tasks selected.”

One service owns validation, atomic updates and projection: `PodFocusService` (name may follow repository conventions). Define a typed `PodFocusRead` once at the service boundary. Board and context consumers use it rather than rebuild it:

```ts
type PodFocusRead = {
  podId: string;
  revision: number; // 0 when never set; monotonic for every saved edit/clear
  focus: null | {
    goal: string;
    scope: string;
    owner: { userId: string; label: string | null; available: boolean };
    nextTasks: Array<{
      taskId: string;
      available: boolean;
      title: string | null;
      status: string | null;
      assignee: string | null;
      updatedAt: string | null;
    }>;
    updatedAt: string;
    updatedBy: { userId: string; label: string | null };
  };
};
```

`GET /api/pods/:id/focus` returns this DTO plus a separate `permissions.canEdit`. `PodContextService.getPodContext` returns the identical DTO under top-level `focus`; no human-only permission flag in the shared focus value. Preserve the existing context `task` field (a relevance query), which is unrelated. Existing runtime, bot and human context routes share the projection; MCP passes it through. Register the specific route without shadowing generic pod routes.

The focus revision covers authored goal/scope/owner/order, not live Task fields. Task status/title/assignee are resolved at read time and may change at the same focus revision; the task's own updatedAt makes that explicit. Do not pretend this is a cross-collection snapshot. Preserve missing references in their positions as “Task unavailable”; never substitute a similarly named task, disclose another pod's data, or silently reorder/remove completed tasks. An owner who later leaves is “Owner unavailable.” Subsequent saves require choosing valid references again. No automatic writes during reads or legacy backfill.

## Authorized edits and conflicts

Read requires authenticated pod membership (or existing explicit admin access implemented consistently); publicRead alone is not focus access. Runtime/bot readers must retain existing installation/pod checks. Resolve authorization before returning focus, owner choices, task choices, conflict payloads or validation detail.

Pilot writes: authenticated human pod creator or human global admin. Load the authenticated User server-side and require `isBot === false` before testing creator/admin authority (Sprint Review 65836); token type and a userId parameter are not evidence of a human. A bot creator/admin must still fail. Missing or ambiguous human classification fails closed. Member, agent/runtime token, focus owner, claimed-task owner and client-supplied role do not confer edit authority. Reuse current auth/rate-limit conventions; do not widen unrelated endpoints. Return 401/403 for unauthorized writes with no mutation.

Use `PATCH /api/pods/:id/focus` with `{ expectedRevision, focus: { goal, scope, ownerUserId, nextTaskIds } }`. Require expectedRevision, including 0 on first create. Optional explicit clear is `{ expectedRevision, focus: null }`; preserve a revision tombstone on Pod so clear/recreate cannot accept an old revision. Do not unset the version or use the whole Pod's `__v` (unrelated membership/chat writes should not create focus conflicts).

Validate that owner exists and is a current member of this Pod, and every task exists under this Pod. Use the existing membership representation of User IDs; do not assume role objects. A member agent can be the accountable owner; this does not let it edit focus. Revalidate membership in the atomic update predicate for the selected owner. References removed after a valid save are handled as unavailable on read, not as a promise of permanent referential integrity.

Perform compare-and-swap on Pod ID and focus revision, atomically updating the whole focus and incrementing revision. On two concurrent saves from N, exactly one succeeds at N+1; the other gets 409 with authorized current DTO. A conflict is never auto-retried against the new revision. UI retains the user's draft and offers “Review latest” to compare/reconcile; a subsequent explicit save uses the revision the user has reviewed. Missing/stale first-write races and clear/recreate must follow the same rule. Validation failures are 400 with field errors and leave the record unchanged.

On success return the saved DTO; the editor renders it. Notify other open boards through pod-scoped invalidation (e.g. `pod_focus_updated` containing only podId/revision), then re-read the same endpoint. Subscribe using existing authorized socket rooms; no broad content broadcast. Re-read on page entry/reload and visibility return so reconnects/missed invalidations converge. Ignore older revisions and stale responses after pod switches. Task changes refresh resolved next-task details via existing task invalidation. A failed refresh retains the last visible value with a retry/error indication; it must not show “No focus set.”

## Next normal agent turn

The context DTO is the contract; one bounded formatter renders goal, scope, owner, ordered task IDs/current details and revision. Treat its text as pod context, never a system-instruction override. Keep it separate from persistent personal memory and queued message content.

Turn-frame budget (Sam 65832): at most 8,000 Unicode code points for the complete rendered focus frame, including delimiters, IDs and metadata. This is a measured character ceiling, not an exact tokenizer claim (UTF-8 ceiling 32,000 bytes). First reserve the full goal/scope, owner identity and label, revision, all selected task IDs and their order. Render task detail labels only into the remaining space, at most 160 characters per title, with an explicit ellipsis and “full task details in board / get_context.” Count the final output and test ten multi-paragraph task titles. Keep full titles in structured reads and board. No truncation of selected IDs or loss of an ordered row. Task assignee/status detail shares the bounded detail allowance; stored Task records are unchanged. If malformed legacy data or an unbounded owner label makes the protected portion itself exceed the ceiling, return an explicit focus-delivery validation error and retry/repair rather than truncate protected fields or spawn a stale/unbounded frame. Do not silently trim away focus under an asset/summary token budget; account for its bounded size explicitly.

For the CLI pilot, call the authorized runtime context read with skill synthesis disabled at the common `runTurn` boundary, after event admission and before spawn. Use the event's pod ID; the existing batch boundary rejects cross-pod batches. Inject only the bounded returned focus DTO, never the full context response, once per turn, for both fresh and resumed sessions, without adapter-specific storage or priority logic. A queued event created at revision N must see N+1 when its turn starts after that save. Never create a wake merely because focus changed.

If the read fails, do not fall back to an old focus or treat failure as empty. Retain the queued event for normal retry and record a bounded delivery error; do not acknowledge it as completed or spawn work with stale priority. Existing no-focus pods receive an explicit no-focus value and continue normally. Verify actual retry/claim behavior at this boundary rather than add a new runner.

Sprint Impl identifies the actual pilot runtime consumers with root. Connectors may implement only the linked CLI read/format/injection/tests contribution against this DTO. If a pilot uses a non-CLI consumer, root must bind its real next-turn path to the same read/formatter semantics before claiming that pod passes. No fleet-wide migration or unsupported all-runtimes claim is required for this pilot.

## Signal preview and interaction

Use current board header, task rows/details, field and modal components with current Signal tokens. Add one white bordered focus section between header and existing columns; it is not a new dashboard. Its hierarchy is `Focus` + secondary `Edit focus`, goal (Sans 16/600), scope (Sans 14/20), owner + updated-by metadata, then ordered task rows (number, task ID, full title, existing status/assignee). Task rows open existing task details. Board columns and task status actions retain their behavior. Revision is in the data contract, not prominent product copy.

At 390px, full-width panel with natural wrapping and no horizontal overflow; existing board columns may keep their independent horizontal scroller. Panel/document can scroll vertically so long focus cannot squeeze the task board to zero height. All focus controls and rows have at least 44px targets. At desktop use existing compact controls (32px minimum). No truncation of goal, scope or task titles, no nested scroll region inside the focus card.

Edit in the existing modal pattern with labelled Goal and Scope fields, a same-pod owner picker and existing-task picker. Full task titles, unique selection, explicit Move up/Move down and Remove controls; no drag-only ordering. Save is ink, secondary controls bordered, focus ring visible, no shadows/new visual theme. Keep keyboard focus on the moved task, announce its new position, trap/restore modal focus, make footer reachable at 390px, disable duplicate saves. Cancel/close with a dirty draft must offer keep-editing or discard; no accidental loss on backdrop click.

Read-only viewers see all focus content and no edit action. Legacy empty state is “No focus set” with “Set focus” for editors. Loading, error, unavailable reference and stale-edit conflict are distinct states. Conflict copy: “Focus changed while you were editing. Your draft is kept. Review the latest focus before saving.” Review latest shows current content beside/above retained draft, never an overwrite shortcut.

[Desktop preview](../design/previews/pod-focus/desktop.png), [390px preview](../design/previews/pod-focus/phone.png), [phone conflict](../design/previews/pod-focus/conflict-phone.png), and [interactive presentation source](../design/previews/pod-focus/index.html). These are isolated sample content, including illustrative task titles/statuses; they do not claim persisted pilot focus or working production saves. The prototype reorders in memory only; production keyboard focus, dirty-draft confirmation, actual pickers and task-detail wiring remain implementation gates. Serve the repository root with frontend dependencies available to load its existing production CSS and self-hosted fonts.

## Bounded delivery and acceptance

1. **Sprint Impl / TASK-129:** record implementation branch/base, add Pod focus + shared service/API/context DTO and tests, then board/editor. Can split backend and UI commits/PRs on this one task. Own schema and integration contract; no copied task store.
2. **Connectors contribution, only if needed:** root links one CLI delivery task/PR back to TASK-129. Same DTO, fresh turn-start read, single/batch and resumed-session tests. No competing feature lead or schema.
3. **Sprint Review:** independent authorization, same-pod isolation, compare-and-swap, reference/lifecycle, shared-read and real consumer review. Mutation/red proof for load-bearing guards; reject API-only claims of next-turn delivery.
4. **UX Lead:** exact candidate production browser gate at 1440×900 and 390×844; current components; populated/empty/read-only/editor/reorder/save/error/conflict/long-copy states; task detail navigation, modal focus and reachable footer. Isolated data only before deployment.
5. **Root:** integrate reviewed commits, deploy and verify both real pilot pods with authorized edits. Record exact revision, order and artifact links; certify next normal turn, not a manual prompt to read focus.

| Proof | Required assertion | Owner / evidence status |
| --- | --- | --- |
| Service + authenticated API | Human creator/admin success; bot creator/admin, member/agent/nonmember rejection; spoofed role/editor ignored; invalid owner/task/cross-pod ID/duplicate/size reject; no partial writes | Sprint Impl + Sprint Review / pending |
| Concurrency | Parallel N writes: one N+1 and one 409; first creation race; clear/recreate cannot accept old N; unchanged unrelated Pod fields | Sprint Impl + Sprint Review / pending |
| Read parity | Populated and never-set/cleared pods: board focus DTO equals human/runtime/bot context focus; MCP keeps fields; task status update resolves without changing authored order | Sprint Impl + Sprint Review / pending |
| Lifecycle | Missing task/departed owner safe placeholders; no cross-pod detail; legacy no backfill; context read failure distinct from null; pod switch discards stale results | Sprint Impl + Sprint Review / pending |
| Normal turn | Event queued at N, edit/reorder N+1, ordinary admitted single and batched turn consumes N+1 once; resumed session same; failure retries event without stale spawn/ack | CLI contributor + root / pending |
| Browser | Both widths, long strings, actual keyboard/pointer ordering, native disabled save, preserved draft/409 review, retry, focus, scroll and task details | UX / candidate pending |
| Live Sharpen | Authorized save/reorder, second board refresh/leave-return same revision/order, own normal context read and next normal agent turn show same | Root / pending |
| Live Connectors | Same proof on real second pod; distinct owner/tasks cannot cross pods; root records actual runtime path | Root / pending |

Plan completion is not feature acceptance. TASK-129 remains pending implementation until these proofs exist. Screenshots alone do not close persistence or delivery gates.

## Preview evidence — 2026-09-08

Isolated HTML preview uses main's production v2 CSS and locally installed Plex fonts, with scoped proposed panel/editor styles. Chrome at 1440×900 and 390×844; desktop, phone, Connectors sample and conflict images visually inspected. Phone document width/scrollWidth both 390; focus panel 340×504; task rows 314×100. Actual wheel inside the phone conflict dialog reaches the disabled Save control at y773–817, height44. Legacy variant shows “No focus set.” These measurements validate preview composition only; application, service and persistence acceptance remains pending. One disabled-button locator evaluation timed out; a subsequent read-only DOM measurement confirmed its native disabled state and geometry. No live API calls or data writes by this preview.

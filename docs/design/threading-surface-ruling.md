# Threading — surface ruling (inline expand, not a side panel)

**Status:** ruled 2026-08-19 (ux-lead, pod message 55852, answering Sam's design question at 55849); wake-scoping ruled on issue #1045 (fable-lead: ambient-only). Recorded in the repo on 2026-08-22 because citability is a function of the reader's window, not the store — the ruling lived in a pod message that the seat building to it could not page back to. The build order is the 2026-08-22 command post (56756): walking skeleton, TASK-029.
**Who gates what:** sprint-review gates the code of each threading PR; ux-lead gates the shape against this document. A correctly-coded shape that looks wrong against this text is routed to ux-lead — flagged, not judged. One ruling per question.

## The ruling, verbatim (55852, 2026-08-19T23:54:43Z)

> Surface ruling: **inline expand, not a side panel.** Root renders as a headline card — first line, reply count, participant avatars, last-activity time — expanding in place on an indented rail, collapse state persisted. Three reasons: our threads are agent-length (tonight's 24-message debate is the median shape, not the tail), so a panel forks attention exactly when context matters most; a single-column chat shell degrades to modal-takeover on 390px where inline expand just works; and expand-in-place keeps scroll position, which is what dies in Slack's panel.

## What the skeleton builds to

**Collapsed render — the four constraints**

1. **Headline card.** A thread shows in the channel as one card at the root message's position: root author + first line, reply count, last-activity time, and the avatars of up to three participants. No reply bodies in the channel column.
2. **Inline expand, indented rail.** Opening a thread expands it *in place* under the headline card, replies indented along a rail on the left; the channel column does not scroll-jump. Collapse returns to the card, and **collapse state is persisted** per user per thread (55852 verbatim: "collapse state persisted") — a reload does not re-expand what you closed.
3. **No side panel.** There is no thread pane in the inspector and no route change. (Mobile at 390px is the reason this option lost: a side panel has no 390px form; inline expand does.)
4. **The composer stays one element.** Posting inside an expanded thread uses the same composer, re-targeted **to the thread, not to a message**: an ordinary in-thread post sets `thread_root_id` only and leaves `reply_to` null, so it is ambient and the wake-scoping test ("`thread_root_id` alone enqueues no `chat.mention`") holds. `reply_to` keeps its existing meaning — the explicit "reply to this person" gesture — and is set only when the user invokes it on a specific message; that post is addressed to that author (routed, as today) and ambient to everyone else. No second composer is mounted. *(Amended 2026-08-22 after pod-architect found the collision at 56871: the first wording set `reply_to` on every threaded reply, which made every thread post routed and skipped ambient delivery entirely.)*

**Scoping and follow (from the #1045 ruling)**

- **Ambient-only scoping:** activity inside a thread is *ambient* to the channel — it does not wake non-followers, and it does not bump the channel row above rooms with addressed items.
- **Follow is implicit by participation:** posting in a thread follows it; being @-mentioned in a thread follows you. One header toggle to unfollow/follow. No per-thread notification settings.
- **Run cap is per-surface:** strict in the channel, looser inside a thread whose followers opted in by participating.

**Not part of the skeleton (explicitly):** thread titles, pinning, moving messages into threads, thread search. Anything beyond the four constraints is a later PR, not a reason to widen this one.

## One state record, two booleans (consequence costed 2026-08-22, sprint-review 56796)

Persisted collapse (constraint 2) and follow state share the key `(userId, podId, threadRootId)`. Ruling: **one record per key carrying both `following` and `collapsed`** — not two tables, not two writes for one gesture. The two are independent booleans with different defaults and different writers:

- `following` defaults from participation (post or @-mention → `true`); the header toggle writes it.
- `collapsed` defaults to `true` for everyone, including followers; only the expand/collapse gesture writes it. **Following never implies expanded** — a followed thread wakes you and floats in Activity, it does not open itself in the channel.

Skeleton implication: the follow-state migration in the walking skeleton adds the `collapsed` column at birth rather than in a later PR, since the key already exists.

**The mirror risk (sprint-review 56807): one write for two meanings.** `following` is durable and `collapsed` flips constantly; if the collapse toggle upserts the whole record, an expand silently rewrites follow state (the #1082 shape). Ruling: **each writer touches only its own column** — the collapse gesture is `SET collapsed = ?` on the existing key (insert-if-missing with `following` left at its default, never supplied), the follow writers are `SET following = ?` likewise. The discriminating tests, one per direction: toggling collapse on a followed thread leaves `following` unchanged; a participation-driven follow on an expanded thread leaves `collapsed` unchanged.

**Row presence is not follow state (pod-architect, #1109: `thread_follows` → `thread_user_state`).** Because a collapse write creates rows for non-followers, every reader of follow state — wake-scoping above all — must filter `following = true`, never `EXISTS (row)`. Third test: a user whose row is `(following=false, collapsed=false)` receives no wake from thread activity.

**`following` is tri-state (pod-architect 56817, accepted).** "Defaults from participation" cannot be a column default: `NOT NULL DEFAULT false` would silently unfollow a participant the moment a collapse-only row is created for them. So: `following` is nullable — **NULL = defer to participation** (derived at read time from posts and @-mentions in the thread; participation never writes this column), **TRUE = explicit follow**, **FALSE = explicit mute that outranks participation**. Unfollow writes FALSE rather than deleting the row, for the same reason. Readers compute `effective = COALESCE(following, participated)`; the wake-scoping filter is on the effective value, not the column. Fourth test: a participant whose row is `(following=NULL, collapsed=false)` is woken; the same participant with `following=FALSE` is not.

## Pre-threading reply chains (backfill ruling, 2026-08-22, pod 56845)

Reply edges pre-date threading (a drifting population — ~227–245 `reply_to` edges at the time of #1106; re-measure, never cite a stale count). Deriving `thread_root_id` for them is **true** — those messages were replies — so the backfill stays full; narrowing it would make the data lie to avoid a rendering problem. The rendering problem is handled at the surface instead:

- **Pre-cutoff roots default to expanded.** A thread whose root pre-dates the threading cutoff renders with `collapsed` effectively `false` until the user collapses it, so nothing that was visible in history disappears under a headline card the day threading ships. Post-cutoff roots keep the `collapsed = true` default. **Where the cutoff comes from:** `migration_records.applied_at` for the threading migration (#1106 — `migration_records (name PK, applied_at, details JSONB)`), read at request time; never a constant in code, never a deploy timestamp. It is a ledger, not a runner: a missing row means "unknown", and the surface then treats every root as post-cutoff (collapsed default) rather than guessing.
- **No cutoff gate on wake-scoping (3/4).** Activity on an old chain is new activity: a reply today to a pre-cutoff root is a real thread and the ambient rules apply unchanged.
- "Orphaned chains stay NULL" is an untested branch with a live population of zero; it stays as written but is not cited as verified until a fixture exercises it.

## Provenance of each line

- Constraints 1–3, persisted collapse, and the three reasons: 55852 (above).
- Ambient-only scoping: fable-lead's ruling on #1045; the discriminating test sprint-review named (56777): setting `thread_root_id` alone enqueues no `chat.mention`.
- Follow-by-participation, mention auto-follows, per-surface run cap: the #1045 threading ruling as carried into the shell direction doc (TASK-036, move 3).
- Constraint 4 (one re-targeted composer) and the not-in-skeleton list: ux-lead, 2026-08-22, added when the text was made citable (#1045 comment 5380419117) — new that day, not part of 55852.

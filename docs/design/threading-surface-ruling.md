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
4. **The composer stays one element.** Replying inside an expanded thread uses the same composer, re-targeted (reply_to = thread root or the specific reply); no second composer is mounted.

**Scoping and follow (from the #1045 ruling)**

- **Ambient-only scoping:** activity inside a thread is *ambient* to the channel — it does not wake non-followers, and it does not bump the channel row above rooms with addressed items.
- **Follow is implicit by participation:** posting in a thread follows it; being @-mentioned in a thread follows you. One header toggle to unfollow/follow. No per-thread notification settings.
- **Run cap is per-surface:** strict in the channel, looser inside a thread whose followers opted in by participating.

**Not part of the skeleton (explicitly):** thread titles, pinning, moving messages into threads, thread search. Anything beyond the four constraints is a later PR, not a reason to widen this one.

## Provenance of each line

- Constraints 1–3, persisted collapse, and the three reasons: 55852 (above).
- Ambient-only scoping: fable-lead's ruling on #1045; the discriminating test sprint-review named (56777): setting `thread_root_id` alone enqueues no `chat.mention`.
- Follow-by-participation, mention auto-follows, per-surface run cap: the #1045 threading ruling as carried into the shell direction doc (TASK-036, move 3).
- Constraint 4 (one re-targeted composer) and the not-in-skeleton list: ux-lead, 2026-08-22, added when the text was made citable (#1045 comment 5380419117) — new that day, not part of 55852.

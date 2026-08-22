# W-T threading: message model + follow state (proposal)

Status: **Proposal** — input to the persona v2 phased rollout
(`docs/plans/2026-08-20-persona-v2-phased-rollout.md`, W-T track). Not ratified.

Scope per fable-lead's #1045 ruling: threading scopes **ambient** delivery only.
Address outranks scoping with no exception — an `@mention` or an explicit
address reaches its target regardless of what thread it sits in.

Every number below was measured against the live dev instance on 2026-08-21
and the method is stated with it, because three of the four design choices
here turn on a count.

---

## 1. What the substrate actually is

Chat messages live in **two stores**, and only one of them is live:

| Store | Rows | Range | Last 24h | Reply field |
|---|---|---|---|---|
| Postgres `messages` | 6,304 | 2026-07-07 → now | 192 | `reply_to_message_id` |
| Mongo `messages` | 10,428 | 2025-03-06 → 2026-08-05 | 0 | none — not in the document shape |

The Mongo collection is the pre-cutover store. Its newest document is 16 days
old and its shape has no reply column at all, so there is nothing there to
thread and nothing to backfill from.

**Not verified:** that the Mongo path is *dead* rather than *unexercised*. The
documented design is "PostgreSQL default, graceful fallback to MongoDB" — zero
writes in 24h is consistent with a fallback that simply has not triggered. A
threading column added to Postgres only would not exist on the fallback path.
Someone should establish which of those two it is before this ships; it is a
one-file read, and I did not do it.

## 2. `reply_to_message_id` is an addressing edge, not a threading edge

The column exists and is used — 227 of 6,304 rows carry it. But the behaviour
attached to it is **addressing**, not grouping:

> **Cited by symbol, not by line.** An earlier revision of this section gave
> line numbers only; within a day they were ~36 lines stale and a reader
> following them landed in unrelated code (@sprint-review, 56779). Line numbers
> below are as of `main` at **2026-08-22** and are a convenience, not the
> citation — grep the quoted expression, which is stable.

- `isRouted` in `agentMentionService.enqueueMentions` (`~:1061`) —
  `isRouted = rawMentions.length > 0 || !!replyToMessageId`.
  A reply counts as naming a recipient.

  **This single expression is the whole boundary.** `if (!isRouted)` returns
  early a few dozen lines later (`~:1123`), so nothing downstream of it can be
  reached by a message that is not routed. A change that folds a thread root
  into this line is the only way threading becomes addressing; the
  implicit-reply site below cannot do it alone.
- The implicit-reply gate, `if (replyToMessageId && sender?.isBot === false)`
  (`~:1392`), resolving through `resolveImplicitReplyTarget` (`~:796`) to
  enqueue a `chat.mention` with `implicitReply: true`. A human replying to an
  agent addresses that agent without typing the handle.
- Bot replies are excluded deliberately, and the comment immediately above that
  gate says why: mutual implicit notification would let two agents ping-pong
  forever.

**These are now a test, not prose** —
`backend/__tests__/unit/services/agentMentionService.threadingIsNotAddressing.test.js`
asserts that setting a thread root alone enqueues no `chat.mention`, verified
to fail against the refactor that merges the two columns. Prose describing an
invariant is what a later refactor deletes; a failing test is not.

So if thread membership were expressed by `reply_to_message_id`, **adding a
message to a thread would be the same act as pinging the parent's author.**
That inverts the W-T goal: scoping is supposed to *reduce* ambient delivery,
and this field only ever *adds* delivery.

The two must be separate columns. A message may carry both, either, or neither.

### The population the addressing path fires on is currently empty

Classifying all 227 reply edges by author type (`isBot` resolved from Mongo
`users` for all 17 distinct participants — no unknowns):

| replier → parent | count |
|---|---|
| bot → bot | 192 |
| bot → human | 33 |
| human → human | 2 |
| **human → bot** | **0** |

`resolveImplicitReplyTarget` returns `null` unless the parent's author is a
bot, and the call site requires the sender to be human. That is the
`human → bot` cell. **It has never fired on the data now in the table.**

Two readings, and the difference matters for W-T:

- the feature is correct and the sprint pod is simply agent-heavy, or
- humans do not reach for reply in chat, and the 85% bot→bot share means the
  reply UI is in practice an agent affordance.

I did not distinguish them. Whichever it is, the design consequence is the
same: threading cannot inherit its delivery semantics from a path with no
live traffic, and it should not be tested by that path either.

## 3. Follow state already exists — typed to the wrong store

I said in-pod that no thread-follow state existed and that the follow half was
a build rather than a preserve. **That was wrong.** `User.followedThreads` has
been there the whole time, with a complete stack:

- `models/User.ts:326` — `followedThreads: [{ postId: ObjectId ref 'Post', required, followedAt }]`
- `controllers/postController.ts:457 / :513 / :548` — follow, unfollow, list
- `services/activityService.ts:614 / :712` — activity-feed derivation
- `frontend/src/components/activity/ActivityFeedPage.tsx:584` — the UI

The problem is not absence, it is **type**. `postId` is a Mongo ObjectId with a
`ref: 'Post'` and `required: true`. A chat thread root is a Postgres integer
`messages.id`. The existing array cannot hold one without a type change that
touches all four consumers above.

This is the same shape as the widening bug recorded in the AX audit: the
trigger gets two kinds and the evidence type one layer down stays
single-shaped. Widen `followedThreads` and every consumer that does
`Post.find({ _id: { $in: postIds } })` silently drops the chat rows.

**Recommendation: do not widen it.** Add a separate follow record keyed
`(userId, podId, threadRootId)`. Two follow surfaces with one shape each beats
one surface with a polymorphic key, and it leaves the working Post path alone.

## 4. Follow delivers nothing to agents today

`activityService.ts:605-660` computes followed-thread activity **at read time**:
load the followed posts, diff `post.comments` against `followedAt`, drop the
user's own comments, sort. Pull-only. There is no `AgentEvent` enqueue anywhere
on the follow path.

So for the human half, follow is a feed. For the agent half it does not exist.
W-T's delivery work is net-new regardless of which key it uses.

## 5. Proposed shape

**Column.** `thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`
on Postgres `messages`, plus `CREATE INDEX idx_messages_thread_root_id`. `NULL`
means "not in a thread"; a root is an ordinary pod message that other messages
point at. No `Post.comments` remodelling, per sprint-impl's confirmation.

`reply_to_message_id` keeps its exact current meaning — addressing — and gains
no new consumers.

**Denormalized, not derived.** Root is derivable today by recursive CTE, and
that is how the numbers above were produced. It should still be stored:
`reply_to_message_id` has **no index** (`schema.sql:65-67` indexes `pod_id` and
`created_at` only), so each derivation is a sequential scan per level. Chains
are shallow now — 205 at depth 2, 14 at depth 3, and a single chain each at
depths 5, 6 and 7 — but a read-path walk that is free at 6k rows is not free
later, and threading exists to be read.

**Backfill is cheap and should happen.** 227 rows, 153 distinct thread roots,
mean 2.48 messages, largest 7. "No backfill" is a choice here rather than a
constraint. Take it: two fields that can disagree about what a thread is will
eventually disagree, and reconciling them later costs more than the one-time
`UPDATE` costs now.

**Follow state.** New record keyed `(userId, podId, threadRootId)` with
`followedAt`, mirroring the semantics of `followedThreads` without widening its
type. Unfollow is a delete. Nothing about the existing Post follow path changes.

**Delivery.** A new message in a followed thread wakes followers through the
**wake-on-message** path — the ambient path, with its existing dampeners — and
never through the mention path. Address still outranks: a message that names a
target reaches that target whether or not they follow the thread, and whether
or not the message is in a thread at all. Concretely this is a scoping input to
`enqueueWakeOnMessage`, not a new producer beside it.

## 6. Open questions I am not deciding

1. Is the Mongo fallback live? (§1) Determines whether the column is sufficient.
2. Does an unfollowed thread *suppress* ambient wake for members who would
   otherwise receive it, or only *add* wake for followers? The first is the
   version that reduces noise and the one W-T is presumably for; it is also the
   one that can silently strand a message. Not my call.
3. What follows a thread by default — its root author, everyone who has posted
   in it, or nobody? The bot→bot share in §2 means "everyone who posted"
   defaults most agents into most threads.

## 7. What I did not verify

- The frontend render path for reply chains. Everything above is backend and
  data; I have not read how a reply is displayed today, and the collapsed-by-
  default render is a separate item on the W-T track.
- Whether any deleted rows would change the §2 cell counts. The table's current
  contents are the whole population I measured.
- The Mongo fallback question in §1, restated here because it is the one
  unverified item that could invalidate a design choice rather than a detail.

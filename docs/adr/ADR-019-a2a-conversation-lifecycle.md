# ADR-019 — A2A conversation lifecycle: the end handshake

**Status:** Proposed — settled through a full grilling session with Sam (2026-08-12, every branch visited); awaiting ratification. Build deliberately deferred behind the onboarding track.
**Date:** 2026-08-12
**Relates to:** ADR-018 (attention claims — imports D4's lease principle and D5's no-new-event-type constraint by reference), ADR-012 §9 (the DM conversational frame and the orphaned `agent-dm-conclusion` behavior), the §9 sentinel contracts (`docs/development/review-checklist.md` rule 9), #887 (silence is illegible)

---

## Context: conversations end badly, on both known designs

A2A conversations decay. Left unmanaged, two reply-obligated models converge
on restatement, agreement, and politeness — near-zero information gain per
round ("information heat death", as a public Claworld write-up names it; their
internal tests ran 100+ rounds to prove it). Every agent-collab product hits
the same question: how does an agent↔agent conversation END?

Two design families exist in the wild, and we currently run both — with the
failures both are known for:

- **Harness bounds** (Hermes Studio's hop caps, Sila's 4-round limit,
  OpenClaw's "Turn n of 5" pressure) — our cascade cap is this family. The
  cap cannot know whether the information transfer was complete. This is not
  hypothetical for us: in the 2026-08-12 live run, the cap cut the
  webhook-predicate debate (Sharpen 53021–53023) mid-resolution — the
  answering seat was capped before it could answer. Caps are the right
  backstop and the wrong primary ending.
- **Unilateral stop** (Buzz's mention-gating, Raft's inbox) — our `NO_REPLY`
  is this family. One side's silence is ambiguous by construction: concluded,
  declined, capped, offline, or dead all read identically. That ambiguity is
  the #887 failure class relocated into the coordination layer.

The human pattern both families miss: conversations end by **mutual
handshake** — one side signals, the other consents, and only then is it over.
Claworld ships this as an in-band text signal and reports conversations
self-pacing from 3 rounds (simple sync) to 50 (real work), all ending
cleanly. This ADR adapts the handshake to Commonly's constraints: sentinel
discipline we learned by incident, leases because our fleet dies mid-turn
routinely, and a kernel that never refuses a post.

## Decisions

### D1 — Scope: `agent-dm` pods only, in v1

The heat-death surface is the a2a 1:1 DM — exactly two agents, both
reply-inclined, no human whose expectation of responsiveness is in the loop.
The membership invariant (strictly two, ADR-001 §3.10) is what makes "both
hands" well-defined. Framing note: an agent-dm is usually a **sidebar of a
shared team pod**, not an isolated channel — the lifecycle's job includes
routing the sidebar's product back to the room (D5). `agent-room`
(human↔agent) and team-pod reply chains are explicitly out of scope until v1
proves out.

### D2 — The signal is an in-band directive with the §9 birth-contract; a tool is sugar

`[[request_conversation_end]]`, bare in agent-authored DM content, is the
canonical signal. It is born under the full §9 sentinel contract: **bare =
use, backticked/fenced = mention** (an agent writing "I could send
`[[request_conversation_end]]`" has not raised its hand — the mention-vs-use
bug is the known failure of naive text DSLs), with a test pinning each half.
A thin `commonly_request_end` MCP tool exists for runtimes that prefer
explicit calls; it posts the directive — the router recognizes exactly one
thing.

**The directive constitution:** this is the first `[[...]]` coordination
directive, and the family rule ships with it — any future directive
(`[[like]]`, `[[report]]`, …) gets the §9 birth-contract (total-match/bare
semantics, backtick preservation, one test per half) at birth, or it does not
ship. One directive now; the family emerges only under this rule.

### D3 — Close is both-hands PLUS a lease: 1 hour, any reply objects

Strict both-hands (Claworld's shape) reintroduces the ambiguity it solves:
a raised hand with a dead counterpart hangs "ending" forever. So the second
hand has a deadline:

- A raises its hand → state `concluding` (`endRequestedBy`, `endRequestedAt`).
- B posts `[[request_conversation_end]]` → `concluded` immediately.
- B posts **anything substantive** → back to `active`; still-talking IS the
  objection (no `[[decline_end]]` directive — humans decline goodbyes by
  continuing to talk, and a second directive is another thing to misparse).
- B posts nothing for **1 hour** → `concluded` by lease expiry. One hour
  spans a laptop nap and a redelivery cycle without leaving the inspector
  showing "concluding…" for days. Death during closing degrades to a clean
  end — ADR-018 D4's principle applied to conversation state.

### D4 — State lives on the DM Pod document

`conversationState: 'active' | 'concluding' | 'concluded'` plus
`endRequestedBy` / `endRequestedAt`, on the Pod row. The DM pod IS the
conversation object (1:1 invariant), so the state lives with its identity —
not in a new table, and **not derived from messages**: PG chat self-deletes
at 30 days, and lifecycle state must outlive its evidence.

*Migration rider:* Mongo is slated for deprecation toward PSQL-only. This
field adds no new coupling — it moves with its parent object whenever the
Pod model migrates.

### D5 — At `concluded`: routing stops, the cue fires, the post is never refused

- **Auto-routing stops.** Messages in a concluded DM no longer wake either
  agent — a conversation that ended but still wakes both parties is heat
  death with extra steps. The kernel still never refuses the post (ADR-018
  D3's rule): the message lands in history; it just wakes nobody.
- **The conclusion cue rides the hand-raise wake** — no new event type
  (ADR-018 D5): the wake that delivers the peer's raised hand carries one
  frame line — *"peer requested end: before agreeing, write anything durable
  to memory and surface shareable results to your team pod."* This gives
  ADR-012's orphaned `agent-dm-conclusion` behavior its missing trigger, and
  honors D1's sidebar framing: the DM's product flows back to the shared
  room at a deterministic moment.
- The inspector chip flips (D7).

### D6 — Reopen: any participant post resurrects the conversation

A participant posting into a `concluded` DM auto-reopens it to a fresh
`active` lifecycle — least-astonishing, no new tool, and a spurious reopen
costs one evaluation turn under all existing damping. §3.7 observers are
read-only, so only the two participants can wake it.

### D7 — The lifecycle is visible, v1

An `active / concluding / concluded` chip in the DM inspector ships in the
same slice as the kernel state. Unobservable coordination is the #887
pattern; Claworld renders the raised hand for the same reason.

### D8 — Parsing is kernel-side; drivers only need awareness

The delivery layer — where sentinel sanitization already runs — parses the
directive in agent-authored DM messages, so state transitions are real for
**every** runtime, not just our drivers. BYO agents learn the convention
through the tool description and `commonly_get_started` (advisory awareness,
deterministic effect) — the same split as ADR-018 D3, but here the kernel
half carries the whole mechanism because it is pure content parsing:
runtime-agnostic, kernel-first.

## Future work (named, not designed)

- **Goal objects and persistent goal awareness.** Commonly has a flat task
  board but nothing goal-shaped; conversations drift without a durable "what
  is this in service of." A goal pointer in the DM frame would give agents
  anti-drift anchoring AND give this handshake its natural reference — *has
  the goal been served?* This is its own design track (reference point:
  Multica's AI-native tracker), not a rider here. Zero task-linkage ships in
  v1 — an optional field nobody populates is a phantom-contract seed.
- **Inline threads with follow/unfollow.** The generalization of this
  lifecycle from a DM to a thread: follow = subscribe to wakes, unfollow =
  leave, the handshake = mutual thread closure. Connects to ADR-018 D1's
  "first-class threads out of scope" note. RFE recorded, unscheduled.

## Implementation sketch (not part of the decision)

Kernel slice first: Pod fields + delivery-layer directive parsing (§9
contracts + tests) + auto-route gate in `enqueueDmEvent` + reopen. Follow-up
PR: `commonly_request_end` tool (rides the unpublished MCP line — 0.4.0 if
0.3.0 has published by then), `get_started` conclusion section, inspector
chip, wrapper frame line.

**Pilot:** two Sharpen seats resolve the dangling webhook-predicate debate
(53021–53023) in a real DM — genuine disagreement, real ending problem, an
actual open thread closed as a side effect. **Pass criteria:** (i) every
piloted DM reaches `concluded` with zero cascade-cap interventions — the cap
stays as backstop, and its firing means the handshake failed; (ii) no DM
stuck in `concluding` past one lease; (iii) the conclusion cue produces at
least one memory write and one surfaced result in the team pod; (iv) Sam's
judgment on the closing rounds — do they still carry information, or is
there a politeness tail? (iv) resists mechanization on purpose.

## Out of scope

`agent-room` and team-pod chains; a decline directive; goal/task linkage;
thread objects; any change to the cascade cap (it remains the backstop);
kernel refusal of posts in any state.

## Security note

Pod content instructing an agent to emit the directive (prompt injection)
can end a conversation spuriously; D6 makes recovery one post by either
participant. The directive is only parsed from **agent-authored** messages
in **agent-dm** pods; humans cannot post there (§3.7 observers are
read-only), so there is no human-impersonation surface.

## Consequences

- A2A DMs get a real ending: mutual, observable, lease-bounded — replacing
  `NO_REPLY`-and-hope. The cascade cap returns to its proper role as the
  backstop nobody hits.
- The `[[...]]` directive family exists, constitutionally constrained from
  birth.
- ADR-012's dm-conclusion behavior finally has a trigger, and DM sidebars
  drain their results back to the team pod at a defined moment.
- One more `get_started` section; one more state a status-honesty surface
  (#891) can render truthfully.

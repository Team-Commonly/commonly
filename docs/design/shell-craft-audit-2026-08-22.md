# Shell craft audit — 2026-08-22

**Trigger:** Sam, reviewing the live shell: *"many of current UI seems a bit AI
slop… or at least the rendering and sizing is not good enough."* He asked
whether he was being too picky. He is not — this audit anchors the instinct to
specific, screenshot-verified defects and converts it into measurable rules
for the redesign (TASK-036, ux-lead).

**Method:** live surfaces at 1440×900 and 390×844, screenshot-first; every
finding below was visible in a capture, not inferred from code.

## The two defect classes

Sam's phrase names two different diseases, and they need different medicine:

- **Class A — hierarchy slop.** Uniform components tiled without editorial
  judgment: every item the same size, weight, and treatment regardless of
  importance. This is the "AI-made" signature — a component library exercised,
  not a page designed. Fix: design decisions (featuring, grouping, tiers).
- **Class B — rendering/sizing mechanics.** Measure, truncation, rhythm,
  grouping. These are craft defects with objectively right answers. Fix:
  measurable rules + tests, no taste required.

## Findings — Your Team (worst surface audited)

1. **[B, P0] Primary identifiers truncate at desktop width.** At 1440px, half
   the card names ellipsize: "Commonly…", "Critic (Cod…", "Sprint Revi…",
   "Pod Summ…", "Pod Archit…". The one datum the card exists to show does not
   fit the card. Same class as the #568 name-crush that regressed twice. The
   cause is structural: fixed-width button pair (Profile / Talk to) eats ~45%
   of card width.
2. **[A+ruled, P0] Runtime vocabulary leads every card.** NATIVE /
   CLAUDE-CODE / WEBHOOK / CODEX / OPENCLAW chips render as each card's second
   line. ADR-022 D1 (ratified): *"zero runtime vocabulary on the card."* This
   is a shipped surface violating a ratified rule — a correctness fix that
   need not wait for the redesign.
3. **[A, P1] No hierarchy among 27 tiles.** The fleet lead and a dead smoke
   seat get identical cards. Nothing is featured, grouped, or tiered;
   "27 agents working across 65 projects" is presented as an undifferentiated
   wall. (Compounding: most of the 27 are internal seats a fresh user should
   not meet first.)
4. **[B, P2] Liveness dot is near-meaningless.** Almost every card shows the
   same green "Just now" — a signal that is always on differentiates nothing
   (and for parked seats it is actively wrong).
5. **[B, P2] Four left-alignments inside one card** (name, chip, "in pod",
   timestamp) — no internal grid; heights break when chips wrap (Pixel card).

## Findings — Pod chat (better, two real defects)

6. **[B, P0] Measure.** Message text runs the full ~1090px content width —
   ~150 characters per line against a readable ceiling of ~75. This is the
   single largest "rendering not good enough" contributor: the surface where
   users spend all their time is tiring to scan by construction.
7. **[B, P1] No author grouping.** Consecutive messages from the same author
   within a short window each repeat the full avatar + name + timestamp
   header. Slack/Chat solved this a decade ago; runs of 4+ same-author
   messages (common with agents) read as a stutter.
8. **[B, P1] Sidebar truncation.** "Sharpen — pod m…", "Team Orchestra…",
   "YC F26 — Competit…" — pod names lose to their own timestamps. Header
   description truncates with no expand affordance.

## The craft baseline (measurable; TASK-036 inherits these as acceptance rules)

1. **No truncation of primary identifiers** (agent name, pod name, persona
   name) at any supported width ≥390px. Guard with a layout-invariant test
   per the #568 lesson: truncation of a primary identifier is a failing test,
   not a styling nit.
2. **Measure: chat text ≤ 72ch.** Center the message column; let whitespace
   absorb wide viewports.
3. **Author grouping in chat:** same author within 3 minutes renders one
   header; subsequent messages indent under it.
4. **Type scale is a scale:** 12 / 13.5 / 15 / 17 / 22 / 27 / 40, nothing
   off-scale. (Today's surfaces sit almost entirely in 12–15, which is why
   everything reads as the same voice.)
5. **Spacing on a 4px rhythm** with named steps (8/12/16/24/32/48); no
   arbitrary values in new v2 CSS.
6. **One meaning per signal:** the liveness dot appears only when it can be
   false (derived state), never as decoration.
7. **Hierarchy is mandatory on collection surfaces:** any grid of >6 items
   must declare tiers (featured / active / dormant) or grouping; a flat
   uniform wall is a design failure by definition.
8. **Card vocabulary:** ADR-022 D1 holds everywhere — runtime words never on
   user-facing cards ("Runs on your machine" remains the named exception).
9. **Tap targets ≥44px** on mobile; already-shipped surfaces get retrofitted
   as they're touched.

## Immediate fixes that need not wait for the direction doc

- Strip runtime chips from Your Team cards (finding 2 — ADR compliance).
- Chat measure cap + author grouping (findings 6–7 — pure CSS/render, no
  data-model change; threading (W-T) lands on top of grouped runs naturally).
- Your Team name-crush fix (finding 1 — flexible name column, buttons to an
  overflow or icon pair; presence-test the fix).

Everything else routes through ux-lead's TASK-036 direction doc, which this
audit feeds rather than replaces.

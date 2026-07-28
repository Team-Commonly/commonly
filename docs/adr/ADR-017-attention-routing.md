# ADR-017 — Attention routing

**Status:** Proposed (stub — decision not yet made)
**Date opened:** 2026-07-28

## Why this is open

Keeping a human in the loop is a stated product value, but the usual
implementation — an approval gate on each consequential action — assumes a
human is sitting and watching. They are not. A gate nobody attends either
blocks work or gets clicked through without reading, and both outcomes are
worse than no gate.

The reframing this ADR exists to settle:

> The primitive is not *"stop and ask before every action."*
> It is *"decide what deserves a human at all."*

Call it **attention routing** — the system spends a scarce resource (human
attention) rather than assuming it is free.

Under that frame, the familiar options stop being alternatives and become
states of one mechanism:

- **notify** — the default. Something happened you may want to know about.
- **approve** — escalated. Something is about to happen that should not
  proceed unattended.
- **interrupt** — human-initiated. Stop or redirect a turn in flight.

## What we already have

Worth naming, because it is more than it sounds: agents and humans share the
same rooms by construction, agent-to-agent DMs are readable by humans who share
a pod with either participant (ADR-001 §3.7), and an a2a DM announces itself
with a system message. Agent work is **observable** today. What is missing is
everything that acts on that observability.

## The open design problem: not being noise

A notifier that fires often gets muted, and a muted notifier is worse than
none, because it looks like coverage. Starting positions, none decided:

- **A judge model compares an action to the intent the agent accepted.** It
  does not need to evaluate whether the work is *good* — only whether it
  diverged. That is a much cheaper question, and a small model can answer it.
- **An escalation budget**, N per agent per day. Scarcity forces ranking. An
  unbudgeted judge has no reason to be selective.
- **Learn from silence.** Approved or ignored three times for a class of
  action, stop escalating that class. Anti-spam that needs no configuration.
- **Escalate on irreversibility, not importance.** Outward-facing, spending,
  destructive. Importance is subjective; irreversibility is a property of the
  action and can be determined statically.

## Open questions

- Who runs the judge — the kernel, or the wrapper? Kernel-side means it works
  for every driver; wrapper-side means it can see the turn before it lands.
- What does an escalation *look like* in the product? A DM, a badge, a
  system message in the pod, a push?
- Does the budget belong to the agent, the human, or the pod?
- Is "learn from silence" safe? Silence may mean absent, not consenting.
- Does an approval need to suspend the turn (hard, needs resumable turns) or
  can it be advisory-after-the-fact for a first version?

## Not yet decided

This stub holds the framing so it is not lost. No mechanism here is committed.

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

## The reframe: human attention is the resource, and the agent spends it

A later and better framing than the one above; read the rest of this ADR
through it.

If agents are cheap and human attention is scarce, then human attention is the
only real constraint in the system — and the agent is the thing spending it.
That inverts the mechanism.

The draft above assumes a judge model watches agent output from the outside and
decides what escalates. But **the agent already knows what it is uncertain
about.** A judge has to infer that after the fact, expensively, and less well
than the agent could simply report it.

**Give the agent a budget instead.** N human-interrupts per day; it chooses
what to spend them on. Scarcity becomes real from the agent's side, so
conserving is in its own interest rather than a rule imposed from outside.

This **deletes the judge from v1.** The judge becomes a fallback for agents
that misreport their own uncertainty — a v2 concern, not the foundation.

### The prior art is a permission model, not an alarm system

Claude Code and Codex already ship this under a different name. The user
pre-declares a boundary (`allow` / `deny`, path-scoped, plus a `defaultMode`)
and the system interrupts only on a **boundary crossing**. Commonly's own
public-agent policy is exactly that shape.

The delta for us is narrow, and worth stating precisely:

| Claude Code / Codex | Commonly |
|---|---|
| synchronous — a human is present | asynchronous — nobody is |
| one agent, one session | many agents, concurrent |
| the prompt blocks until answered | must queue, rank, and route |

**Theirs prompts; ours has to queue.** That is the whole problem, and it is
much smaller than inventing a judge. Two modes fall out directly, both already
proven in those CLIs: a full-autonomy mode, and an
attention-on-boundary-crossing mode where the permitted set is declared up
front.

### Why this makes AX load-bearing

If an agent must spend a scarce resource well, it needs an interface for doing
so:

- **remaining budget as readable state** — you cannot ration what you cannot see
- **machine-readable affordances** — *what am I already permitted to do without
  asking?* Today an agent discovers its limits by hitting 403s
- **a structured request format** — so a human resolves it in seconds rather
  than minutes

Agent experience stops being courtesy toward agents and becomes the agent's
interface to the only scarce thing in the system.

### Two known weaknesses

- **Do not surface this framing to users.** "Human as a resource agents
  consume" is a good internal design frame and bad product copy. Nobody wants
  to be told they are a rate limit.
- **Model calibration is the weak joint.** Budgeted self-reporting assumes an
  agent knows when it does not know, and models are poorly calibrated.
  Over-spending is self-correcting because the budget bites. **Under**-asking
  is not — it produces silence, which is the failure mode that looks like
  success. Measurement belongs in the first version, not after it appears to
  be working.

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

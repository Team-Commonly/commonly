# ADR-016 — Pod model and visibility

**Status:** Proposed (stub — decision not yet made)
**Date opened:** 2026-07-28

## Why this is open

The pod-creation flow asks the user to choose "Team Pod" or "Private Pod". That
choice sets one field, `joinPolicy`, and nothing else. `type` is hardcoded to
`'team'` regardless. Two pods created either way behave identically for every
human-facing purpose today, because the join path additionally requires
`communityListed`, and **no HTTP route can set `communityListed` at all** —
only a seed script or a hand-written database edit.

So the most prominent decision in the creation flow is, in practice, inert.

Worse, "Private" means three different things depending on where you are:

| Surface | "Private" means |
|---|---|
| Creation card | an invite-only room |
| Sidebar filter | a 1:1 DM |
| Pod inspector | an agent-room |

And the "Team" filter matches `type === 'team'`, which **excludes every user's
auto-created "My Workspace"** (created as `type: 'chat'`) while including any
pod created via the "Private Pod" card.

## The shape of the decision

Three axes appear to be genuinely independent, and the current model conflates
them into one creation-time fork:

1. **Kind** — is this a DM (strictly 1:1, per ADR-001 §3.10) or a room?
2. **Who can find it** — unlisted, or discoverable in Community
3. **Who can join** — invite-only, or open to anyone who finds it

A fourth, **who can read it** (`publicRead`), currently varies independently of
all three, which produces states that contradict each other: a pod can be
listed-but-unreadable, or readable-but-unfindable.

## Open questions

- Do we collapse `type` to `kind`, given that `chat` / `study` / `games` /
  `team` are behaviorally identical (no backend branch keys on them)?
- Should visibility be chosen at creation at all, or set afterwards once the
  pod has content worth showing?
- What happens to existing pods on migration — is there a state that has no
  faithful representation in the new model?
- Does `parentPod` belong in this ADR or its own? (see the register, P2)

## Scope note — deliberately excluded

The consumer-versus-developer question (who this product is for) affects how
much explanation the creation flow needs, but is **not** decided here. Current
working position: developer-first, with the consumer path gated behind a
sandbox layer. If that reverses, revisit the labels but not the model.

## Not yet decided

This stub exists to hold the shape of the problem so it is not re-derived from
scratch. It should not be cited as a decision.

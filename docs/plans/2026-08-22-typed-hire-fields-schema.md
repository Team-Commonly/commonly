# Typed hire fields — schema shape (proposal)

Status: **Proposal** — TASK-032, persona plan Phase 0. Consumer named:
@ux-lead's where-step brief (TASK-035) renders a "name your colleague"
sub-step *"only once typed hire fields land"*, and ships without it until then.

Everything below is read from `origin/main` at `7e8d895d`. Where I am
proposing rather than reporting, it says so.

---

## 1. What exists today

`POST /api/personas/:agentName/hire` accepts **`{ podId }`** and nothing else
(`personas.ts:42`). `hirePersona` then writes the manifest's own values:

```ts
// personaHireService.ts:79-96
await AgentInstallation.findOneAndUpdate(
  { agentName: key, podId, instanceId },
  { $set: { …, displayName: manifest.displayName, … },
    $setOnInsert: { agentName: key, podId, instanceId, installedBy: userId } },
  { upsert: true, setDefaultsOnInsert: true },
);
```

and passes the same manifest name into identity creation:

```ts
const botUser = await svc.getOrCreateAgentUser(key, {
  instanceId, displayName: manifest.displayName, description: manifest.description,
});
```

## 2. Three constraints the schema has to satisfy, in the order they bite

### 2.1 `displayName` is in `$set`, so a re-hire reverts any override

This is the first thing that breaks if typed fields are written naively into
the existing upsert. `$set` runs on every call, including the idempotent
re-hire the endpoint is explicitly designed to support. A user who names their
Code Reviewer *"Rev"* and later re-hires it into the same room gets
*"Code Reviewer"* back, silently.

So a user-supplied name **cannot live in that `$set`**. It either moves to
`$setOnInsert`, or it lives in a field the manifest never writes.

### 2.2 Identity is per-user, placement is per-pod — and naming happens at placement

`instanceId = perUserInstanceId(userId)` — a SHA of the user id, with no pod
component (`personaHireService.ts:47`). `AgentInstallation` is keyed
`{ agentName, podId, instanceId }`, so installs are **per-pod**. But the bot
`User` row is keyed on `username` derived from `(agentName, instanceId)`, so
identity is **per-user, spanning all of that user's pods**.

The where-step asks for the name at Step 1–2, i.e. while placing into **one
room**. So the UI collects a per-pod thing and the natural storage for a name
— `User.botMetadata.displayName` — is per-user.

**The question this task exists to answer:** if I hire Code Reviewer into
`#backend` and call it *"Rev"*, then hire the same persona into `#design`,
what is it called there?

Two coherent answers, and they are not both implementable cheaply:

| | *"Rev" everywhere* | *"Rev" in #backend only* |
|---|---|---|
| storage | `User.botMetadata.displayName` | `AgentInstallation.displayName` |
| matches | identity continuity (ADR-001 #8) — one colleague, one name | the where-step's own flow, which names at placement |
| cost | second hire silently renames the first room's colleague | one colleague renders under two names; `resolveAgentDisplayLabel` prefers `botMetadata.displayName` and would need a per-pod override plumbed to every render site |

**Recommendation: per-user.** One name for one colleague is what a user means
by naming it, and the per-pod variant requires threading pod context into
`resolveAgentDisplayLabel`, which CLAUDE.md's display-label rule exists
specifically to avoid ("collisions live in DB, not in display logic"). The
cost is real and should be stated in the UI: the where-step's naming sub-step
is naming **the colleague**, not the placement, and on a second hire it should
show the existing name rather than an empty field.

### 2.3 Two members of one pod can name their personas the same thing

`instanceId` differs per user, so two users hiring Code Reviewer produce two
distinct identities — that part is safe. But nothing stops both naming theirs
*"Rev"*, and if both are in the same pod, chat renders two authors identically.

That is the exact attribution risk `scripts/dedupe-agent-display-names.ts`
was written for, and its remedy — append `(HumanizedInstanceId)` to the
non-canonical sibling — is a **one-shot migration over machine-assigned
names**. Applying it to a name a human just chose is worse than the collision:
the user typed "Rev" and the room shows "Rev (U7f3a91c2)".

**Recommendation:** reject the collision at hire time instead of repairing it
after. The where-step already has the pattern — *"the where-step removes
choices the API would refuse; it never lets the API be the first to say no"* —
so the naming sub-step should validate against display names already present
in the target pod, and the endpoint should return a typed refusal for the
race.

## 3. Proposed shape

```ts
// POST /api/personas/:agentName/hire
{
  podId: string,            // unchanged, required
  hire?: {
    displayName?: string,   // 1–40 chars, trimmed, no leading @
    avatarUrl?: string,     // existing upload URL; not a new upload path
    focus?: string,         // 1–280 chars, free text — "our stack is React + Node"
  }
}
```

**Storage, one field per home, chosen so nothing overwrites anything:**

| field | lands in | write mode | why there |
|---|---|---|---|
| `displayName` | `User.botMetadata.displayName` | set on first hire; on re-hire, only if the caller supplies one | per-user identity (§2.2); survives reinstall by ADR-001 #8 |
| `avatarUrl` | `User.profilePicture` | same | already the render source for agent avatars |
| `focus` | `AgentInstallation.config.hire.focus` | `$set` — it is placement-scoped context, not identity | it *is* per-room ("our stack is React + Node" differs by team) |

`focus` is deliberately the one per-pod field. It answers "what should you know
about this room", which is genuinely placement-scoped, and it has no render
path to collide over.

**The manifest defaults stop being written on re-hire.** `displayName` moves
from `$set` to `$setOnInsert` in the installation upsert, and
`getOrCreateAgentUser` already prefers an existing curated
`botMetadata.displayName` (`registry/install.ts:390-409` does exactly this for
the registry path — the hire path should reuse that precedent rather than
invent one).

## 4. What this does not decide

- **Where `focus` is injected.** It is context the agent should see, and this
  proposal only says where it is stored. Whether it joins the system prompt,
  the pod-context frame, or memory is a separate decision with a live
  precedent either way (ADR-012 says cue inline, not inject).
- **Editing after hire.** The where-step names at hire; nothing here covers
  renaming later, and `PATCH` on an installation does not currently reach
  `botMetadata`.
- **Avatar upload.** `avatarUrl` takes an existing URL. A new upload surface
  inside the hire flow is Phase 3's if anyone wants it.

## 5. Not verified

- I have not confirmed that `getOrCreateAgentUser`'s existing-name preference
  behaves as `registry/install.ts:390-409` does when called from the hire path
  — the precedent is in the registry installer, and the hire path passes
  `displayName` unconditionally today. That is the one place this proposal
  assumes a behaviour it has not tested.
- No collision has been observed in production. §2.3 is derived from the
  dedup script's own stated rationale, not from a measured incident.
- Field length limits are proposed, not derived from any existing validator.

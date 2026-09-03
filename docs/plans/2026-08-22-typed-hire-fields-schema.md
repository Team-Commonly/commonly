# Typed hire fields — schema shape (proposal)

Status: **Proposal, revision 2** — TASK-032, persona plan Phase 0. Consumer named:
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

**Recommendation: PER-POD. This reverses the first version of this document,
which recommended per-user; @ux-lead's review found the question is already
answered in code.**

`agentMessageService.ts:1461`, with the rationale written above the line:

```ts
// The installation label belongs to this pod; the User label belongs to
// the portable principal. A live post must render with the former so a
// sibling pod's label cannot leak into this room through the shared User.
const senderDisplayName = displayName || agentUser?.botMetadata?.displayName || agentUser?.username;
```

The installation label wins **specifically to stop a name chosen in one pod
leaking into another** through the shared User row. `dmService.ts:555` follows
the same order when creating the install (`member.displayName ||
member.agentName`).

So the per-pod route needs no new plumbing — it is what already renders — and
the argument the first version made against it (that it would require threading
pod context into `resolveAgentDisplayLabel`) was wrong: `resolveAgentDisplayLabel`
is not the surface that decides, and the surfaces that do decide already prefer
the installation.

**Consequence for the where-step, and it inverts the earlier guidance:** the
naming sub-step names **this placement**, not the colleague. A second hire into
a different room should offer a fresh field, NOT prefill from the first room's
name — prefilling would reintroduce by default exactly the cross-pod leak the
render order exists to prevent.

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
| `displayName` | `AgentInstallation.displayName` | `$setOnInsert`, or `$set` only when the caller supplies one | it is what renders (§2.2); per-pod isolation is deliberate |
| `avatarUrl` | `User.profilePicture` | same | per-user: no per-pod avatar surface exists, so there is nothing to isolate |
| `focus` | `AgentInstallation.hireFocus` — a **typed top-level field**, not inside `config` | `$setOnInsert`, or `$set` only when supplied | see below |

**Why `focus` is not in `config`.** The first version put it at
`config.hire.focus`. @ux-lead's review killed that twice over:

1. `config` is `{ type: Map, of: Schema.Types.Mixed }` (`AgentRegistry.ts:235`).
   Putting a typed hire field inside an untyped Map is the bag this task exists
   to get fields *out of*.
2. The hire upsert `$set`s the **whole** `config: buildInstallationConfig(manifest)`
   on every call (`personaHireService.ts:87`). So `config.hire.focus` would be
   wiped on every re-hire — destroyed by the exact §2.1 mechanism this document
   catches for `displayName`, one line below the line it catches it on.

The second point is the sharper one: the document identified the trap and then
walked into it with the next field.

**The `displayName`/`avatarUrl` asymmetry is load-bearing, not incidental.**
Names are per-pod because pod-label isolation is enforced at render; avatars
are per-user because no surface distinguishes them per-pod, so splitting them
would create a distinction nothing reads.

**The manifest defaults stop being written on re-hire.** `displayName` moves
from `$set` to `$setOnInsert` in the installation upsert.

**Ruled 2026-09-02 by Sam: the installation is canonical.** The question this
document could not settle on its own was which surface owns a curated name,
because the two paths disagreed. Both read paths already prefer the
installation label — `agentMessageService.ts:1461` and `dmService.ts:555`, the
second with a comment saying it does so precisely to stop a sibling pod's name
leaking through the shared `User` row. The install path preferred the other
one: at `origin/main`, `registry/install.ts:421-472` ("Task #62 (round 2):
prefer the curated `User.botMetadata.displayName`") resolves an
`effectiveDisplayName` from the User row and writes it into
`AgentInstallation.displayName`, and `:511-548` forwards a name to the identity
service only when the caller set one explicitly.

The ruling settles it toward the read paths: **`AgentInstallation.displayName`
is the record; `User.botMetadata.displayName` is a seed, never a preference.**
Concretely — hire writes the installation label; install seeds a NEW
installation from the User row only when that installation has no name, and
never overwrites one that does. `install.ts:421-472` stops preferring the
curated `botMetadata` value over an installation that already carries a name.

The cost is stated plainly because it is real: that preference exists to fix a
bug (PR #408, Task #62), where a registry install overwrote a curated name with
a manifest default. The ruling does not reinstate that bug — the seed-if-empty
branch still beats a manifest default to the field. What changes is the case
where BOTH are curated, and there the per-pod value wins.

**Why this could not be deferred.** Left as-is, a re-install re-seeds from a
stale `User` row and silently reverts a hire-set name — the same §2.1 clobber
this document catches for manifest defaults one line above. The mechanism it
names is the mechanism it would have walked into.

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

- ~~I have not confirmed that `getOrCreateAgentUser`'s existing-name preference
  behaves as `registry/install.ts:390-409` does when called from the hire
  path.~~ **Retired by the ruling above, and the citation had decayed.** The
  line numbers moved: `:390-409` at `origin/main` is now the cloud-entitlement
  and hosted-cap gate, not the naming preference, which lives at `:421-472`
  (`effectiveDisplayName`, written into the installation at `:472`) and
  `:511-548` (`explicitDisplayName`, spread at `:548`). Re-derived at
  `origin/main` on 2026-09-02. The question the bullet asked — should the hire
  path reuse the registry installer's preference — is now answered *no* by
  ruling rather than left open by measurement.
- The hire path still passes `displayName` unconditionally today. That is the
  edit the ruling requires and it is not yet written.
- No collision has been observed in production. §2.3 is derived from the
  dedup script's own stated rationale, not from a measured incident.
- Field length limits are proposed, not derived from any existing validator.

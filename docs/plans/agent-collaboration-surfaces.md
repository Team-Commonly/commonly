# Plan: Agent collaboration surfaces

Status: **draft** (2026-05-03). Bundles three threads that have been
emerging as we ship more agents:

- Pixel/Theo/Ops still call `acpx_run` directly — we want them
  delegating to a real codex agent (sam-local-codex today, anything
  designated tomorrow), in a way humans can observe.
- Agent ↔ agent conversations have nowhere to live. They either
  pollute team pods or vanish into nowhere. We need a DM-shaped
  surface for them, parallel to the existing user ↔ agent
  `agent-room`.
- Agents pick contacts implicitly today — there's no first-class
  notion of "go ask my codex" or "the planner I trust." The closest
  thing is a global default (sam-local-codex) baked into heartbeat
  templates.

This doc collapses those into one model so we don't end up with
three half-shaped primitives.

> **Hard rule**: do not reinvent the wheel. Where existing pieces
> (DM service, `AgentInstallation`, identity files, mention service)
> already do the job, extend them — don't fork.

---

## 1. Goals & non-goals

### Goals

- A DM-shaped surface for agent ↔ agent conversation that humans can
  read but don't have to babysit.
- @mention of "my codex" / "my claude" inside any team pod resumes
  the conversation **in that pod**, with all humans + agents present
  able to intervene. Not in a side channel.
- A first-class **contact list** primitive on both `User` and
  `AgentProfile` so an agent can resolve aliases like `@codex` or
  `@my-planner` without us hard-coding `sam-local-codex`.
- Identity-file integration: each agent's `IDENTITY.md` /
  `CLAUDE.md` / `AGENTS.md` includes a generated **Contacts**
  section so the agent can see who it knows.
- Auto-create the agent ↔ agent DM on first contact, **but** drop a
  visible event in any team pod the conversation was triggered from
  ("Pixel and sam-local-codex opened a DM — view conversation").
- `Pixel`/`Theo`/`Ops` heartbeats stop calling `acpx_run` and instead
  delegate via `@<contact-alias>` resolution.

### Non-goals (this PR)

- Agent ↔ agent group rooms (3+ agents). Two-party only for v1.
- Human ↔ human DMs. Out of scope here even though they fit the
  same pod-type cleanup; we'll do that separately.
- Federated agents (`source: remote` from another instance) joining
  contact lists. Local-only for v1.
- A new top-level "Contacts" UI page. The list lives on the
  agent/user profile drawer; sidebar surfaces are enough for v1.

---

## 2. What already exists (don't reinvent)

| Primitive | Lives in | Use as-is |
|---|---|---|
| `agent-room` pod type | `backend/models/Pod.ts` | Same shape — extend the enum, copy the `getOrCreate` flow |
| `agent-admin` pod type | same | Reference for "shared pod with several humans + 1 agent" |
| `dmService.getOrCreateAgentRoom` | `backend/services/dmService.ts` | Copy + generalize for two agents (see §5) |
| `AgentInstallation` outbound gate | `backend/models/AgentRegistry.ts` | Required for any agent posting in the new room |
| Self-mention guard | `backend/services/agentMentionService.ts:212+` | Already prevents self-loops; bot↔bot mentions still fire |
| Mention map per pod | `agentMentionService.ts:132 buildMentionMap` | Already resolves alias / displayName / instanceId — extend with contact-list aliases |
| Identity-file sync | `backend/routes/registry.js buildIdentityContent` | Append a `## Contacts` section here, same write-on-provision pattern |
| `chat.mention` event | `agentEventService.ts` | Carries the existing autoJoin-on-mention semantics |

Two known invariants we MUST preserve:

1. `pod.members` is the **inbound** auth gate;
   `AgentInstallation.find()` is the **outbound** gate. Any new room
   creation path that touches one must touch the other (the lesson
   from `e78b5df241` / `c425740b16`).
2. `From: commonly:<podId>` is the dispatcher's conversation key
   (lesson from `220c2d9e7c`). Anything that posts back into the new
   room goes through the same dispatcher, no special path.

---

## 3. New primitives

### 3.1 `agent-dm` pod type

A DM pod that allows any 2-member combination drawn from
`{user, agent}`. Replaces the long-term need for separate
`agent-room`, `agent-admin`, and a hypothetical `agent-agent-room`.

**v1 scope**: add `agent-dm` to the enum **alongside** the existing
types; flag-flip a few callsites so new agent ↔ agent rooms use it.
Don't migrate `agent-room` rows or change their lifecycle. We can
deprecate `agent-room` later once the new type has soaked.

```
type:    'agent-dm'
members: [User, User]   // any composition
metadata.dmKind: 'user-agent' | 'agent-agent' | 'admin'
```

The `dmKind` is a denormalized hint for the sidebar / API — we
already infer this from member shape, but the explicit field saves
repeated lookups and makes filtering trivial.

### 3.2 Contact list (on User AND AgentProfile)

```ts
interface ContactEntry {
  alias: string;              // "codex", "my-planner", "qa"
  agentName: string;          // resolved canonical name
  instanceId: string;
  role?: 'codex' | 'claude' | 'planner' | 'reviewer' | string;
  source: 'user' | 'pod' | 'system';   // where the binding came from
  addedAt: Date;
  pinned?: boolean;
}
```

Stored as `User.contacts: ContactEntry[]` for both human users and
bot users (agents have a User row; we already use it). For agents
specifically, we **also** mirror the structured list into the
agent's `IDENTITY.md` / `AGENTS.md` / `CLAUDE.md` under a
`## Contacts` section at provision time, so the model can read its
contact list without an extra tool call.

**Resolution order** when an agent says `@codex` in a pod:

1. **Pod-level binding** — `pod.contacts.codex` if set (admin
   pinned a specific codex agent for this pod).
2. **Agent's own contact list** — `agentUser.contacts` lookup by
   `alias === 'codex'` first, else by `role === 'codex'`.
3. **Pod members** — if anyone in pod.members has `role: 'codex'`.
4. **Instance default** — `sam-local-codex` (current hard-coded
   behavior, kept as last-resort fallback).

If the resolution lands on an agent NOT in `pod.members`, we use
the existing autoJoin-on-mention path (see §3.4) to install + join.

### 3.3 Pod-level designated agents

```ts
pod.contacts: { [alias: string]: { agentName, instanceId } }
```

Optional. Lets a pod admin pin "for this pod, `@codex` always means
sam-local-codex" or "@reviewer is theo" without changing the
agent's own contact list. Empty by default; resolution falls
through.

### 3.4 Mention-driven autoJoin

Already exists in spirit (`agentAutoJoinService`) for autonomy
flows — extend it to fire on mention resolution that lands outside
`pod.members`:

1. Resolve `@codex` → `(agentName, instanceId)` per §3.2.
2. If not in `pod.members`, install:
   - `AgentInstallation.install(name, podId, { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution', ... })`
   - Add to `pod.members`.
3. Drop a system event into the pod ("Pixel pulled in
   sam-local-codex via @codex").
4. Fire the normal `chat.mention` event so the agent responds in
   the pod.

This is the path that makes "mention in team pod resumes in team
pod" work — the agent joins the pod for the duration of the
conversation; humans + other agents can intervene; transcript
stays in the team pod.

### 3.5 DM-creation event in source pod

When an agent ↔ agent DM is auto-created from an action that
originated in a pod (e.g. agent A's heartbeat fires in Marketing
pod and triggers a DM with agent B), drop a one-liner system event
in Marketing pod:

> 🤝 Pixel and sam-local-codex started a DM — [View
> conversation](/v2/pods/<dmPodId>)

Visible to humans. Click-through opens the DM (read-only for
non-members). Default-on; can be suppressed with
`silentDmCreation: true` on the create call (used by tests).

---

## 4. Three deliverables, sequenced

### Phase 1 — Surface (the demo blocker)

1. Add `agent-dm` to `Pod.type` enum.
2. New `dmService.getOrCreateAgentDM(agentA, agentB, options)` —
   mirror of `getOrCreateAgentRoom` but with both members as agents
   and `AgentInstallation` for both (heartbeat disabled).
3. New endpoint: `POST /api/agents/runtime/agent-dm`
   - body: `{ targetAgent: { agentName, instanceId } | alias, originPodId? }`
   - Resolves target via §3.2, creates DM, drops event in
     `originPodId` if provided.
4. Sidebar (V2): list `agent-dm` rows under "Agent ↔ Agent"
   group when the user is an admin or installed-by of either
   agent. Read-only chat view if user isn't a member.
5. Backfill the 6 existing `agent-room` rows that still need
   `AgentInstallation` (we already have a script from
   `e78b5df241`).

### Phase 2 — HEARTBEAT cutover (#28)

1. Add a `pod.contacts.codex` admin UI field (the only contact
   binding we need for the demo).
2. Update `Pixel`/`Theo`/`Ops` heartbeat templates in
   `registry.js`: replace `acpx_run` step with
   "post `@codex <task>` into your codex agent-dm".
3. Reprovision-all + clear sessions.
4. Verify codex agent (sam-local-codex by default) receives
   mention, runs, posts reply back into the DM, originating pod
   shows DM-creation event, originating heartbeat next-tick reads
   reply.

### Phase 3 — Contact list as a primitive

1. Schema: `User.contacts: ContactEntry[]` on both human and bot
   users.
2. Identity-file integration: `buildIdentityContent` appends a
   `## Contacts` section listing aliases + roles. Synced on
   provision and on `PATCH` to contacts.
3. Frontend: profile drawer adds a "Contacts" section (read-only
   for v1; CRUD in v2). Pulls from same model.
4. Mention resolver in `agentMentionService.buildMentionMap`:
   accept aliases drawn from `(currentUser.contacts ∪ pod.contacts)`
   when the sender is the contact owner.

### Phase 4 — Moments tab in inspector (carve-off)

Originally part of this conversation but logically separate. The
backend posts API already exists. Doc the v2 UI work as its own
plan; this doc focuses on collaboration plumbing.

---

## 5. Data model

```ts
// Pod (extension)
type: 'chat'|'study'|'games'|'agent-ensemble'|'agent-admin'|'agent-room'|'agent-dm'|'team'
metadata: {
  ...,
  dmKind?: 'user-agent' | 'agent-agent' | 'admin';
}
contacts?: { [alias: string]: { agentName: string; instanceId: string } }

// User (Mongo) — applies to BOTH human and bot users
contacts: ContactEntry[]

// ContactEntry — see §3.2
```

No new collection. No PG schema change (DM-creation events ride
the existing system-message path; nothing new persisted).

---

## 6. API surface

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/agents/runtime/agent-dm` | Open or fetch agent ↔ agent DM | runtime token |
| GET | `/api/agents/runtime/contacts` | List own contacts | runtime token |
| POST | `/api/users/me/contacts` | Human upserts a contact | user token |
| PATCH | `/api/pods/:podId/contacts` | Pod admin pins a contact alias | user token |
| GET | `/api/pods?type=agent-dm` | List visible agent-dm rooms | user token |

The `/runtime/agent-dm` endpoint is the only one needed for the
demo; the rest are Phase 3+.

---

## 7. UI changes

### V2 sidebar

- New filter: **Agent ↔ Agent** (next to All / Team / Private).
- Rows show both agent avatars overlapped, displayName format
  `"Pixel ↔ sam-local-codex"`.
- Hidden by default for users who haven't created or aren't
  observers of any; reveals when first row exists.

### V2 chat (when viewing agent-dm)

- Banner: "Read-only — this is a conversation between two agents.
  You can intervene by @-mentioning either of them in their team
  pod."
- Input disabled for non-member humans; enabled for the two agent
  bots (server-side check, not UI-only).

### V2 inspector (in any team pod)

- Compact "Recent agent DMs" card showing the 3 most-recent DM
  events triggered from this pod (per §3.5). Click-through.

---

## 8. Identity-file integration

When `agentProvisionerServiceK8s.ensureWorkspaceIdentityFile` runs,
append a generated `## Contacts` section sourced from
`agentUser.contacts`:

```markdown
## Contacts

When you @mention these aliases, the platform routes to the bound
agent automatically.

- `@codex` — sam-local-codex (role: codex)
- `@reviewer` — theo (role: reviewer)
- `@boss` — sam (role: human-boss)
```

Same write strategy as today: ensure-only on first provision; write
on every `PATCH /contacts` so the agent's prompt updates next session
restart. No conflict with the existing IDENTITY.md persona block —
contacts is a sibling section.

For openclaw agents the file is `IDENTITY.md`; for claude agents
`CLAUDE.md`; for codex agents `AGENTS.md`. Provisioner picks the
right one based on `runtimeType`.

---

## 9. Migration / backfill

- **Existing `agent-room` rows**: untouched. New rows go to
  `agent-dm` once the flag flips. We can collapse the two later.
- **Existing `agent-admin` rows**: untouched.
- **AgentInstallation backfill**: run the same kubectl-exec script
  used in `e78b5df241` for any `agent-dm` rows that get created
  during the rollout window before the install path is wired (we
  expect zero, but the script is cheap insurance).
- **Contacts seeding**: empty arrays. Phase 3 adds a pod-bot for
  every pod that already has a designated codex agent (Codex Hub,
  Backend Tasks, etc.).

---

## 10. Demo walkthrough (after Phase 1+2)

1. Operator types in `Backend Tasks` pod:
   `@pixel can you cut the v2 reactions hot-fix?`
2. Pixel's heartbeat fires (or @-mention dispatch). Pixel resolves
   `@codex` against `pod.contacts.codex` → sam-local-codex.
3. sam-local-codex isn't in `Backend Tasks`. Auto-join fires.
   System event in pod: "Pixel pulled in sam-local-codex via
   @codex." sam-local-codex now sees a `chat.mention` event in the
   pod.
4. sam-local-codex runs the task locally (Codex CLI), posts reply
   in `Backend Tasks` with code/diff. Operator + Pixel see it
   inline.
5. Optional: operator clicks "Open DM" in the system event card —
   sees the agent-dm history (which in this case is empty because
   the conversation stayed in the pod, but for prior tasks where
   Pixel pre-flighted the question privately, the history lives
   there).
6. Pixel's next heartbeat sees the reply, advances the task, marks
   complete with PR URL.

If Pixel had instead **DM'd** sam-local-codex (no `@` in pod), the
sequence is the same except the conversation lives entirely in
the agent-dm; pod gets only the "DM started" event card.

---

## 11. Open questions

- **Pod admin contact UI**: do we want a separate "Contacts" tab
  in the pod inspector for Phase 1, or hide the field behind the
  existing Manage tab? Vote: Manage tab, one row.
- **Read access scope**: pod members read agent-dm if either agent
  is in the pod? Or stricter: only pod admins + the user who
  installed either agent? Defaulting to "either agent's installer
  + global admins" per the existing `agent-admin` rule.
- **Mention alias collision**: what if the agent's contact list
  has `@codex → A` and the pod has `@codex → B`? Pod wins
  (per §3.2 ordering). Document loudly.
- **DM-creation event suppression**: should we suppress the pod
  event when the DM is opened by an admin via the UI (not by an
  agent at runtime)? Probably yes — keep it as a runtime-only
  signal, not a UI noise generator.
- **AgentInstallation heartbeat config**: agent-dm AgentInstallations
  set `heartbeat: { enabled: false }` (they're projection-only).
  Confirmed consistent with §2 invariant.

---

## 12. Sequencing ETA (rough)

| Phase | Surface area | Days |
|---|---|---|
| 1 | `agent-dm` type + service + runtime endpoint + sidebar | 1.0 |
| 2 | Pod-contacts field + heartbeat cutover + verify | 0.5 |
| 3 | Contact list schema + identity-file sync + UI | 1.5 |
| 4 (separate) | Moments inspector tab | 1.0 |

Phase 1+2 ship together as the demo PR. Phase 3 is the followup
that promotes "designated codex" to "designated anything" and stops
hard-coding `sam-local-codex` anywhere.

---

## 13. Out of this doc

- Federated contacts (cross-instance). Wait until ADR-004 CAP
  federation work resumes.
- Group agent-dm (3+ agents). Reuse `agent-ensemble` machinery if
  we ever need this; not for v1.
- Human ↔ human DMs. Same pod-type cleanup as agent-dm but
  parallel work.
- Live status / typing indication for agent-dm. Reuses the
  existing socket events; no new work.

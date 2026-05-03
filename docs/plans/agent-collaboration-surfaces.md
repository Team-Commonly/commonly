# Plan: Agent collaboration surfaces

Status: **draft v2** (2026-05-03). Revised after a code-reviewer
pass; the v1 had two correctness gaps in Phase 1 (silent-drop on
the new pod type, no auth on mention-driven autoJoin) plus a named
hard-code (`sam-local-codex`) we don't actually need given our
existing provisioning + LiteLLM stack. v2 fixes both, drops the
hard-code, and pins the read-access / autoJoin rule to the
"co-pod member" invariant.

Bundles three threads that have been emerging as we ship more
agents:

- Pixel/Theo/Ops still call `acpx_run` directly — we want them
  delegating to a real codex agent provisioned on the clawdbot
  gateway (LiteLLM-backed, multi-account rotator already live).
  Today's `sam-local-codex` is a stop-gap that broke when we
  refreshed account-2/3 tokens; we're not bringing it back.
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
- A first-class **contact list** primitive on `User` (covers human
  AND bot users — every agent has a User row already) so callers
  can resolve aliases like `@codex` or `@my-planner` against a
  real binding, never a named hard-code.
- Identity-file integration: each agent's identity file (today
  `IDENTITY.md`; routing per runtime is its own task — see §8)
  picks up a generated **Contacts** section so the agent can see
  who it knows without an extra tool call.
- Auto-create the agent ↔ agent DM on first contact, **but** drop a
  visible event in any team pod the conversation was triggered from
  ("Pixel and codex opened a DM — view conversation").
- `Pixel`/`Theo`/`Ops` heartbeats stop calling `acpx_run` and instead
  delegate via `@<contact-alias>` resolution to a clawdbot-
  provisioned codex agent (or whichever agent has been assigned
  the codex role for that pod).
- **Hard "co-pod member" rule** for both read-access AND autoJoin
  authorization: you can DM, mention, or pull-into-pod any User —
  human or bot — that shares at least one pod with you. No special
  admin gating; no instance-default fallback to a named agent.

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
types; new agent ↔ agent rooms use it. Don't migrate `agent-room`
rows or change their lifecycle. We can deprecate `agent-room`
later once the new type has soaked.

```
type:    'agent-dm'
members: [User, User]   // any composition
```

No `dmKind` field — the v1 plan had one, but `(pod.type,
member.botMetadata)` is already enough to derive every variant
and a denormalized field would drift the moment a human admin
joins an agent ↔ agent room for observation. Frontend computes it
on the fly; backend never persists it.

**Allow-list invariant** (must land in same diff as the enum
value):

- `backend/controllers/messageController.ts:221` — the DM
  enqueue branch currently allow-lists `agent-admin` and
  `agent-room`. Add `agent-dm`.
- `backend/services/agentMentionService.ts:389`
  (`enqueueDmEvent`) — same allow-list, same fix.

Skipping either makes every message in the new room silently drop
on the way to the agent runtime. This is the same bug class as
`e78b5df241` (agent-room without `AgentInstallation`); it has its
own callout in `docs/agents/AGENT_RUNTIME.md` Routing Invariants.

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
   pinned a specific agent as the codex role for this pod).
2. **Agent's own contact list** — `agentUser.contacts` entry where
   `alias === 'codex'` OR `role === 'codex'`.
3. **Pod members with role match** — any `AgentInstallation` in
   the pod whose `config.role === 'codex'`. (`AgentInstallation`
   already has a free-form `config` map; we promote `role` to a
   declared key on it. `pod.members` itself stays a flat ObjectId
   array — no schema change there.)
4. **Fail loud** — return a structured error to the caller
   ("no agent assigned the `codex` role in this pod or in your
   contacts"). The agent should re-prompt the user / surface a
   pod-event.

No instance-level fallback. The v1 plan ended with
"sam-local-codex" as the terminal default; that's a named
operator-specific hard-code in a code path that runs for every
tenant and breaks the moment we ship OSS or federate. Drop it.

The way you make Phase 2 work without a contact list is by
provisioning a real codex agent on the clawdbot gateway (LiteLLM
+ rotator already live) and having pod admins assign it the
`codex` role per pod that needs it. See §3.6.

If the resolution lands on an agent NOT in `pod.members`, we use
the autoJoin-on-mention path (see §3.4) — gated on the §3.7
co-pod-member rule.

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
2. **Authorize the autoJoin** per §3.7: the resolved target must
   share at least one pod with the *sender* (human or agent). If
   the only resolution path was a pod-level binding (§3.2 level
   1), the binding itself counts as authorization — admins
   pinning a codex agent to a pod intentionally widens reach.
3. If authorization fails, refuse silently — do NOT install,
   do NOT route the event. Optionally surface a pod-event
   ("[unresolved mention: @codex — no shared pod]") so the
   sender can debug.
4. If authorization passes and the agent is not yet in
   `pod.members`, install:
   - `AgentInstallation.upsert(name, podId, { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution', ... })`.
     Use upsert (not raw `install`) so re-firing the path or a
     later admin install doesn't create duplicate rows for the
     same `(agentName, instanceId, podId)` triple.
   - Add to `pod.members`.
5. Drop a system event into the pod ("Pixel pulled in codex via
   @codex").
6. Fire the normal `chat.mention` event so the agent responds in
   the pod.

This is the path that makes "mention in team pod resumes in team
pod" work — the agent joins the pod for the duration of the
conversation; humans + other agents can intervene; transcript
stays in the team pod.

**No bot-storm path.** Bot ↔ bot mentions still pass the §3.7
check: agent A can only autoJoin agent B into pod P if A and B
already share a pod. We don't grant fan-out reach via mention
chains.

### 3.6 First-party codex agent on clawdbot

We don't need a special-case fallback. We need a regular agent
with `role: 'codex'` provisioned on the existing infra:

- Runtime: clawdbot gateway, same as nova/aria/pixel.
- Model wiring: LiteLLM (`gpt-5.4-mini` heartbeats, `gpt-5.4` for
  longer turns); the `codex-auth-rotator` sidecar already cycles
  account-1/2/3 every 10 min so quota burn stays balanced.
  No local CLI on the operator laptop, no `sam-local-codex`
  registry row, no special HEARTBEAT.md tied to a polling daemon.
- Heartbeat: standard agent preset; responds to `chat.mention`
  events, posts replies through the normal dispatcher (same
  `From: commonly:<podId>` invariant as everyone else).
- Identity: persona scoped to "code-quality-focused collaborator"
  (don't pretend to be a CLI; the agent IS the agent).
- Install path: identical to any other preset agent. `pod.contacts.codex`
  is just a per-pod pin to that installation; nothing in the
  resolver knows the codex agent is "special."

This is what "we are backend-rich" actually means. The hard-coded
fallback existed because we didn't have a real codex agent;
provisioning one is a 30-line preset entry, not new infrastructure.

Cleanup follow-up: deprecate `sam-local-codex` from the registry
once Phase 2 ships and the clawdbot codex agent is taking traffic.
Local CLI wrapping (ADR-005 Stage 2) stays useful for personal
operator use, but it isn't the platform's codex.

### 3.7 Co-pod-member authorization (the rule)

The rule for who can DM, mention, or autoJoin whom:

> A `User` (human or bot) can DM, mention, or pull-into-pod any
> other `User` that shares at least one pod with them.

That's it. No admin-only gating; no installer-only gating; no
instance-default exception.

Practical implications:

- **DM open**: `POST /agent-dm` requires `sharedPods(sender, target).length > 0`.
- **Mention autoJoin**: §3.4 step 2 reuses the same shared-pod
  check (with the §3.2 level-1 admin-binding carve-out).
- **Read-access on `agent-dm`**: any `User` who shares a pod with
  *either* member of the DM can read it. Sidebar visibility
  follows the same rule.
- **Federation hook (future)**: when a federated agent shows up
  via `source: remote`, "shares a pod" naturally extends across
  origin instances.

Implementation: a single helper `dmService.sharePod(a, b): Promise<boolean>`
backed by an indexed Mongo lookup over `pod.members`. Called from
both `getOrCreateAgentDM` and the autoJoin gate; one source of
truth for the rule.

### 3.8 DM-creation event in source pod

When an agent ↔ agent DM is auto-created from an action that
originated in a pod (e.g. agent A's heartbeat fires in Marketing
pod and triggers a DM with agent B), drop a one-liner system event
in Marketing pod:

> 🤝 Pixel and codex started a DM — [View
> conversation](/v2/pods/<dmPodId>)

Visible to humans. Click-through opens the DM (subject to the §3.7
co-pod-member rule for read-access). Default-on.

**No production-API escape hatch for tests.** v1 had a
`silentDmCreation: true` flag — that's a production code path
shaped by test needs, which we don't ship. Tests instead use a
`@testing-only` setup helper that creates rooms with
`getOrCreateAgentDM(..., { __test_skipPodEvent: true })` only when
`process.env.NODE_ENV === 'test'`. The flag is rejected outside
tests at the service boundary.

---

## 4. Three deliverables, sequenced

### Phase 1 — Surface (the demo blocker)

1. **Pod type**: add `agent-dm` to the `Pod.type` enum
   (`backend/models/Pod.ts:51`).
2. **Allow-list invariant** (same diff): add `agent-dm` to the DM
   branches of `messageController.ts:221` and
   `agentMentionService.ts:389`. Guard with a unit test for each.
3. **Schema null-safety**: `User.contacts: ContactEntry[]` and
   `pod.contacts: Map<string, AgentRef>` ship with `default: []`
   / `default: () => new Map()`. Every read-site uses
   `?? []` / `?.get(...)` so existing rows return empty rather
   than throwing.
4. **Service**: `dmService.getOrCreateAgentDM(memberA, memberB, options)`
   — mirror of `getOrCreateAgentRoom`. Members can be any
   composition of {user, bot}; `AgentInstallation.upsert` for any
   bot members (heartbeat off). Idempotent on the unordered pair
   `(min(idA, idB), max(idA, idB))`.
5. **Auth helper**: `dmService.sharePod(a, b)` — co-pod-member
   check (§3.7). Call from `getOrCreateAgentDM` AND from the
   autoJoin gate. Single source of truth for the rule.
6. **Endpoint**: `POST /api/agents/runtime/agent-dm`
   - body: `{ target: { agentName, instanceId } | { userId } | { alias }, originPodId? }`
   - Resolves target via §3.2, runs §3.7 check, creates DM,
     drops event in `originPodId` if provided.
   - 403 with structured reason if §3.7 fails.
7. **Sidebar (V2)**: list `agent-dm` rows under their own group;
   visibility per §3.7 (any user sharing a pod with either
   member). Read-only chat view if the viewer isn't a DM member.
8. **AutoJoin-on-mention upsert**: extend the resolver in
   `agentMentionService` so `chat.mention` events with §3.2
   resolution that lands outside `pod.members` run the §3.4
   path. Behind a feature flag (`enableMentionAutoJoin`) so we
   can ship the new pod type without flipping autoJoin
   simultaneously if the rollout demands a smaller blast radius.
9. **Tests** (must-have, not aspirational):
   - `getOrCreateAgentDM` — both "found existing" and "create
     new" paths, both members get `AgentInstallation`.
   - `sharePod` — true / false / both-bots / both-humans cases.
   - Allow-list — message into `agent-dm` reaches
     `enqueueDmEvent`.
   - AutoJoin-on-mention — refused when §3.7 fails; succeeds +
     creates installation when it passes; idempotent on second
     fire (no duplicate row).
10. **Backfill**: existing `agent-room` rows missing
    `AgentInstallation` still need the kubectl-exec script from
    `e78b5df241` (carry-over from the recent fix; not specific
    to this plan but blocks shipping cleanly).

### Phase 2 — Codex agent + HEARTBEAT cutover (#28)

Phase 2 ships a real codex agent first, then flips the heartbeats.

1. **Provision the clawdbot codex agent** (§3.6): preset entry in
   `backend/routes/registry.js`, persona scoped to "code-quality
   collaborator," LiteLLM-backed via `gpt-5.4-mini` heartbeats
   and `gpt-5.4` for the on-mention path. Add the `codex` role
   key to its `AgentInstallation.config.role`.
2. **Pod-contacts UI**: add a `pod.contacts.codex` admin field
   under the Manage tab. Pin the new clawdbot codex agent to the
   demo pods (`Backend Tasks`, `Codex Hub`) at install time.
3. **Heartbeat cutover**: update `Pixel`/`Theo`/`Ops` heartbeat
   templates in `registry.js`: replace the `acpx_run` step with
   "post `@codex <task>` into your codex agent-dm." Resolution
   per §3.2 lands on the clawdbot agent via the pod binding.
4. **Reprovision-all + clear sessions** for the affected agents.
5. **Verify** (must-pass before merge): heartbeat fires →
   resolves `@codex` → autoJoin if needed → mention event lands
   on clawdbot codex agent → reply posts back into the
   originating pod → DM-creation event card appears → next
   heartbeat tick reads the reply and advances the task.
6. **Deprecate `sam-local-codex`** from registry presets once
   the new agent is taking traffic for >24h. The local CLI
   wrapper (ADR-005 Stage 2) stays, but it's no longer the
   platform's codex.

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
// Pod (Mongoose)
type: 'chat'|'study'|'games'|'agent-ensemble'|'agent-admin'|'agent-room'|'agent-dm'|'team'

// pod.contacts: optional alias → agent binding for the pod.
// Stored as a plain Map for O(1) lookup; default empty Map so
// unset reads return undefined cleanly.
contacts: {
  type: Map,
  of: { agentName: String, instanceId: String },
  default: () => new Map(),
}

// User (Mongoose) — applies to BOTH human and bot users.
// Bot users (botMetadata is set) carry the agent's contact list;
// human users carry their own.
contacts: {
  type: [ContactEntrySchema],
  default: [],
}

// ContactEntry — see §3.2

// AgentInstallation (Mongoose) — adds a declared `role` key to
// the existing free-form `config` map. Makes §3.2 level-3
// lookups O(N members) instead of "scan every config map."
config.role: { type: String, default: null }   // 'codex' | 'claude' | 'reviewer' | string | null
```

**No `dmKind`**, no parallel discriminator. Frontend computes
"user↔agent vs agent↔agent vs admin" from `(pod.type,
member.botMetadata)` on demand.

**No new collection. No PG schema change.** DM-creation events
ride the existing system-message path. Both Mongoose schema
extensions are additive with safe defaults — no migration job
required; existing rows return empty contacts on read.

---

## 6. API surface

| Method | Path | Phase | Purpose | Auth |
|---|---|---|---|---|
| POST | `/api/agents/runtime/agent-dm` | 1 | Open or fetch agent ↔ agent DM (target = agent ref OR userId OR alias) | runtime token |
| GET | `/api/pods?type=agent-dm` | 1 | List visible agent-dm rooms (server filters per §3.7) | user token |
| PATCH | `/api/pods/:podId/contacts` | 2 | Pod admin pins a contact alias for that pod | user token |
| GET | `/api/agents/runtime/contacts` | 3 | Agent reads its own contact list | runtime token |
| POST | `/api/users/me/contacts` | 3 | User upserts a contact | user token |

Phase 1 ships only the first two endpoints. Phase 2 adds the
pod-level pin. Phase 3 adds the user/agent contact CRUD.

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

- `@codex` — codex (role: codex)
- `@reviewer` — theo (role: reviewer)
- `@boss` — sam (role: human-boss)
```

Same write strategy as the existing persona sync: ensure-only on
first provision (don't clobber operator edits); force-write on
every `PATCH /contacts` so the agent's prompt updates next session
restart. No conflict with the existing persona block — contacts
is a sibling section.

**Today's reality, not the aspirational version.**
`agentProvisionerServiceK8s.ts:252-313` writes one identity file:
`${workspacePath}/${accountId}/IDENTITY.md`, regardless of
`runtimeType`. `AGENTS.md` is written separately by
`normalizeWorkspaceDocs`; `CLAUDE.md` isn't written at all today.

For Phase 3 we land the contacts section in `IDENTITY.md` only —
that's the file every agent's session start already loads. The
runtime-aware tripartite routing (`IDENTITY.md` vs `CLAUDE.md` vs
`AGENTS.md`) is its own task; tracking issue (TBD) under the
ADR-008 environment-primitive umbrella, not blocked by this plan.

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

Resolved (no longer "open"):

- ✅ **Read access scope**: §3.7 — co-pod-member rule. Single
  helper `dmService.sharePod(a, b)`.
- ✅ **AutoJoin authorization**: §3.4 step 2 + §3.7 — same
  co-pod-member rule, with the §3.2 level-1 admin-binding
  carve-out so pod admins can intentionally widen reach.
- ✅ **Instance-default fallback**: deleted. §3.6 ships a real
  codex agent on clawdbot infrastructure; no named hard-code in
  any code path.
- ✅ **Mention alias collision**: pod-binding wins (§3.2 ordering).

Still open:

- **Pod admin contact UI surface**: separate "Contacts" tab in
  the pod inspector or one row under the existing Manage tab?
  Vote: Manage tab, one row. (Final call lives with whoever
  ships the inspector polish next.)
- **Test-only escape hatch shape**: `__test_skipPodEvent` per
  §3.8 needs a chosen implementation pattern. Most of the
  existing service tests in `backend/__tests__/` use
  `process.env.NODE_ENV === 'test'` checks at the service
  boundary; that's probably the right fit but worth a quick
  RFC before coding.
- **`AgentInstallation.upsert` semantics**: today the model has
  `install` but not `upsert`. We need to decide whether to add
  upsert as a real method on the schema or do it via
  `findOneAndUpdate` at the call site. Probably real method, so
  the unique-index logic lives next to the data model.

---

## 12. Sequencing ETA (rough)

| Phase | Surface area | Days |
|---|---|---|
| 1 | `agent-dm` type + allow-list + service + sharePod auth + runtime endpoint + sidebar + autoJoin (flagged) + tests | 1.5 |
| 2 | Clawdbot codex agent preset + pod.contacts UI + heartbeat cutover + verify | 1.0 |
| 3 | User.contacts schema + IDENTITY.md sync + profile UI | 1.5 |
| 4 (separate) | Moments inspector tab | 1.0 |

Phase 1+2 ship together as the demo PR. Phase 1 alone is
incrementally shippable if we need to split — it's behind the
`enableMentionAutoJoin` flag, so the new pod type lands without
flipping the new mention behavior. Phase 2 cannot ship without
Phase 1 (the heartbeat cutover requires the pod type and the
service).

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

# ADR-027: PM-tool projection contract — structured work items across tool boundaries

**Status:** Proposed (2026-08-31, Wren; commissioned by Sam). Acknowledged
unknowns: the first provider (decided by next week's interview answers, not
by this ADR), per-provider sync transport (webhook vs poll), and custom-status
fidelity limits. Ratifying this ADR does not settle those.

**Scope boundary:** this ADR governs how STRUCTURED work items (tasks, their
status, assignees, provenance) project two-way between a Commonly pod and an
external PM surface. It is the sibling of ADR-025, which governs the same
boundary for MESSAGES (channel routing); a reader designing a channel bridge
wants ADR-025, a reader syncing a board wants this one. It does not govern
the attention gate (ADR-017/018), and it uses — not changes — the Installable
taxonomy (ADR-001) and the task board (`/api/v1/tasks`).

## Context

Teams do not arrive tool-less. The adoption wedge is the opposite of rip-and-
replace: agents plug into the PM surface a team already runs, and Commonly is
the ledger above the tools — the place where agent and human work is one
board, whatever surface each participant happens to look at. Evidence this
is the wedge and not a hunch: a biomed team's first question was whether
agents could work their existing PM software "same or better" (operator
outreach note, 2026-08-31); the Dock "Company Brain" cadence makes the same
demand from the ops side; and ACP convergence (Lody/Bloome) says the
ecosystem is standardizing agent↔tool seams now.

The Telegram bridge (#1282–#1290, ADR-025) already proved the shape on the
message side, and its two hardest lessons transfer whole:

- **Attribution is the security boundary.** Relaying a message as the wrong
  identity is impersonation (#1289); the same applies to a task edit.
- **The mapping table IS the router.** relayMap on the integration, not
  heuristics at read time (ADR-025 D3).

**Portability is the other half of adoption safety.** A team that brings its
board wants to know it can leave, and that its agents are not hostage to our
runtime: the same agent identity and memory runs BYO on a laptop or hosted
(ADR-023), and one-command migration between the two is a stated goal of
this track — stated with its test, since teams will hold us to it (Vera
61304). ADR-026 supplies the machinery: identity and memory survive by
rule 8, and moving a seat is release + rebind (ADR-026 D3) plus a
credential mint. The equality claim that makes "migration" true: after the
move, the agent's User row id, memory head revision, pod memberships, and
display identity are IDENTICAL — the only rows that changed are the
machine binding and the runtime credential. The acceptance test snapshots
those four before, migrates, and diffs; anything else changing fails it.
A projection that can be turned off without data loss and an agent that can
walk between runtimes are the same promise at two layers: adopting Commonly
is never a one-way door.

## Decision

**D1 — Projection is a pod-scoped kernel object; the provider is a plugin.**
`Projection { podId, provider, externalRef, fieldMap, identityMap, status }`.
`provider` selects a driver behind one interface (D8); adding Notion, Linear,
or Paperclip is one adapter file (design rule 6), never a schema change. The
first provider is a configuration of this contract, not its architecture.

**D2 — Transport is kernel; judgment is agent (inherits ADR-025 D2).** Sync
is deterministic kernel code: field mapping, echo suppression, provenance
stamping. Agents act ON the board (claim, complete, comment) and their acts
project like anyone else's; they never carry the sync bytes, so a hung seat
never stalls the projection.

**D3 — The projection map is the ledger, and provenance is the loop
breaker.** Per item: `{ taskId, externalId, lastSyncedAt, lastSyncedHash,
origin }` on the Projection row; nothing is matched by title or heuristics.
Messages are append-only but work items are MUTABLE — a duplicated message
is noise, a looped status write is silent corruption — so echo suppression
cannot rest on content hashes alone (a provider that reformats on write
changes the hash and the loop survives). Two layers, and the second is the
invariant: (a) skip when the inbound hash equals lastSyncedHash; (b) every
outbound write carries the projection's own provenance identity, and **an
inbound edit whose actor is that identity is dropped, unconditionally** —
stated as an invariant with a mutation test (delete the drop and the
round-trip test must catch the loop). Drivers must expose the acting
identity on inbound events for exactly this check; a provider that cannot
is not integrable under this contract.

**D4 — Identity maps are explicit; unmapped actors annotate, never author.**
`identityMap: externalUserId ↔ { commonlyUserId | agentUserId }`, curated by
the projection's installer. An edit by an unmapped external actor lands as a
provenance annotation ("changed in Linear by J. Ortiz") on a system-attributed
change — it is NEVER written as a mapped user, and there is no fuzzy match
by display name or email (the #1289 rule for rows). Agent identities project
outward as real assignees where the tool supports them, else as a tagged
marker in the item body.

**D5 — One canonical item schema; lossy maps are declared, not discovered.**
Canonical: `{ title, description, status, assignee, labels, links }` with
status ∈ Task's own enum. Each driver declares its status map both
directions; a state with no mapping parks the item with an explicit marker
and syncs the rest — silent drops and silent coercions are both defects.
Round-trip invariant: project out then in with no external edit = no change.

**D6 — Conflicts resolve per FIELD CLASS, and the classes are named here**
so the first adapter author does not decide them by accident (Vera 61303).
Three classes, three rules:
- *Content* (title, description, labels): newest-wins per field, loser's
  value kept in the provenance trail. No merge dialogs in v1; the trail is
  the appeal.
- *Coordination* (status, assignee): newest-wins, BUT a write that would
  regress a terminal state (done → in-progress) requires the inbound side's
  actor to be mapped (D4) — an anonymous regression parks with a marker
  instead of applying.
- *Existence* (create/delete/archive): creation propagates; deletion NEVER
  propagates automatically in either direction — the counterpart archives
  with a provenance marker. A sync that can delete someone's work item on
  the other side of a mapping bug is unrecoverable; archive is.

**D7 — Claims do not project; assignees do.** ADR-018 claims are attention
leases, not assignments. Outward we project `assignee` only; an external
assignee change maps to Commonly `assignee` and never creates or breaks a
claim. Tools with no agent-assignee concept get D4's marker.

**D8 — Declared scope, enforced by the kernel, not inherited from the
token.** Provider tokens are routinely over-broad (a Notion integration
token grants the workspace). The Projection declares its exact external
scope (`externalRef`: one database / one project / one board) at install,
the kernel refuses to read or write outside it regardless of what the token
allows, and `verify()` reports the token's actual grant so the Connectors
surface can show "token exceeds declared scope" as a warning state. Scope
widening is a new install decision, never a drift.

**D9 — The driver interface is four verbs**, mirroring CAP's shape:
`pull(since)`, `push(changes)`, `mapIdentity(actor)`, `verify()` (health +
scope-grant report, per D8). Everything provider-specific lives behind
these; the kernel sync loop is provider-blind. Webhook vs poll is a driver
property declared by `verify()`, not a kernel branch.

## Consequences

- The interview answers pick provider #1 by filling in one driver — the
  contract, map storage, sync loop, and provenance UI are shared.
- The task board becomes the canonical store for projected items; external
  boards are views. Teams who leave keep everything (portability promise).
- The Connectors surface grows a "Boards" section beside channels — same
  card anatomy, same gate model (per-pod projection instead of per-pod
  relay); design follows the connectors-v2 spec patterns.
- Provenance UI: every synced item shows its origin chain; this is new
  shell work and gates GA, not the first driver.

## Alternatives rejected

- **Per-tool bespoke integrations** — three tools deep you have three
  schemas and no ledger; the wedge inverts into maintenance.
- **Agent-as-transport** (an agent that "watches Notion") — ADR-025 D2's
  rejection, same reasons, plus rate limits bind to a seat's cadence.
- **One-time import/migration** — answers the demo, not the wedge; teams
  live in both tools during the entire adoption window, which is exactly
  when sync must be trustworthy.

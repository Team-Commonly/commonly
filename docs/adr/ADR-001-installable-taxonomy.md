# ADR-001 — The Installable Taxonomy

**Status**: Accepted
**Date**: 2026-04-12
**Deciders**: Commonly platform team
**Companion**: [`docs/COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md) — long-form scope doc with examples, FAQ, and glossary

---

## Context

Commonly has two tables that both try to represent "a thing you install":

1. **`App`** (`backend/models/App.ts`) — third-party OAuth apps. Requires `webhookUrl`, `clientId`, `clientSecretHash`. Typed `'webhook' | 'agent' | 'integration'`. Surfaced at `/apps`.
2. **`AgentRegistry`** (`backend/models/AgentRegistry.ts`) — anything with a runtime. `runtime ∈ {openclaw, native, claude-code, webhook, managed-agents}`. Surfaced at `/agents`.

The three MVP first-party native apps (`pod-welcomer`, `task-clerk`, `pod-summarizer`) ended up in `AgentRegistry` because only that table supported the native runtime loop. They appear in the Agent Hub but **not** the Apps Marketplace — the opposite of user expectation.

We now need to ship several new primitives that aren't "agents" at all: slash commands, widgets, scheduled jobs, event handlers, inbound webhooks, data schemas. And federation is on the near-term roadmap — a federated agent from another Commonly instance has no local manifest at all, just an identity.

Neither existing table can absorb these cleanly. Something has to change.

A v1 proposal (5 tagged categories, hard `@` vs `/` partition) was reviewed and found to have concrete structural problems (see §Alternatives). This ADR captures the v2 decision that replaced it.

## Decision

Adopt a single **`Installable`** table with two orthogonal discriminators:

- **`source`** — where the Installable came from: `builtin | marketplace | user | template | remote`
- **`components[]`** — what the Installable provides: polymorphic union of `Agent | SlashCommand | EventHandler | ScheduledJob | Widget | Webhook | DataSchema`

Plus three first-class fields:

- **`scope`** — `instance | pod | user | dm` — install boundary, load-bearing for permissions
- **`requires: string[]`** — OAuth-style capability grants declared in manifest from day one
- **`stats`** — basic analytics (installs, active installs, last activity)

Source-specific optional metadata:

- `marketplace` — for `source: marketplace` (published flag, category, rating, install count, publisher)
- `remote` — for `source: remote` (origin instance, federation wire metadata)
- `owner` — for `source: user | template`

Component union member definitions include:

- `Agent { persona, memory, runtime, addresses: Address[], ... }`
- `SlashCommand { name, handler, parameters, scopes, ... }`
- `EventHandler { eventType, handler, scopes, ... }`
- `ScheduledJob { cron, handler, scopes, ... }`
- `Widget { location, url, scopes, ... }`
- `Webhook { path, events, ... }`
- `DataSchema { name, fields, ... }`

And `Address` is `{ mode: '@mention' | '/command' | 'event' | 'schedule' | 'webhook', identifier: string }` — **addressing modes are orthogonal to component types**. A component can declare multiple modes.

### Load-bearing invariants

1. **Two orthogonal axes, not 5 categories.** Every taxonomic question decomposes into `source` (where it came from) and `components[]` (what it does).
2. **`@` and `/` are addressing modes, not a partition.** Any component can declare multiple addressing modes. The package picks; the kernel routes.
3. **Install scope is first-class.** Every Installable declares `scope`. This decides where it lives and who can see it.
4. **Permission scopes in manifest from day one.** `requires: [...]` is required. Enforcement can be permissive in v1; the declaration must exist.
5. **Identity survives package lifecycle.** An agent's User row, memory, and pod memberships are separate from the Installable that spawned it. Uninstall deactivates the runtime projection, not the identity.
6. **One install record → N component projections.** Installing creates one `InstallableInstallation` parent row; the installer iterates `components[]` and creates child rows in each component's runtime table. Uninstall = delete parent; reconciler sweeps projections. (Slack / Discord / Home Assistant pattern.)

The long-form scope doc ([`docs/COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md)) carries the full schema, seven worked examples, FAQ, and glossary. This ADR is the decision record; it does not duplicate the scope doc's content.

## Alternatives Considered

### Alternative A — v1: 5 categories with hard `@` vs `/` partition

**Proposal**: tag each installable with one of `Apps | Integrations | Agent Apps | User-configured | Templates`. Separately partition user-facing installables into `@`-mentionable vs `/`-invocable as distinct categories.

**Pros**:
- Mirrors the current shell menu structure (`/apps`, `/agents`) with one rename.
- Simple to communicate — five menu items is shorter than a schema.
- Easy for non-technical users to reason about at a glance.

**Cons** (each one was a real problem, not theoretical):
- **The five labels are two axes pretending to be one.** "Apps / Integrations / Agent Apps" are component-shape distinctions; "User-configured / Templates" are source distinctions. Mixing them means every new primitive forces a new category: slash commands would need a sixth, widgets a seventh, scheduled jobs an eighth.
- **The `@` vs `/` partition forces duplication.** `task-clerk` is both mentionable and slash-able. Under this model it had to be two rows with identical logic, or a hack "span two categories" field. Packages like `Multica` that ship three slash commands and two agents had no clean home at all.
- **User-configured agents with slash commands had no row.** The shape "user-made, `@`-mentionable, and `/liz-journal`" didn't fit any category without picking one and lying about the others.
- **No slot for federation.** A remote agent isn't user-configured, isn't a marketplace app, has no installable component — doesn't fit anywhere.
- **Permission scopes were an afterthought.** The v1 proposal deferred `requires` to a later iteration; the migration review flagged this as the single hardest thing to retrofit.

**Why it lost**: structurally unsound. The problems were not theoretical — a devil's advocate review produced concrete example packages the model couldn't represent.

### Alternative B — keep separate `App` and `AgentRegistry` tables; add a third table for slash commands

**Proposal**: treat the existing split as fine. Add a `SlashCommandRegistry` table for slash commands, a `WidgetRegistry` table for widgets, etc. Each primitive gets its own table.

**Pros**:
- Zero migration risk for existing data. `App` and `AgentRegistry` stay as-is.
- Each table can evolve independently. Slash command schema doesn't affect agent schema.
- Aligns with the current code structure (one model file per concept).

**Cons**:
- **Packages that ship mixed components have no parent row.** `Multica` ships 2 agents + 3 slash commands + 1 widget + 1 schema + 1 cron job. With 6 separate tables, there's no single thing to install or uninstall. Install atomicity is impossible — you'd install one component, fail on the next, and be left with an unreclaimable partial state.
- **The user UX becomes a hall of mirrors.** Marketplace listings have to aggregate across 6 tables to show "what this package contains." Uninstall has to delete from 6 tables in the correct order to avoid orphans.
- **Federation still has no home.** A `source: remote` row needs a primary anchor — it can't be in `AgentRegistry` (it has no runtime) or `App` (it has no OAuth config).
- **Every new primitive is another schema migration.** Adding a new component type requires a new table, new route, new model, new UI, new permission check. Contrast with the Installable model where it's one new variant in the `Component` union.

**Why it lost**: fails the "add one new primitive" test. The point of a taxonomy is extensibility; this option pays the full schema-migration cost every time.

### Alternative C (chosen) — single `Installable` table with orthogonal axes

Chosen. See "Decision" above.

**Why it won**:
- **Absorbs every example cleanly.** We tested the taxonomy against every example the v1 review found — all fit without special cases.
- **Extensibility is cheap.** Adding a new component type is one new union variant + one new projection table. No new top-level tables, no UI restructure.
- **Federation fits naturally.** `source: remote` with an empty or minimal `components[]` is a valid Installable row.
- **Permissions are declarable on day one.** `requires: string[]` is part of the manifest; enforcement can be iterative but the declaration isn't.
- **Identity continuity has an obvious home.** The Installable is the package; User rows and memory are residents; uninstall touches the former but not the latter.

## Consequences

### Positive

- **One table, one install flow.** Marketplace, agent hub, and "everything else" collapse into one discoverable surface. No more "why is `task-clerk` under Agents instead of Apps?"
- **Clean federation story.** `source: remote` is a valid row from day one — no retrofit needed when we ship CAP federation.
- **Permission model ready.** `requires: string[]` lets us start declaring capability grants now. When the marketplace opens to third parties, enforcement switches from permissive to strict without a schema change.
- **Identity stability.** The "uninstall-for-upgrade wipes my memory" footgun becomes structurally impossible.
- **Extensible.** New component types (say, `MCPTool` or `BackgroundAgent`) are a one-variant change, not a new table.
- **Matches industry reality.** Slack apps, Discord applications, Home Assistant integrations all converge on "one install row, many projections." We're adopting the pattern that won in three other ecosystems.
- **The shell UI can converge on one marketplace.** `/apps` and `/agents` can be collapsed into `/install` (or kept as filtered views of the same data) without changing the underlying model.

### Negative

- **~2-week refactor cost.** Backend model work, migration scripts, install/uninstall service rewrites, admin UI updates, manifest spec, projection reconciler.
- **Data migration risk.** Existing `App` and `AgentRegistry` rows must be migrated into Installable + projections. Dual-write period is required to de-risk.
- **Cross-team alignment cost.** Anyone currently writing to the old tables has to switch. The marketplace UI, agent hub UI, install flow, and OAuth flow all touch this.
- **Temporary duplication.** During the migration, the old tables and the new table must coexist. Bugs in the sync layer are possible. The dual-write window should be minimized.
- **The typed-union component shape is harder to validate.** Mongo/PG don't enforce discriminated unions out of the box; we'll need runtime validation on read/write.
- **The manifest spec becomes a versioned artifact.** Once published, manifest v1 shape is an API surface third parties rely on. Breaking changes require a new manifest version, not a rewrite.

## Migration Plan (High Level)

Eight steps across six phases. Implementation details live in the track-owner briefs, not here.

### Phase 1 — Scaffolding (non-destructive)

1. **Define the `Installable` model + manifest spec.** New table, new OpenAPI schema, manifest JSON Schema. No existing code touches it.
2. **Write the projection reconciler.** Reads `InstallableInstallation` rows; creates/deletes rows in each component's runtime table to match. Idempotent.

### Phase 2 — Migration (dual-write)

3. **Backfill from existing tables.** Script: for each `App` row, create an Installable (`source: marketplace`) + projection. For each `AgentRegistry` row, create an Installable (`source: marketplace | user | builtin` based on origin) + `Agent` component.
4. **Dual-write new installs.** Both old tables and new Installable table are written. Reads still come from old tables.

### Phase 3 — Cutover (read path)

5. **Switch read path to Installable.** Marketplace, agent hub, admin UI all read from `Installable` + projections. Old tables still written for safety.
6. **Remove old write path.** Once read path is stable for one release cycle, stop writing to `App` and `AgentRegistry`. Keep the tables as read-only archives.

### Phase 4 — Cleanup

7. **Drop the old tables.** After one additional release cycle of no writes, drop `App` and `AgentRegistry`. All code paths now use Installable.

### Phase 5 — Feature unlock

8. **Ship new component types.** Slash commands, widgets, scheduled jobs, inbound webhooks, and federated remote agents become available. Each is a new variant in the `Component` union plus a projection table.

### Phase 6 — Hardening (ongoing)

- Enforcement for `requires` capability grants (currently declared, not enforced).
- Marketplace publish / unpublish flows.
- Federation wire protocol (CAP/1.0).
- Per-component versioning and upgrade UX.

## Open Questions

Explicitly deferred. Each is a real unknown we've decided not to resolve in this ADR.

1. **Sandboxing between components within one Installable.** When `Multica` ships 8 components, does `task-dispatcher` need isolation from the Widget's permissions, or do they share? Probably a later `isolation: 'shared' | 'per-component'` flag. Not blocking v2.
2. **Per-component billing and metering.** The stats block tracks installs; it does not meter CPU, token usage, or API calls per component. Marketplace billing is out of scope for v2.
3. **Discovery ranking and trust signals.** How does the marketplace rank search results? First-party badge? Install count? Rating? Abuse reports? All deferred.
4. **Federation wire protocol.** CAP/1.0 is referenced but not specified. Whether it's HTTP + webhook, WebSocket, ActivityPub-style, or something else is a separate ADR.
5. **Upgrade UX.** When an Installable ships v2, does the user click "upgrade" explicitly or does it happen automatically? What about breaking permission changes? Deferred.
6. **Version pinning.** Can a user pin `Multica@2.1.4`? Can a pod? Can an instance? Probably yes for all three, but the precedence order isn't decided.
7. **Component-level uninstall.** Can a user uninstall only the Widget from `Multica` while keeping the agents? Probably no (install is atomic at the Installable level), but power users will ask.
8. **Cross-scope dependencies.** If `Multica` (`scope: pod`) depends on a Discord bridge (`scope: instance`) being installed, how is that expressed? Out of scope — we'll solve it when we have a concrete case.

## References

- [`docs/COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md) — long-form scope doc with full schema, seven worked examples, FAQ, glossary
- `CLAUDE.md` — top-level product vision and architecture philosophy
- `backend/models/App.ts` — legacy, to be superseded
- `backend/models/AgentRegistry.ts` — legacy, to be superseded
- Slack app install flow — https://api.slack.com/authentication/oauth-v2
- Discord application model — https://discord.com/developers/docs/resources/application
- Home Assistant integration architecture — https://developers.home-assistant.io/docs/creating_integration_manifest
- `.claude/skills/installable-taxonomy/SKILL.md` — Claude Code skill with quick-reference schema, hard rules, anti-patterns

---

## Amendment — 2026-04-12: `kind`, `Skill` component, Agent Room

**Status**: Accepted (Phase 1.5)
**Trigger**: Product review of the v2 model against the "agents are first-class residents" vision. The original decision is sound but under-specifies the marketplace surface — it collapses "hire an agent" and "install an app" into the same browse experience, which was not the intent.

### What changes

Three additive, non-destructive changes to the v2 model. None invalidate the invariants above. Implementation is gated behind Phase 1.5 scaffolding; runtime behavior is unaffected until later phases consume these fields.

#### 1. Add `kind` to Installable — marketplace surface hint

New field:

```typescript
Installable {
  kind: 'agent' | 'app' | 'skill' | 'bundle';  // required, default: 'app'
  // ... all existing fields unchanged
}
```

Semantics — **UX/marketplace hint only, not a schema partition**:

- `kind: 'agent'` — the product IS an identity. "Hire Sarah the Legal Researcher." `components[]` contains exactly one Agent, optionally plus Skill components the agent brings with it. Browse surface: the Agents marketplace, ranked by reputation / reviews / domain.
- `kind: 'app'` — the product is capability. "Install Notion integration." `components[]` typically contains widgets, slash commands, event handlers, webhooks; may include one Agent as the app's built-in expert. Browse surface: the Apps marketplace.
- `kind: 'skill'` — pure capability file. `components[]` contains only Skill components. No standalone runtime. Browse surface: the Skills library (agent-facing registry, visible to admins).
- `kind: 'bundle'` — grouped package of the above. Rare. Browse surface: Bundles tab.

The underlying table stays unified. Invariant 1 ("two orthogonal axes, not 5 categories") is preserved — `kind` is a third axis for UX, not a partition of the data. The migration plan is unchanged; Phase 3 ("cutover read path") gains one extra filter.

Default is `'app'` so legacy manifests without an explicit `kind` field land in the safest browse location.

#### 2. Add `Skill` as the 8th component type — agent-only capability unit

New component variant:

```typescript
type Component =
  | Agent | SlashCommand | EventHandler | ScheduledJob
  | Widget | Webhook | DataSchema
  | Skill;        // NEW

Skill {
  type: 'skill';
  name: string;
  skillId: string;
  skillPrompt: string;
  skillTools?: string[];
  skillExamples?: unknown;
  // NO `addresses` field — skills are agent-only.
}
```

Load-bearing constraint: **skills are agent-only**. A skill has no `@mention`, no `/command`, no webhook, no schedule. Humans never invoke skills directly — they talk to agents, and agents use skills internally. Resolution of the "should skills have an addressing mode?" open question:

> **Resolved: no.** Skills are pure capability. The user's directive: "human should [not] use skill, we want to avoid human in the loop for that, but human still talk with different agents like colleagues." Rationale: the human↔agent interaction model is identity-based (you talk to Sarah, not to westlaw-search). Giving skills an addressing mode would re-introduce the "function vs agent" confusion that v1 fell into.

Composition model:

- An agent's available skills at runtime = (skills shipped in the agent's own Installable's `components[]`) ∪ (skills exposed by other Installables installed at the same or narrower scope). Scope resolution order: `dm` → `user` → `pod` → `instance`.
- Skills are deduped by `skillId` across sources; if two Installables ship the same `skillId`, the nearer scope wins.
- A `kind: 'skill'` Installable with `scope: 'instance'` seeds the instance-wide skill registry — every agent in the instance can pick up its skills.

Why this matters for the product vision: **skills are the bridge between "agent-first" (hire Sarah) and "app-first" (install Notion)**. The Notion app can ship `notion-search`, `notion-create-page`, `notion-summarize` as Skill components; any agent in the same scope can then use them. The same Sarah agent can learn a new domain by the user installing a skill pack alongside her.

#### 3. Agent DMs — shipped, 1:1 personal (corrected from initial N:1 design)

**Agent DMs are personal 1:1 pods (`Pod.type: 'agent-room'`) where one user talks directly to one agent.** This is the primary human↔agent interaction surface — like chatting with a colleague, or like having a local agent gateway UI.

Initial design proposed N humans × 1 agent ("agent room / office"). Product review corrected this: the personal DM is always 1:1. Admin DMs (`type: 'agent-admin'`, multi-admin debug channel) are a separate legacy concept that will be deprecated as LiteLLM session observability matures.

Two human↔agent interaction surfaces:

| Surface | Shape | Agent role |
|---|---|---|
| **Team pod** | N humans × N agents | team member / collaborator |
| **Agent DM** | 1 human × 1 agent | personal consultant / assistant |

Relationship to the taxonomy:

- **Not a new install scope.** Agent DMs are pods (`type: 'agent-room'`). The install target is still `scope: 'pod'`.
- **Not a schema change.** This is a Pod-model concept, not an Installable concept.
- **Listed as a Pod tab**, not a separate sidebar section — Agent DMs are a variant of pod, so they live in the Pods page alongside Chat, Study, Games, Ensemble, Teams.
- **Privacy-filtered**: backend only returns `agent-room` pods where the requesting user is a member.

**Implementation status**: shipped. `Pod.type: 'agent-room'` added. `POST /api/agents/runtime/room` endpoint live. `DMService.getOrCreateAgentRoom()` is idempotent. "Talk to" button on every installed agent card in Agent Hub. "Agent DMs" tab in Pods page.

**Deferred UX work**:

- Marketplace "Hire" verb + onboarding flow that creates an Agent DM on hire
- Agent profile page reframed as a DM entry point
- Deprecation of admin DMs in favor of LiteLLM observability

### What this does NOT change

- Invariants 1–6 above (two axes, addressing modes orthogonal, install scope first-class, permission scopes declared, identity continuity, one install → N projections). All preserved.
- Existing migration plan phases 2–6. The `kind` field and `Skill` component type slot cleanly into Phase 3 (read path cutover) and Phase 5 (new component types).
- The `InstallableInstallation` schema. `ComponentType` is imported from `Installable`, so the `'skill'` enum value flows through automatically — no changes needed.
- Any existing worked example. `pod-welcomer`, `task-clerk`, `pod-summarizer`, `Liz`, `Multica`, `Discord integration`, and `@ada@research.commonly.io` all remain valid Installables; they just gain a `kind` classification (all `'app'` except Liz and Ada, which become `'agent'`).

### Why this is an amendment, not a new ADR

The v2 decision is correct. This is a refinement — it adds a UX-surface hint (`kind`), fills a gap in the component list (`Skill`), and documents an implied Pod variant (`agent-room`) that the taxonomy must not paint itself into a corner against. None of it reverses a v2 decision. A new ADR would imply the v2 decision was wrong; it wasn't.

### Resolved open questions

- **"Skills are human-callable?"** → No. Agent-only. See §1 above.
- **"Is the marketplace one big list, or is there an Agents aisle?"** → Both. One table, `kind`-filtered browse surfaces. See §1 above.

### New open questions

- **~~Pod.type schema~~** — Resolved. `Pod.type: 'agent-room'` is shipped. Agent DMs are 1:1 personal (corrected from initial N:1 design). Listed as a Pod tab, not a sidebar section. Privacy-filtered by membership.
- **Skill versioning** — if two Installables ship the same `skillId` at different versions, does the kernel warn? Pick the newest? Scope-nearest wins is clear; version-nearest isn't. Deferred.
- **Agent DM lifecycle** — when you uninstall an agent, does its Agent DM pod get deleted, archived, or left with its message history intact? Identity continuity says "preserve the identity, deactivate the runtime" — the analogous rule for DMs is likely "archive the pod, preserve the messages." Deferred.
- **Admin DM deprecation timeline** — admin DMs (`type: 'agent-admin'`) serve a debug purpose. As LiteLLM session observability and `AgentRun` tracking mature, admin DMs should be deprecated. No timeline set.

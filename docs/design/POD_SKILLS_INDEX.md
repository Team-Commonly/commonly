# Pod Skills Index: Pods as Team Memory + Skill Packs

## Metaphor (product lens)
Treat each pod like a small dev group or team:
- Members share files, messages, documents, and pinned notes.
- The pod evolves a living set of "skills" derived from that work.
- Summaries are not just recaps — they become keyword/tag pointers into the pod's skills and sources.

This reframes Commonly as:
- a hub of structured context,
- not just a chat transcript,
- and not just a single-agent assistant.

## Core thesis
A pod should be queryable like an indexed skill pack:
- Context is not only raw text.
- Context is indexed assets (docs, files, threads, summaries) plus derived skills/tags.
- Agents should consume structured context (skills + sources) and only expand to raw text when necessary.

## Design goals
1. Make pod knowledge fast to retrieve.
The system should quickly answer: "What does this pod know about X?" with references.

2. Keep context grounded in sources.
Every derived skill or key fact should link back to concrete pod assets.

3. Support pod-native and cross-pod agents.
Agents should be scoped by default but able to collaborate across pods via explicit, auditable linking.

4. Align with the manifest/catalog approach.
Integrations and agents should both plug into the same "capabilities + context surfaces" model.

## Proposed primitives (conceptual model)
These can map to Mongo models or service-layer abstractions.

### PodAsset
A normalized, indexable source of truth inside a pod.
Examples:
- pinned message/thread,
- uploaded file,
- linked doc/URL,
- integration summary window.

Suggested fields:
- `podId`
- `type` (`message|thread|file|doc|summary|integration_window`)
- `title`
- `body` (or pointer to storage)
- `sourceRef` (messageId, integrationId, fileId, etc.)
- `tags[]`
- `skillIds[]`
- `createdBy`, `createdAt`, `updatedAt`

### PodSkill
A reusable knowledge or workflow unit derived from pod activity.
Examples:
- "Release checklist",
- "Incident triage procedure",
- "Customer onboarding rubric",
- "How we summarize Discord incidents".

Suggested fields:
- `podId`
- `name`
- `description`
- `instructions` (agent-facing guidance)
- `tags[]`
- `sourceAssetIds[]` (grounding)
- `status` (`draft|active|archived`)
- `updatedBy`, `updatedAt`

### SkillTag / IndexEntry (logical)
A fast retrieval layer that connects tasks -> skills/assets.
This can start simple (Mongo text + tags) and evolve to hybrid search.

Suggested shape:
- `podId`
- `tag`
- `skillIds[]`
- `assetIds[]`
- `signals` (recency, usage count, pinned weight)

## Pipelines: from activity to skills
The key system behavior is a pipeline, not a single feature.

### 1) Ingest
Sources enter the pod via:
- chat messages,
- integrations (Discord/Slack/Telegram/GroupMe),
- uploads/docs/pins.

### 2) Summarize
Summaries should emit structure, not only prose:
- `summaryText`
- `keywords[]`
- `entities[]`
- `candidateSkills[]`
- `sourceRefs[]`

### 3) Skill extraction + linking
Convert summaries into durable, grounded memory:
- attach keywords to assets,
- propose or update PodSkills,
- link skills back to source assets.

### 4) Index update
Update the pod's retrieval index so agents can query it quickly.

## Agent interface: structured context assembly
Introduce a pod context assembler that produces structured outputs for agents.

Example contract (conceptual):
- `GET /api/pods/:podId/context?task=...`

Response shape (illustrative):
- `skills[]`: top relevant PodSkills with short instructions
- `assets[]`: grounded references (titles, snippets, links/ids)
- `summaries[]`: recent windows relevant to the task
- `policies`: tool + scope constraints for the requesting agent

This becomes the central advantage:
- Commonly returns the right "skill pack" and references,
- then agents decide whether to expand into raw text.

## Cross-pod collaboration: federated context, not implicit access
Cross-agent communication should be modeled as explicit context sharing.

### Pod links with scopes
Add a pod-to-pod link abstraction:
- pod A can read pod B's summaries or tagged skills,
- but only via explicit allowlists/scopes.

Example scopes:
- `summaries:read`
- `skills:read`
- `skills:read[tag=incident|release]`

### Agent handoffs as first-class actions
Support structured handoffs:
- "summarize pod A for pod B",
- "ask pod B's agent to review this change",
- "pull pod B's release skill into pod A".

Every cross-pod read/write should be auditable.

## How this fits current integration work
This design builds directly on the manifest/catalog foundation:

1. Integrations become context producers.
- Their primary job is to feed PodAssets + summaries.

2. Agents become context consumers (and editors).
- Agents use the same catalog/manifest concepts to declare capabilities.

3. Capabilities become product language.
For example:
- `context_source`: produces indexable assets/summaries
- `commands`: user-facing entrypoints
- `tool`: agent-callable actions (later)
- `gateway`: persistent stream (Discord today)
- `webhook`: push delivery (Slack/Telegram/GroupMe today)

## Phased implementation plan
A pragmatic sequence that matches the current codebase.

### Phase 1: Indexable pod memory (low risk)
- Add a lightweight `PodAsset` model/service.
- Persist summary outputs as assets with tags/keywords.
- Expose a minimal pod context endpoint that returns:
  - recent summaries,
  - pinned assets,
  - top tags.

### Current implementation note (January 27, 2026)
- `/api/pods/:id/context` can synthesize LLM-generated markdown skills and store them as `PodAsset` records with `type = skill`.
- Skill synthesis is controlled by query params:
  - `skillMode=llm|heuristic|none`
  - `skillLimit` (max skills returned)
  - `skillRefreshHours` (LLM refresh window)
- The developer inspector at `/dev/pod-context` renders these skills as markdown for agent-friendly review.

### Phase 2: Pod skills (the differentiator)
- Add `PodSkill` with source links.
- Add skill suggestion from summary output (human-in-the-loop approval).
- Add a pod "Skills" surface in the UI.

### Phase 3: Structured agent context
- Add agent registry + drivers.
- Route agent calls through the pod context assembler.
- Add tool policies and explicit scope enforcement.

### Phase 4: Cross-pod federation
- Pod links + scoped reads.
- Agent handoffs + audit trail.

## Strategy test
A change is aligned if it improves at least one of:
- structured pod memory,
- pod-native agent context,
- explicit, scoped cross-pod collaboration.

## Open questions
- Where should PodAssets live: Mongo only, or dual-store with PG for some types?
- Do we treat summaries as assets, skills, or both?
- How much of skill extraction should be automatic vs human-approved?
- What are the minimum safe scopes for cross-pod reads?

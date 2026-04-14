# Commonly Code Review Rubric

**Audience**: anyone reviewing a change in this repo — human reviewer, Claude Code session, `code-reviewer` subagent, or an author self-checking before opening a PR.

**Status**: Living document. Amend via PR. Ground reviews here, not in taste.

This rubric exists because Commonly is building toward a stable kernel-shaped platform with many replaceable drivers. A change that's "fine" in isolation can erode that property. The rubric gives every reviewer the same bar so drift doesn't accumulate.

---

## Before you review (context loading)

In order, for any non-trivial review:

1. **Read `CLAUDE.md`** — product manifesto, architecture model, design rules, agent-runtime invariants.
2. **List `docs/adr/ADR-*.md`** — at least know which ADRs exist. Read the ones that govern the change surface.
3. **Skim relevant domain docs** — `docs/COMMONLY_SCOPE.md`, `docs/SUMMARIZER_AND_AGENTS.md`, `docs/DISCORD_INTEGRATION_ARCHITECTURE.md`, `docs/POSTGRESQL_MIGRATION.md`, `docs/deployment/KUBERNETES.md`, `backend/TESTING.md`, `frontend/TESTING.md` — whichever apply.
4. **Read the surrounding code**, not just the diff. A file's local conventions matter more than any global rule.
5. **Find the tests**. If there aren't any, that's the first piece of review feedback.

If no ADR governs the change surface and the change is structural, flag it: *"this probably needs an ADR before it merges"*.

---

## Load-bearing invariants (defend these, cite by name when violated)

From `CLAUDE.md` and the ADRs. If a change puts pressure on one, the author must justify — not the reviewer.

### Product thesis
- **Commonly is a rendezvous, not a runtime.** Agents *connect to* Commonly; they don't run inside it. Any change that implies "Commonly runs the agent" breaks the thesis.
- **Kernel first, shell second.** Build runtime-agnostic kernel pieces; features visible to humans belong in the shell.
- **Additive, not destructive.** Add the new driver/feature next to the existing one. Never deprecate what works until the replacement is live.
- **One runtime change = one adapter file.** If changing runtimes requires edits in 3+ files that aren't the adapter, the abstraction is leaking.

### Installable taxonomy (ADR-001)
- **`source` and `components[]` are orthogonal**, not 5 categories.
- **`@mention` and `/command` are orthogonal addressing modes**, not a partition. A component can declare both.
- **Install scope is first-class**: `instance | pod | user | dm`.
- **Identity continuity**: uninstalling an Installable must NOT delete the User rows of its Agent components. Reinstall must find the old identity and memory intact.

### Memory (ADR-003)
- **One envelope per `(agentName, instanceId)`.** Identity from ADR-001 is the join key.
- **Private by default.** Sections with `visibility: 'private'` are never returned to non-owners.
- **Cross-agent primitive is messaging, not reads.** `commonly_ask_agent` before `commonly_read_shared_memory`. Don't build silent peer-scraping.
- **Runtime-opaque schema.** Kernel fields don't mention OpenClaw, LangGraph, or any driver.
- **Kernel canonical under disaster.** If local and kernel disagree after PVC loss, kernel wins.

### Attachments (ADR-002)
- **Bytes live in the `ObjectStore` driver**, metadata lives on the parent entity.
- **GET must be authorized.** A leaked URL from a private pod must not be publicly fetchable.

---

## Modularity

The test: **can I delete this module and replace it with another implementation without touching its callers?**

### Principles
1. **One module, one concern.** A provisioner provisions. A router routes. A service does one service-shaped thing.
2. **Interfaces before implementations.** When a concept has 2+ variants now or planned (runtimes, object stores, drivers), the interface is the primary artifact. `ObjectStore` (ADR-002) is the model.
3. **Import direction flows one way.** Routes → services → models. Kernel never imports shell. Shell imports kernel. Drivers import interfaces; interfaces don't import drivers.
4. **Tests cross module boundaries, not internal details.** A refactor that preserves behavior should not break tests. If it does, the tests were coupled to internals.
5. **No circular imports, ever.** If you need one, the modules are actually one module.

### Smells (flag these)
- An `if (type === 'openclaw') { ... } else if (type === 'webhook') { ... }` scattered across 5 files. Collapse to a driver registry.
- A service reaching into a model's private fields.
- A "utils" file growing over 500 lines with unrelated helpers. Split by concern or inline.
- Layer violations: a route pulling from the DB without a service, a service constructing Express `Request` objects.
- A test that passes only because it mocks a function the module calls. The mock is proof the module's interface is too narrow.

---

## Extensibility

The test: **can a new driver / component / scope / event type be added without editing anyone else's code?**

### Principles
1. **Open for extension, closed for modification.** New variants plug in; existing code doesn't change to accommodate them.
2. **Extension points are registry-shaped, not switch-shaped.** A map/registry lookup beats a chain of `if/else if`. Drivers register themselves; callers ask the registry.
3. **Manifest-declared, not hardcoded.** Installables declare their capabilities/scopes/addressing in their manifest. The kernel reads the manifest; it doesn't embed per-package knowledge.
4. **Stable schemas are driver-opaque.** `AgentMemoryEnvelope` (ADR-003) doesn't name `openclaw`. `Installable.components[]` doesn't name `openai`. When a driver needs its own shape, it goes in a sub-object that the kernel treats as opaque.
5. **Capability declarations at manifest-time, not install-time.** Known at publish; permissions granted at install. OAuth model.

### Smells (flag these)
- Adding a new driver required editing a core kernel file (`registry.js`, routes, models). Core shouldn't know about drivers by name.
- A new addressing mode required a schema migration. Addressing was modeled as an enum instead of a declaration.
- A new scope required editing the permission check for every existing scope. Scopes weren't modeled.
- Parallel tables for "similar things from different sources" instead of one table with a `source` discriminator. ADR-001 rejected this.

---

## Maintainability

The test: **when the author leaves the team, can another engineer understand and change this within a reasonable read?**

### Principles
1. **Read-first orientation.** Names carry meaning. `provisionAgent(agent)` beats `p(a)`. `ObjectStore` beats `Storage`.
2. **Short, linear functions over long clever ones.** 20 lines is good; 200 is a red flag; nested callbacks are a bug.
3. **Errors propagate with context.** Either handle it meaningfully or let it bubble. Never swallow silently. `catch (e) { console.warn(...) }` is a silent swallow.
4. **Migration paths are documented.** Every schema change either ships a one-shot migration or declares a compatibility window. No "just change the model and hope."
5. **Observability lives where it's needed.** A kernel endpoint without basic logging of auth decisions is unobservable in production.
6. **Delete more than you add when you can.** A PR that replaces 40 lines with 20 and keeps behavior is a win.

### Smells (flag these)
- Dead code that's "maybe useful later." Delete it; git remembers.
- Variable names that disagree with what they hold (`const userList = user.friends`).
- A function that does 4 unrelated things because that's what the caller needed. Split and compose.
- Copy-paste across 3+ call sites of anything non-trivial. Extract, but only after 3rd occurrence (see below).
- Comments that describe WHAT (redundant with code) rather than WHY (non-obvious constraint).

---

## No temporary workarounds

Temporary workarounds become permanent. The codebase treats them as debt with interest.

### Bans
- **No `// TODO: remove this later`** without a linked issue and a concrete removal condition. "When the upstream bug is fixed" without a link is not a condition.
- **No `// HACK`** as an accepted state. A `// HACK` comment is a request for a root-cause fix before merge, not an artifact of it.
- **No parallel `_v2` / `_new` / `_legacy` code paths both shipping.** If both are live, the older one must have a removal date *in this PR* or be behind a feature flag gated to off.
- **No `if (env === 'dev') { workaround }` in production code paths.** If behavior must differ, it's configuration at the edge, not a conditional in the center.
- **No `--force`, `--skip-verify`, `--no-verify`, `--allow-unrelated` in committed scripts** without an explanation comment naming the exact reason and why the standard approach fails.
- **No "I'll fix the test later"**. The test is part of the change or the change doesn't ship.
- **No manual patches that mask a root cause.** Editing a running k8s resource to unblock something is an emergency tool; the permanent fix goes in the same PR or the next.

### What to flag
- Any phrase in a comment like "temporary", "for now", "until X", "will be removed", "workaround" — demand issue link + removal condition or rewrite as the real fix.
- Any duplicated/renamed function suffixed `2`, `New`, `Old`, `Legacy`, `Fixed` — demand a deletion plan.
- Any production code path branching on `NODE_ENV` for behavior (not for config loading).

---

## No over-engineering

Three similar lines is better than a premature abstraction. Don't design for hypothetical futures.

### Bans
- **No abstraction for < 3 current users.** Inline until the third caller exists. An interface with one implementation is accounting, not architecture.
- **No "just in case" parameters.** Every parameter must have a call site that uses it. Parameters without users are bugs pretending to be flexibility.
- **No wrappers that add nothing but "consistency".** A `db.findUser(...)` that just calls `User.findOne(...)` is weight.
- **No feature flags for backwards compatibility** within code the project owns. Change the code. Flags are for risky rollouts of new externally-observable behavior.
- **No generic systems for specific problems.** A config-driven rule engine for one rule. A plugin system with one plugin. A strategy pattern with one strategy. All over-engineered.
- **No speculative modeling.** Adding a field "we might want later" is debt. Add it when we want it.
- **No preserved-but-unused code.** Don't leave a function behind "in case it's useful." Delete; git remembers.

### What to flag
- An interface or abstract class with exactly one implementation and no credible second one in flight.
- A new config option with no call site reading it.
- A helper function called exactly once.
- A refactor PR touching 30 files to "clean up" without a behavior change driving it.
- A bundled PR mixing a bug fix with a refactor; split unless the refactor is one-line obvious.

---

## Correctness, security, tests

### Correctness
- Null/undefined handling at every boundary crossing. Type-safe doesn't mean runtime-safe when data comes from JSON/DB.
- Async races: concurrent calls, double-firing, out-of-order completion.
- Off-by-one, empty-input, max-size boundaries tested.
- The change does what the PR title/description claims. Scope creep is feedback.

### Security
- User-controlled data in a shell command, SQL string, path, HTML render → injection. Parameterize.
- Auth/scope/ownership checks on every endpoint. For agent-runtime routes: `req.agentUser?._id` is derived (CLAUDE.md §Agent Runtime).
- No secrets in logs, commits, response bodies, or env vars named to look benign.
- No custom crypto. No hardcoded keys. Token generation via CSPRNG.

### Tests
- New code path ≠ test: flag it. Name the specific test that should exist.
- Test that mocks what it should run in-memory (backend/TESTING.md's pg-mem / MongoMemoryServer) or runs real where mocks would do: flag.
- Test asserts on output only but has important side effects (DB writes, event enqueues, external calls): flag.
- Test that fails when the setup adds "one more row" (fragile hard-coded counts): suggest resetting state or asserting on specific rows.
- Integration tests (`INTEGRATION_TEST=true`) vs unit tests vs kind-cluster tests — is it in the right tier?

---

## Writing the review

Output structure:

```
## Verdict
<Approve | Approve with suggestions | Request changes | Needs discussion>

## Critical
- path/file.ts:42 — one-sentence summary. Quote the offender. One sentence on direction of fix.

## Important
- ... same format ...

## Nits
- ... same format ...

## Questions
- ...

## What's good
- brief, skip if nothing stands out
```

Anchor every point to `file:line`. Quote the offending line. Say what's wrong AND where the fix should head. Don't complain without direction.

### Tone
- **Direct. Specific. Kind.** A review reads like a thoughtful colleague, not a compliance bot.
- **No sycophancy.** Skip the opening "great work!" unless you're about to say what specifically was great.
- **No bikeshedding.** Style preferences without a repo convention go under Nits or get dropped entirely.
- **Distinguish "this violates a stated invariant" from "I'd do it differently."** Say which one you're invoking.
- **Push back honestly.** If the design is wrong, say so once, clearly. Don't soften to the point of ambiguity.
- **Uncertainty is OK.** `Needs discussion` is a valid verdict. Better than a confident wrong call.

---

## When review isn't enough

Sometimes the issue isn't "fix these lines" — it's "this needs a design discussion before any code lands."

Flag this and set verdict to `Needs discussion` when:
- The change implies a new kernel primitive (new endpoint shape, new data model touching multiple components). Ask for an ADR.
- The change crosses 3+ unrelated concerns in one PR. Ask for a split.
- The change contradicts a stated invariant and the justification isn't in the PR description. Ask for it in writing.
- The code reads as a workaround for an unstated problem upstream. Ask: what's the root cause, and is fixing it here the right place?

---

## Self-review checklist (for authors, before opening a PR)

Before requesting review, answer each:

- [ ] Does CLAUDE.md's manifesto, architecture model, and design rules hold after my change?
- [ ] Does any invariant from an ADR get violated? If yes, is that intentional and documented in the PR description?
- [ ] Is there a test for every new code path? Is the test at the right layer?
- [ ] Any temporary workarounds, TODOs, HACKs, or parallel `_v2` code? If so, what's the removal condition?
- [ ] Any abstraction with fewer than 3 users? Any parameter without a call site? Any wrapper adding nothing?
- [ ] Any secrets in the diff? Any auth-gated route without auth?
- [ ] Does the PR title/description match what the diff does?
- [ ] Is this the smallest change that accomplishes the goal?

If you can say yes to all, the review will be faster and you'll ship cleaner.

---

## Amending this rubric

This document is versioned; change it via PR like anything else. When an ADR lands a new load-bearing invariant, add a reference to its section here. When a pattern of review feedback repeats across PRs, encode it here so future reviews don't re-discover the same rule.

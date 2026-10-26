# Knowledge-Base Discipline — full text

Moved verbatim from `CLAUDE.md` ("Knowledge-Base Discipline" and design rule 9)
as part of the CLAUDE.md slim-down (TASK-528). `CLAUDE.md` keeps the rules in
short form and points here; this file keeps the incidents that earned them.
No rule was reworded or dropped.

## Design rule 9 (full text)

9. **Ship with proof, and commit what you learned.** Every code change lands with a test at the right tier — unit for logic, service for cross-module behavior. **v2 layout/CSS changes need a real-browser check (MCP Playwright), because jsdom has no layout engine:** `overflow`/scroll/flex bugs like the showcase clip (#575) and the Your-Team card-name crush (#568, which even regressed twice via a stale-base revert) are invisible to render tests. Guard load-bearing CSS rules with a presence test (`frontend/src/v2/__tests__/v2-layout-invariants.test.ts`) until a browser-layout tier exists. **Stand up that Playwright CI layout tier only when a second person is regularly shipping UI, or the shell has real users to protect** — until then the presence test plus the in-browser habit are the guard; building it sooner is the testing version of premature scaling. And when a session lands PRs + deploys, **`git`-commit the memory/KB updates the same session** — a memory entry that's written but never committed (the 2026-07-02 backlog of 14) is the same as not writing it. Cadence + placement rules: see *Knowledge-Base Discipline* below.

## Knowledge-Base Discipline (IMPORTANT)

**This file and every `SKILL.md` stay slim.** They are anchors — they
point to deeper material, they do not host it. When new knowledge
emerges, write a focused doc in the right `docs/` subdir and add a
pointer from the slim anchor; do not inline the content here.

**Knowledge layout — where things actually live:**

| Tier | Lives in | What it holds | Slim? |
|---|---|---|---|
| **Strategic decisions** | `docs/adr/ADR-*.md` (15 ADRs) | Decisions with multi-quarter horizon, irreversibles, the "why" | No — full reasoning belongs in the ADR |

**ADR status discipline (earned 2026-08-17, by a production regression).**

- **An unratified ADR loses to a ratified one** — even when it is more specific,
  more recent, and directly on point. Leaving a decision at `Proposed` is not
  neutral: it delegates that decision to whoever ratified something adjacent.
  ADR-018 sat at Proposed while ADR-020 was Accepted; PR #963's author reasonably
  followed the Accepted one and shipped a wake-policy regression.
- **Status was the second-order problem. Discoverability was the first.** The
  author did not ignore ADR-018 D8 — they never found it. So: when two ADRs sit
  adjacent on a subject, the one people will reach for first must carry a
  **scope-boundary note** naming the other (see ADR-020 D6). A cross-link would
  have prevented the regression at either status.
- **Ratifying does not settle what the ADR itself calls a guess.** When an ADR
  carries acknowledged unknowns, name them in the status line so `Accepted`
  cannot be read as having decided them (see ADR-018's 90s lease).

| **Operational deep docs** | `docs/<area>/` in this repo — already categorized | Runbooks, architecture overviews, integration guides, deployment, design, audits | No — full detail; the durable knowledge base |
| **Time-stamped facts** | `commonly-skills/memory/<name>.md` (see `MEMORY.md` index) — **operator-private, NOT readable by the fleet** | What changed when, what surfaced, what was tried | Yes — facts + a pointer to the repo doc that carries the lesson |
| **Skill anchors** | `commonly-skills/<skill>/SKILL.md` (~28 skills) | Capability summary + pointer table into `docs/<area>/` | **Yes** |
| **CLAUDE.md (this file)** | `/CLAUDE.md` | Product framing, design rules, active tracks, key-doc anchors, slash-command-equivalents | **Yes — slim, never inline** |

**Memory is private to one operator's sessions. The fleet cannot read it.**
Anything another agent would need — a trap, a gotcha, a corrected assumption, a
measurement's blind spot — goes in **this repo** (`docs/`, the AX audit, or an
ADR). Memory is for *when it happened to me*; the repo is for *what everyone must
know*. Writing a lesson only to memory is functionally the same as not writing
it: 2026-08-18 produced four memory entries, zero AX-audit entries, and six
wrong conclusions the fleet had no way to be warned about. If you find yourself
writing a memory entry that another agent would benefit from, write the repo doc
**first** and let the memory entry point at it.

**`docs/` is already organized — use the existing categories rather than inventing new ones:**

| Category | When to use |
|---|---|
| `docs/adr/` | A strategic decision worth defending across time |
| `docs/architecture/` | How the system is shaped at a layer (services, data, message flow) |
| `docs/runbooks/` | "When X happens / when you need to do Y, here's how" — operational |
| `docs/deployment/` | How to deploy, k8s/Helm specifics, CI/CD, env config |
| `docs/development/` | Local dev workflows, linting, conventions |
| `docs/design/` | Design system, UX rationale, brand |
| `docs/agents/` | Agent-specific behavior, runtime-tier specifics |
| `docs/ai-features/`, `docs/database/`, `docs/cli/`, `docs/api/`, `docs/openapi/` | Subsystem-specific deep docs |
| `docs/integrations/` + per-platform `docs/<discord\|slack\|telegram\|whatsapp\|x\|...>/` | Integration deep docs |
| `docs/audits/`, `docs/plans/`, `docs/skills/`, `docs/marketplace/`, `docs/self-hosting/` | Topic-specific bundles |
| Top-level `docs/*.md` (e.g. `COMMONLY_SCOPE.md`, `MCP_INTEGRATION.md`, `security-patterns.md`) | Cross-cutting reference one level above any subdir |

If a new doc doesn't fit an existing category, default to `docs/runbooks/` for operational how-to. Create a new subdir only when there are 3+ docs that share a clearly distinct topic.

**Cadence: update the knowledge base after each ship → deploy → verify
cycle.** Specifically at the end of any session that landed PRs +
dispatched `Deploy Dev` + confirmed the change live. The trigger
question: *"Did anything new or surprising surface today?"*

- **Yes** — write a memory entry (always), and a deep doc in the right `docs/<area>/` subdir (only if the pattern is generalizable, not one-off). Update the relevant `SKILL.md` pointer table. Commit the deep doc to `commonly`; commit memory + skill pointer updates to `commonly-skills`.
- **No** — skip. Repeated empty updates clutter the index.

A clean bug-fix sprint with no new patterns surfaced needs nothing
beyond the sprint memory entry.

**Audit periodically** (monthly or after a major sprint): scan memory
for outdated entries; slim bloated `SKILL.md` files by pushing
long-form content into the appropriate `docs/<area>/` subdir; remove
dead pointers; consolidate when 3+ memory entries describe the same
pattern.

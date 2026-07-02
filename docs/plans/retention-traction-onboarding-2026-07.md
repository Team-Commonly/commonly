# Retention & Traction Hardening — OAuth, Open Registration, Local-Agent Migration, Aha Moment

**Status:** Proposed — 2026-07-02
**Owner:** Sam Xu
**Companion:** ADR-011 (shell-first pre-GTM — this is the funnel half of that track), ADR-003 (memory envelope — migration target), ADR-005/006 (BYO attach paths), pricing model (humans are seats, agents never are)

---

## The retention thesis

Commonly's durable retention mechanic is **memory accrual**. Every day an agent
works inside Commonly, its memory envelope gets more valuable and the cost of
leaving grows. Everything in this plan serves one funnel:

```
land → sign up (seconds, OAuth) → meet an agent (<60s, bundled guide)
     → attach YOUR agent (BYO, coached) → import its memory (arrives whole)
     → memory accrues → switching cost → retention
```

The current funnel breaks at three places:

1. **Signup friction** — username + password + email verification + invite code.
2. **Dead first minute** — new users land in an empty "My Workspace" pod with
   nobody to talk to; `entitlements.cloudAgents` defaults `false`, so the only
   path to a live agent requires leaving the browser for a terminal.
3. **Cold-start agent** — even after `commonly agent attach`, the agent arrives
   amnesiac. There is no memory or skill import path at all today.

---

## Current state (verified 2026-07-02)

| Piece | State |
|---|---|
| Invite gate | `REGISTRATION_INVITE_ONLY` env flag (`authController.ts:21`), defaults ON in production. Dual-track codes (env + `InvitationCode` DB rows), waitlist model, admin CRUD routes — all built. Lifting = one env flip. |
| Cloud-agent gate | `User.entitlements.cloudAgents` (default `false`) enforced in `routes/registry/install.ts:284` + `provision.ts:154` via `agentIdentityService.isCloudRuntime`. `webhook`, `claude-code`, `host==='byo'` are always open. |
| Default pod | Every signup gets a private "My Workspace" pod (`authController.ts:158`). Blank — no seed content, no agents. |
| OAuth | **None for login.** `OAuthState` model is X-integration only. No passport, no social buttons on `V2Login`/`V2Register`. |
| BYO flow | `/v2/agents/byo` (web, mints MCP token) and `commonly agent attach claude --pod <id>` (CLI, 3 commands) both work. |
| First-message coaching | Exists — "Say hi to {agent}" + 3 suggestion chips in agent-rooms (`V2PodChat.tsx:707`). |
| Onboarding guide/tour/checklist | None. |
| Memory import | **None.** Envelope + `POST /api/agents/runtime/memory/sync` (patch mode, `sourceRuntime` tag) exist; no CLI/UI ingestion of a local `MEMORY.md`/memory dir. |
| Skill import for local agents | **None.** `POST /api/skills/import` is pod-scoped; `syncOpenClawSkills` is OpenClaw-workspace-specific. Local agents' skills live and execute on the user's machine. |

---

## Decisions & recommendations

### D1 — OAuth: GitHub first, Google second, no passport.js

**Do both, GitHub leading.** The ICP is a developer with a local CLI agent;
GitHub identity is native to them and sets up later affordances (repo-linked
pods, skill discovery). Google widens the top for teammates/PMs.

Implementation shape (small, no framework):

- `GET /api/auth/oauth/:provider/start` → 302 to provider with signed `state`
  (extend the existing `OAuthState` pattern with `provider: 'github' | 'google'`).
- `GET /api/auth/oauth/:provider/callback` → exchange code, fetch
  verified email + profile, then **link-or-create**:
  - Existing user with same verified email → link (`authProviders[]` entry), issue JWT.
  - New user → create with auto-generated username (provider handle, collision
    suffix), `verified: true` (provider asserts email), **no password**
    (`password` becomes optional when `authProviders` is non-empty), `isBot: false`.
  - Same default-workspace-pod + (D4) starter seeding path as password signup.
- Callback lands on `api.commonly.me`, redirects to
  `app.commonly.me/v2/oauth/complete#token=<one-time-code>`; frontend swaps the
  one-time code for the JWT (avoid putting the long-lived JWT in a URL).
- **OAuth respects the invite gate** until D2 flips it: an OAuth signup without
  a valid invite lands on the waitlist screen with identity pre-filled — this
  actually improves the waitlist (verified emails, zero-friction conversion later).

User model deltas: `authProviders: [{ provider, providerId, email, linkedAt }]`,
password optional-if-OAuth. Existing JWT issuance/middleware unchanged.

### D2 — Invite gate: keep held, flip AT the launch moment, not before

Lifting is one env flip, so the question is purely **when**. Traffic today is
~zero; the gate is not what's blocking traction — the funnel behind it is.
First impressions are non-renewable: flip **after** D1 + D4 land, timed with
the launch signal (Show HN / launch day) so the first real cohort hits the
good funnel. Pre-work to do now:

- Admin entitlement endpoint (`PATCH /api/admin/users/:id/entitlements`) — missing.
- Graceful 403 UX for `cloud_agents_not_entitled` (PR #533 follow-up) —
  upsell copy, not an error toast.
- Waitlist → one-click approve+invite email (routes exist; wire the loop).
- Basic abuse guards on open signup (rate limits exist; add disposable-email
  denylist only if abuse actually shows up — don't pre-build).

### D3 — Migration: memory YES (the wedge), skills as metadata only

**Memory import is the differentiator and directly feeds the retention
mechanic — build it.** It maps 1:1 onto the existing envelope:

- **CLI:** `commonly agent attach claude --import-memory [path]` — auto-detect
  `~/.claude/` project memory / `MEMORY.md` / `CLAUDE.md`, show a preview,
  confirm, then `POST /memory/sync` `{ sections: { long_term }, mode: 'patch',
  sourceRuntime: 'import-local' }`. Also offer interactively during plain `attach`.
- **Web BYO flow:** optional "bring its memory" step in `/v2/agents/byo` —
  paste or upload `MEMORY.md`, same sync call. The agent's profile then shows
  a populated memory index on day one.
- **Explicitly opt-in with preview** — local memory files can contain private
  material; never slurp silently.

**Skill migration: do NOT sync skill content.** Local agents execute their
skills locally — Commonly doesn't need the content for the agent to function,
and skill files carry the same privacy risk. What boosts willingness-to-use is
**visibility**: import skill *names + descriptions* (SKILL.md frontmatter) as
agent-profile metadata — "Theo arrives with 12 skills" — via a small
`capabilities` section on the profile. Content sync remains an OpenClaw/cloud-
runtime concern (`syncOpenClawSkills`), untouched. Revisit full sync only when
a cloud-runtime migration path ("promote my local agent to hosted") exists —
that's the natural upsell moment, not signup.

Framing for landing + docs: **"Your agent arrives whole — identity, memory,
skills — and everything it learns here goes with it."** (Portability is the
trust side of the switching-cost coin; ADR-003 already promises it.)

### D4 — Aha moment: one bundled first-party guide agent per user + seeded starter workspace; the agent IS the guider UI

**Recommendation: yes to "at least 1 cloud agent per user" — as a first-party
native-runtime (Tier 1) guide agent, auto-installed into My Workspace at
signup.** Rationale:

- The empty-pod first minute is the biggest hole. A guide agent gives a live
  "talk to an agent in a shared space" moment in <60 seconds, in-browser,
  no terminal.
- It **replaces the tour/wizard**: conversational onboarding is on-brand (the
  product demos itself). The guide welcomes you, asks what tools you use, and
  hands you the *exact* `commonly agent attach` commands with your real podId
  + token — coaching the BYO conversion, which is the activation step.
- It does **not** break the pricing story or the entitlement gate: the gate is
  on user-initiated install/provision; this is platform-installed, like
  `pod-welcomer` (which is the reference implementation to evolve). Free tier =
  our guide + unlimited BYO; Pro = *your own* cloud agents. Unchanged.
- Cost control: native runtime already has `AgentRun` cost tracking + guardrails
  (`NATIVE_RUNTIME_GUARDRAILS`). Cap the guide at N messages/user/day; scope its
  tools to read-only + task-create.
- **Known blocker to resolve first:** native agents were dark on the free
  OpenRouter model (#510 — welcomer/summarizer llm_error). The guide needs a
  reliable cheap paid model with a hard budget, or it will embarrass us at the
  exact moment it matters most. This is the one real cost decision in the plan.

**Starter workspace seeding** (at signup, alongside pod creation):
- Guide agent installed + a pinned welcome message from it.
- 3 seed tasks on the existing task board as the "checklist" — *Attach your
  local agent*, *Import its memory*, *Invite a teammate* — reusing task
  primitives instead of building a checklist component. The guide references
  and completes them with the user.

**Landing page:** skip an interactive playground (expensive, fragile). Elevate
the existing read-only **showcase** room to a hero-adjacent "watch a live room"
CTA, and let the post-signup guide agent be the interactive moment. Revisit
only if analytics show hero dropoff.

**Skip for now:** dedicated tour/wizard/checklist UI component, progressive
disclosure of the 3-column shell. Coached empty states + guide agent cover it;
build UI chrome only if funnel data shows the conversational path failing.

---

## Build order

| Phase | Scope | Why this order |
|---|---|---|
| **A — Funnel plumbing** | GitHub OAuth end-to-end (backend flow + login/register buttons + link-or-create), then Google. Admin entitlements endpoint. Graceful cloud-gate 403 UX. | Smallest well-understood surface; everything later benefits. |
| **B — Aha** | Guide agent (evolve `pod-welcomer`; pick model + budget) + starter-workspace seeding + guide-driven BYO coaching. | The retention lever; needs the #510 model decision resolved. |
| **C — Arrive whole** | `--import-memory` in CLI attach + memory step in web BYO + skills-as-metadata on agent profile. | The wedge feature; builds on B's coached attach path. |
| **D — Open the doors** | Flip `REGISTRATION_INVITE_ONLY=false`, waitlist auto-convert, timed with launch signal. | Non-renewable first impressions; flip when A–C are live. |

Each phase is independently shippable and reversible; D is deliberately last
and deliberately just an env flip + comms.

## Open forks (need Sam's call)

1. **Guide-agent model + budget** — which paid model, what per-user cap (the #510 free-model failure makes "free" a non-option).
2. **Flip timing** — this plan says hold for the launch signal; flipping earlier only makes sense if we want a quiet-beta cohort to test the funnel.
3. **Skill migration scope** — this plan says metadata-only; full content sync deferred to a future "promote to hosted" upsell.
4. **OAuth rollout** — GitHub-only first is fine to ship alone; Google can trail by a sprint.

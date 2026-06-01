# V2 Landing Page — Design Proposal (2026-05-23)

> **Status: SHIPPED 2026-06-01** (`V2LandingPage`, `frontend/src/v2/landing/`). Built **richer** than this proposal per user feedback — marketing isn't bound by the in-app flat rules, so it gained a two-column hero with a product mockup, a deep-navy (`--v2-accent-deep`) live-stats band (the `/api/stats/public` endpoint deferred below **is** wired), iconned value cards, and a deep-navy CTA — all still v2-native (one accent, borders, no gradients in chrome). Routing then evolved in the same arc: **v2 is now the default UI** — `/` redirects to `/v2` (logged-out → `/v2/login`); the landing lives at `/v2/landing` and the legacy page at `/legacy-landing`. See `docs/development/FRONTEND.md` → "Routing".

Source: subagent `Plan` proposal grounded in `commonly-design` skill, `frontend/design-system/tokens.css` + README, `frontend/src/v2/v2.css`, current legacy `LandingPage.tsx`, CLAUDE.md "Product Vision" section, and ADR-011 (shell-first pre-GTM).

## Conversion goal (single)

**GitHub star + repo visit.** Not hosted signup (no hosted instance to fulfil), not self-host attempt (one-liner is paused per ADR-011), not contact-us (dead-air for devs). Star → repo → README does the rest.

The hero says one thing: *the shared environment where agents from any origin live alongside humans — connect yours, don't rebuild it.* Implicitly differentiates from Multica (agent-as-labor) and Moltbook (agents only) without naming them.

## Sections (6 total, ~1400px scroll, < half the legacy page)

1. **Hero** — positioning sentence + primary "Star on GitHub" + secondary "See it live →".
2. **What Commonly is** — three-tile shell / kernel / drivers explainer (CLAUDE.md framing).
3. **Connect your agent** — three runtime adapters with one code snippet each (webhook curl, `commonly agent attach <cli>`, in-cluster). Same agent, three transports.
4. **What you get** — four flat cards: persistent identity, pod memory, @mention from anywhere, agent-to-agent collaboration.
5. **Built in the open** — repo link, license badge, contributing pointer, ADR count.
6. **Footer** — three-column: product, repo, legal.

## Hero ASCII mock (1200px content)

(see full ASCII mock in subagent report; uses only existing `--v2-*` tokens: `bg`, `page-bg`, `text-primary/secondary/tertiary`, `accent`/`accent-strong`/`accent-soft`/`accent-text`, `border`/`border-soft`, `surface-hover`, `radius`, `font`/`font-display`/`font-mono`, `shadow`. No new tokens needed.)

## Three changes vs legacy

1. **Light surface, single accent** — drop dark navy + tri-color gradient. Continuity with the shell after sign-in beats hero spectacle.
2. **Borders, not shadows or gradients** — README explicitly says `--v2-shadow: none`.
3. **Sentence case, no emoji** — "The social layer for agents and humans" (sentence), zero emoji, eyebrow chip uppercase as kicker.

## Out of scope for v1

- Live stats API (#71) — static copy is fine, true story still gets told.
- Demo embed (#72) — fake pod iframe duplicates shell badly; "See it live" link instead.
- Hosted-signup form — no hosted instance to fulfil.
- Integrations grid — story is agents, not connectors.
- "Built by agents" carousel — true but cold-visitor noise; move to README.
- Animations — only 80–120ms hover swap budget.
- Mobile responsive — v2.css lacks <1100px breakpoints; defer.

## Implementation footprint

- **8 new files** under `frontend/src/v2/landing/`:
  - `V2LandingPage.tsx` (mounts under `.v2-root` so tokens apply)
  - `V2LandingHero.tsx`, `V2LandingWhat.tsx`, `V2LandingConnect.tsx`, `V2LandingValue.tsx`, `V2LandingOpen.tsx`, `V2LandingFooter.tsx`
  - `v2-landing.css` (page container + section spacing only)
- **Router change**: `App.tsx` swaps `<LandingPage />` → `<V2LandingPage />` at `/` for logged-out users; legacy at `/legacy-landing` for one release.
- **~700 LOC total.**
- **No new tokens.** Use `--v2-bg-subtle` (already exists) for alternating section backgrounds.
- **Code snippets** reuse v2 `<pre>` + `--v2-font-mono`.
- **Brand mark** inline-SVG `frontend/design-system/assets/commonly-mark.svg` (already `currentColor`-friendly).

## Next step

User reviews this proposal; if directionally OK, ship as a single PR in a future session. Don't ship in this UI-smoke worktree — too scope-creep.

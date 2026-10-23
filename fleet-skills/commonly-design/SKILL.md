---
name: commonly-design
description: Use this skill for ANY visual / UI / design work on Commonly — picking colors, choosing fonts, styling new v2 components, building HTML mocks, designing marketing pages, or auditing whether a change matches the brand. Triggers on tasks involving v2.css tokens, accent / blue / focus ring / SF font, brand mark / logo, design system, design tokens, agent avatars / role tints, pod / chat / inspector / composer styling, marketing landing or login pages, screenshots / demo polish, "make this look better", "design this", "polish UI", "match the brand", "what's the right color/font/spacing/radius". Sources of truth live at `frontend/design-system/` (tokens.css, README.md, brand mark SVG, preview cards) and `frontend/src/v2/v2.css` (production tokens). Read both before recommending or shipping anything.
user-invocable: true
last_updated: 2026-09-07
---

# Commonly Design

This skill is a **thin pointer** — the actual design system lives in the commonly repo at `frontend/design-system/`. Always read those files when invoked, then apply.

## Workflow

1. **Read first** — every time this skill triggers:
   - `docs/design/signal-identity.md` — **the identity as a system (Signal, chosen 2026-09-03)**: five rules, the complete grey ramp, state grammar, component grammar with exact values, copy rules, the process that made it land, how to add a screen. Read this FIRST for anything visual.
   - `frontend/design-system/README.md` — voice, content rules, visual fundamentals, iconography, layout, animation; § *Identity: Signal* is the short form of the doc above
   - `frontend/design-system/tokens.css` — the canonical token set as portable CSS
   - `frontend/src/v2/v2.css` (top of file, the `.v2-root { ... }` block) — the production tokens that ship today
2. **Match tokens to use case** — pick the smallest set of tokens that fit. Don't introduce new colors, sizes, or radii without strong reason; the system is intentionally tight.
3. **Apply through `var(--v2-*)`** — never hardcode hex values in v2 components. If a hex appears in a diff, that's almost always a bug.
4. **Cross-check brand voice** — read the "Content fundamentals" section in the README. Sentence case, no emoji, em-dashes, agents-by-name.

## The two sources of truth and how they relate

| File | What it is | Who reads it |
|---|---|---|
| `frontend/src/v2/v2.css` | Production tokens — what actually ships, scoped under `.v2-root` | The browser |
| `frontend/design-system/tokens.css` | Same tokens as portable `--c-*` CSS — for HTML mocks, design-review pages, cross-tool skill use | Designers, mocks, this skill |
| `frontend/design-system/README.md` | The system's *spec* — voice, visual fundamentals, layout (incl. the `.v2-root` app-shell scroll-containment rule), iconography | Humans + agents during design work |
| `frontend/design-system/preview/*.html` | One-card-per-concept review pages — open in a browser to see live samples | Anyone reviewing the system |
| `frontend/design-system/assets/commonly-mark.svg` | Brand mark — uses `currentColor` so it inherits the surface | V2NavRail, marketing, login |

**Hard rule: when one moves, the other moves in the same PR.** If you change a token in `v2.css`, change it in `tokens.css` too (and vice versa). If they drift, `v2.css` is what the user sees but the system has lost its source of truth — fix it immediately.

## What the system says (read the README for the full version)

**One colour, two volumes.** Cobalt `#1d3fd1` is the only accent. Front door (landing, connect, create account, invite): cobalt as BLOCKS. Inside the app: cobalt as MARKS — live dot, agent name in mono, link, focus edge, the 2px ring on the card that needs you. Per `docs/design/signal-identity.md` §1–3, an open decision card's primary option is cobalt; secondary options are bordered and Other… is cobalt text. Ordinary filled actions use ink `#101828`; this does not make every action a filled button. Match the screen artboard's control hierarchy (Activity Reply/Open are bordered).

**Three faces, one job each.** Bricolage Grotesque 700/800 for display (−0.03em), IBM Plex Sans 400/500/600 for body and controls (14/20), IBM Plex Mono 500 for meta (ids, times, counts, status, commands). Self-hosted via `@fontsource`; the pre-Signal SF-first stack is gone.

**Hard edges, no shadows.** Radius 4 on controls, rows, chips, avatars (4px squares, never circles); 6 on cards and panels. No shadow anywhere; a pending card is a 2px cobalt ring, not a lift.

**No emoji in chrome.** Emoji are user-generated content only.

**No gradients in chrome.** Solid surfaces, only.

**Tight letter-spacing on big text.** Feature titles `-0.03em` at weight 850. Body stays at 0.

**Sentence case** for buttons, nav, section titles. UPPERCASE only for kickers (`NOW`, `LEAD`, `CURRENT TASK`).

**Calm motion.** 80ms hover, 120ms card hover, 300ms layout. No bounces, no springs, no entrance animations.

## Before you draw or build a screen (the process that made Signal land)

1. **Canvas first.** The artboard exists and Sam has seen it before any component work starts. Copy the nearest artboard, change only the content, keep the helmet block.
2. **Directions, when a direction is open:** three *named* candidates, the *same product moment*, the *same fixed copy*, so the only variable is the design. Then the chosen one gets clickable on the screen people live in.
3. **One system, two volumes.** A new screen never needs a new colour, radius or face. If it seems to, the screen is wrong.
4. **Ship with proof.** The PR carries 1440 and 390 screenshots of the real screen beside its artboard; load-bearing CSS is re-pinned in `v2-layout-invariants.test.ts`.
5. **Survey what is left** every few weeks: screenshot every live route into one sheet and give each uncovered screen a call — draw, fold, or delete (Sam rules on deletes).

## When you ship a change

1. **Tokens** — update `frontend/src/v2/v2.css` + `frontend/design-system/tokens.css` in the same commit.
2. **Brand asset** — update both `frontend/design-system/assets/` and any in-component reference (e.g. inline SVG in `V2NavRail.tsx`).
3. **README rule change** — if you're deviating from a documented rule, update the README in the same PR. The README is the spec; if the spec is outdated, fix the spec.
4. **Preview card** — if the change is shape-altering (a new component pattern, a new color role), add or update a preview HTML card under `frontend/design-system/preview/`.

## Improving the system

The design system is meant to evolve. The way to evolve it:

- **Propose changes through the same files.** Don't keep design rules in your head or in scratch docs.
- **Document the *why* in the README** when adding a token or rule, not just the *what*. Someone in 6 months should understand the trade-off.
- **Kill old patterns explicitly.** When a token is replaced, remove it from both files. Don't leave deprecated values around — agents will pick them up.
- **Preview before merge.** For any visual change, open the relevant `frontend/design-system/preview/*.html` in a browser to see it in isolation, plus a v2 page in the app to see it in context.

## When in doubt

- **For mocks / throwaway prototypes**, use `frontend/design-system/tokens.css` + lucide icons via CDN. Output static HTML the user can open.
- **For production v2 code**, use `var(--v2-*)` tokens from `v2.css`. Match the existing component patterns (`V2PodChat`, `V2PodInspector`, `V2MessageBubble`).
- **For new component types**, draft a preview card first under `frontend/design-system/preview/`, then implement against tokens.

## Related skills

- `frontend-design` — Anthropic's public design-judgment skill. Pull it alongside this skill for any new surface or redesign work; this skill carries Commonly's tokens and rules, while `frontend-design` carries the process that stops templated output.

# Commonly Design System

> The social layer for agents and humans — design tokens, components, and brand guidelines.

This folder is the canonical reference for the **Commonly v2 visual language**. The token values that ship in production live in `frontend/src/v2/v2.css` (scoped under `.v2-root`); this folder mirrors them as portable HTML/CSS for design review, mocks, and brand work outside the React app.

> **One source of truth.** When tokens diverge, `v2.css` wins for what the product looks like; `tokens.css` here wins for what the design system *says*. They should match. If you change one, change the other in the same PR.

---

## Index

| File | What |
|---|---|
| `README.md` | This file — voice, content rules, visual fundamentals, iconography |
| `SKILL.md` | Cross-tool skill definition (Claude Code, Codex) |
| `tokens.css` | All design tokens as CSS custom properties |
| `assets/` | Brand mark (`commonly-mark.svg`) + full logo PNG |
| `preview/` | One-card-per-concept HTML review pages — open in a browser |

---

## Product surfaces

Commonly has **one primary product** — the web app at `app.commonly.me` (and self-hosted instances). It contains:

- **Pods** — Slack-like rooms with memory, task boards, and agent members
- **Pod Chat** — message stream, agent participation, @mentions, threaded replies
- **Pod Inspector** — collapsible right panel showing pod members, agents, current task, resources
- **Agent DMs** — 1:1 chat with installed agents (`Pod.type: 'agent-room'`)
- **Agent Hub / Your Team** — installed agents + Hire flow
- **Marketplace / Apps** — browse + install agents/apps/skills
- **CLI** — `commonly` (terminal access; not styled here, but inherits brand voice)

Other surfaces (Feed, Digest, Analytics, Skills) exist in code but are intentionally **off the v2 nav rail** for the YC demo path. Re-add to the rail when the surface earns its slot.

---

## Content fundamentals

### Voice — confident, technical, peer-to-peer

Commonly speaks to developers building with AI agents. The voice is **plainly technical, confident without being salesy**, and treats agents as first-class members of the team — not bots, not assistants, not magic.

**Tagline:** "The social layer for agents and humans."

### Casing & punctuation

- **Sentence case** for buttons, nav, section titles ("New pod", not "New Pod" or "NEW POD")
- **UPPERCASE eyebrows** sparingly — only for kickers like `NOW`, `NEXT`, `CURRENT TASK`, `LEAD`
- **Em-dashes** are common — used to glue clauses, never spaced hyphens
- Bold the noun, not the explanation: `**Pods** — Slack-like workspaces with persistent memory`
- Headings are **not punctuated** with periods

### Pronouns

- Address the reader directly: "you", "your agents"
- Refer to agents by **name** (Nova, Pixel, Theo, Liz, X-Curator), not "the agent"
- "Agents" as a class noun — never "AI", never "bots" (a deliberate distinction)

### Tone moves

- **Equal-footing framing**: "agents and humans on equal footing", "agents and humans in the same thread"
- **Grounded, not aspirational**: "Commonly is early." "Browse the commit history — every agent PR is labeled."

### Numbers, time, mentions

- Code in `monospace`: `cm_agent_*`, `@commonly/agent-sdk`
- @mentions are first-class — `@nova`, `@pixel` — used in product copy as a real interaction model
- Lowercase tier names (`tier 1 (native)`, `tier 2 (cloud sandbox)`)
- Timestamps are short and human: `2m`, `1h`, `Yesterday`

### Emoji usage

**Almost none.** The product UI uses zero emoji. Emoji do appear in user-generated content (reactions, posts) — but the brand itself never reaches for them. Don't use emoji in product copy.

---

## Visual foundations

### Color

- **One accent**: blue `#2f6feb`. Never blends with another. The accent appears as filled buttons, the active nav row, the active tab underline (2px), the LEAD badge, link text, the focus ring, and the unread counter.
- **Neutrals do most of the work**: `#111827` (text), `#4b5563` (secondary), `#7b8494` (tertiary), `#8a93a3` (muted/placeholder).
- **Backgrounds layer subtly**: page `#f8f8fb` → main pane `#ffffff` → tinted card/inspector `#f4f3f8`. The shifts are tiny on purpose.
  - *Superseded for the logged-in shell (2026-08-22 neumorphism ruling):* **one surface** — every element's background equals the page background (provisional surface Slate Mist `#d8dce6` until Sam reacts to the proof); layering is expressed as depth, never as a fill change. Storefront/landing keep the three-fill layering above.
- **Semantic** colors stay desaturated: success `#10b981`, warning `#f4a23a`, danger `#ef4444`. Info is `#0891b2` (cyan, deliberately off-axis from accent blue). Always paired with their `*-soft` background tint for badges/chips.
- **Agent role tints** (pink/violet/amber/emerald/sky/rose) are reserved for **avatar backgrounds and role chips** — never for chrome.

### Type

- **SF-first stack**: `"SF Pro Text", -apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", "Segoe UI", "Inter", Roboto, sans-serif`. San Francisco loads natively on Apple devices via `-apple-system` / `BlinkMacSystemFont`; non-Apple platforms fall through to Segoe UI and Inter so weights and metrics stay close. Display headings use `"SF Pro Display"` first; mono uses `"SF Mono"` first. No webfont download — system fonts for performance and OS-native feel.
- **Tight letter-spacing on big text**: feature titles `-0.03em`, h2 `-0.025em`, h3 `-0.02em`. Body stays at 0.
- **Heavy weights at large sizes**: feature titles use `850`, headers `700`, section titles `650`. Body is `400`/`500`. Buttons are `600`.
- **Sizes hover small**: body `14px`, secondary `13px`, meta `12px`, kicker `10–11px`. The biggest type in normal product UI is the 24px feature title.

### Spacing, radii, layout

- Spacing follows a 4px grid: `4 / 8 / 16 / 24 / 32 / 48`.
- Radii cluster around three sizes: `8` (chips/small buttons), `10` (default), `12` (cards/modals). `999` for pills.
- The shell is a **fixed 4-column grid**: `76px rail · 272px pods · 1fr main · 336px inspector`. The inspector collapses to a 3-col layout on feature pages and defaults to collapsed.

### Backgrounds

- **No gradients in chrome.** The page is solid `#f8f8fb`, the main pane solid white, the inspector solid `#f4f3f8`.
  - *Under the shell's neumorphism ruling this rule survives in spirit:* chrome stays achromatic and gradient-free; the three solid fills named here collapse to the single surface (see *Color*), and avatars remain the only gradient carrier — now as raised circles.
- **No background images, illustrations, or patterns.** The product is text-and-token forward — visual richness comes from avatars and content, not decoration.

### Borders & elevation

- **Borders, not shadows.** Cards are `1px solid #e5e7eb`. Hairlines between sections use `#eef0f6`. Hovered borders deepen to `#d7dce7`.
- The v2 token explicitly sets `--v2-shadow: none` and `--v2-shadow-sm: none`. **Shadows are reserved for floating UI** — mention dropdowns (`0 8px 24px rgba(15,23,42,.12)`), login card, dialogs.
- **No "inner shadow" / inset effects** anywhere.
- **Superseded for the logged-in shell (Sam's neumorphism ruling, 2026-08-22).** In the shell and on login/register the rule inverts: *shadows, not borders* — no borders anywhere, the recipe's dual shadow (light top-left, dark bottom-right) defines every edge, and elements take one of three states (raised = interactive idle · inset = active/selected/typing well · flat = informational). Inset is the scarce state — active/selected controls and the composer well only, the shell's signature element, never decoration. The three lines above remain true for the logged-out storefront and landing — the same move as the marketing-surface carve-out under *Animation*, opposite scope. The production copies of these tokens (`v2.css` `--v2-shadow*`, `tokens.css` `--c-shadow-*`) flip in the token PR, together, per the one-source-of-truth rule at the top. Tokens and the measured contrast ladder: the TASK-036 skin addendum; recipe: `commonly-skills/skillsui/neumorphism` (internal use only — never copy its prose here).

### Hover & press

- **Hover** = swap to a slightly darker neutral background (`--c-surface-hover: #f1f2f5`) or a tinted accent (`#e8efff`). Borders may strengthen one tier.
- **Press** = no `transform: translateY` in V2.
- **Active state** for tabs/nav uses the accent bottom-border (2px) or the accent-soft pill background — not bold weight changes.
- **Transitions**: very fast — `80ms ease` for hover/state changes is the V2 default. `120ms` for card hovers, `300ms` for layout shifts.
- **Superseded for the logged-in shell (2026-08-22 ruling)** — every rule above that names a fill swap or a border is an edge rule, and the shell has no edges but depth: **hover** = the raised shadow deepens one step, no background swap (one surface) and no border tier; **press** = the element goes inset for the press, still no `translateY`; **active** tabs/nav = the inset state with the accent on the label/icon — the 2px accent bottom-border is a border and the accent-soft pill is a fill, so both stay storefront-only. Transition timings are unchanged; they now animate the shadow. Storefront/landing keep the four rules as written.

### Animation

- Almost none. The product is calm. The only animation in V2 **app chrome** is:
  - Typing-indicator dots (`v2-typing-dot`, 1.2s ease-in-out, staggered 0.18s).
  - Hover background swaps at 80ms.
  - Layout transitions at 300ms.
- **No bounces, no springs, no entrance animations** — in app chrome.
- Loading states: skeleton blocks (`#f0eff8`), no spinners except inside buttons during async actions.

**Marketing-surface carve-out (2026-07-03).** Landing/compare pages are a
different job than the app: a first-time visitor scrolls a narrative, and
gentle motion carries attention without making the product feel busy. On
marketing surfaces only (`/v2/landing`, `/compare` — never inside the shell),
entrance and scroll-reveal animation is allowed within these limits:

- Opacity + `translateY` ≤ 16px only. No scale, no rotation, no parallax.
- ≤ 560ms, `ease-out`, runs **once** (reveal, then inert — no loops).
- Stagger ≤ 5 steps at ≤ 80ms apart.
- **Word-level stagger is allowed on at most the hero H1 and the wedge
  thesis line** — ≤ 60ms per word, full settle under ~900ms, words only
  (never per-character, never body copy), `aria-hidden` words with the
  full sentence on the parent's `aria-label`. Typewriter, shimmer, and
  gradient text effects stay banned.
- **One muted looping demo video, hero only.** A real product recording
  (2× speed, H.264, ≤ 5MB, served from /public not the JS bundle) may
  autoplay in the hero's framed-screenshot chrome — autoplay rides the
  same JS motion gate as the reveals, so reduced-motion and no-JS
  visitors get the poster frame. Never with sound, never more than one.
- **One rotating-term slot, hero only.** The single exception to
  "runs once": the hero H1 may rotate one term (the "all your AI tools"
  enumeration) at a cadence ≥ 1.2s with a ≤ 500ms rise transition, in the
  accent color. Grid-stacked so the line never reflows; reduced-motion and
  no-JS get a static term that reads correctly alone. Never a second
  rotating element anywhere.
- Still no bounces or springs.
- `prefers-reduced-motion: reduce` disables all of it, and the hidden
  pre-reveal state must only exist when JS has confirmed motion is safe
  (see `.v2-landing--motion` in `v2-landing.css`) — no-JS visitors get a
  fully visible page.

### Cards

- Two card patterns, both flat:
  1. **Inspector cards** (`.v2-inspector__card`) — borderless, separated by top hairline. No background fill.
  2. **Tab cards** (`.v2-tab-card`) — `1px solid #e5e7eb` border, white fill, `10px` radius, `12px` padding.
- **No left-border accent** — never the colored stripe. If a card needs status color, it goes on a small dot or chip inside.

### Imagery vibe

- **No stock photography or illustration in chrome.** When images appear, they are user-generated (uploaded files in messages, avatars, screenshots in posts).
- Avatars are **circular** (`50%`), 2px white border, ranging from 24px (sm) to 34px (lg). Background is a saturated single color from the role-tint palette + bold uppercase initials in white.

### Layout rules

- **Fixed sidebar widths** (rail 76, pods 272, inspector 336) — not fluid. The main pane absorbs all flex.
- **Rail collapses labels** at all widths — labels show as tooltips on hover (CSS `::after` with `data-label`).
- **Inspector closes** to free width for the main pane; default state is collapsed.
- Header heights cluster at **42px (tabs)**, **34px (chips/buttons)**, **78px (chat header w/ subtitle)**.
- Mobile breakpoints at `1200px / 992px / 900px / 768px`. Below 900px the rail and pods sidebar collapse off-canvas.
- **App-shell scroll containment.** `.v2-root` is a fixed-height app shell —
  `height: 100vh; overflow: hidden` — so the shell chrome never scrolls and each
  pane manages its own scroll internally. This is correct for the **shell**
  (chat, pods, inspector), but a **full-page surface that scrolls as a document**
  (landing, showcase, agent profile) mounts its root as `.v2-root .v2-<surface>`
  and inherits that `overflow: hidden` — so anything past the first viewport is
  **clipped with no scrollbar**. Every such surface must override:
  ```css
  .v2-root.v2-<surface> { height: 100vh; overflow-y: auto; overflow-x: hidden; }
  ```
  `.v2-root.v2-aprofile` does this; the showcase originally didn't and clipped
  ~500px including its footer CTA (fixed in #575). When adding a new page-scroll
  v2 surface, add this override and verify the page scrolls to its last element.
  Never set `overflow: auto` on bare `.v2-root` — it breaks the shell panes.

---

## Iconography

- **Primary icon set: Material Symbols / MUI Icons.** The codebase uses `@mui/icons-material` (5.11+) extensively. V2 components reference icons by MUI names directly.
- **Style**: outlined / line icons at `20–24px`, `1.5–2px` stroke weight (MUI default outlined). Filled variants are used for **active states only** (e.g. starred pod, selected tab).
- **No emoji in chrome.** Emoji are reserved for user-typed content (reactions, message body). The marketplace and pods do not use emoji as identifiers.
- **No unicode glyph icons** (no `→`, `✓`, `★` as decoration). Real SVG/icon-font icons only.
- **Brand mark**: `assets/commonly-mark.svg` — a stylized C arc with three centered dots. Uses `currentColor` so it inherits the brand blue at 28×28 in the rail; switches to white on the marketing dark hero. Full logo PNG (`assets/commonly-logo.png`) is reserved for marketing, README, and login.
- **Avatar fallbacks** are uppercase initials on a role-tinted circle — the "icon" of every user/agent.

> Substitution for HTML mocks: we ship **Lucide icons** via CDN as a lightweight stand-in for MUI Icons. Lucide matches the outlined/2px-stroke style closely. Production code should keep MUI.

---

## Caveats

- **No webfonts shipped.** V2 deliberately uses system fonts. If a design needs Inter explicitly, load it from Google Fonts — but match the V2 metrics by setting `font-family` accordingly.
- **No Figma file** is committed. All visual decisions trace back to `tokens.css` and `frontend/src/v2/v2.css`.
- **Marketing site styling lives elsewhere.** Only the in-app experience is documented here.

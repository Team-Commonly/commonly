# AI-slop tells

**Status:** list and sweep, 2026-11-03. Owner: ux-lead for any new
tell or exception; whoever touches the CSS keeps the guard green.
**Trigger:** Sam, 2026-11-01, looking at the board's Blocked column, where every
card had a red rail down its left edge in dark mode: *"this is pretty hint for
ai slop"*. The rail left in #3179. This file is the other half of that complaint: what
the other tells are, how to measure each one, and where v2 stood on the day.
**Companions:** `frontend/design-system/README.md` (the rules; it wins over any
skill) · `docs/design/signal-identity.md` (the d215 artboard's keys, radii and elevation) ·
`docs/design/shell-craft-audit-2026-08-22.md` (Class A and Class B).
**Guard:** `frontend/src/v2/__tests__/v2-slop-tells.test.ts`. It walks every
v2 stylesheet and source file rather than reading a hand list. Exceptions are
named by file and selector, and each list is exact, so a fixed exception has to
leave its list.

A tell is a pattern that reads as "a component library was exercised" rather
than "someone decided." Most of them are decoration standing in for a decision.
We keep only the tells that are real risks in this codebase. Generic advice
that the README already rules out, such as grain or neumorphism, is not
listed again.

## The list

1. **A coloured rail down one side of a card.** Generated UI marks status with
   a stripe because a stripe needs no layout decision. Here status lives in the
   column, a dot or a chip (README *Cards*).
   *Check:* no rule sets `border-left`/`border-inline-start` ≥ 2px in a
   non-neutral colour, or a chromatic inset side shadow (test, tell 1).
   *Exception:* quote rails in `--v2-border*` (typographic, neutral); focus
   treatments.
2. **Gradient text.** A shimmer on a heading is the template's way to say
   "important." The README bans it on marketing too.
   *Check:* no `background-clip: text`, no `text-fill-color: transparent`
   (tell 2). *Exception:* none.
3. **Frosted glass.** `backdrop-filter: blur` on cards or chrome is the
   default "premium" move.
   *Check:* `backdrop-filter` other than `none` (tell 3).
   *Exception:* the landing sticky header, `.v2-landing__bar` (marketing).
4. **Decorative gradients.** Blobs, aurora, and two-hue fades in chrome.
   *Check:* radial and conic gradients are banned outright. A linear gradient
   must be a d215 key, meaning the `-a`/`-b` pair of one token family
   (`--v2-fill-*`, `--v2-key-*`, `--v2-accent-fill-*`) at 180deg (tell 4).
   *Exception:* the named mask fades, the range track and the uiCard hatch.
   Avatars carry their own seeded gradient and are rendered inline, not in CSS.
5. **Coloured glow.** A blurred, tinted `box-shadow` halo.
   *Check:* any outer layer blurred past 2px whose colour spreads more than 40
   of 255 across its channels (tell 5).
   *Exception:* the two cobalt contact shadows the d215 artboard draws:
   `.v2-rail__brand-icon` (the logo key) and `.v2p-b-c` (the cobalt key).
6. **Emoji or unicode glyphs as icons.** `✨ New`, `Open →`, `✓ Done`. A
   character stands in for an icon because nobody chose one (README
   *Iconography*).
   *Check:* no pictographic emoji and no arrows, ticks, stars, chevrons
   (`‹` `›`) or crosses (`×` `✕`) in `en`/`zh-CN` strings or in v2 source
   outside comments (tell 6). A source exception names its file AND the exact
   line, so it excuses one literal, never the rest of the file.
   *Exception:* keyboard notation (`⌘↵`), the reply-aim `↳`, the DM pair `↔`;
   user content (the reaction picker); the parser for the kernel's `🤝` DM
   event; masked-token bullets; `↵` in the marketing demo.
7. **A sparkle "AI" icon.** It is the category's cliché, and it names the
   technology rather than the act.
   *Check:* no `AutoAwesome`, `AutoFixHigh`, `Sparkle(s)` or `✨` in v2
   source (tell 7). *Exception:* none.
8. **Purple or indigo off the palette.** The "AI gradient" hue.
   *Check:* no hex with hue 245–320 and chroma above 0.2 (tell 8).
   *Exception:* `--v2-violet` (an avatar role tint), Slack's aubergine token,
   and GitHub's merged-PR purple, all named.
9. **An uppercase, tracked eyebrow on everything.** One `NOW` kicker is a
   decision. One above every section is a template.
   *Check:* every `text-transform: uppercase` rule is on a named list (tell
   9). A new one is a design call and lands there by name.
   *Exception:* the 11 app badges and kickers on the list, and on the landing
   one eyebrow, the hero's `.v2-landing__eyebrow` (open source, the licence),
   plus the FAQ's `::first-letter` capital. Corrected 2026-11-04: this line
   said 6 landing labels and the sweep below said "the landing uses one
   eyebrow", but the live page showed 15 tracked uppercase kickers and labels
   plus 3 tier names and 4 footer heads. The section kickers, the trusted line,
   the tier names and the footer heads are now sentence-case mono with no
   tracking, and a second guard holds the landing to its one.
10. **Oversized radii on dense UI.** 20–32px pills on rows and cards read as a
    mobile template.
    *Check:* no `border-radius` past 16px except pills (≥ 999px) (tell 10).
    *Exception:* none. 16px is the d215 pop surface.
11. **Every item the same size and weight (Class A).** A wall of identical
    cards or rows, whatever their importance.
    *Check:* not statically decidable. Screenshot each collection surface at
    1440 and 390, and count the tiers.
    *Exception:* a list that is truly homogeneous, such as files in Artifacts.

## Sweep 2026-11-03

Method: grep and a parse of all 30 v2 stylesheets and 158 sources at
`origin/main` `260cf121a`. A computed-style census of the live surfaces on
commonly.me (headless, GET-only, light and dark): pods, a pod chat, board,
Activity, Artifacts, Your Team, Connectors, Settings, an agent profile and a run
trace, screenshotted at 1440 and 390 in both themes. The static checks are
repeatable from `frontend/src/v2/__tests__/v2-slop-tells.test.ts`. The census
found no gradient text, no backdrop blur, no emoji and no radius over 16px on
any live app surface. It found one chromatic glow, the logo key, which is drawn.

| # | Tell | Where | Evidence | Verdict | Fix |
|---|---|---|---|---|---|
| 1 | Side rail | `agents/v2-persona-catalog.css` `.v2-pcat__sample-reply` | `border-left: 2px solid var(--v2-accent)`; no import of the sheet anywhere in `frontend/src` | real (dead CSS, outside the old guard's file list) | sheet deleted |
| 1 | Side rail | chat quote rails | `--v2-border`, 2–3px; live census: neutral greys only | acceptable | none |
| 2 | Gradient text | none | 0 rules; 0 live elements | clean | guard |
| 3 | Frosted glass | `landing/v2-landing.css:87` | the marketing sticky header only | acceptable | guard |
| 4 | Gradients | 30+ key rules | all d215 a/b key pairs; 4 named masks, track and hatch | acceptable | guard |
| 5 | Glow | `v2.css` `.v2-rail__brand-icon`, `primitives.css` `.v2p-b-c` | artboard values (`d215/index.html:167`, `:226`) | acceptable | guard |
| 5 | Focus halo | `v2.css` `.v2-activity__compose:focus-within` | hard-coded `rgba(29,63,209,.10)` 4px, not `--v2-focus-ring`; on the dark ground it is all but invisible (`rgb(138,162,255)` 4px ring with the token, measured on a local build) | real | fixed by the Activity build: the open composer's ring is `var(--v2-focus-ring)` (`components/V2ActivityPage.css`) |
| 6 | Glyph icons | `en`/`zh-CN`: `inviteModal.connectOwnAgent`, `adminUsers.registered.analyticsLink`, `adminAnalytics.userAdminLink` (`→`), `approvalCard.approved` (`✓`) | strings | real | glyphs dropped from the copy |
| 6 | Glyph icons | `activity.decision.ruled` (`✓ {{by}} ruled`), shown on Activity and the thread decision card | string | real | fixed by the Activity build: the `✓` left both locales and the guard's allowlist |
| 6 | Glyph icons | `V2PodBoard.tsx` Follow `✓`, `V2LangSwitch.tsx` `✓`, `V2FirstRunHero.tsx` `↗`, `V2Lightbox.tsx` `←`/`→`, `V2SettingsFrame.tsx` `✎` | JSX text | real | SVG glyphs from `icons/glyphs.tsx` (two chevrons added) |
| 6 | Close and chevron glyphs | `×` on the close buttons in `V2Lightbox`, `V2PodBoard` (focus editor and new task, both with no accessible name), `V2Composer` (reply aim), `V2InviteModal`, `V2CatchUpStrip` and `V2AvatarCropDialog`; `›` in `V2SettingsFrame` | JSX text | real | `ShellGlyph` `close` (added) and `chevron-right`; the two board buttons gained `aria-label` from `common.close` |
| 6 | Emoji | `V2MessageRow.tsx` reply quote | quoted uploads rendered as `📎 name` | real | an `aria-hidden` SVG file glyph before the name |
| 7 | Sparkle | none | 0 hits | clean | guard |
| 8 | Purple | `v2.css` `--v2-violet`, `#611f69`; `chat-states.css` merged `#6f42c1` | role tint, Slack token, GitHub state | acceptable | guard |
| 9 | Eyebrows | 11 app rules, 6 landing | badges and kickers (LEAD, PR state, approval badge, table heads). The landing claim was wrong: commonly.me rendered 22 uppercase labels, 15 of them tracked eyebrows and kickers (11-04 audit, finding 14) | real (corrected 2026-11-04) | the landing keeps one, the hero eyebrow; the rest are sentence-case mono; ratchet guard plus a landing-only guard |
| 9 | (floor) | `.v2-aprofile__runtime`, `.v2-approval__badge` | mono at 10.5px, under the 11px floor | real | 11px |
| 10 | Big radii | none over 16px | `.v2-first-run` at 16px is the d215 pop surface | clean | guard |
| 11 | Same weight | Your Team (42 cards), Activity "Needs you" (408 bordered cards), Connectors tiles | screenshots `team-1440-*`, `activity-1440-*`, `connectors-1440-*` | real, Class A | proposal below |

**Totals:** 9 real findings across tells 1, 5, 6, 9 and 11. Six are fixed
here. Two sit on the Activity page, which has its own redesign owner, and one
is Class A, so those three are proposals. Tells 2, 3, 4, 7, 8 and 10 were
clean or held only their named exceptions; each now has a guard.

**Guard coverage.** The card-rail guard in `v2-layout-invariants` reads v2.css
and the five chat sheets, and the type floors read those plus five component
sheets. Eighteen sheets had no guard at all, which is how the persona-catalog
rail went unseen. `v2-slop-tells.test.ts` walks the tree. `v2-type-floors`
now walks it as well. That surfaced 36 floor violations in the newly scanned
sheets (mostly `uiCard.css` and the agent-settings surface). They went onto the
floors burn-down allowlist under a heading dated 2026-11-03, not fixed here.

### Proposals for the Activity/Artifacts redesign owner

- Done for Activity (the d215 build): the composer ring is the token, the `✓`
  left `activity.decision.ruled`, and "Needs you" is one hairline-split list
  (the Class A note below).

### Proposals for UX Lead (Class A, not made here)

- **Your Team is a flat wall.** "Needs you" cards get a ring, but the other 36
  cards are identical. The fleet lead, an idle seat and a seat unseen for two
  days carry the same weight, and rows stretch to the tallest card. Craft
  baseline rule 7 already asks for tiers (featured / active / dormant).
- **Activity "Needs you" is 408 bordered cards of one weight.** A mention, an
  approval and a board move all render as the same card. Consider grouping by
  kind or pod, or dropping the per-item border so it reads as a list.
- **Connectors are a centred icon-and-name tile grid,** and every tile weighs
  the same. "0 on" says nothing is connected, but nothing points to the first
  one to connect.
- **Chip rows on agent cards** (`sharpen`, `v4 build`, `+4`) sit on almost
  every card and say little to a newcomer. Decide whether pod chips earn the
  card.

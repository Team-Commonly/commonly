# AI-slop tells

Sam, 2026-11-01 (D225): the red left rail on every blocked card was "a tell of AI slop." This is the list we check a v2 surface against before it ships, and the sweep that came out of it. A tell is a pattern that decorates instead of informing: remove it and the page loses nothing.

The D215 artboard (`docs/design/artboards/d215/`) is the reference for what stays. Anything it does not draw needs a reason in the PR.

## The tells

1. **Accent rails on cards.** A coloured left edge (`border-left` of 2px or more, or an `inset Npx 0 0 0` box-shadow) on a card, row or tile. State goes in the column, a mono kicker or one mark, never in an edge. Exempt: a quote or thread rail in a neutral colour (it joins a reply to its root).
2. **Every card the same rounded box with a coloured edge.** If every item in a list carries the same ring, the ring says nothing. A ring marks the one item that differs (Your Team: ring alone = needs you).
3. **Gradient text, or a gradient on a panel, card or page.** Text never takes a gradient (`background-clip: text`). The d215 keys keep their 2-stop vertical lift: the buttons (`primitives.css`), the logo mark and the active nav item in the rail (`v2.css` .v2-rail__brand-icon, .v2-rail__item--active) and the Connectors tile (`.v2-cx-tile`, drawn that way on the artboard). Anything else needs the artboard to draw it.
4. **Glow or glass.** No coloured `box-shadow: 0 0 Npx`, `drop-shadow` halo, `text-shadow`, `backdrop-filter` or `blur()` as decoration. The focus ring is the one halo.
5. **An emoji in a heading, a label or a button.** Headings and chrome use the icon set. Emoji belong to people's content (message text, reactions).
6. **Badge confetti.** More than one coloured badge on a row. One mark per row says what it is; the rest are mono text.
7. **Decorative motion.** Only presence pulses (1.6s) and state changes move; reduced motion switches them off.
8. **Filler copy.** A sentence under a heading that restates the heading, a count spelled as a sentence, "seamless", "powerful", "supercharge".

## Sweep of `frontend/src/v2` at main e2d474c89

| Tell | Result |
|---|---|
| 1 rails | One card rail: `.v2-board__card--blocked` (v2.css:13820, from #3141). It is TASK-746, otto's. Seven `border-left` rules of 2px or more remain (v2.css:3641, 7585, 9134, 9412, 9767, 13208, 13313): a message blockquote, the message quote, the board update rows, the approval pitch and the thread replies, all neutral in colour (9767 hard-codes `#eef0f6` rather than a token). `.v2-thread .v2-msg__quote:focus-visible` (v2.css:13215) draws an accent `inset 2px` rail as a focus state; it is a focus ring, not a card rail, and the TASK-746 guard must not flag it. |
| 2 same ring on every card | **Hit:** `.v2-activity__queue-row` has `border: 2px solid var(--v2-accent)` (v2.css:10282, 13410). Decision, approval, mention, handoff and blocked rows all carry it; only the `--settled` and `--onboarding` rows drop to a 1px neutral border (v2.css:13414). A queue where every open row needs you gains nothing from the ring. Fix: 1px neutral border like the other lists, the ring only on the row the page has focused. Follow-up row. |
| 3 gradients | No gradient text. v2.css has two gradient fills, the logo mark and the active nav item (both d215). The rest are the button keys, `.v2-cx-tile` and a hatch in `uiCard.css`, plus a slider track and two scroll-fade masks. Clean. |
| 4 glow, glass | **Hit, two bars:** `landing/v2-landing.css:87` and `agents/v2-agent-profile.css:25` set `backdrop-filter: saturate(180%) blur(12px)` on a sticky bar. v2.css has no `backdrop-filter`, `blur(`, `text-shadow` or coloured glow. Follow-up rows for the landing nav and the agent-profile header (the artboard draws a solid bar). |
| 5 emoji | Clean in chrome. Emoji appear only in the reaction palette and in message-content parsers (`📎` quote preview, `🤝` agent-DM event text). |
| 6 badge confetti | Not found by grep; needs a render check per page. Checked when each page's PR opens. |
| 7 motion | v2.css has eight infinite animations, all presence, typing or spin. The landing logo marquee (`v2-trusted-scroll`, 99s) is decorative; it is the landing's to justify. |
| 8 filler copy | Not grepped; read per page. |

Selected states with a 2px accent border (`.v2-byo__mode[aria-pressed="true"]`, `.v2-team-card--needsYou`) are a ring that marks the one differing item, so they pass tell 2.

## Guard

The card-rail rule is enforced in `frontend/src/v2/__tests__/v2-layout-invariants.test.ts` by TASK-746, which fails on a card selector with an inset rail or a coloured `border-left` of 2px or more. Tells 3 and 4 are cheap to grep and can join it when a page next touches them.

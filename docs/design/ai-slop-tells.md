# AI-slop tells

Sam, 2026-11-01 (D225): the red left rail on every blocked card was "a tell of AI slop." This is the list we check a v2 surface against before it ships, and the sweep that came out of it. A tell is a pattern that decorates instead of informing: remove it and the page loses nothing.

The D215 artboard (`docs/design/artboards/d215/`) is the reference for what stays. Anything it does not draw needs a reason in the PR.

## The tells

1. **Accent rails on cards.** A coloured left edge (`border-left` of 2px or more, or an `inset Npx 0 0 0` box-shadow) on a card, row or tile. State goes in the column, a mono kicker or one mark, never in an edge. Exempt: a quote or thread rail (neutral token, it joins a reply to its root).
2. **Every card the same rounded box with a coloured edge.** If every item in a list carries the same ring, the ring says nothing. A ring marks the one item that differs (Your Team: ring alone = needs you).
3. **Gradient text or gradient fills.** Text never takes a gradient (`background-clip: text`). The only fills with a gradient are the d215 keys (`.b-p`, `.b-s`, `.b-c`): a 2-stop vertical lift on a button, never on a panel, a card or a page.
4. **Glow or glass.** No coloured `box-shadow: 0 0 Npx`, `drop-shadow` halo, `text-shadow`, `backdrop-filter` or `blur()` as decoration. The focus ring is the one halo.
5. **An emoji in a heading, a label or a button.** Headings and chrome use the icon set. Emoji belong to people's content (message text, reactions).
6. **Badge confetti.** More than one coloured badge on a row. One mark per row says what it is; the rest are mono text.
7. **Decorative motion.** Only presence pulses (1.6s) and state changes move; reduced motion switches them off.
8. **Filler copy.** A sentence under a heading that restates the heading, a count spelled as a sentence, "seamless", "powerful", "supercharge".

## Sweep, v2.css and components at main e2d474c89

| Tell | Result |
|---|---|
| 1 rails | One card rail: `.v2-board__card--blocked` (v2.css:13820, from #3141). It is TASK-746, otto's. The other six `border-left` rules (message blockquote, message quote, thread replies, approval pitch, board update rows) are neutral-token quote and thread rails. |
| 2 same ring on every card | **Hit:** `.v2-activity__queue-row` has `border: 2px solid var(--v2-accent)` (v2.css:10282, 13410) on every row of the Needs-you queue. Every row there needs you, so the ring carries no information. Fix: 1px neutral border like the other lists, ring only on the row the page has focused. Follow-up row. |
| 3 gradients | Clean. The three `linear-gradient` fills are the d215 keys; the other two are a slider track and a scroll fade mask. No gradient text. |
| 4 glow, glass | Clean. No `backdrop-filter`, no `blur(`, no coloured glow, no `text-shadow`. |
| 5 emoji | Clean in chrome. Emoji appear only in the reaction palette and in message-content parsers (`📎` quote preview, `🤝` agent-DM event text). |
| 6 badge confetti | Not found by grep; needs a render check per page. Checked when each page's PR opens. |
| 7 motion | Eight infinite animations, all presence or typing pulses (`v2-team-pulse`, `v2-connector-pulse`, `v2-now-pulse`, `v2-typing-dot`, spin). Clean. |
| 8 filler copy | Not grepped; read per page. |

Selected states with a 2px accent border (`.v2-byo__mode[aria-pressed="true"]`, `.v2-team-card--needsYou`) are a ring that marks the one differing item, so they pass tell 2.

## Guard

The card-rail rule is enforced in `frontend/src/v2/__tests__/v2-layout-invariants.test.ts` by TASK-746, which fails on a card selector with an inset rail or a coloured `border-left` of 2px or more. Tells 3 and 4 are cheap to grep and can join it when a page next touches them.

# Connectors page → the Signal artboard: the design diff

**Spec:** canvas page *Coverage*, artboard `02 · Connectors` (`Connectors.dc.html`), approved by Sam 2026-09-04. **System:** [`docs/design/signal-identity.md`](../design/signal-identity.md). **Page today:** `frontend/src/v2/components/V2ConnectorsPage.tsx` as of #1531, plus the Slack rows #1538 adds. **Builder:** Kai, TASK-007, after #1537 and #1538 are on main. **Rule carried over from the connectors-v2 spec:** the page never renders a control the server does not enforce, and never a number the server does not count.

This is the diff between what the page draws today and what the artboard draws, state by state, with the call for every place the artboard shows something the kernel does not have yet. States are the ones TASK-005/006 shipped; none is added or removed here.

## 1. What changes and what does not

| | today (#1531 + #1538) | artboard | call |
|---|---|---|---|
| Frame | one column, `max-width: 720px`, two sections ("Your channels", "Add a channel") | one content card, `grid-template-columns: minmax(0,1fr) 400px`, gap 40; list left, aside right | **change.** Page head (display 32 "Connectors" + muted sentence), then the list, then the connect control, aside on the right |
| Rows | stacked cards with a 34px platform tile in the provider's tint, 14px bold name, green/orange/red dot, controls inside the card | one bordered container (radius 4, `#e4e7ec` dividers); each row a grid `200px minmax(0,1fr) 200px 120px`, gap 16, padding 16px 18px; dot + display 18 name, two-line middle, mono when, one action | **change.** Platform tiles and tint go from the rows. Each row opens with the provider's **glyph at 20px in ink** (`PlatformGlyph`, `currentColor`, no tile, no tint — Sam, 2026-09-04, added to the artboard) before the display-face name; the state dot stays the only cobalt on the row. Not-yet rows draw the glyph in placeholder `#98a2b3`. Tint tokens stay in both token files (the invariants test pins them) — nothing consumes them on this page any more, so the pin moves to `--v2-accent` on the dot (see §5) |
| Dot colours | `--v2-success` green, `--v2-warning`, `--v2-danger` | cobalt solid, cobalt pulsing, hollow `#98a2b3`, dashed `#98a2b3`, idle `#e4e7ec` | **change** to the state grammar (§2). No green, no orange, no red anywhere on the page |
| Actions | Manage (cobalt text link), Copy command (cobalt fill), Authorize in Slack, Confirm, This is not me, New code, Disconnect (red text) | one action per row, right-aligned, 32px: bordered secondary or ink primary | **change.** One action per row; everything else moves to the aside for the selected row (§3). Ink fills the action that is the user's next step; bordered for Manage; no cobalt fills, no red text |
| Relay toggle + Attention/Mirror | inline under every connected Telegram/Slack row | not on the row | **move** to the aside's *What the channel sees* card for the selected row. Same PATCH calls, same tests |
| Code step (hint + Copy + grouped code) | inline under a pending Telegram row | not on the row | **move** to the aside as a command block: ink ground, mono 14–18 white, Copy in cobalt (the one cobalt fill the grammar allows, on ink) |
| Slack authorize / Confirm / This is not me | inline under a pending Slack row | not on the row | **move.** Row action = the next step (ink *Authorize in Slack*, or ink *Confirm*); *This is not me* is the bordered secondary in the aside beside Confirm |
| Add flow | provider tiles (Telegram, SOON tiles at 45%) + ghost empty card + pod select + "New Telegram connector" | ink 40px *Connect a channel* + a 13px muted sentence under the list | **change.** The button opens one inline form row under it: provider segment (the providers this instance offers), pod select, ink *Connect*. SOON tiles go; unavailable providers become the *not yet* row (§2) |
| Empty state | ghost card with the sentence and the tiles | not drawn | the list container with only the *not yet* row, then *Connect a channel* + its sentence. No ghost card — the head sentence already says what a channel is |
| Aside | none | a chat sample of the channel (interrupt, my reply, digest) and a *What the channel sees* card with three counts | **partial** — see §4. The card ships now with the selected row's controls; the conversation and the counts wait on the ADR-029 D6 ledger, which does not exist |
| Phone | `@media (max-width: 760px)` wraps the controls | not drawn; the shell rule applies | §6 |

## 2. State table — same states, the artboard's marks

Rows are one line each. `dot` is the 8px mark before the name; between the dot and the name sits the provider glyph, 20px, ink (`currentColor`), placeholder grey on the not-yet row — it is recognition, not state, so it never changes colour with the row. The name column is 200px (widened from the first artboard's 160px so glyph + `Discord · WhatsApp` sit on one line). `line 1` and `line 2` are the middle column (line 2 is mono 12 muted). `when` is mono 12 muted. `action` is the one control on the row; ink = the next step, bordered = secondary.

| state (unchanged) | dot | line 1 | line 2 | when | action |
|---|---|---|---|---|---|
| connected · relay on · active in the last 10 min | cobalt, pulsing | **{chat title}** {kind} · linked to **{pod}** | `{lead} answers` / `every agent line reaches the channel` (mirror) | `connected {rel}` | Manage (bordered) |
| connected · relay on · quiet | cobalt, solid | same | same | same | Manage |
| connected · relay off | `#e4e7ec` solid (idle) | same | `relay off · messages stay in the pod` | same | Manage |
| pending · Telegram code live | cobalt, pulsing | Waiting for one message in your Telegram chat | `code expires in {m} min` | `started {rel}` | Show code (ink) |
| pending · Telegram code expired | hollow `#98a2b3` | The enable code expired. | `nothing was sent` | `started {rel}` | New code (ink) |
| pending · Slack, no state yet | hollow `#98a2b3` | Authorize Commonly in your Slack workspace to connect your DM. | `one click in Slack` | `started {rel}` | Authorize in Slack (ink) |
| pending · Slack, `pendingBind` | cobalt, pulsing | **{teamName}** says **@{slackUserName}** connected — is that you? | `waiting for you to confirm` | `Slack answered {rel}` | Confirm (ink) |
| installing / activating / uninstalling (parent transient, D8 Phase 2) | cobalt, pulsing | Installing to **{pod}** / Removing | `waiting for the server` | `started {rel}` | none — the artboard's *Cancel* does not render until a cancel verb exists (today the lifecycle verb refuses during a transient) |
| error | hollow `#98a2b3` | ink sentence stating what happened (the row's `errorMessage`, else "The connection dropped.") | `reconnect to resume` | `since {rel}` | Reconnect (ink) — Telegram: New code; Slack: Authorize in Slack |
| not yet (providers the instance does not offer) | dashed `#98a2b3`; name in muted | Not yet. Tell us which one you need and we build it next. | — | `—` | Ask (bordered) — a link, so it is honest: the public repo's new-issue URL with the title prefilled `Connector request: {provider}`. If Sam prefers HQ, swap the href; nothing else changes |

Rules under the table:

- **{lead}** is `config.leadAgentUsername`; when unset the line reads `attention · escalations reach the channel` (meta wraps to a second line and never ellipsises — lily-shen, 2026-09-05). Nobody invents an agent name.
- **when** uses the row's `createdAt` (exists) with the word *started* for pending rows. `connected {rel}` needs `connectedAt`, which no row carries; until Kai stamps it at the Telegram enable and the Slack Confirm (two writes, same PR or a follow-on), connected rows read `added {rel}` from `createdAt`. `updatedAt` is not used — every relay touches it.
- **Selected row** ground `#f2f4f7`, name weight unchanged (display is already heavy). Default selection: the first row whose action is ink (needs the user), else the first connected row. Manage on an already-selected row deselects nothing; it just keeps the aside on that row.
- **iMessage** is on the artboard as a sample provider. It is not in the provider enum; it does not render.
- **Recent** stays 10 minutes, from `updatedAt` as today — that is the one place `updatedAt` is the right field, because a relay is activity.

## 3. The aside is the selected channel

The right column (400px at 1440) belongs to whichever row is selected. Top to bottom:

1. **The step it needs now** — only for pending/error rows. Telegram code live: the command block (`/commonly-enable {code}` grouped in 4s, Copy in cobalt, the bot handle in the line above, mono `expires in {m} min`). Slack `pendingBind`: workspace + user in body text, ink *Confirm*, bordered *This is not me*. Error: the sentence and the ink action, repeated from the row so the aside stands alone.
2. **Conversation panel** — `#f9fafb`, radius 6, padding 18: mono header `{chat title} · {provider} · today`; an agent line white with a 3px cobalt left border and `{agent} · interrupt` in mono cobalt; my line ink on the right; a digest line white with an `#e4e7ec` border and `{agent} · digest · {hh:mm}` in muted mono. **Gated on the ADR-029 D6 ledger.** Until a `GET /api/integrations/:id/ledger` (or equivalent) returns `{verdict, at, agent, text}` rows, the panel does not render. `config.relayMap` is not a substitute: it records outbound ids, not verdicts or inbound lines, and the existing `/:id/messages` route answers 400 for Telegram and an empty list for Slack.
3. **What the channel sees** — bordered card, display 16 title, the 13px secondary sentence (`One name, {lead}. Interrupts when something needs you; a digest at the hour you pick otherwise. Every relayed line says who did the work.` when a lead is set; the attention/mirror sentence otherwise), then the controls that live inline today: the Relay toggle and the Attention/Mirror segment (bordered segment, pressed item ink 600 on `#f2f4f7`, never a cobalt pill), and Disconnect as a bordered secondary that flips to the ink confirm line on first click (the two-click confirm stays). The counts grid (`14 interrupts · 6 digests · 0 missed needs`, display 22 + mono 11) renders only when the same ledger exists; until then the card ends at the controls.

The connect form (after *Connect a channel*) also opens in the aside when a row is not selected, so the page never grows a third column or a modal. At 390 it opens under the button.

## 4. What the kernel does not have, named

| the artboard shows | the kernel has | call |
|---|---|---|
| the channel's conversation | `relayMap` (outbound ids only); `/:id/messages` is 400 for Telegram, empty for Slack | ADR-029 D6 ledger. Not in TASK-007; its row is the delegate work. The panel is drawn in CSS now and mounted behind the ledger read, so landing the ledger is a data change, not a restyle |
| interrupts / digests / missed counts | nothing counts them; `shouldEscalate` decides and forgets | same ledger; the silence detector (#1540) is where *missed* comes from |
| `connected 3 days ago` | `createdAt` | `connectedAt` stamp — two writes |
| Cancel on a transient row | no cancel verb (the lifecycle verb refuses while the parent is transient) | D8 Phase 2 row (mine, next): parent rows with error/uninstalling, Retry/Remove, then Cancel |
| which providers the instance offers | `ADD_PLATFORMS` constant on the page | the capability catalog (`GET /api/installables` with `available`), same D8 row; until then the constant decides which providers are rows and which are the *not yet* row |
| `wren answers` | `config.leadAgentUsername` | exists; unset reads as attention mode |

## 5. Pins for `v2-layout-invariants.test.ts`

A restyle re-pins, never deletes. Class names below are the proposal; Kai's names win, the pins do not move. Replace the connectors block with:

1. `.v2-connector-row` is `display: grid` with `grid-template-columns: 200px minmax(0, 1fr) 200px 120px`.
2. `.v2-connectors` (the content grid) contains `minmax(0, 1fr) 400px`.
3. `.v2-connector-row__dot--live` contains `var(--v2-accent)`; `.v2-connector-row__dot--idle` contains `var(--v2-border-soft)`; no rule under `.v2-connector` contains `var(--v2-success)`, `var(--v2-warning)` or `var(--v2-danger)`.
3b. The row glyph rule sets `width: 20px; height: 20px` and `color: var(--v2-ink)` (not-yet: `var(--v2-text-placeholder)`); no glyph rule contains `var(--v2-accent)` or a `--v2-platform-*` token — the glyph is never the state mark.
4. Every `background` under `.v2-connector` that is a fill is `var(--v2-ink)` or the command block; no `var(--v2-accent)` background except `.v2-connector-code__copy`.
5. `@media (max-width: 760px)` contains `.v2-connector-row { grid-template-columns: minmax(0, 1fr) auto }` and `.v2-connectors { grid-template-columns: minmax(0, 1fr) }`.
6. The platform tint tokens stay pinned in both token files (the existing test) — the page no longer consumes them; they are kept for the front door.

## 6. 390

The shell rule: the rail is the bottom bar, the content card loses its border and goes edge to edge, `padding 16px`. The page grid collapses to one column; the aside stacks under the list and keeps its order (step, conversation when it exists, the card). Each row becomes two lines: dot + name and the action on line 1; line 1 of the middle column and the mono when on line 2, with line 2 of the middle column dropped (the mono detail is in the aside). No horizontal scroll: `scrollWidth` 390 is the gate.

## 7. Gate

Screenshots at 1440 and 390 beside the artboard in the PR, from the deployed page with at least one connected row and one pending row (seed or a real bind). Computed checks: the dot on a live row is `rgb(29,63,209)`; the Manage button has a `rgb(208,213,221)` border and no fill; the next-step action is `rgb(16,24,40)`; no element on the page has a green, orange or red computed colour; `document.documentElement.scrollWidth` is 390 at 390. The Connectors test suite keeps every case in `V2ConnectorsPage.test.tsx` — the moves in §1 change where a control renders, not what it calls.

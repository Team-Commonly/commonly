# Signal — the Commonly identity, as a system

Chosen by Sam on 2026-09-03 from three named directions (Studio, Workshop, Signal) on one canvas, then applied screen by screen. This document is the spec of the *system*; the canvas is the spec of each *screen*:

- Canvas: https://claude.ai/code/artifact/2c6cfbd9-6f18-4da3-91a1-24eea2a635d6 — pages **Workspace in C** (chat + inspector, Activity, Your team, agent profile, phone shell, the delegate), **Front door** (landing at 1440 and 390, connect, create account), **Directions** (the three candidates, for reference), **Coverage** (the survey of every remaining screen and the six drawn from it: invite, connectors, settings, board, bring your own, reset password).
- Tokens: `frontend/src/v2/v2.css` (ships) and `frontend/design-system/tokens.css` (mirror). They move together in one PR.
- Anchor: `frontend/design-system/README.md` § *Identity: Signal* carries the short form of this page.

A screen is done when it matches its artboard at 1440 and 390 in a real browser. Nothing is pressed on a description; Sam sees it live beside its artboard.

## 1. The five rules

1. **One colour, two volumes.** Cobalt `#1d3fd1` is the only accent. On the *front door* (landing, connect, create account, invite, reset password) it is a **block**: the hero band, a full panel, a wordmark underline. *Inside the app* it is only ever a **mark**: the live dot, an agent's name in mono, a link, the focus edge, and the single card that needs you (2px ring). The same hex, never a tint of it as a background inside the app.
2. **Ink acts.** Every filled control inside the app is ink `#101828` on white: Send, Answer, Press, Create, Save. Cobalt fills a control inside the app in exactly one place: the **primary option of an open decision card** — the one thing the page is asking of you, and the second cobalt block on the page beside the selected room. Nothing else. Secondary controls are a 1px `#d0d5dd` border. The rare cobalt fill (Copy on a command block) sits on an ink ground, so it is a mark on ink, not a button on white.
3. **Three faces, one job each.** Bricolage Grotesque 700/800 for display, letter-spacing −0.03em. IBM Plex Sans 400/500/600 for body and controls, 14/20. IBM Plex Mono 500 for meta: timestamps, ids, counts, status, lowercase labels, commands. Meta is mono *because* it is data; a sentence is never mono.
4. **Hard edges, no shadows.** Radius 4 on controls, rows, chips, avatars and marks; 6 on cards, panels and the content card. No shadow anywhere; elevation is a border. Avatars are 4px squares in cobalt (people), ink (agents) or `#e4e7ec` (idle), never circles, never photos in chrome.
5. **Engagement is behaviour, not paint.** A card settles when you pick; a row flips when an agent takes it; presence is a pulsing dot (1.6s, respects reduced motion). Energy comes from things changing, never from adding colour. When a screen feels flat, remove something.

## 2. The grey ramp (complete — do not add greys)

| role | hex | used for |
|---|---|---|
| ground | `#eef0f4` | the page behind the content card, the rail |
| border | `#d0d5dd` | cards, inputs, secondary buttons, the content card |
| divider | `#e4e7ec` | rows inside a card, hairlines, idle avatars, the rail's bottom slot |
| tint | `#f2f4f7` | the selected nav row, nothing else |
| panel | `#f9fafb` | an inset panel (a chat sample, a board column, an aside) |
| muted | `#667085` | meta text, hints, timestamps |
| secondary | `#475467` | body copy that is not the point, secondary button text |
| placeholder | `#98a2b3` | empty inputs, disabled, "not yet" |
| ink | `#101828` | text, filled controls, agent marks |

Cobalt hover is `#1633a8`. The focus ring is `0 0 0 3px rgba(29,63,209,0.16)` around a `#1d3fd1` border. That is the whole palette.

## 3. State grammar

| state | how it reads | never |
|---|---|---|
| needs you | 2px cobalt ring on the card, mono `needs you` in cobalt; on a decision card the primary option is a cobalt fill, the others bordered, Other… as cobalt text; on a plain needs-you card an ink Answer button | a coloured background, a badge count on the card |
| working | cobalt pulsing dot + mono `working · TASK-131` | a spinner |
| connected / live | solid cobalt dot | green |
| idle / done | `#e4e7ec` mark, muted mono `idle · 41m`, done cards drop to `#e4e7ec` border and secondary text | greying out the whole card |
| not yet / unavailable | dashed `#d0d5dd` border or dashed dot, placeholder text | a disabled-looking button that still says the action |
| error | ink text stating what happened and the one thing to do; a `#d0d5dd` card | red fills, exclamation icons |

Counts live in mono next to the thing they count (`7 open · 2 need you`), never as pills.

## 4. Component grammar (exact values)

- **App shell.** Ground `#eef0f4`, 14px padding, `grid-template-columns: 56px minmax(0,1fr)`, 12px gap. Rail: 32px squares, 8px apart, the wordmark `C` in cobalt on top, the current section in ink, the rest `#d0d5dd`, account at the bottom in `#e4e7ec`. Content: one white card, 1px border, radius 6, padding 32px 40px (24px 28px on dense screens like the board).
- **Page head.** Display 32px + muted 13px meta on one baseline; actions on the right: one ink primary, secondaries bordered. Heights: 36px in heads, 40px in forms, 44–48px on the front door. Padding 0 12–18px, weight 600, size 13–15.
- **Inputs.** 40px (in-app) or 44px (front door), 1px `#d0d5dd`, radius 4, 12px side padding, 13px 500 label in secondary above, 12px muted hint below. Focus: cobalt border + ring.
- **Rows and tables.** A bordered container (radius 4) with `#e4e7ec` dividers; each row a CSS grid with named column widths; the name in display 18px, meta in mono 12px, the action right-aligned. No zebra, no header row unless the columns need naming.
- **Cards in a grid.** `repeat(3, minmax(0,1fr))`, 12px gap, 16px padding, radius 4, 1px border; the one that needs you gets the 2px cobalt ring. Card body: 40px avatar + display 18 name + mono 11 status; 13px secondary copy; mono 11px chips (2px 6px, bordered) for rooms; an action row.
- **Chat samples and asides.** Panel `#f9fafb`, radius 6, 18px padding; my lines ink on the right; an agent's lines white with a 3px cobalt left border and the name in mono cobalt; a digest line white with a `#e4e7ec` border and the name in muted mono.
- **Command blocks.** Ink ground, radius 4, mono 14–18 white, the Copy control in cobalt.
- **Numbered steps.** Mono cobalt `01 02 03` at 28px column, only when the order carries information (a sequence the reader performs). Lists that are not sequences are not numbered.
- **Front door.** `grid-template-columns: minmax(0,1fr) 560px`: a cobalt panel with the wordmark, one display line at 64/64 with `text-wrap: balance`, one 18/28 sentence at 86% white, one mono footer; a white panel with the form, a 32/36 display title, 48px controls. Reset password, invite and create account are the same frame with different words.
- **Phone (390).** The rail becomes a bottom bar; the content card loses its border and goes edge to edge; the inspector is a sheet. See *Workspace · 390* on the canvas; no per-page phone artboards are drawn, the shell rule fixes every page.

## 5. Copy

Real copy on every artboard, final draft, in the product's voice: short declaratives, second person, sentence case, agents by name. No lorem, no "welcome", no marketing filler. Facts that are not known are bracketed, never invented. Names, counts and times on artboards are sample values and say so in the note. Numbers appear only where they change what the reader does.

## 6. How a screen gets made (the process that made this land)

1. **Directions before deliverables.** When a direction is open, three *named* candidates on one page, each built around the *same product moment* with the *same fixed copy*, so the only variable is the design. Five shades of one idea is not a choice.
2. **The chosen one gets clickable.** The winning direction is applied to the screen people live in as a working prototype (state changes, not a tour) before any other screen is drawn.
3. **One system, two volumes.** Every later screen is the same system; the only knob is front door (blocks) vs in-app (marks). A screen that needs a new colour or radius is wrong, not the system.
4. **Canvas first, code second.** No component work starts before the artboard exists and Sam has looked at it. The artboard is the spec; the PR carries 1440 and 390 screenshots of the real screen beside it.
5. **Survey what is left.** Periodically screenshot every live route at 1440 and 390 into one sheet (the *Coverage* page shows the shape); each uncovered screen gets a call — draw, fold into a drawn screen, or delete — and Sam rules on the deletes.
6. **A screen ships whole, never in slices.** A new sidebar beside an old composer is parity and misalignment, not progress (Sam, 2026-09-05). When an artboard covers several components, their PRs stack and press within the hour, deploy once, and the old components are deleted in the same cutover — no flags, no half-states in production.
7. **Pin the load-bearing CSS.** Layout rules a browser could silently break are pinned in `frontend/src/v2/__tests__/v2-layout-invariants.test.ts`; a restyle re-pins, never deletes.

## 7. Adding a screen

1. Copy the nearest artboard on the canvas (`Connectors.dc.html` for a list page, `YourTeam.dc.html` for a card grid, `Invite.dc.html` for a front-door screen) and change only the content.
2. Keep the helmet block as is (fonts, `.disp`, `.mono`, `.pulse`); everything else is inline style so the editor can restyle it.
3. Add it to `canvas.json` on the right page with a title that says what it is; write the note that names the sample values.
4. Save the canvas; post the artboard in the pod; build only after Sam has seen it.

## History

- 2026-09-03 — direction chosen (C · Signal). Tokens landed in #1530; Activity rebuilt to its artboard in #1522.
- 2026-09-05 — Active goal: the workspace is the preview. Sidebar, inspector, thread, decision card and composer rebuilt as new components to `Workspace · clickable`, one cutover; decision loop closed both ways (card → pick → event to the agent → Telegram).
- 2026-09-04 — Coverage page: 18 uncovered screens surveyed, six drawn (invite, connectors, settings, board, bring your own, reset password); delete or fold proposed for feed, digest, analytics, dashboard, skills, manage agents, profile, devices — pending Sam. Chat + inspector restyle in progress.

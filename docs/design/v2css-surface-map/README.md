# v2.css surface map

D223 says a surface's old v2.css rules are deleted in the same PR that lifts the surface onto the artboard. This map says which rules those are. For each surface it lists the selectors that only that surface uses, which go with its lift, and separately the selectors it shares with another surface, which stay until the last of their users lifts.

Measured 2026-11-01: v2.css at main `323595193` (14,081 lines, 2,374 rules, 2,754 selectors), live DOM read on prod `9460865ab`.

| Surface | Goes with the lift | of which never seen live | Whole rules (≈ lines) | Trim from a shared rule | Shared, stays |
|---|---|---|---|---|---|
| [Chat](chat.md) (main pane + pod inspector) | 579 | 285 | 513 (≈ 2,578) | 26 | 203 |
| [Task board](board.md) | 282 | 87 | 247 (≈ 815) | 5 | 87 |
| [Settings](settings.md) | 184 | 81 | 162 (≈ 688) | 5 | 98 |
| [Sidebar](sidebar.md) (rail, pods list, phone tab bar) | 148 | 44 | 130 (≈ 727) | 1 | 72 |
| [Connectors](connectors.md) | 141 | 137 | 119 (≈ 195) | 3 | 37 |
| [Agent settings](agentSettings.md) | 0 | — | 0 | 0 | 54 |
| [Agent memory](memory.md) | 0 | — | 0 | 0 | 57 |

Also: [377 unreferenced selectors](unreferenced.md), never matched live and named by no component, which any PR may delete. 757 more belong only to pages outside these seven (activity, artifacts, Your team, bring your own, landing, auth, admin), and 17 only to the shell.

**Agent settings and memory have nothing of their own in v2.css.** Both are styled in `frontend/src/v2/agents/v2-agent-settings.css` (198 lines), with `v2-agent-policy.css`, `v2-agent-wake-pods.css`, `components/v2-agent-skills.css` and `components/V2AgentRuntimeGrants.css` beside it. Their lifts delete from those files. The v2.css selectors they use are all shared base rules (`.v2-root *`, buttons, inputs, scrollbars). Connectors is partly the same: its tiles and popovers (`v2-cx-*`) are styled only in `connectors/connectors.css`, and its v2.css selectors are the older row, gate and setup-panel rules, which is why 137 of 141 weren't on screen.

## How a selector is classed

A selector belongs to a surface when both sources below name that surface and no other:

1. **Live DOM.** Each of the 24 states below was loaded at 1440 and 390 on prod, signed in as a non-admin member, read-only. Every v2.css selector was run through `querySelectorAll`, and each match was attributed to the region holding it:
   - rail, pods list and phone tab bar → sidebar;
   - pod inspector → chat;
   - main pane, and portals such as dialogs, drawers and popovers → the route's surface;
   - an element that contains the whole shell → shell.

   Before matching, states that can't be seen statically are removed from the selector: hover and focus, `::before`/`::after`/`::placeholder`, `:lang()`, and the theme prefixes `:root[data-v2-theme=…]`. So a dark-only or zh-only rule counts where its element appears.
2. **Source.** The classes on the selector's subject (the rightmost compound holding a `v2` class) are grepped across `frontend/src` (tests excluded). Each file is mapped to surfaces through the import graph from each surface's entry component:
   - chat: `V2Thread`, `V2Inspector`
   - sidebar: `V2NavRail`, `V2PodsSidebar`, `V2MobileTabs`
   - board: `V2PodBoard`
   - settings: `V2SettingsPage`
   - connectors: `ConnectorsPage`
   - agent settings: `V2AgentSettingsPage`
   - memory: `V2AgentMemory`
   - plus every other routed page as "other", and `V2App`/`V2Layout` as "shell".

   A walk from one entry stops at another entry. So `V2Lightbox`, imported by chat and by artifacts, counts for both.

The union of both sources decides the class: one surface means it goes with the lift, more than one means it's shared, none means it's unreferenced.

**States walked.** For each state, the route class and URL:
- Chat states, all on `/v2/pods/<pod>`:
  - a team pod with the Agents, Files and Needs-you folds open and one Show more expanded;
  - its Threads tab with a thread open;
  - a pod the account owns, with Who-can-join open and a long thread reply expanded;
  - the create-pod form;
  - pod search;
  - a public pod;
  - an agent room.
- Board: `/v2/pods/<pod>/board`, plain and with a task drawer open.
- Settings: `/v2/settings` with every fold open, and `/v2/settings/devices` (which redirects to the same page).
- Connectors: `/v2/connectors`, plain and with one Tools popover and one Channels popover open.
- Agent settings: `/v2/agents/<agent>/<instance>`.
- Agent memory: its memory page, on the Rules and Journal tabs.
- Pages outside the seven, walked so their use counts as sharing: activity, Your team, bring your own, artifacts, a public agent profile, connect.

## Before deleting, read these caveats

- **"Never seen live" means the state wasn't reached, not that it's dead.** Approval, decision, gig and PR cards, the lightbox, error and empty states, the connector setup drawer (not opened, since its next step can start a connect), and admin-only controls weren't on screen. Those selectors are classed by source alone. Before deleting one, confirm its class no longer appears in the surface's components after your lift.
- **Dynamic class names.** The grep also counts every separator prefix of a class followed by `${` or `' +` (so `v2-board__owner-dot--${state}` covers `v2-board__owner-dot--not-claimed`), but a class assembled any other way reads as unreferenced. Grep the stem before deleting anything from [unreferenced.md](unreferenced.md).
- **Pins.** "pinned by" names a test that reads v2.css and names the selector's subject class as a CSS class (plain or regex-escaped), mostly `v2-layout-invariants.test.ts` and `v2-type-floors.test.ts`. A deletion PR updates or drops those assertions in the same change.
- **Ancestor-scoped selectors are classed by their subject.** `.v2-feature--board .v2-feature__body` counts everywhere `.v2-feature__body` is used, so it reads as shared with connectors and other pages, even though only the board route sets `v2-feature--board` (in `V2App`). This errs toward keeping a rule, never toward deleting one. A lift can take a scoped rule whose ancestor only its own route sets.
- **Comma lists.** When a rule lists selectors of different classes, delete only your surface's selector from the list ("rule lists N selectors").
- **Line numbers** are each rule's first line (L<start>–<end>), not the selector's own line inside a comma list, and they drift with every edit above them. Search by selector.
- **Prod lags main.** Selectors added on main after `9460865ab` are classed by source only until the next deploy.

## Re-running it

Tools: `scripts/v2css-surface-map/`.

1. `node parse.mjs frontend/src/v2/v2.css rules.json` splits v2.css into rules and selectors.
2. In a signed-in browser on each state, evaluate `collect.js` with `{ sels, route }`, and save the results keyed `<state>@<width>`. `live-9460865ab.json` is this run's output. It holds selectors and region names only, no page content. Use a non-admin account and stay read-only: open folds, tabs, drawers and popovers, and never submit.
3. `node analyze.mjs frontend/src rules.json live.json rows.json` classes every selector.
4. `node render.mjs rows.json docs/design/v2css-surface-map <main sha> <prod sha> <date>` writes these pages.

Re-run after each lift merges and deploys, so the next surface's map reflects what the last one removed.

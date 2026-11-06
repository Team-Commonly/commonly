# D215 artboard: "Signal, Said Less"

The spec for D215 (artboard v2). Open `index.html` in a browser. The toggle at the top switches it between light and dark, and every D215 surface has a frame at 1440 and at 390.

- `index.html` holds the before shots and live mocks for seven surfaces: sidebar, pod chat, task board, agent memory, agent settings, settings and connectors. The mock's names, messages and task titles are neutral samples. Counts and times come from the captures.
- A second block under agent settings draws the states of that page (policy and machine, identity edit, connector grants, runtime with the model and effort selects, own API key) at 1440 and 390. The runtime and key frames follow V2RuntimeControls and V2AgentProviderKey, including the stored-model refusal and the key-save error. Those frames carry `data-state`, so `measure_after.js` skips them and `targets.json` does not move.
- Two state-only surfaces: `task-record` (the task record page, loaded and not-available, under the reply trace) and `handoff` (the OAuth and Discord return pages, `data-state` working, done, error, on the auth card). Every frame carries `data-state`, so the scorer skips them and `targets.json` does not move.
- An `Empty and error` block (`#s-empty`) draws the empty pod list, the empty board, the board's load error, an agent with no memory, and a page-not-found that replaces live's silent redirect to `/v2`, at 1440 and 390. Agent not found is drawn under the agent profile. Every frame carries `data-state`, so the scorer skips them and `targets.json` does not move.
- A block under Settings draws the free-plan Plan row and the administrator-only Administration group (`data-state="admin-free"`, 1440 and 390, also skipped by the scorer).
- Under Activity and under Artifacts, a block redraws each page in the picked language (`#s-activity-signal`, `#s-artifacts-signal`): busy and day zero at 1440 and 390, built only from the seven picked surfaces' blocks. Sam approved both on 11-03. Each page's build dropped the `data-state`, so the eight frames (`activity-busy`, `activity-dayzero`, `artifacts-busy`, `artifacts-dayzero`) are the scored ones, and retired the traced `#s-activity` and `#s-artifacts` sections and their CSS.
- The theme switch (sun / moon, D224) sits in the rail above the avatar at 1440. At 390 there is no rail, so the same switch rides the Pods top bar, left of Search. It is a two-item segment: the item for the theme in effect is the white key.
- `before/` holds prod captures from 2026-10-31, blurred so they show layout and density only.
- `targets.json` holds the helper-word and scroll targets per frame. `cap/measure_after.js` writes it from `index.html`.
- `cap/` holds the measuring scripts. See the header of `measure_after.js` for its env.
- Every frame without `data-state` must be listed in `measure_after.js`, either in `SURFACES` (scored) or in `SKIPPED` (not scored, with a reason). The two trace "before" frames, `run-trace-before` and `chat-trace-before`, draw the old pages and are skipped: they are never a target. On prod, `activity-busy` is measured at `/v2/activity` and `artifacts-busy` at `/v2/artifacts`; the two day-zero frames need an account with nothing in it, so they are artboard-only. The Activity and Artifacts prod checks (`BUSY` in `measure_after.js`) refuse the error line, the spinner and any list shorter than the frame. They then measure only as many rows as the frame draws, because prod shows the account's whole history. Artifacts is cut to 6 file rows. Activity is cut to 4 Needs you rows and 5 Moved forward lines; its Needs you list pages through every open item, which was 429 on lily-shen on 11-04. `node --test cap/measure_after.test.js` fails on any frame that is in neither list.

## Where each frame came from

Passing the prod check means a page matches its frame. It means the page matches the style Sam picked only when the frame came from his pick. Every frame is in one of three groups. A group's frames are scored only where the table says so, and prod scores are reported per group, never as one total.

| Group | Frames | Source |
|---|---|---|
| **From Sam's pick** | sidebar, chat, board, agent-memory, agent-settings, settings, connectors | The seven surfaces picked on 10-31 (#3059). Later edits: the theme switch (#3175) and the open thread (#3178). #3288 (the 390 agent-settings and settings frames, brought up to the shipped pages) and #3289 (memory notes drawn as the API holds them) moved those frames toward the live page, so read them with that in mind. **Connectors Discord tile, 11-05, not from Sam's pick:** Discord joined the Channels row at 1440 and 390 once the page offered it, the count went to 8 available, and the channel off counts it used to fold into dropped by one (nothing else in those frames changed). **Sidebar 390 pod rows: row height raised to the 44 px accessibility floor, Cofounder 11-04, not from Sam's pick** (36 → 44; nothing else in that frame changed). Sam can reverse it. **Pin on touch via press and hold, Cofounder 11-04:** the frame shows the pin only in a row's hover state, so on a phone a 500 ms press and hold is that hover. It reveals the pin in the time's place, and a tap on it pins. At rest, pinned pods show under the view switch's Pinned option, as the frame draws it. No frame change. |
| **Drawn after the pick** | dm, byo, byo-handoff, connect, team, firstrun-\*, signin, signup, signup-sent, verify-email, forgot-password, reset-password, cli-authorize, invite, invite-required, profile, agent-profile, run-trace-after, chat-trace, chat-agents-away, and the agent-settings, settings and empty-and-error state blocks | New drawings in the picked language, from 11-01 on. Sam has not reviewed them as a set. |
| **Approved by Sam, 11-03** | activity-busy, activity-dayzero (`#s-activity-signal`); artifacts-busy, artifacts-dayzero (`#s-artifacts-signal`); task-record-\*; handoff-\* | Sam saw each one live-beside-proposed and answered "Build as drawn" for all four pages. Activity and Artifacts are built only from the picked surfaces' blocks, and both are scored since their builds. Task record and handoff still carry `data-state`, so the scorer skips them. |

## Rules for D215 PRs

1. Every PR attaches screenshots of the built page at 1440 and 390, in light and dark, beside the matching artboard frame.
2. Every PR gets two gates. The design gate compares the screenshots with the frame and holds on visible drift. The code gate is separate.
3. A row closes on prod, not at merge. After the deploy, run `node cap/measure_after.js prod` against prod. The surface has to hit its targets.

```sh
# regenerate targets after an artboard edit
node cap/measure_after.js
# check prod (token from env only; the script never prints it or page text)
COMMONLY_TOKEN=… D215_POD=<pod id> D215_AGENT=<name>/default node cap/measure_after.js prod --only chat,board
```

## Caveats

- The artboard and prod modes use different exclusion lists. The artboard mode skips the mock's own control classes, while the prod mode uses the counter that produced the before numbers. Read a near-miss with that in mind.
- The chat frame carries one open thread (root, one reply, foot keys) since TASK-745. It is the reference for the live `.v2-thread-block`; the helper-word target for chat includes it (38 at 1440, 7 at 390).
- The chat scroll target (5.32× at 1440, 6.28× at 390) was measured on live history with the fold applied, and the targets file pins it. Chat and board scroll both depend on how much history the chosen pod has, so measure the same pod each time.

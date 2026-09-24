# Landing demo and README frames: the spec

**Approved by Sam, 2026-09-23.** The landing hero replaces its video with an interactive fake of the workspace. The README gets still frames. The build is TASK-147.

The canvas these boards come from is private to Sam's account, so the sources live here for the seats that build from them. Each `.dc.html` file is one board from the Design canvas format. The markup is plain HTML with `{{ holes }}`, `<sc-for>` and `<sc-if>`. The behaviour is the `DCLogic` class in the script block at the bottom of the file.

| file | what it is |
|---|---|
| `Demo.dc.html` | **The spec that matters.** It is the interactive hero at 1312 by 720. There are four pods (Launch, Support, Website, Growth). Decision cards take a pick, then Sam's ruling and the agent's reply appear. Suggested prompts show a timed "working" state and a scripted reply. Free text gets a generic reply from the pod's lead agent. The inspector's agents, needs-you, board and channel panels follow the state. All copy and sample data are in `data()`. |
| `Landing.dc.html` | The landing at 1440. It has a cobalt hero with the demo half on the band, and four feature rows using the frames. Row copy for decisions and connectors is new; the rest is the live landing's copy without OpenClaw. |
| `Readme.dc.html` | Where the frames sit in the README: the demo's first state as the hero, Activity and Your Team side by side, Connectors, then Bring your own. |
| `Shot*.dc.html` | The four still frames at 1440 by 900: Activity, Your Team, Connectors (Direction A as shipped), and Bring your own (the daemon path from the README). |

## Rules for the build

- **Build from the real v2 components with fixture data, not from this markup.** The hero must look like the product because it is the product's components. The boards are the spec for content and behaviour, not code to copy.
- **No backend.** Replies are scripted and time-delayed, and the demo says so in a visible line.
- **Faces come from the real kit.** `/_blob/…` image URLs in these files are canvas assets and do not resolve here. Use `characterAvatarFor(seed, kind)`, the "Cut" kit since #1834.
- **Sample values only.** Names, counts, times and PR numbers are invented and must stay obviously sample.
- **Frames for the README** are exported at 2x from the real components, not from these boards.
- **Evidence** is 1200 and 390 screenshots beside the board, per `docs/design/signal-identity.md`.

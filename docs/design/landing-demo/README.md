# Landing demo and README frames: the spec

**Approved by Sam, 2026-09-23.** The landing hero replaces its video with an interactive fake of the workspace. The README gets still frames. The build is TASK-147.

**Extended 2026-09-29: the rest of the landing moves onto Signal.** Sam chose to keep the seven middle sections of the live page, restyled onto Signal: How it works, Why open-source, What you get, Use cases, Architecture, the proof section and Pricing. Lily Shen ruled the proof section on 2026-09-29: A · Quiet panel. The hero lede keeps "all in one room", the line Sam approved, and step 1 of How it works now says "pod". The build is TASK-192 to TASK-196, rows A to E. They are one screen, so they ship whole (`docs/design/signal-identity.md` rule 6). TASK-191 commits these boards.

The canvas these boards come from is private to Sam's account, so the sources live here for the seats that build from them. Each `.dc.html` file is one board from the Design canvas format. The markup is plain HTML with `{{ holes }}`, `<sc-for>` and `<sc-if>`. The behaviour is the `DCLogic` class in the script block at the bottom of the file.

| file | what it is |
|---|---|
| `Demo.dc.html` | **The spec that matters.** It is the interactive hero at 1312 by 720. There are four pods (Launch, Support, Website, Growth). Decision cards take a pick, then Sam's ruling and the agent's reply appear. Suggested prompts show a timed "working" state and a scripted reply. Free text gets a generic reply from the pod's lead agent. The inspector's agents, needs-you, board and channel panels follow the state. All copy and sample data are in `data()`. |
| `Landing.dc.html` | The landing at 1440 by 9406: the cobalt hero with the demo half on the band, the trusted strip and the wedge, four feature rows using the frames, the seven kept sections, the close and the footer. The rows carry the live copy from TASK-165, and comments in the markup say what changed from the live page and why. |
| `Landing390.dc.html` | The same page at 390 by 12922, in one column with 24px gutters. The demo and the row shots are images on this board: `landing-390-demo-2x.png`, and the README frames in `../../assets/readme/`. |
| `landing-390-demo-2x.png` | A 2x still of the demo at phone width, for the 390 board. |
| `Readme.dc.html` | Where the frames sit in the README: the demo's first state as the hero, Activity and Your Team side by side, Connectors, then Bring your own. |
| `Shot*.dc.html` | The four still frames at 1440 by 900: Activity, Your Team, Connectors (Direction A as shipped), and Bring your own (the daemon path from the README). |

## Rules for the build

- **Build from the real v2 components with fixture data, not from this markup.** The hero must look like the product because it is the product's components. The boards are the spec for content and behaviour, not code to copy.
- **No backend in the demo.** Replies are scripted and time-delayed, and the demo says so in a visible line.
- **Faces come from the real kit.** `/_blob/…` image URLs in these files are canvas assets and do not resolve here. Use `characterAvatarFor(seed, kind)`, the "Cut" kit since #1834.
- **Sample values only.** Names, counts, times and PR numbers are invented and must stay obviously sample.
- **Copy comes from the live locale keys.** The boards match them, apart from the changes the TASK-192 to TASK-196 rows name.
- **Frames for the README** are exported at 2x from the real components, not from these boards.
- **Evidence** is 1200 and 390 screenshots beside the board, per `docs/design/signal-identity.md`. The TASK-167 rows also gate at 1440, the width the board is drawn at.

## Where the build departs from the boards

- **The install command.** The 1440 board draws it as a bare, shortened line beside the buttons. The build keeps TASK-154's copyable command box with the exact live command: in the button row where it fits, and on its own row below the buttons where it does not. The 390 board draws the second case.
- **The title's line break.** The 1440 board sets the title on one line. The build keeps the live break before the rotating term, so a longer term cannot change the line count and move the band.
- **The language switch.** "EN" on the boards stands for the live language switch, white on the band.
- **Live numbers.** The proof counts on the boards are sample values. The build shows `/api/stats/public` and hides the counts when it does not answer, as the live page does.
- **The ADR count is counted, not typed.** It must equal the number of `docs/adr/ADR-*.md` files: 30 on 2026-09-29, while the live constant says 15. The deploy builds the frontend image with `frontend/` as the Docker context, so `docs/adr/` does not exist inside that build. Count it outside the image, or pin the number with a test that counts the files.
- **Where a board and `docs/design/signal-identity.md` disagree, the identity doc wins.**

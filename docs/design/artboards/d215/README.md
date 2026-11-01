# D215 artboard: "Signal, Said Less"

The spec for D215 (artboard v2). Open `index.html` in a browser. The toggle at the top switches it between light and dark, and every D215 surface has a frame at 1440 and at 390.

- `index.html` holds the before shots and live mocks for seven surfaces: sidebar, pod chat, task board, agent memory, agent settings, settings and connectors. The mock's names, messages and task titles are neutral samples. Counts and times come from the captures.
- `before/` holds prod captures from 2026-10-31, blurred so they show layout and density only.
- `targets.json` holds the helper-word and scroll targets per frame. `cap/measure_after.js` writes it from `index.html`.
- `cap/` holds the measuring scripts. See the header of `measure_after.js` for its env.

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
- The chat scroll target (5.32× at 1440, 6.28× at 390) was measured on live history with the fold applied, and the targets file pins it. Chat and board scroll both depend on how much history the chosen pod has, so measure the same pod each time.

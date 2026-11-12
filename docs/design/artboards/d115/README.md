# D115 artboard: agent health

The frame for the agent health page that `docs/architecture/fleet-health.md` designs. Open `index.html` in a browser. It draws four states, each at 1440 and at 390, one in light and the other in dark:

1. **A busy day.** One row per agent install. The outcome bar splits the wakes that asked for something into posted, declined, failed, never picked up and in flight. Heartbeats get a column of their own. Cost is shown for hosted agents. Needs you and Offline badges sit in the status column.
2. **A quiet window.** Installs with no wakes keep their row, with one muted line in place of the numbers.
3. **No agents in your pods.** The head plus one line and Hire an agent.
4. **The read failed.** No zeros, a retry, and the window select stays.

The page lives under Your team as a second option beside Agents (`/v2/agents/health`). It shows the viewer's own pods only, with no admin view, and no message text. The rules the build follows are listed at the foot of the page, including the proposed split of failure codes into Needs you and Failed. Names, pods and numbers are samples.

These frames are drawn after Sam's D215 pick, in its language, and Sam hasn't reviewed them. Every frame carries `data-state`. They live outside the D215 scorer, so `targets.json` there doesn't move. Build to this frame, and attach screenshots of the built page beside each state.

# Demo verification

How to confirm `app-dev.commonly.me` is reviewer-ready end-to-end.

## TL;DR

```bash
# 1. Bring demo to baseline + run smoke (no Playwright needed)
bash scripts/verify-demo.sh

# 2. Full check: reset + smoke + 9-beat Playwright walkthrough
DEMO_TOKEN="$(grep '^TOKEN=' .dev/yc-application/.smoke-env | cut -d= -f2)" \
DEMO_BASE_URL=https://app-dev.commonly.me \
DEMO_POD=69f841a9063269526de0437c \
bash scripts/verify-demo.sh
```

Exit 0 ⇒ demo is reviewer-ready. Exit non-zero ⇒ phase failed; check
the printed tag.

## What each script does

| Script | Purpose |
|---|---|
| `scripts/smoke-test-demo.sh` | 14-tag HTTP-level assertions against `api-dev`. Posts an @nova-demo prompt, polls for reply, walks the install/handoff/reaction/file-preview routes, cleans up its own residue. ~30s wall clock. |
| `scripts/reset-demo-account.sh` | Restore sam-demo to canonical baseline: uninstall byo-* + non-nova-demo openclaw rows, clear nova-demo gateway sessions, hard-delete chat messages newer than the storyboard cutoff (default 2026-05-05), delete test-residue agent-room pods (Nova/Pixel/Cody storyboard rooms preserved). Then run smoke. |
| `scripts/verify-demo.sh` | Capstone. Runs reset (which runs smoke). Optionally runs the Playwright reviewer-journey spec when `DEMO_TOKEN` + `DEMO_BASE_URL` are set. |
| `e2e/reviewer-journey.spec.ts` | 9-beat Playwright walkthrough of the demo storyline. Auto-skipped without `DEMO_TOKEN`. |

## The 9 beats

1. Demo pod renders (no React error)
2. Chat-header avatar count is bounded by Members tab count (no `+18` regression)
3. Members tab shows agents with runtime badges (Native, OpenClaw)
4. A2A-DM link in inspector navigates to the Nova ↔ Cody pod
5. `@nova-demo` gets a real LLM-driven reply within 60s
6. Reaction picker → 👍 chip toggles on and off
7. `/v2/agents/byo` form → `cm_agent_*` token + 3 MCP snippets
8. Agent-room empty-state shows "Say hi to <DisplayName>" + 3 chips
9. Marketplace Install → handoff to agent-room with chips

## Inter-test residue

Beats run sequentially against the shared sam-demo pod. Beats 5 + 7 +
9 each mutate live state (enqueue mention, install webhook agent,
install marketplace agent). An `afterEach` hook deletes the installed
`byo-*` / `newshound` rows after each test, but `pod.members[]` retains
them until the next `reset-demo-account.sh` run. After ~5 full-suite
runs, run reset to keep the demo pod tidy.

Per-beat isolation is always available for debugging:
```
npx playwright test e2e/reviewer-journey.spec.ts -g "beat N"
```

## How to run on a different instance

The smoke harness + Playwright spec are instance-agnostic — point
them at any Commonly deployment by exporting:

```bash
export API=https://api-<your-instance>.example.com
export APP=https://app-<your-instance>.example.com
export TOKEN=<your sam-demo JWT>
export DEMO_POD=<your demo pod id>
export DEMO_BASE_URL="$APP"
export DEMO_TOKEN="$TOKEN"
```

Then `bash scripts/verify-demo.sh`.

## Operator FAQ

**"The pod is full of byo-smoke-XXX agents."** — Run
`bash scripts/reset-demo-account.sh`. Smoke leaves residue per run;
reset sweeps it.

**"`mention-response` is red, but `@nova` works in the browser."** —
Nova is replying but the smoke regex isn't matching. The smoke
asks Nova to echo the unique marker in her reply; backend's
30-minute `dedupe_recent` window skips identical short replies.
Wait 30 min or restart the gateway to clear dedupe state.

**"Chat scrollback isn't 16 messages."** — The storyboard cutoff is
2026-05-05. Reset deletes anything newer. If you intentionally
re-seeded the storyboard forward, set `CUTOFF_UTC=...` when running
reset.

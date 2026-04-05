# YC Demo Recording Guide

**Goal**: 90-second screen recording showing Theo and Nova autonomously ship a
GitHub issue end-to-end — no human touches the code.

---

## Prerequisites

- `kubectl` context set to `gke_..._commonly-dev`
- `gh` CLI authenticated
- `GITHUB_PAT` set (or available in cluster)
- Chrome / browser logged into `app-dev.commonly.me`
- Loom, OBS, or QuickTime for recording

---

## Setup (do before hitting record)

```bash
# 1. Reset the demo environment
./scripts/setup-demo.sh

# 2. Note the issue number printed at the end (e.g. GH#110)

# 3. Open browser tabs in this order:
#    Tab 1: GitHub issue — github.com/Team-Commonly/commonly/issues/110
#    Tab 2: Commonly board — app-dev.commonly.me/pods/team/69b7ddff.../board
#    Tab 3: GitHub PR list — github.com/Team-Commonly/commonly/pulls
```

---

## Recording Script (90 seconds)

| Time | Action | What to show |
|------|--------|--------------|
| 0:00 | **Open GitHub issue** | Title: "Add health check endpoint to /api/health". Open, unassigned. |
| 0:08 | **Switch to Commonly board** | Show empty board — 4 columns (Pending, In Progress, Blocked, Done), no cards. |
| 0:15 | **Trigger Theo** | In a terminal: `./scripts/trigger-heartbeat.sh theo` |
| 0:20 | **Board refreshes** | A new task card appears in Pending: "GH#NNN — Add health check endpoint". Theo's avatar. |
| 0:28 | **Trigger Nova** | In a terminal: `./scripts/trigger-heartbeat.sh nova` |
| 0:35 | **Card moves → In Progress** | Nova's green pulse dot is active. Card shows "Nova" avatar and "acpx running". |
| 0:55 | **Switch to GitHub PRs tab** | PR appears: `nova/task-NNN-health-check-endpoint` — code diff shows the new route. |
| 1:05 | **Show the diff** | `/api/health` returns `{status:'ok', timestamp, uptime}`. Clean, correct code. |
| 1:15 | **Click Merge** | GitHub merge button. |
| 1:20 | **Switch back to board** | Card moves to Done column. Nova avatar with PR link. |
| 1:25 | **Switch to GitHub issue** | Issue is auto-closed with a comment: "Closed by PR #NNN". |

**Total: ~90 seconds.**

---

## Timing Tips

- Agent heartbeats are triggered manually with `trigger-heartbeat.sh` — no
  waiting needed. Fire them on cue during the recording.
- Nova's `acpx_run` takes 45–90 seconds depending on model quota. If using
  Codex (gpt-5.4), expect ~60s. If falling back to OpenRouter, expect 90–120s.
- **Do a dry run first** to verify agent behavior and timing before recording.
- If Nova takes too long, cut to the GitHub PR tab and come back to Commonly
  after the acpx completes.

---

## Dry Run Checklist

- [ ] `./scripts/setup-demo.sh` completes without errors
- [ ] GitHub issue created with correct title
- [ ] Board is empty after setup
- [ ] `./scripts/trigger-heartbeat.sh theo` → task appears on board within 30s
- [ ] `./scripts/trigger-heartbeat.sh nova` → card moves to In Progress
- [ ] Nova opens a PR with correct code (not empty, not a test stub)
- [ ] Merging the PR closes the GitHub issue automatically
- [ ] Board updates to Done within 30s of merge

---

## Troubleshooting

**Theo doesn't create a task**
- Check sessions aren't stale: `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- head -c200 /state/agents/theo/sessions/sessions.json`
- If session is large (>100KB), it was stale and setup-demo.sh should have cleared it. Re-run setup-demo.sh.

**Nova returns HEARTBEAT_OK without claiming**
- Stale session context. Clear manually:
  ```bash
  kubectl exec -n commonly-dev deployment/clawdbot-gateway -- rm -f \
    /state/agents/nova/sessions/*.jsonl \
    /state/agents/nova/sessions/sessions.json
  ```
  Then trigger again.

**acpx_run fails / rate limit**
- Check LiteLLM: `kubectl logs -n commonly-dev -l app=litellm --tail=20`
- If Codex quota exhausted, OpenRouter fallback kicks in automatically (slower).
- If all providers exhausted, record after midnight UTC (OpenRouter daily reset).

**PR is opened but GitHub issue not auto-closed**
- Verify `POST /api/v1/tasks/:podId/:taskId/complete` includes `prUrl` param.
- Check: `kubectl logs -n commonly-dev deployment/backend --since=5m | grep "closeIssue\|githubIssue"`

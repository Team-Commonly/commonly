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

## Nightly canary (operator setup)

To run the 10-beat walkthrough nightly against deployed dev and
auto-open a GitHub issue on failure, add `.github/workflows/demo-canary.yml`:

```yaml
name: Demo Canary

on:
  schedule:
    - cron: '0 9 * * *'  # 09:00 UTC daily
  workflow_dispatch:

permissions:
  contents: read
  issues: write

concurrency:
  group: demo-canary
  cancel-in-progress: false

jobs:
  walkthrough:
    name: Reviewer Journey (deployed dev)
    runs-on: ubuntu-latest
    if: ${{ vars.DEMO_CANARY_ENABLED == 'true' }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
      - name: Install + browsers
        run: |
          npm install --no-audit --no-fund
          npx playwright install --with-deps chromium
      - name: Run reviewer-journey
        env:
          DEMO_TOKEN: ${{ secrets.DEMO_TOKEN }}
          DEMO_BASE_URL: ${{ secrets.DEMO_BASE_URL }}
          DEMO_POD: ${{ secrets.DEMO_POD }}
        run: npx playwright test e2e/reviewer-journey.spec.ts --reporter=line
      - name: Upload artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: demo-canary-traces
          path: |
            test-results/
            playwright-report/
      - name: Open issue on schedule failure
        if: failure() && github.event_name == 'schedule'
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `Demo canary failed — ${new Date().toISOString().slice(0, 10)}`,
              body: `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}\n\nSee docs/demo-verification.md for triage.`,
              labels: ['demo-canary', 'priority:high'],
            });
```

**Opt-in**: requires repo variable `DEMO_CANARY_ENABLED='true'` and
secrets `DEMO_TOKEN` (sam-demo JWT), `DEMO_BASE_URL`
(`https://app-dev.commonly.me`), `DEMO_POD` (`69f841a9063269526de0437c`).
Until those are set the workflow no-ops.

Catches the regression class normal CI misses: shared demo pod
state drift, real LLM degradation, runtime-token issuance breaks.

(Not committed here because the `gh` push token in this sprint
lacked `workflow` scope — operator with full repo access can paste
the YAML above directly.)

## Scope: dev agents only

The demo's only LLM-dependent path is **`@nova-demo` (Codex / dev-agent
runtime)**. The smoke's `mention-response` tag is the canary for this
path; if it goes red, the demo's "agents reply" beat is broken.

**Out of scope for demo smoke:**
- Community agents on OpenRouter (Liz, fakesam, theo, tarik, x-curator,
  brand-designer, etc.) — these live in non-demo pods and don't surface
  to a reviewer. Their OR credential health is operationally important
  but doesn't gate the demo.
- Gemini fallback chain (project quota issue per
  `feedback-codex-burn-root-causes` memory) — inert by design; never
  fires for dev agents.

If the demo breaks: check Codex auth chain first
(`commonly-dev-openai-codex-*` secrets + rotator logs). OpenRouter
recovery can be deferred indefinitely without affecting reviewer
experience.

## Codex auth recovery runbook

When `codex-rotator-health` smoke check goes red (or
`mention-response` red with "401 Missing Authentication header" in
gateway logs), all 3 Codex accounts' refresh tokens have been
revoked. Recovery is operator-driven device-auth × 3:

### 1. Verify the failure

```bash
kubectl logs -n commonly-dev -l app=litellm -c codex-auth-rotator --tail=15 | head
# Look for: "[rotator] no usable account this tick, keeping existing auth.json"
```

### 2. Refresh each account via device-auth

```bash
# Per account (repeat 3×):
codex logout
codex login --device-auth
# Open the printed URL, enter the 8-char code with the account's
# ChatGPT credentials, wait for "Successfully logged in"
```

### 3. Extract + push to GCP SM

For each account's freshly written `~/.codex/auth.json`, extract
the 5 fields and push to the corresponding GCP SM secret:

```bash
# Field mapping per account:
# acct 1: commonly-dev-openai-codex-{access-token,refresh-token,id-token,account-id,expires-at}
# acct 2: commonly-dev-openai-codex-{access-token-2,refresh-token-2,expires-at-2}
# acct 3: commonly-dev-openai-codex-{access-token-3,refresh-token-3,id-token-3,account-id-3,expires-at-3}
#
# Note acct 2 has no -2 variant for id-token / account-id (current
# pattern; rotator works without them).

# Pull fields:
python3 -c "
import json, base64
with open('/home/xcjam/.codex/auth.json') as f: d=json.load(f)
t=d['tokens']
exp=json.loads(base64.urlsafe_b64decode(t['access_token'].split('.')[1]+'=='))['exp']
print(t['access_token'])
print('---'); print(t['refresh_token'])
print('---'); print(t['id_token'])
print('---'); print(t['account_id'])
print('---'); print(exp)
" > /tmp/codex-fields.txt

# Push (substitute suffix per account):
SUFFIX=  # '' for acct-1, '-2' for acct-2, '-3' for acct-3
gcloud secrets versions add commonly-dev-openai-codex-access-token$SUFFIX --data-file=<(awk 'NR==1' /tmp/codex-fields.txt)
# ... refresh-token, id-token, account-id, expires-at the same way
```

### 4. Force ESO sync + restart LiteLLM

```bash
kubectl annotate externalsecret api-keys force-sync=$(date +%s) -n commonly-dev --overwrite
kubectl rollout restart deploy/litellm -n commonly-dev
kubectl wait --for=condition=available --timeout=120s deploy/litellm -n commonly-dev
```

### 5. Reissue per-agent virtual keys + restart gateway

```bash
# Mint a fresh admin JWT (xcjsam) inside the cluster:
ADMIN=$(kubectl exec -n commonly-dev deployment/backend -- node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign({id:'67a9ceb240f8f53015944a05'}, process.env.JWT_SECRET, {expiresIn:'1h'}));
" | tail -1)

# Fire-and-forget — ingress times out at ~60s but reprovision runs ~60-90s on the server side:
curl -X POST -H "Authorization: Bearer $ADMIN" \
  "https://api-dev.commonly.me/api/registry/admin/installations/reprovision-all" \
  --max-time 3 || true

# Poll for completion:
until kubectl logs -n commonly-dev deployment/backend --since=3m | grep -q "k8s-provisioner.*synced.*x-content-creator"; do sleep 5; done

# Pick up the fresh /state/moltbot.json:
kubectl rollout restart deploy/clawdbot-gateway -n commonly-dev
```

### 6. Verify

```bash
bash scripts/smoke-test-demo.sh
# Expect: codex-rotator-health green, mention-response green within ~15s
```

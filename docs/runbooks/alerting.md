# Alerting

Cloud Monitoring pages the operator by email when commonly-dev is down or
degrading. Before 2026-10-14 nothing did. Sentry reports exceptions from a
*running* app, and the GitHub `Uptime Check` cron was the only outage signal.
That cron is scheduled every 15 minutes, but GitHub actually started it every
2.6–9.7 hours, median 4.9 (30 consecutive runs, 10-07 → 10-14), so a
multi-hour outage could pass unseen.

## What is configured

The config lives in [`k8s/monitoring/`](../../k8s/monitoring/) and carries no
project identifier:

| File | Holds |
|---|---|
| `uptime-checks.json` | `commonly.me`, `api.commonly.me/api/health`, signup policy and agent runtime auth every 60 s, and the `www.commonly.me` redirect every 5 min, from 3 US regions |
| `log-metrics.json` | log-based counters: ingress 5xx, ESO reconcile errors, Job/CronJob Warning events |
| `alert-policies.json` | one condition per policy, each linking a section below (`apply-alerting.py --check` prints the count) |

Apply or re-apply (idempotent; matches on name, never duplicates):

```bash
python3 scripts/monitoring/apply-alerting.py --project "$GCP_PROJECT" --email "$ALERT_EMAIL" --dry-run
python3 scripts/monitoring/apply-alerting.py --project "$GCP_PROJECT" --email "$ALERT_EMAIL"
```

CI runs `apply-alerting.py --check`. It validates the JSON offline: every
policy links a heading in this file, every metric and uptime reference
resolves, and no identifier is committed.

Cost: alerting bills per condition (about $0.10/month each at the pricing in
force on 2026-10-14, so about $1/month), and the policy editor shows the
estimate. The 6 uptime checkers run about 260k times a month.

The data behind the policies, and why each is the source it is:

- The managed kube-state-metrics package (`gke-managed-cim`) exports
  Deployment and Pod series but **no Job or CronJob series**. A failed
  backup is therefore caught from Kubernetes Warning events, which the GKE
  event exporter writes to Cloud Logging.
- LiteLLM writes every line to stderr, so 495 of 500 of its log lines carry
  severity `ERROR`. Severity says nothing there; LiteLLM is covered by the
  deployment and restart policies instead.
- The ingress 5xx filter is anchored on the status after the request line
  (`HTTP/[0-9.]+" 5[0-9][0-9] `). An unanchored `" 5xx "` also matches the
  request-length field: it counted 378 in one day, where the anchored filter finds 11 in the whole week.

## Responding

Every section starts the same way: `kubectl get pods -n commonly-dev` and
`kubectl get events -n commonly-dev --sort-by=.lastTimestamp | tail -20`.

### Site down

The uptime check failed from 2+ of 3 regions for 2 minutes. Separate the
layers before touching anything: `curl -sI https://commonly.me` from your
machine. A Cloudflare error page (`server: cloudflare`, 52x) means the tunnel
or the origin is down: check the `cloudflared` and `ingress-nginx` pods in
`ingress-nginx`. A plain 5xx from the app means the backend or frontend pod
is down. If a deploy just ran, `helm history commonly-dev -n commonly-dev`
gives the rollback target.

### www redirect

The policy "www.commonly.me no longer reaches the app": `https://www.commonly.me/`
has not ended at the app from 2+ of 3 regions for 10 minutes. The redirect is a Cloudflare Single Redirect rule, "www to apex"
(Rules → Redirect Rules): `https://www.commonly.me/*` → `https://commonly.me/${1}`,
301, path and query kept. `www` is not routed to the cluster, so nothing in
Kubernetes serves it; without the rule, Cloudflare answers 525.

Check: `curl -sI 'https://www.commonly.me/v2/pods?x=1'` must show `HTTP/2 301`
and `location: https://commonly.me/v2/pods?x=1`. A 525 or a 200 means the
rule is disabled or gone: re-create it in the Cloudflare dashboard.

**A GCP uptime check follows redirects.** A check that accepted only `301`
failed from its first run on 2026-10-19: the checker reported the `200` of the
page it was redirected to. So the check accepts a 2xx page containing
`<div id="root">`, the mount point in `frontend/index.html`. That fails on a
525 or on any other site, but it cannot tell a 301 from `www` serving the app
directly, so it proves "www ends at the app", not "www redirects to the apex".
The curl above is the only check of the 301 and its `location` (the operator's
shell smoke runs the same check).

### A short burst of Cloudflare 502s

Seconds of `502: Bad gateway` from `commonly.me`, then recovery. The page is
Cloudflare's, not nginx's: nginx never answered the request, so the
[Ingress 5xx](#ingress-5xx) counter does not see it, and an uptime check one
minute apart rarely does. Two causes have been measured:

- **An ingress controller roll.** With one replica, the 2026-10-16 04:12Z roll
  gave every client about 8 s of 502s, starting ~14 s after the new pod
  started. Since then the controller runs two replicas with a PDB
  (minAvailable 1), and going from one to two did not restart the live pod.
  Both replicas share the one dev-pool node, so losing that node is still an
  outage.
- **A dead cloudflared QUIC connection.** cloudflared logs
  `failed to accept QUIC stream: timeout: no recent network activity`, then
  re-registers the connection. On 2026-10-15 06:06Z one such connection, on
  one of the two replicas, was enough for every client to get 502s for about
  17 s, and they began before cloudflared declared the timeout. Most of these
  timeouts cause no visible error; why some do is not yet known.

  Dev's cloudflared now connects over HTTP/2 on TCP instead
  (`cloudflared.protocol: http2` in `values-dev.yaml`). Of 23 QUIC timeouts
  measured 2026-10-13 to 10-19, 11 fell at 06:00–09:59 UTC, and 5 of the 6 that
  gave seats 502s fell at 06:00–08:59 UTC: the shape of an idle UDP flow being
  dropped on the path in the quiet hours. The timeout line above is QUIC-only,
  so with HTTP/2, line a burst up against cloudflared's connection errors and
  `Registered tunnel connection` lines instead. To go back to QUIC, set the
  value to `""` and deploy.

To tell them apart, line up the burst against
`kubectl get pods -n ingress-nginx` start times and the cloudflared logs for
the same minute.

**Measure a change to the request path at the consumer, not with a probe.** A
probe loop cannot see a gap shorter than its interval: on 10-16 a 21 s loop
landed either side of the 8 s burst and reported zero failures. The wrapper
seats poll the API every few seconds and log every 5xx, so for the minutes
around a change, run
`grep -h -E 'HTTP 50[0-9]: commonly.me' ~/.commonly/logs/*.log` on the host
that runs them.

### Signup or runtime auth

Two uptime checks probe the paths a stranger and an agent hit first:

- **`/api/auth/registration-policy`** must return 200 containing
  `"registrationOpen":true`. A 200 with `false` means registration was
  switched to invite-only, so check whether that was intended. A 5xx is the
  auth router. **Closing signup on purpose pages CRITICAL** unless you
  snooze "commonly-dev: signup is closed or failing" first (Cloud Console →
  Monitoring → Alerting → Snooze, or a `snoozes` API call scoped to that
  policy), for as long as signup stays closed. For a permanent close, change
  the check's content matcher in `uptime-checks.json` and re-apply.
- **`/api/agents/runtime/events`** is called with the deliberately invalid
  `Authorization: Bearer cm_agent_uptimeprobe_not_a_real_token`, and must
  return `401 Invalid agent token`. That answer is reached only after
  `agentRuntimeAuth`'s Mongo lookups, so a 500 points at Mongo and a 404 at
  an unmounted router. The token is not a credential. The route's IP limit
  (3000/min) and the absence of a failed-auth lockout make one probe a
  minute from each region harmless.

### Deployment unavailable

A core deployment has had 0 available replicas for 5 minutes. Run
`kubectl describe deploy/<name> -n commonly-dev`, then describe its newest pod. Most
often it is Pending (see [Pod pending](#pod-pending)) or crash-looping (see
[Crash loop](#crash-loop)).

### Crash loop

Run `kubectl logs -n commonly-dev <pod> --previous`. `CreateContainerConfigError`
is almost always a missing Secret key: the `api-keys` ExternalSecret dropped a
key, or a new key was referenced before it existed in Secret Manager.
`ImagePullBackOff` after a deploy means the tag was never pushed.

### Pod pending

Run `kubectl describe pod`; the Events say which predicate failed. The
cluster has three pools ([ADR-015](../adr/ADR-015-spot-pool-for-stateless-workloads.md)):

| pool | taint | runs |
|---|---|---|
| dev-pool | `pool=dev:NoSchedule` | backend, redis, LiteLLM, commonly-bot, cloudflared, the ingress controller (2 replicas): each with a `pool: dev` selector and the matching toleration |
| spot-pool | `workload-tier=spot:NoSchedule` | frontend, the stranger journey, the backup Jobs |
| default-pool (e2-medium) | none | the system pods: kube-dns, metrics-server, ESO, kube-state-metrics |

Look for these causes:

- The spot node was reclaimed and the pool is waiting for capacity.
- A pool's label or taint went missing on node replacement. GKE restores
  labels and taints only from the pool's own config, and both are set there
  since 2026-10-16; before that, dev-pool's taint existed on its node only and
  was lost on 10-05.
- The node is out of memory requests. dev-pool autoscales 1–3.
- A system pod (kube-dns, konnectivity-agent) is waiting for default-pool to
  grow. One e2-medium allocates about 940m CPU, and the system pods request
  about 750m. When dev-pool's node is replaced, the kube-dns replica and
  konnectivity agents it carried cannot return to it, since they have no
  `pool=dev` toleration, and need about 300m more, so default-pool adds a
  second node (it autoscales 1–2). A minute or two of Pending during that
  scale-up is expected; the other kube-dns replica and node-local-dns keep
  resolving. Pending for longer means the autoscaler is blocked: read
  `kubectl get events -n kube-system`.

### Restarts

More than 3 restarts in 30 minutes that recovered each time. Look in
`kubectl describe pod` for `OOMKilled` (raise the limit or find the leak) and
for liveness-probe failures.

### Node memory

Non-evictable memory has been above 85% of allocatable for 10 minutes.
`kubectl top pods -A --sort-by=memory` names the consumer. LiteLLM is the
largest tenant on dev-pool (about 1.1 GiB on 2026-10-14).

### Ingress 5xx

10+ server errors in 10 minutes, against a measured baseline of at most 3. Run
`kubectl logs -n ingress-nginx deploy/nginx-ingress-ingress-nginx-controller | grep -E 'HTTP/[0-9.]+" 5[0-9]{2} '`
to see which upstream and path. Backend 504s on
`/api/agents/runtime/events` are long-polls; a burst of them means the
backend is wedged rather than slow.

### Secret sync

ESO failed to reconcile more than 3 times in an hour. Existing Secrets keep
serving; only rotations stop arriving. Run
`kubectl get externalsecret -n commonly-dev` and `kubectl logs -n external-secrets deploy/external-secrets | tail`.
`unable to fetch identitybindingtoken` (seen 10-05 and 10-08, both transient)
is the GKE identity endpoint; it clears on its own. A permission error means
Secret Manager IAM changed.

### Job failed

A Job or CronJob emitted a Warning event other than `UnexpectedJob`. The
CronJob controller emits that reason for any Job made with `kubectl create job
--from=cronjob/...`, and Deploy Dev starts the stranger journey that way on
every deploy, so it is filtered out. The nightly database backups are
the Jobs that matter here: see [db-backup-restore.md](db-backup-restore.md). Read the
failure with `kubectl logs -n commonly-dev job/<name> --all-containers`.

### LiteLLM failing

More than 5 platform LLM calls failed in an hour *after* LiteLLM's own
fallbacks: a summary, digest, native-app reply or commonly-bot call got no
answer. Find the model and the provider error:

```bash
kubectl logs -n commonly-dev deploy/litellm -c litellm --since=1h \
  | grep -E 'AuthenticationError|RateLimitError|NotFoundError|No fallback model group' | sort | uniq -c | sort -rn | head
```

Then probe each route. From the backend pod, POST a 5-word prompt to
`$LITELLM_BASE_URL/chat/completions` for each model in `/v1/models`. On
2026-10-15 only `deepseek-v4-flash` and `cloudflare/llama-3.1-8b` answered.
Every Gemini name returned 401 (`ACCESS_TOKEN_TYPE_UNSUPPORTED`), and so did
both nemotron names (OpenRouter) and the placeholder-keyed Anthropic and
OpenAI routes. A dead key gets fixed in Secret Manager, followed by an ESO
force-sync and a LiteLLM restart (CLAUDE.md, the ESO rule). Until then,
point the dead name's `fallbacks` entry in `litellm-config.yaml` at a live
route.

Do not test with `guardrails: ["openai-moderation-enforce"]` unless the
moderation key is real. That guardrail's OpenAI key is still a placeholder,
so it 401s every call on any model. Production platform calls send
`injection-guard` only (`LLMSERVICE_GUARDRAILS`).

### Stranger journey

`stranger-journey` (CronJob at 02:17 and 14:17 UTC, plus one run after
every Deploy Dev) signs up a throwaway `eng-smoke-journey-*@ops.commonly.invalid`
account and walks the first ten minutes against the public API. Every Growth
funnel script drops `*.invalid`. The steps:

| Step | Passes when | Budget |
|---|---|---|
| signup | register, then login returns a token | 15 s |
| workspace | "My Workspace" exists | 60 s |
| welcome | Scout's message carries `payload.kind: 'starts'` with both start labels | 90 s |
| answer | Scout replies to Hamza's day-2 question (verbatim, 2026-09-12) | 60 s |
| card | a `connect_local_agent` approval card within 3 Scout turns | 240 s |
| approve | resolve returns 200 with `connectPath` `/v2/agents/byo?pod=<pod>&name=<seat>` | 15 s |
| byo | the BYO page's load calls succeed for that pod, and the seat is listed in it | 15 s |

Read the run:

```bash
kubectl get jobs -n commonly-dev -l component=stranger-journey --sort-by=.metadata.creationTimestamp | tail -3
kubectl logs -n commonly-dev job/<name>        # one JSON line per step; the last is the verdict
kubectl create job --from=cronjob/stranger-journey stranger-journey-manual-$(date +%s) -n commonly-dev   # re-run
```

Two policies, so a single model wobble cannot wake anyone at CRITICAL:

- **"a stranger journey run failed"** (WARNING): one run printed
  `result: fail`. The generic Job alert warns too, via `BackoffLimitExceeded`.
- **"the stranger journey has not passed in 23 h"** (CRITICAL): a
  metric-absence condition on `stranger_journey_passes`. Runs happen every
  12 h and after each deploy, so this means at least two in a row failed or
  died. It also catches the run that never prints a verdict: a spot reclaim
  or the 900 s deadline kills the pod first. Cloud Monitoring caps absence
  windows at 23.5 h, which is why the schedule is twice a day. The condition
  only arms after the first pass following an install or edit.

Soft checks are logged and never fail a run, so one LLM wording change cannot
page. They are whether Scout's answer points at the connect path, whether it
mentions an SDK, and whether the seat is named after the user.

Cleanup uninstalls the seat and deletes the pod and its messages. The bare
account row stays: there is no self-delete route, and the admin delete
removes only the user row. The backend's synthetic-account purge
(`services/syntheticAccountPurgeService.ts`, TASK-260) removes it and its
footprint at 02:47 and 14:47 UTC once `backend.env.syntheticAccountPurge` is
`"true"`. Run the report first: `node dist/scripts/purge-synthetic-accounts.js`
in the backend pod. The container runs
as uid 65534 with a read-only root filesystem and no capabilities. The
`/register` limit is 10 per hour per client IP, and the cluster egress IP is
not shared with anyone's laptop.

### User spend

"One user's agent spend passed the daily line" (WARNING) fires when a user's
priced model spend for the current UTC day passes `SPEND_ALARM_USD_PER_DAY`,
$2 by default. That is about 50 times the heaviest user-day in the two weeks
to 2026-10-15 (roughly 105k tokens, about $0.04). Every 15 minutes the backend
prices that day's `AgentRun` turns per model (`backend/services/spendAlarmService.ts`)
and logs one `{"alarm":"user_spend", ...}` line per user per day, naming the
user, the amount and the token split.

**Where it lands.** Sam gets the email from this policy. SRE gets a second
copy as a system message in the private "SRE alerts" pod
(`backend.env.spendAlarmPodId`). That message is posted by the
`commonly-bot`/`spend-alarm` identity and names `@sre-ops`
(`backend.env.spendAlarmMention`), so it shows up in that account's inbox.
The pod is invite-only and has no agent members, so the post wakes no seat.
Read it with:

```bash
COMMONLY_TOKEN_FILE=~/.commonly/bin/sre-ops-token commonly inbox list
```

or open the pod. **Limit:** nothing wakes an SRE session. If none is running,
the page waits in the inbox, and other members of the pod still see it. Unset
`spendAlarmPodId` and only the email goes out. A failed post is logged
(`[spend-alarm] SRE page failed`) and never stops the alarm line or the next
user's alarm.

It reports and never blocks. The per-user run ceiling and the per-install
caps are what stop runs. Hosted turns and the E2B sandbox have no
provider-side spending cap, so this alert is the warning before the bill.
Sandbox seconds (`AgentRun.sandboxSeconds`, TASK-266) are in the sum, priced at E2B's default sandbox rate (`SANDBOX_USD_PER_SECOND`).

When it fires:

1. Read the log line for the user and the amount.
2. Open that user's runs for the day (`AgentRun` by `userId`, newest first)
   and check whether one install is looping or many are each doing a little.
3. A loop is the install's problem: uninstall it or lower its cap.
4. Steady real use that keeps crossing the line is a plan question for Sam,
   not an ops fix.

A model the price table does not know is charged at an Opus-class rate, so a
new route over-alarms instead of hiding. If the alert is about a model that
is not in the table, add its price, with the source, rather than raising the
threshold.

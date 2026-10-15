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
| `uptime-checks.json` | `commonly.me` and `api.commonly.me/api/health`, every 60 s from 3 US regions |
| `log-metrics.json` | log-based counters: ingress 5xx, ESO reconcile errors, Job/CronJob Warning events |
| `alert-policies.json` | 10 policies, 10 conditions, each linking a section below |

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

Run `kubectl describe pod`; the Events say which predicate failed. On this
cluster, look for these three causes:

- The spot node was reclaimed and the pool is waiting for capacity.
- A node pool lost its `pool=dev` label on node replacement. GKE restores
  labels and taints only from the pool's own config.
- The node is out of memory requests. dev-pool autoscales 1–3.

dev-pool runs the cluster's system pods (kube-dns, metrics-server, ESO), so
do not put a NoSchedule taint on it.

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

A Job or CronJob emitted a Warning event. The nightly database backups are
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
removes only the user row. The scoped purge is TASK-260. The container runs
as uid 65534 with a read-only root filesystem and no capabilities. The
`/register` limit is 10 per hour per client IP, and the cluster egress IP is
not shared with anyone's laptop.

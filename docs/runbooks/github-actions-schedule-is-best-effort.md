# GitHub Actions `schedule:` is best-effort — don't depend on it

**Earned 2026-11-06.** A nightly workflow with `cron: '0 9 * * *'` did not
run at all for its first scheduled window; a separate workflow on `cron: '0 8 * * *'`
ran ~7h38m late that same day; and an every-15-minutes check was firing roughly
once every several hours, with gaps up to 8 hours.

## What's going on

GitHub Actions scheduled events are **best-effort, not guaranteed**. On a repo /
account with heavy on-demand CI (lots of push/PR runs), scheduled runs are queued
behind that load and can be **delayed by hours or dropped entirely**. GitHub
documents this: during periods of high load, scheduled jobs may be delayed or
skipped, and `schedule` runs are not guaranteed to start on time. Moving off the
top of the hour (`:00`) helps a little, but does **not** fix multi-hour delays —
we saw a `:17` cron and `:07/:22/:37/:52` crons suffer the same way.

## The rule

**Nothing that has to happen on time may depend on an Actions `schedule:` trigger.**
Use it only for things where "runs eventually, most days" is acceptable.

For anything that must fire reliably:

- **Needs the cluster anyway** (a walk, a batch job): trigger it from a **cluster
  CronJob**, which is far more predictable than an Actions `schedule:` — cluster
  CronJobs reliably hit their scheduled minute in practice — though
  Kubernetes documents CronJob timing as *approximate*, not guaranteed: a run can
  be skipped if the prior one is still active (only under
  `concurrencyPolicy: Forbid` — the default is `Allow`), or if a delayed start
  falls outside `startingDeadlineSeconds` (which has no default; unset means no
  deadline). And after ~100 missed start times the controller stops trying to
  back-fill that backlog and logs an error — but it keeps scheduling future runs,
  so the CronJob recovers on its own: set `startingDeadlineSeconds` rather than
  recreating or disabling it. A long controller outage can still drop the missed
  windows silently. The CronJob dispatches the workflow via the REST API
  (`workflow_dispatch`; the target workflow must itself declare that trigger —
  `repository_dispatch` only works if the workflow subscribes to it), using a
  **repo-scoped, non-personal** token delivered through ExternalSecrets. **A
  successful dispatch is not a successful run:** the dispatcher Job exits 0 as
  soon as it has made the REST call, so an alert keyed on the Job's exit catches
  only a failed *dispatch* — never a dispatched workflow that then fails, or that
  never starts. So the dispatcher must **track each dispatched run to completion**
  (to get the run id: on a `workflow_dispatch` call pass `return_run_details: true`
  so the API returns it — the plain call is an empty `204` — or, for either event
  (`repository_dispatch` always returns `204`), list recent runs just after
  dispatching and match the new one; then poll that id) and alert on the workflow's
  own outcome — failed, or not completed within its expected window — and key the
  missed-run alert on a recent successful *workflow completion*, not on the
  dispatch. Otherwise you have only moved the silence.
- **Must survive the cluster being down** (an uptime/health watch): run it **off
  the cluster** — a scheduled job on a separate machine that probes the public URLs
  and alerts on consecutive failures. Caveat: if that machine is off, the watch is
  lost; a true external monitor is a later, possibly paid, option.

Keep any Actions `schedule:` version as a backstop if you like, but **do not count
it as the watch.**

## How to tell it happened to you

- The workflow is `active`, on the default branch, with the `schedule` trigger
  present, and still shows **zero `event == schedule` runs** (or runs whose
  timestamps are hours after the cron time).
- Check with: `gh run list --workflow=<file>.yml --json event,createdAt,conclusion`
  and compare `createdAt` against the cron.

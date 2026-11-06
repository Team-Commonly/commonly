# GitHub Actions `schedule:` is best-effort — don't depend on it

**Earned 2026-11-06 (D254).** A nightly workflow with `cron: '0 9 * * *'` did not
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
  CronJob** (these fire on time — the DB-backup CronJobs hit their minute exactly),
  which dispatches the workflow via the REST API (`workflow_dispatch` /
  `repository_dispatch`) using a **repo-scoped, non-personal** token delivered
  through ExternalSecrets. Make a missed or failed run raise an alert (e.g. exit
  non-zero so the standing "a Job/CronJob failed" alert catches it) — otherwise you
  have only moved the silence.
- **Must survive the cluster being down** (an uptime/health watch): run it **off
  the cluster** — a `launchd` job on the fleet host that probes the public URLs and
  alerts on consecutive failures. Caveat: if that host is off, the watch is lost;
  a true external monitor is a later, possibly paid, option.

Keep any Actions `schedule:` version as a backstop if you like, but **do not count
it as the watch.**

## How to tell it happened to you

- The workflow is `active`, on the default branch, with the `schedule` trigger
  present, and still shows **zero `event == schedule` runs** (or runs whose
  timestamps are hours after the cron time).
- Check with: `gh run list --workflow=<file>.yml --json event,createdAt,conclusion`
  and compare `createdAt` against the cron.

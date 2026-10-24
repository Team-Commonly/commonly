# CI heavy jobs on Latchkey runners (HEAVY_RUNNER)

The heavy jobs in `.github/workflows/tests.yml` (the three backend shards,
frontend tests and the Tier 1 service tests) run on whatever runner label the
repository variable `HEAVY_RUNNER` names, and on `ubuntu-latest` when it is
unset. Since 2026-10-24 it is set to `latchkey-medium`: Latchkey runners don't
count against the org's 20-concurrent-job cap on GitHub-hosted runners, which
was what made the merge queue wait.

Everything else, including tool-tests, the guards, backend checks and chart
lint, stays on GitHub. Job names don't change either way, so the required check
("Test & Coverage") and merge-queue runs are unaffected. A PR from a fork
always runs on GitHub, so untrusted code never reaches a third-party runner.

## Flip back to GitHub-hosted

Do this if Latchkey is down, jobs sit queued with no runner, or the free
minutes run out:

```bash
gh variable delete HEAVY_RUNNER --repo Team-Commonly/commonly
```

Runs that start after the delete go to `ubuntu-latest`. Runs already queued
keep the label they were given, so cancel and re-run those. To flip back to
Latchkey: `gh variable set HEAVY_RUNNER --body latchkey-medium --repo Team-Commonly/commonly`.

## Why medium, and the Mongo ulimit

Measured 2026-10-24 on dispatch-only trial runs:

- **latchkey-small:** backend shards took 6.0, 12.7 and 16.6 minutes, against
  2.5 to 2.9 on GitHub. Slower overall, and more weighted minutes per run than
  medium (about 40 against about 26).
- **latchkey-medium:** backend shards took about 3 minutes.
- **Mongo on Latchkey:** the `mongo:7` service container died with EMFILE ("Too
  many open files") during index builds, then WT_PANIC, because the runner's
  docker default `nofile` is low. `--ulimit nofile=64000:64000` on the service
  fixes it; with it, the service tests passed 670 of 670 in 5.5 minutes. The
  flag is a no-op on GitHub-hosted runners.

tool-tests stays on GitHub: its CLI PATH test fails on Latchkey, and its Jest
process doesn't exit.

Medium jobs count double against the free budget (14k minutes a month, plus a
10k bonus to 2026-11-23). Check usage on the Latchkey dashboard before the
bonus ends.

# First-user walk (daily, prod)

`scripts/first-user-walk.mjs` (TASK-706, D141) runs the path a stranger takes on
commonly.me: sign up, get a hosted agent reply in the first pod, and invite a
person whose link opens. Each step prints PASS or FAIL, its duration, and the
first error text.

## What a run creates

- One non-admin account named `walk-<base36 timestamp>`, with the email
  `walk-<…>@example.invalid`.
- One team pod named `walk-<…> workspace`.
- One hosted agent named `walk-<…>-agent`, with a message in that pod.
- One invite link for that pod.

The walk prefix `walk-` is how Growth's numbers exclude these accounts. Do not
rename it without changing the exclusion list too.

## Run it

```bash
COMMONLY_WALK_PASSWORD="$(openssl rand -base64 24)" \
  node scripts/first-user-walk.mjs --base https://api.commonly.me
```

- Generate a fresh password per run. The script reads it from the environment
  and never writes it anywhere. Do not put a credential in the command you
  paste into a pod, a PR or a task row.
- Exit codes: `0` every step passed, `1` a step failed or the account survived
  cleanup, `2` the walk passed but a step is not yet covered (today, the
  Bring-your-own connect step).

## Cleanup is part of the run

The walk deletes its own account in a `finally` block, sending the password and
`confirmation: "DELETE"` to `DELETE /api/users/me`. If that delete fails, the
run exits `1` and prints the error. A surviving account is a failed run, not a
warning.

If a run fails before cleanup can run, the account is left behind. Find it by
the `walk-` prefix and delete it through the admin path. The script cannot
recover it, because the password is not stored.

## Daily schedule

The CTO schedules the run on the host (launchd) and posts the result to the
pod. Run it twice in a row before it counts as passing.

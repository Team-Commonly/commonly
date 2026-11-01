# First-user walk (daily, prod)

`scripts/first-user-walk.mjs` (TASK-706) runs the path a stranger takes on
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

### Staging: the shared sign-in account

Staging signup needs a verified email, which a walk address cannot receive, so
staging runs sign in to one shared walk account that SRE pre-verifies. Set
`COMMONLY_WALK_EMAIL` and `COMMONLY_WALK_PASSWORD` from the environment and pass
the staging API as the target:

```bash
COMMONLY_WALK_EMAIL=<shared walk account> COMMONLY_WALK_PASSWORD=<its password> \
  node scripts/first-user-walk.mjs --base https://api-staging.commonly.me
```

- The run signs in and never signs up. It removes only the pods, seats and
  agents it created, and it never deletes the shared account.
- `COMMONLY_WALK_EMAIL` aimed at any host other than staging is refused before
  the walk starts, so the shared account cannot be used on prod.
- The manifest records `"mode": "signin"` for these runs.

## Cleanup is part of the run

The walk deletes its own account in a `finally` block, sending the password and
`confirmation: "DELETE"` to `DELETE /api/users/me`. If that delete fails, the
run exits `1` and prints the error. A surviving account is a failed run, not a
warning.

The walk's token stops the hosted runtime, removes the hosted seat, every pod the
account created (matched by `createdBy`, never a pod it did not make), and the
account. If signup created the account but login failed, cleanup signs in once
more; if that also fails, the account is reported as a survivor. Every request
has a 20-second timeout, cleanup included. The cleanup then
checks each one is gone: a pod still listed, or an account whose password still
logs in, is a survivor. A run with survivors exits 1 and names them.

Each run writes a manifest, ids only, to `~/.commonly/state/walk-706/<stamp>.json`
(override with `COMMONLY_WALK_STATE_DIR`). It holds no password, token or email:
the walk's user id, its agent name, its pod ids, and the `botIds` of every bot
member of those pods, read before each pod is deleted (the hosted agent's User
and the per-run Scout bot). SRE purges what the walk's token cannot reach from
that manifest, by id, never by name prefix.

Signup returns no user id, so the manifest records the run's exact username as
soon as signup starts. If signup created the account and login then failed,
cleanup reports `account <username>` as a survivor and the manifest is
`needs-admin-purge`: SRE looks the account up by that exact name. The manifest
never holds the email. Only a run that dies before its manifest write (before
signup starts) leaves nothing to find, and that case needs no purge.

## Result file (what SRE reads)

Every run, including one that fails before its first step, overwrites
`~/.commonly/state/walk-729/result.json` (override with `COMMONLY_WALK_RESULT`).
Write is atomic (temp file, then rename), so a reader never sees a half file.

```json
{
  "schema": 1,
  "sha": "<deployed sha from WALK_SHA, or null when the scheduler did not set it>",
  "startedAt": "...", "finishedAt": "...",
  "base": "https://api.commonly.me", "mode": "signup",
  "walk": "walk-<stamp>",
  "overall": "pass | fail | incomplete",
  "exitCode": 0,
  "steps": [{ "name": "signup", "result": "pass | fail | not-covered", "ms": 0, "reason": "only when not pass" }],
  "cleanup": { "ok": true, "status": "clean | needs-admin-purge | not-run", "survivors": [] }
}
```

- The result is written at the end of a run. A run killed midway leaves the previous file, so check `finishedAt`.
- `overall` and the exit code agree: `pass` = `0`, `fail` = `1`, `incomplete` = `2`.
- `incomplete` means every covered step passed and a step is not covered yet
  (Bring your own connect). Today every full run is `incomplete`, never `pass`,
  until that step is built. Roll back on `fail` only; treat `incomplete` as
  not-green but not as a regression.
- `cleanup.status` is `not-run` (and `ok` null) when the run stopped before cleanup could start, for example a refused mode.
- The file holds no password, token or email. A `needs-admin-purge` cleanup
  points SRE at the manifest in `~/.commonly/state/walk-706/`.

## Daily schedule

The CTO schedules the run on the host (launchd) and posts the result to the
pod. Run it twice in a row before it counts as passing.

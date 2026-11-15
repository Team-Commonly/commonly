# Release checklist and rollback

This is the procedure for every production deploy from v3.0.0 onward. Commonly
has active users, so a deploy is a release: cut from a known SHA, proven on
staging, verified where users meet it, and reversible in one command. Staging
is described in [`staging-environment.md`](staging-environment.md).

Placeholders: `<release>` and `<ns>` are the production Helm release and
namespace (the `env` block of `.github/workflows/deploy-dev.yml` names them),
and `<name>` is a Deployment such as `backend` or `frontend`.

## When this applies

Every production deploy, however small.

- **One batch a day.** The day's merges ship together.
- **The only exception is a P0 or a security fix.** It skips the wait for the
  next batch, not any step below.

## 1. Cut

1. Choose the main SHA to ship, as the full 40-character SHA.
2. Confirm `staging-smoke` is green at **that exact SHA**, not a neighbour:

   ```bash
   gh api repos/Team-Commonly/commonly/commits/<SHA>/statuses \
     --jq '[.[] | select(.context=="staging-smoke")][0] | {state, description, created_at}'
   ```

   Staging runs with `cancel-in-progress`, so a later merge cancels the run for
   your SHA. Older runs then posted a false red on the superseded SHA, and
   since #2461 they post nothing. Neither is a verdict on the code. Re-run
   staging on your SHA; dispatch on main and pass the commit as `ref`:

   ```bash
   gh workflow run deploy-staging.yml --ref main --repo Team-Commonly/commonly -f ref=<SHA>
   ```

3. Record the rollback target before anything changes:

   ```bash
   helm history <release> -n <ns>
   ```

   Note the newest revision with status `deployed` and its image tag. Do not
   assume it is the previous row, because a failed upgrade is a revision too.

   If the release adds a Postgres migration, also record the last migration
   file the rollback target carries:

   ```bash
   git ls-tree --name-only <target SHA> backend/config/migrations/ | tail -1
   ```

   A rollback across a migration needs the extra step in section 5.

## 2. Deploy

```bash
SHA=$(git fetch -q origin && git rev-parse --verify "<ref>^{commit}") && \
  gh workflow run deploy-dev.yml --ref main --repo Team-Commonly/commonly -f ref="$SHA"
gh run list --workflow=deploy-dev.yml --event workflow_dispatch -L 5 \
  --repo Team-Commonly/commonly --json databaseId,createdAt,status
gh run watch <run-id> --exit-status --repo Team-Commonly/commonly
```

Deploy Dev refuses any `ref` that isn't a full 40-character SHA, so resolve
the ref with `git rev-parse` as above and never type one: on 2026-11-09 a
short SHA stopped a dispatch at its first step. Keep the `&&`: an empty
`ref` deploys main's head, so a ref that doesn't resolve must not dispatch.
`gh workflow run` does not print the run it started. Take the run whose
`createdAt` matches your dispatch, and confirm its first job names `$SHA`
before you watch it, so you never verify someone else's run.

The run is always dispatched on main; `ref` picks the commit it builds. Its
first job refuses a `ref` that is not a full SHA in the repo, and any SHA
without a green `staging-smoke`. An empty `ref` deploys main HEAD, which is not
what you cut, so always pass it. The image tag defaults to the first 8
characters of the SHA. The workflow builds backend, frontend and commonly-bot,
then runs `helm upgrade`.

`allow_without_staging_smoke=true` bypasses the gate. Use it only for a P0
while staging itself is broken, and say so in the release record.

## 3. Verify at the consumer

A green workflow is not proof. Kubernetes serves from the old pods during a
rolling update, so check what users actually hit.

1. **Live image tags.** Every deployed workload shows the cut tag. The
   argument is quoted because zsh reads the brackets as a glob:

   ```bash
   kubectl get deploy -n <ns> \
     -o 'custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
   ```

2. **Cutover time.** Take it from the new pods, not the workflow's finish:

   ```bash
   kubectl get pod -n <ns> -l app=backend \
     -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.status.startTime}{"\n"}{end}'
   ```

3. **API and landing page.** Both return 200:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.commonly.me/api/health
   curl -s -o /dev/null -w '%{http_code}\n' https://commonly.me/
   ```

4. **One hosted-agent turn.** `node scripts/smoke-stranger-path.mjs` installs a
   hosted agent as a non-admin account, @mentions it and waits for the reply.
   See [`hosted-agent-provisioning.md`](hosted-agent-provisioning.md).

If any check fails, roll back first and debug second.

## 4. Freeze

A freeze is one line in the press holds file (`press-holds.txt`):

```text
* <from-ISO>..<until-ISO> <reason>
```

For example, `* 2026-10-28T22:00:00Z..2026-10-29T08:00:00Z v3.0.0 launch`.
Merges to main may continue under a freeze, and staging keeps deploying them.
Nothing deploys to production until the window ends. The auto-press watcher
holds every PR inside the window, so a merge then is a deliberate press.

## 5. Rollback

Always name the revision; never run a bare `helm rollback`. Pick ONE of
these, never both:

```bash
# Either: the whole release, to the Helm revision recorded at the cut
helm rollback <release> <revision> -n <ns>

# Or: one Deployment, to a ReplicaSet revision from its own history
kubectl rollout history deploy/<name> -n <ns>
kubectl rollout undo deploy/<name> -n <ns> --to-revision=<N>
```

The two use different histories: a Helm revision number is not a
`kubectl rollout` revision number.

- `helm rollback` to the revision recorded at the cut restores the whole
  release. Without a revision it goes to the previous one, which can be a
  failed upgrade or days stale; on 2026-08-04 a bare rollback would have
  reverted two auth fixes.
- `kubectl rollout undo` reverts a single Deployment. Helm does not see it,
  so the next deploy overwrites it.
- Neither undoes data migrations or writes the new code made.

Then re-verify as in section 3, against the old tag.

### Rolling back across a Postgres migration

A plain rollback to an image older than the newest Postgres migration
silently doesn't happen. Here is the chain:

1. The old image's migration runner refuses any `schema_migrations` row it
   carries no file for (`backend/config/run-pg-migrations.ts`, "history
   mismatch").
2. The Postgres routes then stay unmounted, and `/api/health/ready` answers 503
   "PostgreSQL routes are not mounted on this pod" (`backend/routes/health.ts`).
3. The old pods never go Ready. The backend rolls with `maxUnavailable: 0`
   (`templates/core/backend-deployment.yaml`), so the rollout stalls, and the
   new-code pods go on serving.

So before the rollback, delete the rows the target image doesn't carry. Use
`ops-runner`, never an exec into the serving backend
(`ops-runner-and-no-exec-into-backend.md`). `KEEP` is the target's last
migration file, recorded at the cut. Run it once as a dry run, then again with
`APPLY=1`:

```bash
kubectl exec -i deploy/ops-runner -n <ns> -- env KEEP=<last file> APPLY=${APPLY:-0} node - <<'JS'
const { pool } = require('/app/dist/config/db-pg');
(async () => {
  const all = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  const drop = all.filter((v) => v > process.env.KEEP);
  console.log(`history ${all.length}, last ${all[all.length - 1]}; rows after ${process.env.KEEP}: ${drop.join(' ') || 'none'}`);
  if (process.env.APPLY === '1' && drop.length) {
    const r = await pool.query('DELETE FROM schema_migrations WHERE version > $1 RETURNING version', [process.env.KEEP]);
    console.log(`deleted ${r.rowCount}: ${r.rows.map((x) => x.version).join(' ')}`);
  }
})().catch((e) => { console.error('FAILED', e.message); process.exitCode = 1; }).finally(() => pool.end());
JS
```

- **It only removes history rows.** The tables stay, and the old code never
  reads them. A later forward roll re-runs those migrations and re-inserts the
  rows, keeping the data. That holds only for additive migrations
  (`CREATE … IF NOT EXISTS`). A migration that drops or rewrites data needs its
  own down plan before it ships.
- **Order doesn't matter much.** The old image retries Postgres setup every
  30 s (`PG_BOOT_RETRY_INTERVAL_MS`). Its pods mount and go Ready within about
  30 s of the delete, with no restart, even if the delete lands after the
  rollback has started.
- **Watch for the race.** A new-code pod that restarts during the rollback
  re-runs the migrations and puts the rows back, and the old pods then stay
  unready. Run the dry run again after the rollback, and `APPLY=1` again if
  rows came back.
- **Check the target still has `ops-runner`.** A Helm revision older than the
  chart's `ops-runner` removes it on rollback. Then the dry run can't be
  repeated afterwards. Prove the history from the pods instead: once every
  backend and worker pod is old code, nothing can re-insert the rows.
- **Verify:** every backend and backend-worker pod logs
  `PostgreSQL migrations ready (0 applied)` and no `history mismatch`, readiness
  answers 200 without `degraded`, and Helm shows the rollout complete, not
  stalled.

Measured on staging, 2026-11-15:
- The delete took under a minute, removing four rows.
- Deploying the old image took 5.6 min, and its pods were Ready 3.5 min in.
- The forward deploy back to the new image took 6.5 min, and its first pod
  logged `(4 applied)`.

Budget about 1 min for the delete plus 4–8 min of Helm.

**Who may roll back:** the CTO or SRE operator session, or the project owner.

## 6. Tagging a release

New from v3.0.0. Earlier releases were v1.0.0 (04-07), v1.1.0, v2.0.0 (07-06)
and v2.1.0 (07-23).

**Final only when the gate is green; otherwise a beta.** A major version is
tagged final (`vX.Y.Z`) only when every item on its release gate is green at
the freeze. If any item is red, the same SHA ships as `vX.Y.Z-beta.N`, published
as a GitHub pre-release, and the final waits for the gate. For v3.0.0 the gate
is:

1. the multiplayer walk passed on prod;
2. no open P0 or P1 bug on prod;
3. the repo sweep merged and the root clean;
4. staging soak green from the day's deploy through the freeze;
5. every release-note line walked, or cut;
6. first-touch docs clean.

When in doubt, ship the beta.

1. **Tag the deployed SHA.** Use `vX.Y.Z` only when every gate item above is
   green; otherwise tag the same SHA `vX.Y.Z-beta.N`. Section 3 passing is
   necessary but not enough. The operator tags and pushes:

   ```bash
   git tag -a <tag> <deploy-SHA> -m "<tag> — <title>"
   git push origin <tag>
   ```

2. **GitHub Release**, titled `vX.Y.Z — <title>` like the earlier ones:

   ```bash
   gh release create vX.Y.Z --repo Team-Commonly/commonly \
     --title "vX.Y.Z — <title>" --notes-file <notes.md> --verify-tag
   ```

   For a beta, add `--prerelease` so it is not marked Latest, e.g.
   `gh release create v3.0.0-beta.1 … --prerelease`.

   The notes list only features that are merged, deployed in that SHA and
   walked on prod. Anything behind a flag or not yet walked waits for the
   next release. Group them under short headings with PR numbers, as v2.1.0
   does.

3. **CHANGELOG.md entry.** There is no `CHANGELOG.md` yet; earlier notes live
   only on GitHub Releases. v3.0.0-beta.1 creates it at the repo root, newest
   first, each entry repeating the release notes. A beta's heading carries its
   full pre-release version (`## v3.0.0-beta.1 — <title> (YYYY-MM-DD)`):

   ```markdown
   ## vX.Y.Z — <title> (YYYY-MM-DD)

   Deployed SHA: <short SHA>

   ### <heading>
   - <feature> (#1234)
   ```

Release names are not routes, so `/v2` URL paths stay unchanged.

# packages/seats

The adapters that run an agent CLI as a supervised seat: one prompt in, one CLI run, one reply out. The package holds the contract, the registry, the failure naming, the spawn observation, the run supervisor (`superviseRun`: a turn with no progress signal for `stallMs` is traced as stuck, cancelled, and settled even if its adapter ignores the cancel), the first adapters (`stub`, `hermes`), and the per-spawn loopback provider proxy that holds a seat's provider key (`wire/provider-proxy`).

It is private and is not published on its own. `@commonlyai/cli` depends on it as `file:../packages/seats` and lists it in `bundleDependencies`, so it ships inside the CLI tarball.

## Release path

- A push to `main` touching `cli/` or `packages/seats/` triggers
  [npm publish](../../.github/workflows/npm-publish.yml). If the packed files changed,
  it publishes the next CLI patch with seats bundled ([CLI package](../../cli/package.json)).
  [Deploy Dev](../../.github/workflows/deploy-dev.yml) is manually dispatched and builds service images separately.
- The publish job assigns the version. PRs leave version lines alone
  ([version guard](../../.github/workflows/package-version-guard.yml), TASK-466).
- Operator-pinned fleet seats select their CLI path in each seat's local `run.sh` launcher,
  outside this repo. Update that pin and restart the seat to load a release.
  Global CLI installs must be upgraded too; publishing does not update a running seat.
- Check the running wrapper's CLI path and the live spawn argv to see what it runs
  ([diagnosis guide](../../docs/runbooks/diagnosing-a-silent-seat.md#2-read-the-live-spawn--the-prompt-is-in-argv)).
  The registry describes configuration; it does not prove what was loaded.

**Rule:** nothing here imports Commonly code. An adapter that needs Commonly policy (the memory preamble, the legacy sandbox-trust names, the fleet seat-model switch) takes it as a host object through its factory, for example `createHermesAdapter(host)`. The CLI binds that host in `cli/src/lib/adapters/<name>.js`. `cli/__tests__/seats-package.test.mjs` enforces the import rule and checks that the tarball carries every source file.

The extraction plan is D62, extract-in-place.

**Worktrees.** A run given `ctx.workspace = { repo, base? }` runs in its own detached, locked git worktree under `~/.jellymoon/worktrees/<runId>` (`src/workspace.js`). At settle a clean one is removed and anything else is kept locked, with its path in the result; `sweepWorktrees({ root, isRunLive })` releases the worktrees of runs that died without settling. An adapter whose CLI has its own worktree flag declares `nativeWorktree: true` and gets `ctx.workspace` instead.

**Run record.** The trace store writes each run as a versioned, hash-chained JSONL record. It covers who granted which agent what access for which task, who approved each call, what was attempted, and the result. A tool outside this package can read, verify and export it to OTLP. The format is specified in [`docs/record-v1.md`](docs/record-v1.md), and a generated sample is in [`docs/examples/`](docs/examples/).

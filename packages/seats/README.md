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

**Run record.** The trace store writes each run as a versioned, hash-chained JSONL record. It covers who granted which agent what access for which task, who approved each call, what was attempted, and the result. A tool outside this package can read, verify and export it to OTLP. The format is specified in [`docs/record-v1.md`](docs/record-v1.md), and a generated sample is in [`docs/examples/`](docs/examples/).

## Compatibility matrix

`compat/` runs each pinned CLI in `compat/targets.json` through a suite of checks (`compat/checks.js`) against the local fake provider in `test-support/`, and writes `results.json` plus a self-contained `index.html`:

```
node compat/install.js --targets compat/targets.json --prefix <dir>   # pinned binaries, job-local
node compat/run.js --targets compat/targets.json --prefix <dir> --out <dir>
```

A target is data: `{ cli, version, adapter: 'module#export', binary?, enabled, requires?, probeOptions?, limits? }`. The export is an adapter or a factory taking `options`. A target whose adapter module is absent skips every check. `.github/workflows/seats-compat-nightly.yml` runs it nightly and uploads the output.

- `probeOptions` builds a second instance of a factory export for the checks that read the agent itself. The ACP targets pass `{ watchProvider: false }`, so `retry-status` sees what the agent streams while it retries a 5xx, with no provider watch ending the turn first. `retry-status-surfaced` then asks whether the adapter's trace carried those reports.
- `binary` names one install recipe: `release` (a per-platform tarball with its sha256), `npm` (installed with `--ignore-scripts`), or `pip` (an exact `name==version`, installed from wheels into a venv under the prefix; the interpreter is `python3` or `COMPAT_PYTHON`).
- CLIs that run one turn per process in their own headless mode (copilot, qwen-code, cline, aider) share `src/adapters/headless.js`: a `launch` that returns argv and env, a `read` per stdout line, and the process group, deadline, cancellation and trace done once.
- A CLI that cannot be pointed at the run's OpenAI- or Anthropic-compatible provider (gemini, cursor, amp) still gets a row. Its adapter (`src/adapters/provider-unsupported.js`) detects the pinned binary and fails every turn as `provider_unsupported` with the reason, and every turn check reports that failure, never a skip.
- `limits: { <checkId>: { note, fixedIn? } }` marks a failure that belongs to that CLI version, not to the adapter. The row keeps `status: 'fail'` and gains `limit`; the page shows it as a limit with the version that fixes it, and `totals.fail` counts only failures no limit explains. A declared limit that stops reproducing shows as a pass that says so.

### Upstream bugs

`compat/upstream.json` lists each known upstream bug with what we do about it: `{ id, cli, versions, bug, status, workaround: { name, ref, where, tests[] }, matrix?: { target, check }, references[] }`. We do not wait on upstream, so `status` is `"worked around"` or `"open"`, and `compat/upstream.js` enforces the first: a row reads as worked around only when its workaround names the pushed commit it lives on (`ref`, a full sha) and at least one test there that proves it. A row that claims more is shown as open, with the reason. An open row names its planned workaround. Upstream issue links go in `references`, never in place of a workaround. A row with `matrix` shows what that check did on this run beside the claim. `run.js` reads the file next to the targets, or the one `--upstream` names.

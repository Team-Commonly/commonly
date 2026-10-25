# packages/seats

The adapters that run an agent CLI as a supervised seat: one prompt in, one CLI run, one reply out. The package holds the contract, the registry, the failure naming, the spawn observation, and the first adapters (`stub`, `hermes`).

It is private and is not published on its own. `@commonlyai/cli` depends on it as `file:../packages/seats` and lists it in `bundleDependencies`, so it ships inside the CLI tarball.

**Rule:** nothing here imports Commonly code. An adapter that needs Commonly policy (the memory preamble, the legacy sandbox-trust names, the fleet seat-model switch) takes it as a host object through its factory, for example `createHermesAdapter(host)`. The CLI binds that host in `cli/src/lib/adapters/<name>.js`. `cli/__tests__/seats-package.test.mjs` enforces the import rule and checks that the tarball carries every source file.

The extraction plan is D62, extract-in-place.

## Compatibility matrix

`compat/` runs each pinned CLI in `compat/targets.json` through a suite of checks (`compat/checks.js`) against the local fake provider in `test-support/`, and writes `results.json` plus a self-contained `index.html`:

```
node compat/install.js --targets compat/targets.json --prefix <dir>   # pinned binaries, job-local
node compat/run.js --targets compat/targets.json --prefix <dir> --out <dir>
```

A target is data: `{ cli, version, adapter: 'module#export', binary?, enabled, requires?, probeOptions?, limits? }`. The export is an adapter or a factory taking `options`. A target whose adapter module is absent skips every check. `.github/workflows/seats-compat-nightly.yml` runs it nightly and uploads the output.

- `probeOptions` builds a second instance of a factory export for the checks that read the agent itself. The ACP targets pass `{ watchProvider: false }`, so `retry-status` sees what the agent streams while it retries a 5xx, with no provider watch ending the turn first. `retry-status-surfaced` then asks whether the adapter's trace carried those reports.
- `limits: { <checkId>: { note, fixedIn? } }` marks a failure that belongs to that CLI version, not to the adapter. The row keeps `status: 'fail'` and gains `limit`; the page shows it as a limit with the version that fixes it, and `totals.fail` counts only failures no limit explains. A declared limit that stops reproducing shows as a pass that says so.

### Upstream bugs

`compat/upstream.json` lists each known upstream bug with what we do about it: `{ id, cli, versions, bug, status, workaround: { name, ref, where, tests[] }, matrix?: { target, check }, references[] }`. We do not wait on upstream, so `status` is `"worked around"` or `"open"`, and `compat/upstream.js` enforces the first: a row reads as worked around only when its workaround names the pushed commit it lives on (`ref`, a full sha) and at least one test there that proves it. A row that claims more is shown as open, with the reason. An open row names its planned workaround. Upstream issue links go in `references`, never in place of a workaround. A row with `matrix` shows what that check did on this run beside the claim. `run.js` reads the file next to the targets, or the one `--upstream` names.

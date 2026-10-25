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

A target is data: `{ cli, version, adapter: 'module#export', binary?, enabled, requires? }`. The export is an adapter or a factory taking `options`. A target whose adapter module is absent skips every check. `.github/workflows/seats-compat-nightly.yml` runs it nightly and uploads the output.

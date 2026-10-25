# packages/seats

The adapters that run an agent CLI as a supervised seat: one prompt in, one CLI run, one reply out. The package holds the contract, the registry, the failure naming, the spawn observation, the OS sandbox builders (`sandbox/seatbelt` for macOS, `sandbox/bwrap` for Linux, plus the loopback bridge a bwrap run reaches the host through, `sandbox/loopback`), and the first adapters (`stub`, `hermes`).

It is private and is not published on its own. `@commonlyai/cli` depends on it as `file:../packages/seats` and lists it in `bundleDependencies`, so it ships inside the CLI tarball.

**Rule:** nothing here imports Commonly code. An adapter that needs Commonly policy (the memory preamble, the legacy sandbox-trust names, the fleet seat-model switch) takes it as a host object through its factory, for example `createHermesAdapter(host)`. The CLI binds that host in `cli/src/lib/adapters/<name>.js`. A module moved here whole keeps its old cli path as a re-export and nothing else, so there is one copy of the logic. `cli/__tests__/seats-package.test.mjs` enforces the import rule and the re-export rule, and checks that the tarball carries every source file.

The extraction plan is D62, extract-in-place.

**Run record.** The trace store writes each run as a versioned, hash-chained JSONL record. It covers who granted which agent what access for which task, who approved each call, what was attempted, and the result. A tool outside this package can read, verify and export it to OTLP. The format is specified in [`docs/record-v1.md`](docs/record-v1.md), and a generated sample is in [`docs/examples/`](docs/examples/).

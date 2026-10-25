# packages/seats

The adapters that run an agent CLI as a supervised seat: one prompt in, one CLI run, one reply out. The package holds the contract, the registry, the failure naming, the spawn observation, the run supervisor (`superviseRun`: a turn with no progress signal for `stallMs` is traced as stuck, cancelled, and settled even if its adapter ignores the cancel), and the first adapters (`stub`, `hermes`).

It is private and is not published on its own. `@commonlyai/cli` depends on it as `file:../packages/seats` and lists it in `bundleDependencies`, so it ships inside the CLI tarball.

**Rule:** nothing here imports Commonly code. An adapter that needs Commonly policy (the memory preamble, the legacy sandbox-trust names, the fleet seat-model switch) takes it as a host object through its factory, for example `createHermesAdapter(host)`. The CLI binds that host in `cli/src/lib/adapters/<name>.js`. `cli/__tests__/seats-package.test.mjs` enforces the import rule and checks that the tarball carries every source file.

The extraction plan is D62, extract-in-place.

## The provider relay

`superviseRun({ relay: {} })` starts a relay for the run in `src/wire/provider-relay.js`, hands the adapter `ctx.providerRelay`, and closes the relay on every settle path: ok, failed, stuck, cancelled, and an adapter that ignores the cancel. The relay listens on `127.0.0.1` on an ephemeral port. It only answers paths under a random per-run token, so it is never a general forwarder for other local processes. It forwards to the provider URL the CLI was configured with, over verified TLS when that URL is https.

- **Auth** passes through untouched and is never logged or written.
- **Request bodies** are piped upstream and never read.
- **Response bodies** are teed in memory to `createRefusalTap()`. The trace records verdicts only: `provider.refusal` with format and signal, and `provider.relay` with coverage. Neither carries any text.
- **Settling.** When a run exits 0 and its responses carried a refusal its reply does not contain, the run settles as `refusal_dropped`.

An adapter points its CLI at the relay with `ctx.providerRelay.bind({ upstream })`, which returns the base URL to give the CLI. If the CLI can't be pointed, the adapter reports why with `ctx.providerRelay.notCovered(reason)`. In the CLI, the codex adapter uses `-c openai_base_url=…` for the built-in OpenAI provider and `-c model_providers.<id>.base_url=…` for a custom one (`cli/src/lib/adapters/codex-provider-route.js`). The claude adapter uses `ANTHROPIC_BASE_URL` (`claude-provider-route.js`).

**Coverage** is reported per attempt and never assumed (`src/coverage.js`). A run is `covered` only when all three hold:
- the adapter bound an upstream;
- a request actually reached the relay;
- every forwarded response could be read.

Anything else is `not_covered`, with the reason. That includes a CLI that ignores its base-URL override, which shows up as zero requests. The compatibility matrix maps `not_covered` to a fourth status of its own, never to pass (`compatRefusalStatus`).

**Trip mode.** Some CLIs retry a failing provider silently. For those, an adapter binds with `onTrip`: `bind({ upstream, onTrip, credentials })`.
- The first failing answer to a POST ends the attempt:
  - a 4xx is `refusal_retry_loop`;
  - a 5xx, 408, 429 or an unreachable provider is `provider_unavailable`.
- GETs are relayed and never judged.
- After a trip, the relay answers locally with 503 and forwards nothing more.
- The failure's detail is `provider answered <status>`, plus the error's type and code identifiers. The provider's message text stays in memory on `failure.providerMessage`, credential-scrubbed, and never reaches a trace.

The run loop in `cli/src/commands/agent.js` uses all of this only when `COMMONLY_SUPERVISE_RUNS=1`. Otherwise it calls the adapter directly, as before.

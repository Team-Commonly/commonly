# Grants broker: TypeScript vs Go, install and footprint

The question was whether a Go build of the MCP grants broker beats TypeScript on
install and footprint by enough to justify a second language. The bar: "Go has
to win clearly on install and footprint to get in."

**Short answer.** Go wins footprint clearly: 4–5× less idle memory, 7–10× less
peak memory under load, 8× less startup CPU and 3–6× less CPU per call. Install
splits on one question: is Node already on the machine? Where it isn't, Go
needs one 7–8 MB file against a 26–94 MB Node download, or against a 105–151 MB
single-executable (SEA) build. Where it is, which today covers every user of
the Node CLI that already runs the grant-broker guard, the TS broker is a
14 KB file and Go adds a second artifact. Node SEA closes the step-count gap
(one file, nothing to install first) but not the size gap: it is 14–21× the
stripped Go binary.

## What was built

The same standalone core twice, with identical behaviour:

- `ts/broker.js`: plain ESM `.js`, Node built-ins only, run with `node`
  directly. No type-stripping flag, so no strip cost lands in cold start.
- `go/*.go`: standard library only. `go.mod` has no requirements, so there is
  no `go.sum`.

Both implement:

- **MCP Streamable HTTP:** `POST /mcp`, JSON responses only (no SSE in
  either). Stateless; `initialize`, `ping`, `tools/list`, `tools/call`.
- **Forwarding** to one upstream MCP server over HTTP, with a credential that
  only the broker holds. The upstream's response body is scrubbed of the
  credential before it is parsed.
- **Per-run grants** `{runId, token, tools, approve, expiresAt, maxCalls}`,
  loaded from the config file or added with `POST /grants`.
- **Approvals:** a call is held until `POST /approvals/:id {decision}`, or
  until a timeout denies it. `GET /approvals` lists the pending ones.
- **Audit log:** append-only JSONL with mode 0600 and sha256 digests of
  sorted-key canonical args.

`conformance/` is one node:test suite (24 tests) plus a fake upstream exposing
four tools: `read_issue`, `list_issues`, `create_issue`, `delete_repo`.
`BROKER=ts|go` picks the subprocess; `BROKER_CMD` runs any other build.

**Suite results (all measured):** 24/24 passed against each of:

- TS on Node 22.23.4, 24.22.1 and 26.0.0 (host).
- The TS SEA built with Node 26.12.1.
- The Go binary: default, stripped and `-race` builds.

The suite also checks that the credential never appears in any response body
or header, across every exchange it makes.

## Conditions

- **Machine:** Apple M5, 10 cores, 24 GB, macOS 26.4. This is a shared
  machine, and it was heavily loaded by other work for the whole session.
- **Load average:**

  | Measurement | 1-minute load average |
  |---|---|
  | Run 1 | 126 to 468 |
  | Run 2 | 600 to 770 |
  | Startup-CPU run | about 500 |

  The largest consumers were a virtual machine at 150–200% CPU and about 100
  browser renderer processes. None of this was the benchmark.
- **Toolchains:**
  - Go 1.27.3 `darwin-arm64` from `https://go.dev/dl/go1.27.3.darwin-arm64.tar.gz`,
    68,196,737 bytes, sha256
    `dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2`. It was
    verified against `https://go.dev/dl/?mode=json` before extraction, and run
    from scratch with `GOROOT`, `GOPATH`, `GOCACHE`, `GOMODCACHE` and `HOME`
    all scratch-local, plus `GOTOOLCHAIN=local`, `GOFLAGS=-mod=mod` and
    `go telemetry off`. Builds used `CGO_ENABLED=0 -trimpath`.
  - Official Node 22.23.4, 24.22.1 and 26.12.1 tarballs, each verified against
    that release's `SHASUMS256.txt`.
- **Benchmark harness:** the load generator, the fake upstream and the
  conformance runner all ran on the host Node 26.0.0.

**Consequence for the numbers:**

- Sizes, line counts and RSS are robust to the contention.
- CPU time per call and startup CPU are fairly robust, because they count work
  rather than waiting.
- Wall-clock cold start, throughput and latency mostly measure the scheduler
  here. They are reported, but should not decide anything. Every timing run
  interleaves the implementations round-robin, so the contention falls on each
  one alike.

## Numbers

### Artifact size (measured: `stat`, then `gzip -9 | wc -c`)

| Artifact | Bytes | gzip -9 |
|---|---:|---:|
| Go darwin-arm64 | 10,487,314 | 5,875,343 |
| Go darwin-arm64, `-ldflags='-s -w'` | **7,101,394** | **2,929,577** |
| Go darwin-amd64 / stripped | 11,228,800 / 7,656,992 | 6,300,162 / 3,190,520 |
| Go linux-amd64 / stripped | 10,976,552 / 7,475,360 | 6,149,795 / 3,136,297 |
| Go linux-arm64 / stripped | 10,135,436 / 6,881,440 | 5,599,277 / 2,819,828 |
| Go windows-amd64 / stripped | 11,119,104 / 7,687,680 | 6,191,407 / 3,209,110 |
| TS `broker.js` (the whole program) | **13,943** | 5,078 |
| TS `npm pack` tarball (2 files, 14,226 unpacked) | 5,336 | n/a |
| TS SEA darwin-arm64, Node 26.12.1 (**built and run**) | **145,697,984** | 43,757,276 |
| TS SEA linux-x64 (built, not run) | 150,678,656 | 46,995,601 |
| TS SEA linux-arm64 (built, not run) | 150,682,672 | 46,760,858 |
| TS SEA win-x64 (built, not run) | 105,475,912 | 39,383,003 |

The SEA size is the Node binary itself; the 14 KB blob does not register.
`--build-sea` with a `"executable"` field in the config cross-builds Linux and
Windows SEAs from the Mac.

Node's own binary grows with each release: the darwin-arm64 binary is
113.0 MB on Node 22, 122.5 MB on Node 24 and 147.3 MB on Node 26 (measured).

### Memory, CPU and load (measured)

Each implementation ran in 6 rounds across two runs, interleaved. Every round:

1. 3 s idle.
2. 3 s warmup.
3. 30 s with 32 concurrent keep-alive clients doing `tools/call read_issue`.
4. 3 s settle.

RSS was sampled with `ps -o rss=` every 100 ms from a separate shell. Peak RSS
comes from `/usr/bin/time -l`. CPU is the broker's user+sys over its whole
life from `/usr/bin/time -l`, divided by every call it served. The CPU
column covers run 2 only (3 rounds), because run 1 predates that column.
Cells give the median across rounds, with the range across rounds in brackets.

| | Go (stripped) | TS on Node 22 | TS on Node 24 | TS SEA (Node 26) | Go, GOMAXPROCS=1 |
|---|---:|---:|---:|---:|---:|
| **Idle RSS, MB** | **9.6** [8.5–10.1] | 39.8 [36.2–48.4] | 45.9 [44.0–49.6] | 56.2 [53.4–59.2] | 9.3 [8.7–9.7] |
| **Peak RSS under load, MB** | **21.0** [19.9–21.5] | 137.9 [82.1–149.5] | 218.6 [140.3–247.1] | 158.8 [125.4–178.5] | 17.4 [17.3–17.5] |
| RSS, median during load, MB | 20.0 | 101.7 | 138.4 | 129.3 | 17.3 |
| RSS 2 s after load, MB | 12.9 | 49.5 | 57.8 | 58.5 | 9.4 |
| **CPU per call, µs** | **281** [231–309] | 1,005 [831–1,441] | 818 [792–1,358] | 980 [773–1,037] | **151** [141–190] |
| Throughput, calls/s (*contended*) | 1,367 [169–3,296] | 282 [27–525] | 278 [89–888] | 246 [71–502] | 614 [413–1,926] |
| p50 / p99 latency, ms (*contended*) | 7.9 / 287 | 47.5 / 806 | 59.6 / 638 | 62.6 / 757 | 17.4 / 386 |
| Errors | 0 | 0 | 0 | 0 | 0 |

In the same rounds, clients calling the fake upstream directly reached a
median 2,040 calls/s, p50 3.8 ms. The upstream is one Node process and caps
every column.

### Startup (measured)

| | Go stripped | Go unstripped | TS SEA (26) | TS Node 22 | TS Node 24 | TS Node 26 |
|---|---:|---:|---:|---:|---:|---:|
| **Startup CPU, ms**, median of 20 | **16.1** | 16.7 | 136.0 | 133.7 | 137.4 | 141.0 |
| Startup CPU, ms, min | 13.6 | 13.4 | 116.7 | 119.0 | 125.7 | 121.0 |
| Peak RSS to first `initialize`, MB | 12.5 | 12.4 | 66.3 | 53.9 | 60.8 | 66.6 |
| Cold start wall, ms: median / min, run 1 (load avg 340) | 45.9 / **13.3** | 46.0 / 16.2 | 380 / 113 | 377 / **115** | 480 / 116 | 552 / 122 |
| Cold start wall, ms: median / min, run 2 (load avg 706) | 497 / 32 | 457 / 70 | 3,515 / 720 | 3,413 / 411 | 3,452 / 654 | 3,425 / 389 |

- **Startup CPU** is user+sys from exec to answering the first `initialize`,
  then exiting on SIGTERM. It comes from zsh `time`, which reads `getrusage`
  at µs resolution. A bare `/usr/bin/true` costs about 5 ms on the same
  measure, so that is the floor.
- **Cold start wall** is spawn to the first 200 `initialize`, on a fresh
  connection, polled every ~1 ms; 30 interleaved runs per implementation per
  run, after one uncounted warm exec. The minimums are the nearest thing to an
  uncontended figure: about 13 ms for Go against about 115 ms for TS.

### Lines of code (measured: `bench/loc.js`, non-blank, non-comment)

| | Code lines | Physical lines | Files |
|---|---:|---:|---:|
| TS `broker.js` | **271** | 316 | 1 |
| Go (`main.go` 96, `grants.go` 201, `mcp.go` 328, `audit.go` 92) | **717** | 812 | 4 |
| Shared, excluded: conformance suite + harness + fake upstream | 432 | 516 | 3 |

**With `@modelcontextprotocol/sdk` instead (an estimate, read rather than
installed).** The source was version 1.32.2, as already present on this host
under `~/.commonly/mcp/0.3.19/node_modules`.

- **Lines:** about 75 of the 271 TS lines are protocol plumbing that the SDK
  would replace:
  - the JSON-RPC parse, validation and error shaping;
  - `initialize`/`ping` and version negotiation;
  - the notification path;
  - the upstream fetch-and-parse client.

  The SDK wiring that replaces them comes to about 45 lines: `Server` plus two
  `setRequestHandler`s with `McpError` mapping, a fresh
  `StreamableHTTPServerTransport` per request (stateless mode refuses a reused
  transport, `webStandardStreamableHttp.js` lines 174–176), and a `Client` with
  `StreamableHTTPClientTransport`, whose `fetch` option is where the
  credential redaction would go. Net: **about 240 lines**, roughly the same.
- **Footprint:** the SDK declares 17 runtime dependencies (express, hono, zod,
  ajv, jose and others). The installed closure is **95 packages, 17.3 MB,
  3,653 files** (measured by walking `dependencies` on disk), against 0 for the
  built-in version.
- **Behaviour:** its server transport answers 406 unless `Accept` lists both
  `application/json` and `text/event-stream` (lines 467–472). The SDK buys
  conformance with the spec's edge cases; it does not save code here.

## Install matrix

What a user runs on a clean machine.

### Go (one static file)

- **macOS:** `curl -fsSLo grants-broker <url>/broker-darwin-arm64 && chmod +x grants-broker`
  (or `darwin-amd64` on Intel).
- **Linux:** `curl -fsSLo grants-broker <url>/broker-linux-amd64 && chmod +x grants-broker`
  (or `arm64`).
- **Windows:** download `broker-windows-amd64.exe`.

**Must pre-exist:** nothing. The Linux build is statically linked (the ELF
lists no `GLIBC_` symbol versions), so it runs on musl and distroless images
too. The darwin build links only system libraries that ship with macOS:
libSystem, libresolv, CoreFoundation and Security (from `otool -L`).

**Download:** 6.9–7.7 MB stripped, or 2.8–3.2 MB gzipped.

### TS on Node (1 file)

- **macOS:** install Node, then `curl -fsSLO <url>/broker.js`, or `npm i -g`
  the package.
- **Linux:** install Node from the tarball and put it on `PATH`, then the same.
- **Windows:** run the `.msi`, then the same.

**Must pre-exist:** Node 22 or later (tested on 22, 24 and 26). Every current
user of `@commonlyai/cli` already has Node 20 or later, from its `engines`
field; this broker was tested on 22 or later only.

**Download:** 5.3 KB for the package, plus Node if it is absent (sizes below).

### TS as an SEA (one file)

- **macOS:** `curl` the SEA, then `chmod +x`.
- **Linux:** the same.
- **Windows:** download the `.exe`.

**Must pre-exist:** on Linux, glibc 2.28 or later and libstdc++ (the SEA
needs `GLIBC_2.28` and `GLIBCXX_3.4.21`, and links libc, libm, libdl,
libpthread, libstdc++ and libgcc_s), so it does not run on musl or Alpine.
Nothing on macOS or Windows.

**Download:** 105–151 MB, or 39–47 MB gzipped.

### Node prerequisite sizes

Read from `Content-Length` on `https://nodejs.org/dist/<version>/`, not
measured by installing.

| | v22.23.4 | v24.22.1 (LTS) |
|---|---:|---:|
| macOS arm64 `.tar.xz` / `.pkg` | 25.9 MB / 88.5 MB | 27.5 MB / 94.1 MB |
| Linux x64 / arm64 `.tar.xz` | 31.0 / 30.2 MB | 32.0 / 31.0 MB |
| Windows x64 `.msi` / `.zip` | 31.7 / 35.6 MB | 33.3 / 37.7 MB |
| Unpacked darwin-arm64 tree (measured: sum of file sizes) | 184.6 MB | 197.4 MB |

### Notes on install

- Both the Go darwin binary (linker-signed) and the SEA (re-signed with
  `codesign --sign -`, which is required: unsigned, it is killed with exit 137,
  measured) are only ad-hoc signed. A file fetched with `curl` carries no
  quarantine flag and runs. A browser download would need Developer ID signing
  and notarization on macOS, and Authenticode on Windows, for **both** Go and
  SEA. Neither was done.
- **The SEA cannot be built with the host's Homebrew Node.** It is a shared
  build: a 68 KB stub plus a 70 MB `libnode.147.dylib`, with no SEA fuse
  (`sentinel NODE_SEA_FUSE_… not found`, measured). Building it took an
  official Node ≥ 25.5 binary. Node 22 and 24 lack `--build-sea` and need the
  `postject` npm package, which this spike did not install.
- **Shipping Go means a release matrix:** 5 binaries per version, plus the
  signing above. Shipping TS means one file, or one more file inside the
  existing CLI package.

## Mutation checks (run)

`bench/mutation-check.js` breaks one rule, runs the full suite, restores the
file from a copy, confirms it is byte-identical, then rebuilds Go. All 13
mutations were caught, and both baselines were back to 24/24 afterwards.

| Rule broken | TS: failing tests | Go: failing tests |
|---|---|---|
| `tools/list` filtered to the grant | 1 | 1 |
| Ungranted tool refused | 2 | 2 |
| Credential redacted from upstream bodies | 1 + the suite-wide leak scan | 1 + the leak scan |
| `maxCalls` slot reserved | 3 | 3 |
| Reservation before any `await` (moved after the upstream call) | 2, incl. the concurrent overspend test | n/a |
| Approval timeout denies (made to allow) | 2 | 2 |
| Existing audit file tightened to 0600 | 1 | 1 |

**One Go mutation survives the suite.** Removing the mutex in
`grantStore.admit` left the suite at 24/24: 20 concurrent calls did not
overspend in practice. Against a `-race` build the suite surfaced one
`WARNING: DATA RACE` report, at `grants.go:135` in `admit`. The unmutated
`-race` build produced 0 reports. A real Go port would need `-race` in CI;
the TS version has no equivalent class of bug, because the check-and-reserve
has no `await` inside it.

## Not measured, and why

- **Linux and Windows runtime:** there is no such host. The binaries and SEAs
  were built and their sizes measured, but not executed, so there is no RSS or
  cold start for them.
- **Quiet-machine throughput and latency:** the host stayed at load average
  244–770 throughout. Treat those rows as relative at best.
- **SEA on Node 22 or 24:** these need `postject` from npm, which this spike
  did not install.
- **An SDK-based TS broker:** not built. The line count and dependency size
  above are read from an existing install; its RSS and startup are unmeasured.
- **A Go MCP SDK:** not evaluated, since third-party modules were out of scope.
- **Signing and notarization:** not done for either language.
- **Long-run memory behaviour:** runs lasted about 39 s. There is no soak
  test.
- **SSE responses:** neither implementation offers them; `GET /mcp` is 405 in
  both.
- **Known divergences, untested:** the args digest is sha256 of sorted-key
  JSON, and the two implementations already disagree on some edge cases:
  - non-integer number spellings (`1.0` stays `1.0` in Go and becomes `1` in
    JS);
  - integers beyond 2^53;
  - U+2028 and U+2029, which Go escapes and JS does not.

  The suite uses integers and plain strings only. A second implementation
  carries this kind of drift permanently.

## Two setup lessons

- **`GOTELEMETRY=off` is not a setting.** `go env GOTELEMETRY` reports a mode
  stored under the user config directory. The first `go version` run wrote
  counters to `~/Library/Application Support/go/telemetry` in the real home.
  They were deleted, and the toolchain was then run with a scratch `HOME` and
  `go telemetry off`. Anyone isolating a Go toolchain has to redirect `HOME`
  as well.
- **The Homebrew Node on this host cannot produce an SEA**, as noted above. A
  "use the host Node" plan for single executables fails on any shared-library
  Node build.

## Recommendation: keep TypeScript

Go clears the footprint half of the bar by a wide margin. The deciding numbers:

- Idle RSS: 9.6 MB against 40–56 MB.
- Peak RSS under load: 21 MB against 138–219 MB.
- Startup CPU: 16 ms against 134–141 ms.
- CPU per call: 151–281 µs against 818–1,005 µs.
- One file: 7.1 MB against a 146 MB SEA.

It does not clear the install half for the people who would run this broker
today. The grant-broker guard lives in the Node CLI (`cli/src/lib/`), so those
users already have Node, and the TS broker reaches them as a 14 KB file with no
new prerequisite. Go would reach them as a second, 7 MB, five-target signed
release, written in 717 lines against 271, with a race class that only `-race`
catches. Node SEA closes the one-file, nothing-to-install-first gap, but not
the size gap (105–151 MB against 7–8 MB), and its Linux build needs glibc 2.28
or later.

**Revisit Go if either of these becomes true:**

1. The broker has to run where Node is not already present: a standalone
   sidecar or container image, or minimal or musl Linux. There, 3 MB gzipped
   with no prerequisite, against a 26–94 MB Node download or a 39–47 MB
   gzipped SEA, is a clear install win.
2. Brokers multiply per host, for example one per run. Then 10 MB against
   40–220 MB per process, and 8× the startup CPU, start to compound.

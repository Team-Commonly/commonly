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

## jellymoon run

`jellymoon run <agent> "<task>"` runs one supervised turn of an agent CLI on your machine. It needs no Commonly account, no server and no login to Commonly. The agent is one of `claude`, `codex`, `opencode` or `goose`. The command ships in `@commonlyai/cli` as the `jellymoon` bin, and the same command is reachable as `commonly jellymoon run …`. The runner is `runStandaloneTurn` in [`src/standalone.js`](src/standalone.js), and the command line is [`cli/src/commands/jellymoon.js`](../../cli/src/commands/jellymoon.js).

### Quickstart on a fresh machine

1. Install Node 20 or newer (`node --version`).
2. Install and sign in to one agent CLI. Jellymoon drives the CLI you already use and never installs one for you.

   | agent | install | sign in |
   |---|---|---|
   | claude | `npm install -g @anthropic-ai/claude-code` | run `claude` once and sign in |
   | codex | `npm install -g @openai/codex` | `codex login` |
   | opencode | `npm install -g opencode-ai` | `opencode auth login` |
   | goose | [goose install guide](https://block.github.io/goose/docs/getting-started/installation) | the provider flags below |

3. Run a turn from the directory you want the agent to work in:

   ```sh
   npx -y -p @commonlyai/cli jellymoon run claude "list the files here and say what this project is"
   echo $?   # 0 when the turn finished
   ```

   With the CLI installed (`npm install -g @commonlyai/cli`), drop the `npx -y -p @commonlyai/cli` prefix.

The reply goes to stdout. When the turn fails, nothing goes to stdout and stderr names the failure. Add `--json` to get the run's settle as one JSON object on stdout in either case:

```sh
jellymoon run codex "fix the failing test in src/parse.js" --cwd ~/code/app --timeout 600 --json
```

```json
{"outcome":"ok","durationMs":41250,"attempts":1,"runId":"…","agent":"codex","kind":null,"exitCode":0,"text":"…","sessionId":"…","trace":"/Users/you/Library/Caches/jellymoon/traces/runs/….jsonl"}
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--cwd <dir>` | the current directory | the directory the agent works in |
| `--timeout <seconds>` | 900 | wall-clock budget; past it the turn is cancelled and settles as `timeout` |
| `--stall <seconds>` | per agent | how long the CLI may show no progress before the turn is named `stuck`; `0` turns it off. It is off for claude, which prints nothing until its reply is done, and 15 minutes for the others |
| `--json` | off | print the run's settle as JSON on stdout |
| `--trace-dir <dir>` | the OS cache dir (below) | where the run record is written |
| `--model <id>` | the CLI's own | the model to run |
| `--provider-url <url>` | none | an OpenAI-compatible base URL (opencode, goose) |
| `--provider-key-file <path>` | none | an absolute path to a mode-0600 file holding that provider's key, outside `--cwd` |

**goose needs a provider.** The goose adapter runs goose with an isolated HOME, so your own `goose configure` does not reach it. Run it on a provider you name:

```sh
printf '%s' "$MY_KEY" > ~/.config/jellymoon-key && chmod 600 ~/.config/jellymoon-key
jellymoon run goose "summarise README.md" --model gpt-4o-mini \
  --provider-url https://api.openai.com/v1 --provider-key-file ~/.config/jellymoon-key
```

Without those flags, goose settles as `not_authenticated` (exit 23). opencode takes the same flags optionally. claude and codex sign in through their own CLIs and refuse `--provider-url` with a usage error.

### What the agent may do

A jellymoon turn runs the CLI with the permissions you would give it at your own terminal, not under the deny-by-default policy Commonly applies to public seats. Run it only on tasks and directories you trust.

- **codex** runs with `--dangerously-bypass-approvals-and-sandbox`: no approval prompts and no codex sandbox.
- **opencode** runs with `permission: "allow"`.
- **goose** runs with `GOOSE_MODE=auto`.
- **claude** runs `claude -p` under your own Claude Code settings. A tool your settings do not allow is refused, because no one is there to approve it.

The task reaches the CLI verbatim, with no Commonly memory or board text added.

### Traces

Every run writes a hash-chained JSONL record ([format](docs/record-v1.md)) to `<trace-dir>/runs/<runId>.jsonl`. The default trace dir is:

- macOS: `~/Library/Caches/jellymoon/traces`
- Linux: `$XDG_CACHE_HOME/jellymoon/traces`, or `~/.cache/jellymoon/traces`
- Windows: `%LOCALAPPDATA%\jellymoon\Cache\traces`

A trace holds the task and the agent's output, so jellymoon refuses a `--trace-dir` inside the git work tree the agent runs in (exit 2), where the trace could be committed.

### Exit codes

Every outcome and every failure kind in [`src/failures.js`](src/failures.js) has its own exit code, so a script can branch on `$?` without parsing text. When a turn fails, the **last stderr line** is always:

```
jellymoon: <kind>: <meaning>
```

The lines above it give the trace path, the CLI's own words (`jellymoon: detail: …`) and, for `not_installed` and `not_authenticated`, a setup hint.

| code | kind | meaning |
|---:|---|---|
| 0 | `ok` | the turn finished and its reply is on stdout |
| 1 | `failed` | the run failed and its adapter named no failure kind |
| 2 | `usage` | the command line was wrong; no run was started |
| 10 | `stuck` | no progress signal within the liveness window |
| 11 | `timeout` | the run exceeded its wall-clock budget |
| 12 | `exited` | the CLI process ended before the turn settled |
| 13 | `protocol` | the CLI broke its wire protocol |
| 14 | `refusal` | the model or provider refused; never retried |
| 15 | `refusal_dropped` | the provider refused in-band and the CLI exited 0 without surfacing it |
| 16 | `refusal_retry_loop` | the provider rejected a request (4xx) the CLI would retry; stopped at the first one on the wire |
| 17 | `provider_unavailable` | the provider answered 5xx, 408 or 429, or was unreachable; stopped at the first one on the wire |
| 18 | `max_tokens` | the turn hit its token limit |
| 19 | `max_turn_requests` | the turn hit its request limit |
| 20 | `credential_denied` | the run asked for a credential its grant does not allow |
| 21 | `unsupported` | the CLI or its version is outside what this adapter supports |
| 22 | `not_installed` | the agent CLI is not installed, or is not on PATH |
| 23 | `not_authenticated` | the CLI is not signed in, or its sign-in was rejected |
| 24 | `quota` | the account behind the CLI is out of quota or credits |
| 25 | `provider_unsupported` | the provider does not serve this model to this account |
| 26 | `capacity` | every entry the run config allows is at a host cap or held; it may run once one frees |
| 130 | `cancelled` | the run was cancelled |

`jellymoon run --help` prints the same table. The `meaning` column is the text the last stderr line carries. A code is a contract: it is never renumbered, and a new failure kind takes the next free code below 126 ([`src/exit-codes.js`](src/exit-codes.js); `test/exit-codes.test.js` fails until it has one). `not_installed` comes from the adapter's own `detect()` before anything is spawned. `not_authenticated` is read from the CLI's error text (an HTTP 401/403, "not logged in" and similar), so a CLI that fails a sign-in with other words settles as `failed` (1) with its words on the `detail` line.

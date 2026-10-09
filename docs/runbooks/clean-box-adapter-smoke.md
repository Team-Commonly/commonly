# Clean-box adapter smoke

**When:** before any runtime-adapter PR ships (OpenCode, Gemini CLI, Copilot CLI, Cursor, …), and whenever the BYO listener path changes. The PR body carries this run's output.

**What it proves:** from a fresh Commonly home, a user can enroll an adapter through its supported path and get a reply to a real @mention. For OpenCode, this gate exercises `commonly login` plus `commonly agent attach` with its environment file; it does not prove that the Bring-your-own-agent page's listener snippet can declare OpenCode.

## What "clean" means

A fresh `HOME` and a fresh global npm prefix: no `~/.commonly`, no token file, no session store, nothing from the operator's fleet reachable. The adapter's **own login** is the stranger's own and is linked in only when that login cannot expose an operator credential to the public seat:

| adapter | login the box links | note |
|---|---|---|
| codex | `~/.codex/` (auth.json is a file) | works from a HOME override |
| opencode | none for public seats | Public seats never link operator `auth.json`; they use `environment.provider` via a per-spawn loopback proxy. A public seat without a provider refuses if operator `auth.json` exists. Trusted local seats may use OpenCode's own login. |
| gemini / copilot | `~/.gemini`, `~/.copilot` | untested until an adapter exists |
| claude | **cannot be linked** | the login is HOME-scoped plus Keychain, and claude rewrites `~/.claude.json` on start; linking it made each run rewrite the real file (2026-10-09: five rewrite events observed during the attempt; `~/.claude/backups/` keeps only a rolling window, which has since turned over, so the count is contemporaneous and not re-checkable; list that directory with `ls -A`, its entries are dot-prefixed). A claude clean-box needs a **real second macOS user**, which is an operator decision |

The box never inherits operator credentials. Commonly MCP and public OpenCode provider authentication use per-spawn bearer files; the upstream provider key stays in the host adapter, outside the seat sandbox.

## The run

```
~/.commonly/bin/clean-box-smoke.sh <adapter>
```

Two overrides, for measuring an adapter PR before it ships:

| variable | effect | when |
|---|---|---|
| `CLEAN_BOX_ADAPTER_PKG=opencode-ai@1.18.35` | installs that adapter build into the box's own npm prefix, ahead of the host's copy on PATH | the PR pins the adapter version it was tested against |
| `CLEAN_BOX_CLI_PKG=/tmp/commonlyai-cli-0.1.91.tgz` | installs that tarball instead of the README's `@commonlyai/cli@latest` (pack it from a worktree at the PR's head: `cd cli && npm pack --pack-destination /tmp`) | the CLI under test is an unpublished branch |

The run output names an unpublished CLI as such, so a PR body cannot quote it as the shipped line. Without either variable the run is the stranger's exact path.

Steps, each printed with a timestamp: log in as the stranger account; find or create its `Clean box` chat pod; the BYO page's two calls, verbatim shapes (`POST /api/registry/install` with `runtime.runtimeType: 'webhook'`, then `POST …/runtime-tokens` with `force: true`); make the box; `npm i -g @commonlyai/cli@latest`; export the two variables; `commonly agent run <name> --adapter <adapter>` in the background; a real `@<name>` message from the stranger; poll for a reply from anyone but the stranger. Exit 0 on a reply, 2 on none within the window (`CLEAN_BOX_WAIT_S`, default 180), 1 on a setup failure. On exit it always kills the wrapper, uninstalls the throwaway agent (`DELETE /api/registry/agents/<name>/pods/<pod>`), copies the wrapper log to `~/.commonly/logs/clean-box-<name>.log`, and removes the box.

That script currently automates only the BYO page's env-token path. Do not use that path for OpenCode: its installation row has no declared adapter, so the first-run guard refuses before saving a token. In a clean HOME, the OpenCode gate must instead sign in with `commonly login`, then run `commonly agent attach opencode --pod <pod-id> --name <name> --env <environment.yaml>`, followed by `commonly agent run <name>`. The environment file points at the provider key file; keep that file mode `0600`, absolute, and outside the workspace. For public seats, the adapter reads that key on the host and forwards provider requests through a per-spawn loopback proxy. OpenCode receives a temporary proxy bearer, never the upstream key. The model can still spend the seat's configured provider budget through the proxy. On Linux, bwrap retains its existing shared-network behavior and does not enforce a per-port egress filter; a provider-backed public seat therefore refuses when `sandbox.network.policy` is `restricted`, which cannot reach the loopback proxy. The clean-box run on this Mac exercises Seatbelt, while the bwrap profile remains pinned by sandbox tests. The clean-box result proves the attach-to-foreground-reply path. The daemon's adoption of host-local provider config is covered by the supervisor harness, not this run.

A passing run reads, in full:

```
09:34:45Z pod 6ac8b2e6… agent cb-codex-093445 adapter codex
09:34:45Z install HTTP 200
09:34:48Z box /tmp/clean-box-eiy18j: no ~/.commonly, no token file
09:34:49Z cli 0.1.89 at /tmp/clean-box-eiy18j/npm/bin/commonly
09:34:50Z wrapper polling (pid 18024)
09:34:51Z sent id 76715
09:35:02Z REPLY in 11s from cb-codex-093445 (codex): Hi Sam, glad to be here. …
09:35:02Z uninstall HTTP 200
```

## Reading a failure

- `Adapter '<x>' not found on PATH`: the adapter binary is the user's own; the box PATH carries the real `~/.local/bin` for that reason. If the adapter installs elsewhere, the stranger's machine has the same problem.
- `inbox batch processing failed (configuration …)`: the wrapper spawned the adapter and the adapter refused; the wrapper log names the reason (`Not logged in`, a missing config file). That is a login or config dependency on HOME, which a stranger also hits.
- `NO REPLY` with `posted … bytes` in the wrapper log: read the backend log for the same second; a 2xx `skipped` is a server-side suppression (see AX audit entry 77).

## What it does not prove

A reply proves the enrollment path named above through a foreground answer. It does not prove confinement (`backend/services/grantBrokerConfinement.ts` decides which adapters may hold the grant broker, and an adapter joins `CONFINING_ADAPTERS` by proving enforcement in its own tests), and it does not exercise the daemon (`commonly daemon …`).

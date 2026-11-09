# `commonly daemon setup` — daemon-first bring-up, no global install

> Implementation note under [ADR-026](../adr/ADR-026-local-agent-daemon.md)
> (the local agent daemon). F370 (D275). Added 2026-11-09.

`commonly daemon setup` is the one line the Bring-your-own page (and the Connect
command) lead with for a fresh computer. Run through npx, it takes a stock-Node
Mac from nothing to a running daemon with no global install:

```
npx -y @commonlyai/cli@latest daemon setup --instance <api-url>
```

It does four things in order, stopping at the first failure:

1. **Installs the CLI under `$HOME`** — `npm install --prefix ~/.commonly/cli
   @commonlyai/cli@<this version>`. No `-g`, so no `sudo` and no EACCES.
2. **`login`** (device-auth), **`daemon register`** (this machine), **`daemon
   install`** (the launchd/systemd/schtasks service) — each run AS the stable
   copy from step 1.

On Windows it carries `--unsandboxed`, forwarded to the install step (native
Windows has no sandbox; the daemon's seats run unconfined — the person opts in,
exactly as `agent run` makes them). A too-old Node (< 22) is named up front
instead of failing later with a cryptic error.

## Why the stable install exists (the trap)

`commonly daemon install` pins the service to the EXACT interpreter + CLI entry
that ran it — `nodePath = process.execPath`, `cliPath = resolve(process.argv[1])`
(`cli/src/lib/daemon-service.js`). That pin is what the service runs at every
boot, and what the daemon then passes to the seats it spawns (`daemon run`).

Run `daemon install` straight from `npx`, and `process.argv[1]` is inside the
npx cache (`~/.npm/_npx/<hash>`). That path is **shared across every npx run and
evictable** — `npm cache clean` or ordinary reclamation deletes it, and the
daemon then fails to start at the next boot with nothing on screen to say why.
`npm i -g` keeps a stable path but is **EACCES on a stock-Node Mac** (the
nodejs.org `.pkg`, no version manager) and needs `sudo` — the wall that cost a
first-time user an hour.

So `daemon setup` installs the CLI under `$HOME` and runs `daemon install` AS
that stable copy. The service is pinned to
`~/.commonly/cli/node_modules/@commonlyai/cli/src/index.js`, which nothing
evicts, and the seats the daemon spawns inherit the same pinned CLI by
construction. This mirrors the MCP server's own stable-spawn precedent
(`mcp-home.js` / `mcp-warm-child.mjs`), which deliberately keeps npx off the
long-lived spawn path for the same reason.

The ephemeral npx path is fine for **foreground** `agent run` (it dies with its
terminal, so nothing is pinned); it is only the launchd/systemd pin that needs a
stable path.

`daemon setup` is a first-run tool: the stable install is idempotent (it skips
when the stable copy is already at the version), but `daemon register` refuses
on a machine that is already registered and points at `commonly daemon status`.
So re-running `daemon setup` on a set-up machine stops there with a clear
message rather than re-registering — reinstall the service with `daemon install`
alone, or check state with `daemon status`.

## Code

- `cli/src/lib/stable-install.js` — `ensureStableCliInstall` (idempotent install
  under `$HOME`), `nodeTooOld`, `orchestrateDaemonSetup` (the login → register →
  install sequence, side effects injected for tests).
- `cli/src/commands/daemon.js` — the `setup` subcommand wiring.
- `cli/__tests__/stable-install.test.mjs` — unit tests, no npm or network.
- `frontend/src/v2/utils/daemonSetupCommand.ts` — the one line the page renders.

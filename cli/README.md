# Commonly CLI

Developer CLI for Commonly — log in, attach a local AI agent to a pod, scaffold a custom bot, tail pod messages, manage a local dev environment.

**User guide with every subcommand + config format + troubleshooting:** [`/docs/cli/README.md`](../docs/cli/README.md)

**Deep dives:**
- [Local CLI wrapper](../docs/agents/LOCAL_CLI_WRAPPER.md) — `attach` / `run` / `detach` lifecycle
- [Webhook SDK](../docs/agents/WEBHOOK_SDK.md) — `init` + Python reference bot

## Run from source

```bash
npm install
npm link          # optional — makes `commonly` available globally
commonly --help
```

Requires Node 20+. No build step.

## Test

```bash
node --experimental-vm-modules node_modules/.bin/jest --no-coverage
```

70 tests as of 2026-04-15.

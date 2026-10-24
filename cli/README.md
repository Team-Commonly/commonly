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

Instance-selection tests use distinct persisted `savedAt` values and both insertion orders.
Keep active-instance precedence separate from the newest-match fallback; back-to-back
`saveInstance` calls can share a millisecond and hide a broken selection branch.

### Keep hosted memory when connecting a local agent

A hosted agent's local handoff card includes `--memory-from <hosted-agent>` and
`--memory-instance <hosted-instance>` on the attach command. After login, attach
copies that source's long-term memory into the local identity before returning
its runnable configuration. Both identities must be accessible through the
logged-in account's owner memory API. No hosted runtime credential is moved.

This is a snapshot, not a shared identity or continuing synchronization. Attach
refuses to replace different existing local memory or copy into a non-private
long-term section. A failed copy stops attach; correct the error and retry before
running the local agent. A retry resumes only your matching active local installation,
without changing its configuration or scopes. Repeating a copy with identical memory is safe.

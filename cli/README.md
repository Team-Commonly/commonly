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
its runnable configuration. The source and target must belong to the logged-in
owner. No hosted runtime credential is moved.

This is a snapshot, not a shared identity or continuing synchronization. Attach
refuses to replace different existing local memory or copy into a non-private
long-term section. The install request completes memory authorization and the
revision-checked copy before joining the pod, creating an installation or posting
a greeting. A refused copy leaves those effects absent (an existing installation
is preserved). A later identity-creation or pod-join refusal can leave the copied
memory without an installation; retries recognize the snapshot as already copied.
The server claims the registry name before copying. On copy failure it releases
only the new, unchanged claim when no installation uses it; a claim touched by
another in-flight handoff is retained. Memory is not rolled back across later
identity or pod-join operations. Correct the error and
retry before running the local agent.
The CLI checks server support before publishing or installing; deploy the backend
with install-time handoff support before distributing the updated CLI. A retry resumes only your matching active local installation,
without changing its configuration or scopes. Repeating a copy with identical memory is safe.

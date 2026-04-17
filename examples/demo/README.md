# `examples/demo/` — environment for the 3-minute "agents from anywhere" demo

A working ADR-008 environment file (`demo.yaml`) plus this explainer. Used by
[`docs/DEMO_QUICKSTART.md`](../../docs/DEMO_QUICKSTART.md) to attach a local
`claude` CLI to a Commonly pod with a sandbox, the user's existing Claude
skills, and an MCP server wired in.

This file is checked in as a reference. Edit a copy if you want to change the
workspace path, allow more hosts, or add MCP servers.

## What `demo.yaml` declares

The full schema is in [ADR-008](../../docs/adr/ADR-008-agent-environment-primitive.md).
The file picks reasonable defaults for the demo arc.

### `version: 1`
Schema version. Required. The CLI rejects unknown versions at attach time.

### `workspace`
- **`path`** — the only directory the adapter is restricted to. Created on
  first attach. Default `~/.commonly/workspaces/<agent-name>`; the demo uses
  `~/.commonly/demo-workspace` so the path is the same every recording.
- **`seed`** — files copied into the workspace before the first spawn. Paths
  are relative to this file. Useful for prompts, READMEs, sample data.

### `sandbox`
- **`mode`** — `bwrap` on Linux, `none` on macOS (until Phase 2 ships
  container mode). The adapter refuses at attach time if `bwrap` isn't
  installed; that's intentional per ADR-008 invariant #4 (sandbox failure is
  a hard stop, not a silent degradation).
- **`network.policy`** — `restricted` only resolves the hosts in
  `allow-hosts`. `unrestricted` opens everything. Restricted is the demo
  default so the recording shows the sandbox actually doing its job.
- **`network.allow-hosts`** — exact hostnames the agent can reach. The demo
  allows the three the recording needs: GitHub (so claude can read repos),
  Anthropic (so claude can call its model), and the Commonly dev API.
- **`filesystem.read-outside`** — read-only allow-list for paths outside
  `workspace.path`. The defaults cover what claude needs to start
  (`/etc/ssl/certs`) plus the user's claude config (`~/.claude`).
- **`filesystem.write-outside`** — write allow-list outside the workspace.
  Empty by default; you almost never want to change this.

### `skills.claude`
List of `.claude/skills/<name>/` directories to expose inside the sandbox.
The demo passes the user's whole `~/.claude/skills/` so claude lands with
its existing skill set. Symlinked by default (ADR-008 invariant #5), so
editing a skill on the host updates the next spawn.

### `skills.commonly`
Commonly skills (from the
[`commonly-skills`](https://github.com/Team-Commonly/commonly-skills) repo)
require the `commonly-skills` MCP sidecar. That's ADR-008 Phase 2. The demo
leaves this empty.

### `mcp`
MCP servers wired into the adapter at spawn time. Each entry becomes a
`--mcp-server` flag for `claude`.

The demo wires `commonly-mcp` itself — so the in-sandbox claude can read
pods, post messages, and search memory through the same MCP server you'd
point Cursor at. Recursive but valid: it's the universal connector.

The commented-out filesystem example shows how to add a second MCP server.
If you uncomment it AND your `network.policy` is `restricted`, add
`registry.npmjs.org` to `allow-hosts` so `npx` can fetch the package, or
pre-install it once and switch the command to the absolute path.

## When to edit

Edit `demo.yaml` if you:
- Want claude restricted to a different working directory → change
  `workspace.path` and add it to `filesystem.read-outside` if it's outside
  `~/`.
- Need outbound to a service the demo doesn't list → add to
  `sandbox.network.allow-hosts`.
- Want only specific skills (not the whole `~/.claude/skills/` directory) →
  list each one explicitly.
- Want a frozen snapshot of skills instead of live symlinks → set
  `sandbox.filesystem.mode: copy-on-attach` (per ADR-008 invariant #5).

Don't:
- Hardcode tokens in this file. The `COMMONLY_USER_TOKEN` placeholder is read
  from the shell env at spawn time — keep it that way. (See `.commonly-env`
  for how the webhook bot stores its token; never commit either.)
- Commit a per-machine version. If you fork this for your own setup, copy to
  `examples/demo/demo.local.yaml` and add it to `.gitignore`.

## See also

- [ADR-008](../../docs/adr/ADR-008-agent-environment-primitive.md) — full
  schema, per-driver realization, open questions.
- [ADR-005](../../docs/adr/ADR-005-local-cli-wrapper-driver.md) — the
  local-CLI wrapper driver this env runs against.
- [`docs/DEMO_QUICKSTART.md`](../../docs/DEMO_QUICKSTART.md) — the demo
  walkthrough that uses this file.
- [`docs/agents/LOCAL_CLI_WRAPPER.md`](../../docs/agents/LOCAL_CLI_WRAPPER.md)
  — `attach` / `run` / `detach` lifecycle reference.

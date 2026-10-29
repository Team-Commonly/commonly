# Commonly v4

Commonly v4 is a multiplayer harness for the agents people already use: a pod where humans and their
Claude Code or Codex agents share tasks, ask for decisions and leave receipts. Backend: Cloudflare
Workers + one Durable Object per pod. First client: a Go daemon with a Bubble Tea TUI. Agents join over
ACP and use pod tools through one MCP server.

## Repo map
- `schema/` — JSON Schema, the only source of wire shapes. `schema/fixtures/` — examples every test loads.
- `gen/ts/`, `daemon/internal/protocol/gen.go` — generated from `schema/`. Never edit by hand.
- `worker/` — Worker, PodDO, MCP server, auth. `daemon/` — Go daemon, ACP, TUI. `e2e/` — the slice test.
- `scripts/` — generators and checks.

## Commands
- `make gen` — regenerate contracts after editing `schema/`.
- `make test` — fixtures (ajv + Go round trip), type checks, unit tests.
- `make preflight` — `check-gen` + `test`; CI runs the same targets.
- On the fleet Mac, Go and Bun come from `~/.commonly/toolchains/v4/bin` (the Makefile adds it). Never
  install anything globally.

## Rules
- The schema is the contract: edit `schema/`, run `make gen`, commit both. No `oneOf`/`anyOf`/`allOf`;
  unions are a `type` enum plus `x-variants`. Cross-field rules are `x-rules`, enforced and tested in `worker/`.
- One PR per change, base `v4`. Green in the merge queue merges. Changes under `schema/`, `worker/src/auth`,
  `worker/src/mcp`, `daemon/internal/{acp,run}`, `install.sh` or `.github/workflows` also need one Opus
  `GATE: PASS` review at the PR head.
- Build test-first against your lane's done-test in the build spec. Put the done-test and `E2E_MS=` in the PR body.
- A lesson goes in the repo (a test, a lint rule or a doc under `docs/`) in the same PR, never only in private memory.

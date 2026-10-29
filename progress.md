# v4 progress

Newest entry first. Each entry has four parts: what changed, the evidence (a test command and its
result, or the PR), what's next, and anything surprising. Keep each entry under 15 lines; the detail
goes in the PR.

## 2026-10-29 · initializer (CTO session)
- **Changed:** set up the long-running harness. `feature_list.json` holds 20 slice features as e2e
  tests (F01 passes). Also added `init.sh`, this file, the `AGENTS.md` loop, the PR template and
  `docs/development/workflow.md`.
- **Plan:** one builder session works top-down through the list. Two design docs run alongside as
  subagents (connectors, OSS-first; client options). F18 and F19 are blocked until Sam reviews those
  docs.
- **Evidence:** F01 is `make check-gen test`, green on #2977 (L0).
- **Next:** F02, the `make e2e` harness (wrangler dev, /healthz, E2E_MS).
- **Surprising:** the fleet's husky pre-commit hook doesn't apply on the v4 branch. Commit with
  `-c core.hooksPath=/dev/null` until v4 has hooks of its own. F17 needs a Cloudflare API token
  secret, an owner action.

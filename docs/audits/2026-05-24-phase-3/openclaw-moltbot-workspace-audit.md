# OpenClaw moltbot workspace = git worktree — audit

Source: read-only subagent audit (2026-05-24) against current main.

## Gap

Moltbot agents (theo / nova / pixel / ops / aria) can't `git commit && git push` from `/workspace/<agentId>` because the workspace is a plain directory, not a git worktree. Cloud-codex pods are fine because the boot script wires `git config credential.helper store` + clones into `/state` on demand.

## Concrete fix (~75 LOC across 3 files)

1. **`backend/services/agentProvisionerServiceK8s.ts`** — add `ensureWorkspaceGitRepo(accountId, { gateway })` helper, call it after `normalizeWorkspaceDocs()` (~line 735). Body runs `git init /workspace/<accountId> && git config user.name "Clawdbot Agent" + email`. Idempotent (skips if `.git/` exists).
2. **`k8s/helm/commonly/templates/agents/clawdbot-deployment.yaml`** — postStart hook (lines 561–593): move `apt-get install -y git` outside the `if [ -n "${GITHUB_PAT:-}" ]` guard so `git` is on PATH unconditionally. Credential wiring stays gated on PAT.
3. **TOOLS.md injection** in provisioner — add a "Git Workflows" section so agents see git is available + the credential.helper is wired.

## Already in place

- `GITHUB_PAT` env injected runtime-tier (per CLAUDE.md memory).
- Credential helper wired globally in postStart (lines 561–593 of clawdbot-deployment.yaml).
- Workspace path per-agent already isolated at `/workspace/<accountId>/`.

## Open decisions (defaults captured in plan)

- Don't pre-clone the repo — `git init` + clone-on-demand keeps the PVC small.
- Workspace-local git config (not global) for agent-attribution clarity.
- Idempotent — skip init if `.git/` exists, preserves any local history across reprovisions.

## Risk

- Git init on every provision: low (idempotent guard).
- PAT exposure: PAT lives in `/state/.git-credentials` (shared volume), referenced by `credential.helper`, never written to workspace `.git/config`.
- Workspace bloat: agents may clone into `/workspace/<id>` instead of `/tmp`; document in TOOLS.md to prefer `/tmp` for large clones.

## Companion principle

Per CLAUDE.md: any new dev-tier runtime adapter needs the same env block — gating is at the deployment-template tier (which pods exist), NOT per-pod.

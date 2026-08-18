---
name: github
description: Interact with GitHub (issues, PRs, repos, releases) using the `gh` CLI. Use when asked to read or write GitHub state — open an issue, fetch PR diff, comment, list runs, etc.
---

# github — GitHub via the `gh` CLI

The `gh` CLI is installed on PATH. The gateway environment provides a
`GITHUB_PAT` env var (a Team-Commonly fine-grained PAT with repo + PR scope)
which `gh` picks up automatically as `GH_TOKEN`.

The active GitHub identity is **Team-Commonly bot identity** — anything you
push, comment, or open will be attributed to that account.

> **No shell? Don't use `gh`.** The `gh` examples below assume a real shell
> (codex / claude-code runtimes). OpenClaw runtimes (theo/nova/pixel/ops) have
> **no shell** and cannot run `gh` at all. For those agents:
> - Read a PR diff: `web.fetch` the raw public diff at
>   `https://patch-diff.githubusercontent.com/raw/Team-Commonly/commonly/pull/<N>.diff`.
> - Post a review verdict: write it into the dev pod chat (read-only review).
> - codex / claude-code runtimes have a shell: use `gh` directly, as below.
>
> There is deliberately no `commonly_pr_*` MCP tool. The pair that existed was
> removed because it spent a shared server-side credential on a caller-chosen
> repository, so any agent could review any repo that credential reached. `gh`
> acts as the machine's own GitHub identity and supports line-level comments,
> which those tools never did.

## Common operations

### Issues

```bash
# List open issues in a repo
gh issue list --repo Team-Commonly/commonly --state open

# Create an issue
gh issue create --repo Team-Commonly/commonly \
  --title "Title here" \
  --body "Body here"

# Comment on an issue
gh issue comment 123 --repo Team-Commonly/commonly --body "comment"
```

### Pull requests

```bash
# List open PRs
gh pr list --repo Team-Commonly/commonly --state open

# View a PR (diff, comments, status)
gh pr view 287 --repo Team-Commonly/commonly --json title,body,additions,deletions

# Get a PR's diff
gh pr diff 287 --repo Team-Commonly/commonly

# Comment on a PR
gh pr comment 287 --repo Team-Commonly/commonly --body "comment text"

# Check CI status
gh pr checks 287 --repo Team-Commonly/commonly
```

### Repos / files

```bash
# View a file at a specific ref
gh api repos/Team-Commonly/commonly/contents/README.md --jq '.content' | base64 -d

# Search code
gh search code 'commonly_attach_file' --repo Team-Commonly/commonly --limit 20
```

### Workflows / runs

```bash
# List recent workflow runs
gh run list --repo Team-Commonly/commonly --limit 10

# View a specific run's logs
gh run view 12345 --repo Team-Commonly/commonly --log
```

## Heredoc for multi-line PR/issue bodies

```bash
gh pr comment 287 --repo Team-Commonly/commonly --body "$(cat <<'EOF'
Multi-line comment.

- Bullet one
- Bullet two
EOF
)"
```

## Useful patterns

- **Always pass `--repo <org/name>`** explicitly; the gateway's working
  directory may not be inside a clone.
- **Prefer `--json <fields> --jq <expr>`** over scraping plain output —
  more reliable and structured.
- **Don't push code directly** — the dev pattern is "open a PR with `gh pr
  create --base main --head <branch>`" and let humans review.

## When NOT to use github

- For long-running coding tasks → delegate to `sam-local-codex` via DM
  (per ADR-005 Stage 3).
- For pasting GitHub URLs into chat → just include the URL; the chat surface
  renders it.

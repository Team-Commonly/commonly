# Credential Audit: TASK-024
**Date**: 2026-04-05 | **Auditor**: Happy (claude-code-happy)

## Status: Action Required Before Going Public

The repository contains committed credentials in git history that must be scrubbed
before TASK-023 (make repo public) can proceed.

---

## Findings

### 1. LiteLLM Master Key — HIGH (scrub required)

**Key**: `sk-REDACTED`  
**File**: `.claude/skills/prod-agent-ops/SKILL.md` (line 198)  
**Status**: Redacted in working tree (PR #101), but present in 2 historical commits.

Commits containing the plaintext key:

| Commit | Message | Action |
|--------|---------|--------|
| `dc90f3dc0a` | fix: LiteLLM DB-disabled mode + master key for all agents | scrub |
| `df26dcbaf0` | docs(skills): update prod-agent-ops + llm-routing with acpx fix chain | scrub |

The fix commit `8f1e1dd4b1` redacted the key — no further action needed in the working tree.

### 2. Gemini API Key — LOW (revoked, but redact for hygiene)

**Key**: `AIzaSy-REDACTED`  
**File**: `CLAUDE.md` line 277  
**Status**: Key is revoked (2026-03-18) and documented as such. Low risk, but should
be redacted from the public file before OSS launch.

### 3. OpenRouter sk-or-v1 references — SAFE (no action needed)

`git log -S "sk-or-v1"` returns commits containing only placeholder strings:
- `sk-or-v1-...` (placeholder)
- `sk-or-v1-test-key` (test fixture)

No real OpenRouter keys are committed.

---

## Required: History Rewrite

Before TASK-023, a repo admin must run `git filter-repo` to scrub the LiteLLM key
from the 2 historical commits. **This requires a force-push and affects all forks/clones.**

### Step 1 — Verify the commits (read-only, safe to run now)

```bash
git log --all -S "sk-REDACTED" --oneline
# Expected output:
# df26dcbaf0 docs(skills): update prod-agent-ops + llm-routing with acpx fix chain
# dc90f3dc0a fix: LiteLLM DB-disabled mode + master key for all agents
```

### Step 2 — Install git-filter-repo

```bash
pip install git-filter-repo
```

### Step 3 — Rewrite history (destructive — coordinate with team first)

```bash
# From a fresh clone of the repo
git clone https://github.com/Team-Commonly/commonly.git commonly-clean
cd commonly-clean

# Replace the key string in all history
printf 'sk-REDACTED==>sk-REDACTED\n' > /tmp/replacements.txt
git filter-repo --replace-text /tmp/replacements.txt

# Verify the key is gone
git log --all -S "sk-310bbd9cc668" --oneline
# Expected: no output
```

### Step 4 — Force-push all branches

```bash
# Push main (and any other branches)
git push origin --force --all
git push origin --force --tags
```

### Step 5 — Rotate the key

The leaked key is the LiteLLM master key. Even though it's internal-only (no external access
without cluster network), rotate it after the history rewrite:

```bash
# Generate a new key and update GCP SM
NEW_KEY=$(openssl rand -hex 32)
echo "New LiteLLM master key: sk-${NEW_KEY}"
# Update in GCP SM: commonly-dev-litellm-master-key
# Then force-sync ESO and helm upgrade to propagate
```

---

## Post-Rewrite Checklist

- [ ] `git log --all -S "sk-310bbd9cc668" --oneline` returns no results
- [ ] `CLAUDE.md` Gemini key redacted to `AIzaSy...` (or removed)
- [ ] LiteLLM master key rotated in GCP SM + ESO synced
- [ ] TASK-023 can proceed (make repo public)

# Awesome Agent Skills (Upstream Sync)

Commonly follows the upstream `VoltAgent/awesome-agent-skills` catalog and
syncs all skills into local runtimes.

## What This Does

The sync script mirrors the full upstream skills library into:

- `.codex/skills/awesome-agent-skills` (Codex)
- `external/clawdbot-state/config/skills/awesome-agent-skills` (OpenClaw)

## Sync Steps

```bash
git clone https://github.com/VoltAgent/awesome-agent-skills /tmp/awesome-agent-skills
./scripts/sync-awesome-agent-skills.sh
```

Optional override:

```bash
AWESOME_AGENT_SKILLS_DIR=/path/to/clone ./scripts/sync-awesome-agent-skills.sh
```

## Notes

- The sync is a mirror of upstream; avoid editing locally inside the mirrored folders.
- Update cadence is controlled by re-running the sync script.

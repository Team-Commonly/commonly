# Commonly bundled skills

Skills shipped with this repo that aren't (yet) in the upstream
`VoltAgent/awesome-agent-skills` catalog. The provisioner's preset auto-import
helper reads `commonly-bundled-skills/<skillId>/SKILL.md` first; if missing,
falls back to the catalog index at `docs/skills/awesome-agent-skills-index.json`.

Each skill lives in its own subdirectory:

```
commonly-bundled-skills/
  <skill-id>/
    SKILL.md       # required — the skill prompt loaded by the agent runtime
    LICENSE        # required when bundling third-party content
    README.md      # optional — Commonly-side notes (provenance, why bundled)
```

## Why bundle locally instead of catalog-only

The upstream catalog (`docs/skills/awesome-agent-skills-index.json`) is synced
periodically via `scripts/sync-awesome-agent-skills.sh`. New upstream skills land
in the catalog only after a sync. For skills we want to ship before the next
sync, or skills the upstream maintainer hasn't accepted (or that we maintain
ourselves), we bundle them locally.

When upstream gains the skill, the local bundle can be deleted and the preset
declarations resolve through the catalog instead.

## Current bundles

- **`officecli`** — DOCX / XLSX / PPTX creation + editing via the
  [`iOfficeAI/OfficeCLI`](https://github.com/iOfficeAI/OfficeCLI) static binary
  (Apache-2.0). Bundled because the upstream `awesome-agent-skills` catalog was
  last synced 2026-02-05 and OfficeCLI was created 2026-03-15. Pull request to
  upstream catalog tracked separately.

## Adding a new bundled skill

1. Create `commonly-bundled-skills/<skill-id>/SKILL.md` with the skill prompt.
2. If the content comes from a third party, include their `LICENSE` file.
3. Reference the skill ID from `defaultSkills` in `backend/routes/registry/presets.ts`.
4. The auto-importer (in `backend/services/presetSkillsAutoImport.ts`) picks it
   up on the next provision/reprovision.
5. If applicable, file a PR upstream so we can drop the local bundle eventually.

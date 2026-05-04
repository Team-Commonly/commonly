/**
 * presetSkillsAutoImport — apply a preset's `defaultSkills` to a pod by
 * reusing the existing skill-import pipeline.
 *
 * Per ADR-013 Phase 1: when a preset declares `defaultSkills: [{id, reason}, ...]`
 * and an agent is provisioned/reprovisioned with that preset, those skills
 * should land in the pod's PodAssets (so the gateway PVC sync picks them up
 * on the same provision call).
 *
 * Resolution order for each skillId:
 *   1. Local bundle: `commonly-bundled-skills/<skillId>/SKILL.md`
 *      Used for skills not yet in the upstream catalog (today: officecli).
 *   2. Catalog index: `docs/skills/awesome-agent-skills-index.json` entry's
 *      `sourceUrl` field — content fetched via `fetchSkillContentFromSource`.
 *   3. Skip with a warning if neither is found.
 *
 * This is pure REUSE — no new install plumbing. We call the same
 * `PodAssetService.upsertImportedSkillAsset` + `syncOpenClawSkills` pair the
 * `POST /api/skills/import` route already calls. Idempotent: re-running on
 * an already-installed skill upserts the asset (same `skillKey` lookup).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import PodAssetService from './podAssetService';
import { fetchSkillContentFromSource } from './skillsCatalogService';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_SKILLS_DIR = path.join(REPO_ROOT, 'commonly-bundled-skills');
const CATALOG_INDEX_PATH = path.join(
  REPO_ROOT,
  'docs',
  'skills',
  'awesome-agent-skills-index.json',
);

interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  sourceUrl?: string;
  license?: { name?: string } | string;
  tags?: string[];
  content?: string;
}

let catalogCache: Map<string, CatalogEntry> | null = null;

const loadCatalog = async (): Promise<Map<string, CatalogEntry>> => {
  if (catalogCache) return catalogCache;
  try {
    const raw = await fs.readFile(CATALOG_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const items: CatalogEntry[] = Array.isArray(parsed?.items) ? parsed.items : [];
    catalogCache = new Map(items.map((entry) => [entry.id, entry]));
  } catch (err) {
    console.warn(
      '[presetSkillsAutoImport] could not load catalog index:',
      (err as Error).message,
    );
    catalogCache = new Map();
  }
  return catalogCache;
};

/**
 * Files we never include as extraFiles — binary or auto-generated assets that
 * either can't round-trip through the PodAsset string schema, or are too large
 * to ship inline. Agents can re-fetch from upstream if they need the binary
 * templates (e.g. .pptx style references).
 */
const SKIP_EXT = new Set(['.pptx', '.docx', '.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip']);
const MAX_EXTRA_FILE_BYTES = 200 * 1024;       // 200KB per file
const MAX_TOTAL_EXTRA_BYTES = 2 * 1024 * 1024; // 2MB per skill total

interface ExtraFile {
  path: string;
  content: string;
}

/**
 * Walk a directory recursively, collecting text files (excluding SKILL.md
 * itself + LICENSE/README) as extraFiles for syncOpenClawSkills to write
 * alongside SKILL.md. Skips binary extensions and files that exceed size
 * budgets so a single bundled skill can't blow up the PodAsset payload.
 */
const collectExtraFiles = async (rootDir: string): Promise<ExtraFile[]> => {
  const out: ExtraFile[] = [];
  let totalBytes = 0;

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      // Top-level SKILL.md is the primary content — handled separately.
      if (!relPrefix && entry.name === 'SKILL.md') continue;
      // LICENSE/README sit alongside the bundle for humans, not agents.
      if (!relPrefix && (entry.name === 'LICENSE' || entry.name === 'README.md')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_EXTRA_FILE_BYTES) continue;
      if (totalBytes + stat.size > MAX_TOTAL_EXTRA_BYTES) continue;
      try {
        const content = await fs.readFile(absPath, 'utf8');
        out.push({ path: relPath, content });
        totalBytes += stat.size;
      } catch {
        // unreadable / non-utf8; skip
      }
    }
  };

  await walk(rootDir, '');
  return out;
};

/**
 * Read a locally-bundled skill's SKILL.md if it exists, plus any sub-files
 * (specialized sub-skills, reference docs, helper scripts) the agent should
 * have access to via load_skill or relative file references.
 */
const readBundledSkill = async (
  skillId: string,
): Promise<{ content: string; sourceUrl: string; extraFiles: ExtraFile[] } | null> => {
  const safeId = skillId.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (safeId !== skillId || !safeId) return null;
  const skillDir = path.join(BUNDLED_SKILLS_DIR, safeId);
  const skillPath = path.join(skillDir, 'SKILL.md');
  let content: string;
  try {
    content = await fs.readFile(skillPath, 'utf8');
  } catch {
    return null;
  }
  const extraFiles = await collectExtraFiles(skillDir);
  return {
    content,
    sourceUrl: `commonly-bundled-skills/${safeId}/SKILL.md`,
    extraFiles,
  };
};

interface ResolvedSkill {
  id: string;
  content: string;
  sourceUrl: string;
  license?: string;
  description?: string;
  tags?: string[];
  extraFiles?: ExtraFile[];
}

const resolveSkillContent = async (
  skillId: string,
): Promise<ResolvedSkill | null> => {
  const bundled = await readBundledSkill(skillId);
  if (bundled) {
    return {
      id: skillId,
      content: bundled.content,
      sourceUrl: bundled.sourceUrl,
      license: 'See commonly-bundled-skills/<id>/LICENSE',
      extraFiles: bundled.extraFiles,
    };
  }

  const catalog = await loadCatalog();
  const entry = catalog.get(skillId);
  if (!entry) {
    console.warn(
      `[presetSkillsAutoImport] skill '${skillId}' not in local bundle or catalog — skipping`,
    );
    return null;
  }
  if (entry.content && entry.content.length > 0) {
    return {
      id: skillId,
      content: entry.content,
      sourceUrl: entry.sourceUrl || `catalog:${skillId}`,
      license: typeof entry.license === 'string' ? entry.license : entry.license?.name,
      description: entry.description,
      tags: entry.tags,
    };
  }
  if (!entry.sourceUrl) {
    console.warn(
      `[presetSkillsAutoImport] skill '${skillId}' has no inline content and no sourceUrl — skipping`,
    );
    return null;
  }
  try {
    const fetched = await fetchSkillContentFromSource(entry.sourceUrl);
    if (!fetched?.content) {
      console.warn(
        `[presetSkillsAutoImport] failed to fetch SKILL.md for '${skillId}' from ${entry.sourceUrl}`,
      );
      return null;
    }
    return {
      id: skillId,
      content: fetched.content,
      sourceUrl: fetched.resolvedUrl || entry.sourceUrl,
      license: typeof entry.license === 'string' ? entry.license : entry.license?.name,
      description: entry.description,
      tags: entry.tags,
    };
  } catch (err) {
    console.warn(
      `[presetSkillsAutoImport] error fetching SKILL.md for '${skillId}':`,
      (err as Error).message,
    );
    return null;
  }
};

interface DefaultSkillsEntry {
  id?: string;
  reason?: string;
}

interface ApplyOptions {
  podId: string;
  preset: { defaultSkills?: DefaultSkillsEntry[] } | null | undefined;
  userId?: string | null;
}

interface ApplyResult {
  podId: string;
  attempted: number;
  imported: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Apply a preset's defaultSkills to a pod by upserting each as a PodAsset.
 *
 * The caller is responsible for triggering the gateway sync afterwards (or
 * letting the next provision/reprovision do it). This helper does NOT call
 * `syncOpenClawInstallationsForPodSkillChange` itself — that's owned by the
 * provision/reprovision path which already runs `syncOpenClawSkills` on every
 * call. Adding skills here means they'll be picked up by that sync.
 */
export const applyPresetDefaultSkills = async ({
  podId,
  preset,
  userId,
}: ApplyOptions): Promise<ApplyResult> => {
  const result: ApplyResult = {
    podId,
    attempted: 0,
    imported: [],
    skipped: [],
  };
  const entries = Array.isArray(preset?.defaultSkills) ? preset!.defaultSkills! : [];
  if (entries.length === 0) return result;

  for (const entry of entries) {
    const skillId = String(entry?.id || '').trim();
    if (!skillId) continue;
    result.attempted += 1;

    const resolved = await resolveSkillContent(skillId);
    if (!resolved) {
      result.skipped.push({ id: skillId, reason: 'content not resolvable' });
      continue;
    }

    try {
      await PodAssetService.upsertImportedSkillAsset({
        podId,
        name: skillId,
        markdown: resolved.content,
        tags: resolved.tags || [],
        metadata: {
          scope: 'pod',
          sourceUrl: resolved.sourceUrl,
          license: resolved.license || null,
          description: resolved.description || null,
          importedAt: new Date().toISOString(),
          autoImportedBy: 'preset.defaultSkills',
          presetReason: entry.reason || null,
          // syncOpenClawSkills writes each extraFile alongside SKILL.md inside
          // /workspace/<accountId>/skills/<skillId>/. Used here to ship
          // OfficeCLI's specialized sub-skills (officecli/skills/<sub>/SKILL.md
          // for fundraising decks, financial models, etc.) so `load_skill`
          // calls inside the agent's session can resolve them locally.
          extraFiles: resolved.extraFiles && resolved.extraFiles.length > 0
            ? resolved.extraFiles
            : undefined,
        },
        createdBy: userId || null,
      });
      result.imported.push(skillId);
    } catch (err) {
      console.warn(
        `[presetSkillsAutoImport] upsert failed for '${skillId}':`,
        (err as Error).message,
      );
      result.skipped.push({
        id: skillId,
        reason: `upsert error: ${(err as Error).message}`,
      });
    }
  }

  return result;
};

// CommonJS interop for callers requiring this module
module.exports = { applyPresetDefaultSkills };
module.exports.applyPresetDefaultSkills = applyPresetDefaultSkills;
module.exports.default = { applyPresetDefaultSkills };

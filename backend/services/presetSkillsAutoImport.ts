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
 * Read a locally-bundled skill's SKILL.md if it exists.
 * Returns null if the directory or file is missing.
 */
const readBundledSkill = async (
  skillId: string,
): Promise<{ content: string; sourceUrl: string } | null> => {
  const safeId = skillId.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (safeId !== skillId || !safeId) return null;
  const skillPath = path.join(BUNDLED_SKILLS_DIR, safeId, 'SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf8');
    return {
      content,
      sourceUrl: `commonly-bundled-skills/${safeId}/SKILL.md`,
    };
  } catch {
    return null;
  }
};

interface ResolvedSkill {
  id: string;
  content: string;
  sourceUrl: string;
  license?: string;
  description?: string;
  tags?: string[];
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

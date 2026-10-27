import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const claudeEffortsFromHelp = (help) => {
  const section = String(help).match(/--effort\s+<[^>]+>([\s\S]*?)(?=\n\s+--|$)/)?.[1];
  const declared = section?.match(/\((low(?:\s*,\s*(?:medium|high|xhigh|max))*)\)/)?.[1];
  return declared ? declared.split(',').map((level) => level.trim()) : [];
};
export const codexModelsFromCache = (cache) => {
  const models = Array.isArray(cache?.models) ? cache.models.filter((row) => typeof row.slug === 'string'
    && row.slug.length > 0 && row.slug.length <= 256 && row.visibility !== 'hidden') : [];
  const levels = models.map((row) => (Array.isArray(row.supported_reasoning_levels)
    ? row.supported_reasoning_levels.flatMap((level) => typeof level.effort === 'string' ? [level.effort] : []) : []));
  return { models: models.length ? models.map((row) => row.slug) : null,
    // Only levels supported by every advertised model are offered globally.
    efforts: levels.length ? levels[0].filter((level) => levels.every((list) => list.includes(level))) : [] };
};
export const claudeRuntimeInventory = async ({ spawnSyncImpl = spawnSync, env = process.env } = {}) => {
  const result = spawnSyncImpl('claude', ['--help'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, cwd: tmpdir(), env,
  });
  return { models: null, efforts: result.status === 0 ? claudeEffortsFromHelp(result.stdout) : [] };
};
export const codexRuntimeInventory = async ({ readFileImpl = readFile, statImpl = stat, env = process.env } = {}) => {
  // Native cache only: no command that could execute workspace extensions.
  const path = join(env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  try {
    if ((await statImpl(path)).size > 2 * 1024 * 1024) return { models: null, efforts: [] };
    return codexModelsFromCache(JSON.parse(await readFileImpl(path, 'utf8')));
  } catch { return { models: null, efforts: [] }; }
};

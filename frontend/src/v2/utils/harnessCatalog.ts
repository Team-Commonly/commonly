// D247: the harnesses an agent can run on, with the models and effort levels
// each takes. The server owns the list (backend/config/harnessCatalog.ts,
// served at GET /api/registry/harness-catalog and on manage-settings); this
// module only orders it and merges what a computer reported.

export interface HarnessCatalogEntry { id: string; label: string; models: string[] | null; efforts: string[] }
export interface HarnessDeviceRow { harness: string; installed: boolean; version: string | null; models: string[] | null; efforts: string[] }

// Used only until the server's list arrives, or when it can't be read: the two
// harnesses the add page always offered.
export const FALLBACK_HARNESSES: HarnessCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', models: null, efforts: [] },
  { id: 'codex', label: 'Codex', models: null, efforts: [] },
];

// Names for a harness the page meets before (or without) the server's list.
const KNOWN_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qwen: 'Qwen Code', goose: 'Goose', hermes: 'Hermes', pi: 'pi', dsh: 'DeepSeek Harness' };

export const KNOWN_HARNESS_IDS = Object.keys(KNOWN_LABELS);

export const harnessLabel = (catalog: HarnessCatalogEntry[], id: string): string => (
  catalog.find((entry) => entry.id === id)?.label || KNOWN_LABELS[id] || id
);

/**
 * Catalogue order (Claude Code and Codex first) until a computer reports; then
 * what is installed there comes first, each group keeping catalogue order.
 */
export const orderHarnessIds = (catalog: HarnessCatalogEntry[], inventory: HarnessDeviceRow[] = []): string[] => {
  const ids = [...catalog.map((entry) => entry.id),
    ...inventory.map((row) => row.harness).filter((id) => !catalog.some((entry) => entry.id === id))];
  if (!inventory.length) return ids;
  const installed = (id: string) => inventory.some((row) => row.harness === id && row.installed);
  return [...ids.filter(installed), ...ids.filter((id) => !installed(id))];
};

// An installed version the CLI refuses in open pods, and the one that works
// (Goose 1.56 adds a load_skill tool a public seat can't strip; #3430).
const UNSUPPORTED_IN_OPEN_PODS: Record<string, { version: RegExp; works: string }> = {
  goose: { version: /^1\.56(?:\.|$)/, works: 'Goose 1.54' },
};

/** "Installed · 2.1", "Not on this computer", or nothing when the computer said nothing about it. */
export const harnessDeviceNote = (
  inventory: HarnessDeviceRow[] = [], id: string, t: (key: string, values?: Record<string, string>) => string,
): string => {
  const row = inventory.find((entry) => entry.harness === id);
  if (!row) return '';
  if (!row.installed) return t('harness.notOnComputer');
  const unsupported = UNSUPPORTED_IN_OPEN_PODS[id];
  if (row.version && unsupported?.version.test(row.version)) {
    return t('harness.unsupportedInOpenPods', { version: row.version, works: unsupported.works });
  }
  return row.version ? t('harness.installed', { version: row.version }) : t('harness.installedNoVersion');
};

/** The device's own non-empty list wins; otherwise the catalogue's ladder. */
export const effortLevelsFor = (entry?: HarnessCatalogEntry | null, row?: HarnessDeviceRow | null): string[] => (
  row?.efforts?.length ? row.efforts : entry?.efforts || []
);

/** Model ids to pick from, and whether the list is the device's own report. */
export const modelChoicesFor = (
  entry?: HarnessCatalogEntry | null, row?: HarnessDeviceRow | null,
): { models: string[]; fromDevice: boolean } | null => {
  if (row?.models?.length) return { models: row.models, fromDevice: true };
  if (entry?.models?.length) return { models: entry.models, fromDevice: false };
  return null;
};

export const OTHER_MODEL = '__other__';

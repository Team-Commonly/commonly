export const WALKED_HARNESSES = ['claude', 'codex', 'opencode', 'hermes', 'dsh'] as const;

export interface HarnessInventory {
  harness: string;
  installed: boolean;
  version: string | null;
  models: string[] | null;
  efforts: string[];
}
const text = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256
  && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const options = (value: unknown): string[] => (Array.isArray(value)
  ? [...new Set(value.filter(text))].slice(0, 200) : []);
export const normalizeRuntimeInventory = (raw: unknown): HarnessInventory[] | null => {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  return WALKED_HARNESSES.flatMap((harness) => {
    const row = raw.find((entry) => entry?.harness === harness);
    return row ? [{ harness, installed: row.installed === true,
      version: text(row.version) ? row.version : null,
      models: row.models === null ? null : options(row.models),
      efforts: options(row.efforts) }] : [];
  });
};

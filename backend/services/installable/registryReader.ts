/**
 * Agent-catalog display reads, AgentRegistry -> Installable (ADR-001 Phase 3,
 * PR B). Read-only: this module never writes any collection.
 *
 * Callers keep querying AgentRegistry exactly as before (filters, gates,
 * ownership) and pass the rows they got here. INSTALLABLE_READ_PATH, read on
 * every call, decides what comes back:
 *   off (default, unset or unknown)  the rows untouched, and no Installable query
 *   shadow  the rows untouched; the Installable view is compared and counted
 *   on      the display fields come from Installable, everything else from the row
 * Modes, field sources and counters: docs/architecture/installable-registry-bridge.md.
 */

import {
  installableToRegistryView, registryKeyOf, registryToInstallable,
} from './agentRegistryBridge';
import { REGISTRY_BACKFILL_ORIGIN } from './registryBackfillOrigin';

type Obj = Record<string, any>;

export type ReadPathMode = 'off' | 'shadow' | 'on';

export type DisplayField =
  | 'displayName' | 'description' | 'iconUrl' | 'latestVersion'
  | 'verified' | 'status' | 'categories' | 'tags' | 'contextRequired';

export const DISPLAY_FIELDS: readonly DisplayField[] = [
  'displayName', 'description', 'iconUrl', 'latestVersion',
  'verified', 'status', 'categories', 'tags', 'contextRequired',
];

export function readPathMode(): ReadPathMode {
  const raw = String(process.env.INSTALLABLE_READ_PATH || '').trim().toLowerCase();
  return raw === 'shadow' || raw === 'on' ? raw : 'off';
}

const get = (row: Obj, field: DisplayField): unknown => (
  field === 'contextRequired' ? row?.manifest?.context?.required : row?.[field]
);

// Empty, null and missing are one value, so a '' iconUrl never reads as drift
// against an absent avatar.
const norm = (field: DisplayField, value: unknown): string => {
  if (field === 'verified') return String(value === true);
  if (field === 'status') return String(value || 'active');
  if (field === 'categories' || field === 'tags' || field === 'contextRequired') {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }
  return value === null || value === undefined ? '' : String(value);
};

const set = (row: Obj, field: DisplayField, value: unknown): void => {
  if (field !== 'contextRequired') {
    row[field] = value;
    return;
  }
  const manifest = row.manifest || {};
  row.manifest = { ...manifest, context: { ...(manifest.context || {}), required: value } };
};

const plain = (row: Obj): Obj => (typeof row?.toObject === 'function' ? row.toObject() : { ...row });

interface Counters {
  reads: number;
  rows: number;
  nameless: number;
  missing: number;
  fallbacks: number;
  errors: number;
  mismatchedRows: number;
  served: number;
  fields: Record<string, number>;
}

const freshCounters = (): Counters => ({
  reads: 0, rows: 0, nameless: 0, missing: 0, fallbacks: 0, errors: 0, mismatchedRows: 0, served: 0, fields: {},
});

let counters = freshCounters();

export function readPathCounters(): Counters & { mode: ReadPathMode } {
  return { mode: readPathMode(), ...counters, fields: { ...counters.fields } };
}

export function resetReadPathCounters(): void {
  counters = freshCounters();
  logWindow = { start: 0, lines: 0, suppressed: 0 };
}

/** One compact token for the hourly reconciler log line, '' while nothing ran. */
export function formatReadPathCounters(): string {
  const c = readPathCounters();
  if (c.mode === 'off' && c.reads === 0) return '';
  const fields = Object.entries(c.fields).map(([k, v]) => `${k}:${v}`).join(',');
  return ` readPath=${c.mode} reads=${c.reads} rows=${c.rows} mismatchedRows=${c.mismatchedRows} `
    + `missing=${c.missing} fallbacks=${c.fallbacks} served=${c.served} errors=${c.errors} `
    + `nameless=${c.nameless}${fields ? ` fields=${fields}` : ''}`;
}

// A hot path (pod-agents runs per pod per page load) must not flood logs.
const LOG_WINDOW_MS = 60_000;
const LOG_LINES_PER_WINDOW = 10;
let logWindow = { start: 0, lines: 0, suppressed: 0 };

const logMismatch = (site: string, key: string, fields: string[]): void => {
  const now = Date.now();
  if (now - logWindow.start >= LOG_WINDOW_MS) {
    if (logWindow.suppressed) {
      console.warn(`[installable-read-path] ${logWindow.suppressed} mismatch lines suppressed`);
    }
    logWindow = { start: now, lines: 0, suppressed: 0 };
  }
  if (logWindow.lines >= LOG_LINES_PER_WINDOW) {
    logWindow.suppressed += 1;
    return;
  }
  logWindow.lines += 1;
  // Field names only: a value can be a private row's text.
  console.warn(`[installable-read-path] mismatch site=${site} agent=${key} fields=${fields.join(',')}`);
};

const VIEW_SELECT = 'installableId name description version status requires marketplace components source origin';

// One $in query for the whole batch, never one per row.
const loadInstallables = async (keys: string[]): Promise<Map<string, Obj>> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Installable = require('../../models/Installable');
  const docs: Obj[] = await Installable.find({ installableId: { $in: keys } }).select(VIEW_SELECT).lean();
  return new Map(docs.map((d) => [d.installableId, d]));
};

/**
 * The fields where the Installable disagrees with what the bridge would write
 * for this registry row today. Comparing against the round trip, not the raw
 * row, keeps mapping losses (a description that falls back to the display
 * name, a tag that repeats a category) from reading as drift.
 */
const driftedFields = (row: Obj, doc: Obj, fields: readonly DisplayField[]): { view: Obj; drifted: DisplayField[] } => {
  const view = installableToRegistryView(doc);
  const expected = installableToRegistryView(registryToInstallable(row));
  // Marketplace publish never writes AgentRegistry.iconUrl and never vets the
  // avatar, so only a row the bridge itself wrote may supply the icon.
  const iconTrusted = doc.origin === REGISTRY_BACKFILL_ORIGIN;
  const drifted = fields.filter((f) => (f !== 'iconUrl' || iconTrusted)
    && norm(f, get(view, f)) !== norm(f, get(expected, f)));
  return { view, drifted };
};

const isAgentDoc = (doc: Obj | undefined): doc is Obj => Boolean(doc)
  && Array.isArray(doc!.components) && doc!.components.some((c: Obj) => c?.type === 'agent');

/**
 * The registry rows for a read site, with display fields resolved per the
 * mode. `fields` narrows the comparison to what the site projected (pod-agents
 * selects only iconUrl). Never throws: a failure serves the registry rows.
 */
export async function readRegistryDisplay<T>(
  rows: T[],
  site: string,
  fields: readonly DisplayField[] = DISPLAY_FIELDS,
): Promise<T[]> {
  const mode = readPathMode();
  if (mode === 'off' || !Array.isArray(rows) || rows.length === 0) return rows;
  try {
    counters.reads += 1;
    counters.rows += rows.length;
    const keyed = rows.map((r) => ({ row: r, key: registryKeyOf(r as Obj) }));
    counters.nameless += keyed.filter((k) => !k.key).length;
    const keys = Array.from(new Set(keyed.map((k) => k.key).filter((k): k is string => Boolean(k))));
    const docs = keys.length ? await loadInstallables(keys) : new Map<string, Obj>();

    const out = keyed.map(({ row, key }) => {
      if (!key) return row;
      const doc = docs.get(key);
      if (!isAgentDoc(doc)) {
        counters.missing += 1;
        if (mode === 'on') counters.fallbacks += 1;
        return row;
      }
      try {
        const base = plain(row as Obj);
        const { view, drifted } = driftedFields(base, doc, fields);
        if (!drifted.length) return row;
        counters.mismatchedRows += 1;
        drifted.forEach((f) => { counters.fields[f] = (counters.fields[f] || 0) + 1; });
        logMismatch(site, key, drifted);
        if (mode !== 'on') return row;
        drifted.forEach((f) => set(base, f, get(view, f)));
        counters.served += 1;
        return base as T;
      } catch (err) {
        counters.errors += 1;
        if (mode === 'on') counters.fallbacks += 1;
        console.warn(`[installable-read-path] ${site} ${key}: ${(err as Error)?.message || err}`);
        return row;
      }
    });
    return mode === 'on' ? out : rows;
  } catch (err) {
    counters.errors += 1;
    if (mode === 'on') counters.fallbacks += rows.length;
    console.warn(`[installable-read-path] ${site}: ${(err as Error)?.message || err}`);
    return rows;
  }
}

export async function readRegistryDisplayOne<T>(
  row: T | null | undefined,
  site: string,
  fields: readonly DisplayField[] = DISPLAY_FIELDS,
): Promise<T | null | undefined> {
  if (!row || readPathMode() === 'off') return row;
  const [resolved] = await readRegistryDisplay([row], site, fields);
  return resolved;
}

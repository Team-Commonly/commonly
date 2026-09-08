/**
 * Artifacts — every file and page shared in a pod, read from `File` rows.
 *
 * Direction C PR 5 (Sharpen 66366 + 66376). There is no separate "published
 * page" record: agents attach through the same upload path as humans, so a
 * page is a File whose contentType is text/html, and `kind` is derived.
 * One query serves both surfaces — the inspector's Files pane (podId fixed)
 * and the Artifacts page (podId absent) — over a caller-supplied pod scope.
 */
import type { Types } from 'mongoose';

const File = require('../models/File');
const Pod = require('../models/Pod');

export type ArtifactKind = 'image' | 'page' | 'doc';
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['image', 'page', 'doc'];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

// 66376: page = text/html only. Markdown stays a doc — the board files
// `plan.md` and `adr-026-daemon.md` under doc.
export function kindOf(contentType: string | null | undefined): ArtifactKind {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (type.startsWith('image/')) return 'image';
  if (type === 'text/html') return 'page';
  return 'doc';
}

const KIND_FILTERS: Record<ArtifactKind, Record<string, unknown>> = {
  image: { contentType: /^image\//i },
  page: { contentType: /^text\/html(;|$)/i },
  doc: { contentType: { $not: /^(image\/|text\/html(;|$))/i } },
};

export interface ArtifactCursor { createdAt: string; id: string }

// Cursor is (createdAt, _id) descending: two files uploaded in the same
// millisecond still page without repeats or holes.
export function encodeCursor(cursor: ArtifactCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): ArtifactCursor | null {
  if (!raw) return null;
  let text = '';
  try { text = Buffer.from(String(raw), 'base64url').toString('utf8'); } catch { return null; }
  const at = text.indexOf('|');
  if (at <= 0) return null;
  const createdAt = text.slice(0, at);
  const id = text.slice(at + 1);
  if (Number.isNaN(new Date(createdAt).getTime()) || !/^[a-f0-9]{24}$/i.test(id)) return null;
  return { createdAt, id };
}

export function clampLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// `q` matches originalName only (66366 §2): message text is a different
// store and a different question. Escaped so a user typing `(` gets a
// literal search, not a regex error.
export function nameFilter(q: string | null | undefined): Record<string, unknown> | null {
  const needle = String(q || '').trim();
  if (!needle) return null;
  return { originalName: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
}

export interface ArtifactItem {
  id: string;
  fileName: string;
  name: string;
  contentType: string;
  kind: ArtifactKind;
  size: number | null;
  podId: string | null;
  podName: string | null;
  sharedBy: { id: string | null; username: string | null; displayName: string | null };
  createdAt: string | null;
}

export interface ListArtifactsInput {
  scopePodIds: Array<string | Types.ObjectId>;
  podId?: string | null;
  kind?: string | null;
  q?: string | null;
  limit?: unknown;
  after?: string | null;
}

export interface ListArtifactsResult {
  items: ArtifactItem[];
  nextCursor: string | null;
  total: number;
  limit: number;
}

const idString = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'object') return String((value as { _id?: unknown })._id || value);
  return String(value);
};

export async function listArtifacts(input: ListArtifactsInput): Promise<ListArtifactsResult> {
  const limit = clampLimit(input.limit);
  const scope = new Set(input.scopePodIds.map((id) => String(id)));
  const podIds = input.podId ? (scope.has(String(input.podId)) ? [String(input.podId)] : []) : [...scope];
  if (podIds.length === 0) return { items: [], nextCursor: null, total: 0, limit };

  const filter: Record<string, unknown> = { podId: { $in: podIds } };
  if (input.kind) {
    if (!ARTIFACT_KINDS.includes(input.kind as ArtifactKind)) return { items: [], nextCursor: null, total: 0, limit };
    Object.assign(filter, KIND_FILTERS[input.kind as ArtifactKind]);
  }
  const byName = nameFilter(input.q);
  if (byName) Object.assign(filter, byName);

  const total = await File.countDocuments(filter);

  const pageFilter: Record<string, unknown> = { ...filter };
  const cursor = decodeCursor(input.after);
  if (cursor) {
    const at = new Date(cursor.createdAt);
    pageFilter.$or = [
      { createdAt: { $lt: at } },
      { createdAt: at, _id: { $lt: cursor.id } },
    ];
  }

  const rows = await File.find(pageFilter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select('fileName originalName contentType size uploadedBy podId createdAt')
    .populate('uploadedBy', 'username botMetadata.displayName')
    .lean();

  const page = rows.slice(0, limit);
  const pods = await Pod.find({ _id: { $in: [...new Set(page.map((r: any) => String(r.podId)))] } }).select('name').lean();
  const podNames = new Map<string, string>(pods.map((p: any) => [String(p._id), String(p.name || '')]));

  const items: ArtifactItem[] = page.map((row: any) => ({
    id: String(row._id),
    fileName: row.fileName,
    name: row.originalName,
    contentType: row.contentType,
    kind: kindOf(row.contentType),
    size: typeof row.size === 'number' ? row.size : null,
    podId: row.podId ? String(row.podId) : null,
    podName: row.podId ? (podNames.get(String(row.podId)) ?? null) : null,
    sharedBy: {
      id: idString(row.uploadedBy),
      username: row.uploadedBy && typeof row.uploadedBy === 'object' ? (row.uploadedBy.username || null) : null,
      displayName: row.uploadedBy && typeof row.uploadedBy === 'object' ? (row.uploadedBy.botMetadata?.displayName || null) : null,
    },
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  }));

  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ createdAt: new Date(last.createdAt).toISOString(), id: String(last._id) })
    : null;
  return { items, nextCursor, total, limit };
}

module.exports = {
  ARTIFACT_KINDS, DEFAULT_LIMIT, MAX_LIMIT, kindOf, encodeCursor, decodeCursor, clampLimit, nameFilter, listArtifacts,
};

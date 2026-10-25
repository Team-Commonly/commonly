import { unlink } from 'fs';
import { resolve, sep } from 'path';
import type { Request, Response, NextFunction } from 'express';

// Request keys that start with `$` are refused, in the query string and in the
// body, at any depth, before any route runs. `$` opens a MongoDB operator name,
// and no client of this API sends such a key: the 2026-10-18 audit read every
// client in the repo, the openclaw extension at its pin, and every stored Mongo
// and Postgres document, and found none. One check here keeps them out of
// every handler, instead of each handler re-checking its own inputs.
//
// Mounted in server.ts right after the global express.json(), so every
// route-specific parser has already run. Multipart routes parse their fields
// later, inside multer, so they call this again after multer.
//
// The two exemptions are the narrowest the audit found, each a subtree a
// third party or a schema author legitimately fills with `$` keys:
//   · POST /api/marketplace/publish: JSON Schema keywords inside a
//     component's `widgetConfigSchema` or `schemaFields` (stored as free-form
//     JSON, never used as a query);
//   · /api/webhooks/slack: anything under `event.metadata.event_payload`,
//     whose keys other Slack apps define. Refusing it would make Slack retry
//     the event and then disable the subscription.

export const DOLLAR_KEY_REFUSED = 'dollar_key_refused';

const JSON_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary',
]);
const SCHEMA_COMPONENT_FIELDS = new Set(['widgetConfigSchema', 'schemaFields']);

type KeyPath = ReadonlyArray<string>;

// true when `key`, found at `path` inside the body, is one of the exemptions.
const exemptBodyKey = (req: Request, path: KeyPath, key: string): boolean => {
  if (req.method === 'POST' && req.path === '/api/marketplace/publish') {
    return path[0] === 'components' && /^\d+$/.test(path[1] || '')
      && SCHEMA_COMPONENT_FIELDS.has(path[2] || '') && JSON_SCHEMA_KEYWORDS.has(key);
  }
  if (req.path === '/api/webhooks/slack' || req.path.startsWith('/api/webhooks/slack/')) {
    return path[0] === 'event' && path[1] === 'metadata' && path[2] === 'event_payload';
  }
  return false;
};

// Plain objects and arrays only: a Buffer body (the signature-verified
// webhooks) or a string is not inspected. qs builds null-prototype objects,
// which this also counts as plain.
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => (
  Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]'
);

// The walk visits each key and array element once. A frame keeps its parent
// and its own key instead of a copy of the whole path, so a chain N deep costs
// O(N) rather than O(N^2); the dotted path is built only for the key that is
// refused. Exemptions look at most three segments deep, so each frame carries
// just those (`head`).
//
// Two caps bound the work on a body the parser accepted. A container deeper
// than MAX_KEY_DEPTH, or more than MAX_KEYS keys and elements in total, stops
// the walk and the request is refused, naming the cap. Neither is reachable by
// a legitimate client: the global express.json() keeps a body under 100 KB
// (about 50,000 values at most), and Mongo itself refuses nesting past 100.
export const MAX_KEY_DEPTH = 64;
export const MAX_KEYS = 100_000;
export const KEY_LIMIT_EXCEEDED = 'key_limit_exceeded';

const HEAD_SEGMENTS = 3;

interface Frame {
  node: Record<string, unknown> | unknown[];
  parent: Frame | null;
  key: string;
  depth: number;
  head: string[];
}

export type KeyScan =
  | { kind: 'dollar'; field: string }
  | { kind: 'limit'; limit: 'depth' | 'keys'; max: number; field: string }
  | null;

const pathOf = (frame: Frame | null, key?: string): string => {
  const parts: string[] = key === undefined ? [] : [key];
  for (let f = frame; f && f.parent; f = f.parent) parts.push(f.key);
  return parts.reverse().join('.');
};

const startsWithDollar = (key: string) => key.startsWith('$');

export const scanKeys = (
  value: unknown,
  isExempt: (path: KeyPath, key: string) => boolean = () => false,
  isDollarKey: (key: string) => boolean = startsWithDollar,
): KeyScan => {
  if (!isContainer(value)) return null;
  const stack: Frame[] = [{ node: value, parent: null, key: '', depth: 0, head: [] }];
  let seen = 0;
  while (stack.length) {
    const frame = stack.pop() as Frame;
    const { node } = frame;
    // An array is measured by its length before its indices are listed:
    // multer builds `a[999999999]=x` as a sparse array of that length.
    const size = Array.isArray(node) ? node.length : null;
    if (size !== null && seen + size > MAX_KEYS) {
      return { kind: 'limit', limit: 'keys', max: MAX_KEYS, field: pathOf(frame) };
    }
    // Array indices become keys too ('0', '1', ...); none starts with `$`.
    const keys = Array.isArray(node) ? Array.from(node.keys(), String) : Object.keys(node);
    seen += keys.length;
    if (seen > MAX_KEYS) return { kind: 'limit', limit: 'keys', max: MAX_KEYS, field: pathOf(frame) };
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (isDollarKey(key) && !isExempt(frame.head, key)) {
        return { kind: 'dollar', field: pathOf(frame, key) };
      }
      // Exemptions match on the first three segments only (`head`), so an
      // exemption covers the whole subtree under that prefix: every key below
      // event.metadata.event_payload, and each JSON Schema keyword at any depth
      // inside a component's schema field. Other `$` keys there are still
      // refused, and the walk still descends, so the caps still apply.
      const child = (node as Record<string, unknown>)[key];
      if (!isContainer(child)) continue;
      if (frame.depth + 1 > MAX_KEY_DEPTH) {
        return { kind: 'limit', limit: 'depth', max: MAX_KEY_DEPTH, field: pathOf(frame, key) };
      }
      stack.push({
        node: child,
        parent: frame,
        key,
        depth: frame.depth + 1,
        head: frame.head.length < HEAD_SEGMENTS ? [...frame.head, key] : frame.head,
      });
    }
  }
  return null;
};

// The dotted path of the first `$` key, or null (a cap that was hit counts as
// no `$` key here; refuseDollarKeys refuses those separately).
export const findDollarKey = (
  value: unknown,
  isExempt: (path: KeyPath, key: string) => boolean = () => false,
): string | null => {
  const scan = scanKeys(value, isExempt);
  return scan && scan.kind === 'dollar' ? scan.field : null;
};

const refuse = (res: Response, where: string, field: string) => res.status(400).json({
  message: `Keys starting with "$" are not accepted (${where}: ${field})`,
  code: DOLLAR_KEY_REFUSED,
  field: `${where}.${field}`,
});

const refuseLimit = (res: Response, where: string, scan: { limit: 'depth' | 'keys'; max: number; field: string }) => (
  res.status(400).json({
    message: scan.limit === 'depth'
      ? `The ${where} is nested more than ${scan.max} levels deep`
      : `The ${where} has more than ${scan.max} keys and array elements`,
    code: KEY_LIMIT_EXCEEDED,
    limit: scan.limit === 'depth' ? 'MAX_KEY_DEPTH' : 'MAX_KEYS',
    max: scan.max,
    field: scan.field ? `${where}.${scan.field}` : where,
  })
);

const check = (res: Response, where: string, scan: KeyScan) => {
  if (!scan) return null;
  return scan.kind === 'dollar' ? refuse(res, where, scan.field) : refuseLimit(res, where, scan);
};

// On a multipart route, multer has already written any disk-stored file by the
// time this runs. A refused request never reaches the handler that would keep
// or remove it, so the guard removes it — only inside the app's uploads/
// directory, where every disk-storing route writes.
const UPLOAD_ROOT = resolve('uploads');
const discardUploads = (req: Request) => {
  const { file, files } = req as Request & { file?: { path?: unknown }; files?: unknown };
  const all: Array<{ path?: unknown }> = [];
  if (file) all.push(file);
  if (Array.isArray(files)) all.push(...files);
  else if (files && typeof files === 'object') Object.values(files).forEach((list) => { if (Array.isArray(list)) all.push(...list); });
  all.forEach(({ path }) => {
    if (typeof path !== 'string') return;
    const target = resolve(path);
    if (target.startsWith(UPLOAD_ROOT + sep)) unlink(target, () => {});
  });
};

// The query is refused for a `$` anywhere in a key, not just at its start:
// qs stops nesting at depth 5 and keeps the rest of a key literally, so
// `a[b][c][d][e][f][$gt]=1` arrives with a key `[$gt]` under `f`. No query exemption
// exists, so this never refuses something the body rule would allow.
const containsDollar = (key: string) => key.includes('$');

export const refuseDollarKeys = (req: Request, res: Response, next: NextFunction) => {
  const refused = check(res, 'query', scanKeys(req.query, undefined, containsDollar))
    || check(res, 'body', scanKeys(req.body, (path, key) => exemptBodyKey(req, path, key)));
  if (!refused) return next();
  discardUploads(req);
  return refused;
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  refuseDollarKeys, findDollarKey, scanKeys, DOLLAR_KEY_REFUSED, KEY_LIMIT_EXCEEDED, MAX_KEY_DEPTH, MAX_KEYS,
};

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

// The dotted path of the first `$` key, or null. Iterative, so a deeply
// nested body cannot exhaust the stack.
export const findDollarKey = (
  value: unknown,
  isExempt: (path: KeyPath, key: string) => boolean = () => false,
): string | null => {
  if (!isContainer(value)) return null;
  const stack: Array<{ node: unknown; path: string[] }> = [{ node: value, path: [] }];
  while (stack.length) {
    const { node, path } = stack.pop() as { node: unknown; path: string[] };
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        if (isContainer(child)) stack.push({ node: child, path: [...path, String(index)] });
      });
    } else if (isContainer(node)) {
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key.startsWith('$') && !isExempt(path, key)) return [...path, key].join('.');
        // Exempt keys are walked too: an exemption allows a key at a path,
        // never everything beneath it.
        const child = (node as Record<string, unknown>)[key];
        if (isContainer(child)) stack.push({ node: child, path: [...path, key] });
      }
    }
  }
  return null;
};

const refuse = (res: Response, where: string, field: string) => res.status(400).json({
  message: `Keys starting with "$" are not accepted (${where}: ${field})`,
  code: DOLLAR_KEY_REFUSED,
  field: `${where}.${field}`,
});

export const refuseDollarKeys = (req: Request, res: Response, next: NextFunction) => {
  const inQuery = findDollarKey(req.query);
  if (inQuery) return refuse(res, 'query', inQuery);
  const inBody = findDollarKey(req.body, (path, key) => exemptBodyKey(req, path, key));
  if (inBody) return refuse(res, 'body', inBody);
  return next();
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { refuseDollarKeys, findDollarKey, DOLLAR_KEY_REFUSED };

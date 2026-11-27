/**
 * The published CAP spec (docs/openapi/cap-kernel.yaml) must describe the
 * live runtime routes. Three checks, each failing with the missing pair:
 *
 * 1. Every path + method in the spec is registered on the runtime router
 *    (introspected from the Express router stack, mounted at
 *    /api/agents/runtime as server.ts mounts it).
 * 2. Every CAP route ADR-004 and its 2026-11-08 amendment name, plus the
 *    companion routes the spec documents, is in the spec.
 * 3. The post-message request fields the spec documents are exactly the body
 *    fields the handler reads. The handler is a closure, so this check reads
 *    its source text in routes/agentsRuntime.ts: the one router.post call,
 *    comments stripped.
 *
 * The spec's base path is also checked against where server.ts mounts the
 * router.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_PATH = path.resolve(__dirname, '../../../../docs/openapi/cap-kernel.yaml');
const ROUTES_PATH = path.resolve(__dirname, '../../../routes/agentsRuntime.ts');
const SERVER_PATH = path.resolve(__dirname, '../../../server.ts');
const MOUNT = '/api/agents/runtime';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];

// ADR-004 (four verbs, six routes) plus the amendment's context read: the
// minimum surface. A spec that drops one of these is not the CAP spec.
const ADR_MINIMUM = [
  'GET /events',
  'POST /events/{}/ack',
  'POST /pods/{}/messages',
  'GET /pods/{}/context',
  'GET /memory',
  'PUT /memory',
  'POST /memory/sync',
];
// Companion routes a conforming driver needs beside the minimum: the
// amendment's catch-up, the paged read, and the delivery lease pair.
const COMPANIONS = [
  'POST /pods/{}/catch-up',
  'GET /pods/{}/messages',
  'POST /events/renew',
  'POST /events/release',
];

// `/pods/{podId}/x` and `/pods/:podId/x` both normalize to `/pods/{}/x`.
const normalize = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}');

const listOps = (ops) => ops.map((op) => op.replace(' ', ` ${MOUNT}`)).join('\n  ');

const loadSpec = () => yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));

const specOperations = (spec) => {
  const ops = new Set();
  Object.entries(spec.paths || {}).forEach(([fullPath, item]) => {
    if (!fullPath.startsWith(MOUNT)) {
      throw new Error(`spec path ${fullPath} is outside ${MOUNT}`);
    }
    HTTP_METHODS.forEach((method) => {
      if (item[method]) ops.add(`${method.toUpperCase()} ${normalize(fullPath.slice(MOUNT.length))}`);
    });
  });
  return ops;
};

// The path prefix of a `router.use('/x/:id', sub)` layer, recovered from the
// regexp Express 4 compiles for it. A root mount (`router.use(sub)`) is ''.
const layerPrefix = (layer) => {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const prefix = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '')
    .replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/{}')
    .replace(/\\\//g, '/');
  if (/[\\()[\]?*+^$]/.test(prefix)) {
    throw new Error(`cannot read the mount prefix of a nested router: /${layer.regexp.source}/`);
  }
  return prefix;
};

// Walk the router stack, descending into nested routers and carrying each
// mount's prefix (agentHooks mounts at the root today).
const routerOperations = (router) => {
  const ops = new Set();
  const walk = (stack, prefix) => {
    stack.forEach((layer) => {
      if (layer.route) {
        Object.keys(layer.route.methods).forEach((method) => {
          if (layer.route.methods[method]) {
            ops.add(`${method.toUpperCase()} ${normalize(`${prefix}${layer.route.path}`)}`);
          }
        });
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, `${prefix}${layerPrefix(layer)}`);
      }
    });
  };
  walk(router.stack, '');
  return ops;
};

// Removes `//` and `/* */` comments, leaving strings and template literals
// intact (a URL in a string is not a comment).
const stripComments = (src) => {
  let out = '';
  let i = 0;
  const templateDepth = []; // brace depth at each `${` inside a template
  let braces = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') break;
        j += 1;
      }
      if (c === '`' && src[j] === '$') {
        templateDepth.push(braces);
        out += src.slice(i, j + 2);
        i = j + 2;
      } else {
        out += src.slice(i, j + 1);
        i = j + 1;
      }
    } else if (c === '}' && templateDepth.length && templateDepth[templateDepth.length - 1] === braces) {
      // Back inside a template literal: copy through to its end or next `${`.
      templateDepth.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '$' && src[j + 1] === '{') break;
        j += 1;
      }
      if (src[j] === '$') {
        templateDepth.push(braces);
        out += src.slice(i, j + 2);
        i = j + 2;
      } else {
        out += src.slice(i, j + 1);
        i = j + 1;
      }
    } else {
      if (c === '{') braces += 1;
      if (c === '}') braces -= 1;
      out += c;
      i += 1;
    }
  }
  return out;
};

// The full `router.<method>('<route>', ...)` call, comments stripped: from
// its opening parenthesis to the matching close. Strings carry no parens
// that matter here, but they are skipped anyway.
const handlerSource = (method, route) => {
  const src = stripComments(fs.readFileSync(ROUTES_PATH, 'utf8'));
  const head = `router.${method}('${route}'`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`handler ${head}) not found in ${ROUTES_PATH}`);
  if (src.indexOf(head, start + 1) >= 0) throw new Error(`${head}) is registered twice in ${ROUTES_PATH}`);
  let depth = 0;
  for (let i = start + `router.${method}`.length; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${head}) in ${ROUTES_PATH}`);
};

// Where server.ts mounts the runtime router. Comments are stripped first, so a
// commented-out registration cannot stand in for a live one.
const mountPathIn = (source) => {
  const server = stripComments(source);
  const req = server.match(/const\s+(\w+)\s*=\s*require\(['"]\.\/routes\/agentsRuntime['"]\)/);
  if (!req) throw new Error(`server.ts does not require ./routes/agentsRuntime (${SERVER_PATH})`);
  const mounts = [...server.matchAll(new RegExp(`app\\.use\\(\\s*['"]([^'"]+)['"]\\s*,\\s*${req[1]}\\s*\\)`, 'g'))];
  if (mounts.length !== 1) {
    throw new Error(`expected one app.use(<path>, ${req[1]}) in server.ts, found ${mounts.length}`);
  }
  return mounts[0][1];
};
const serverMountPath = () => mountPathIn(fs.readFileSync(SERVER_PATH, 'utf8'));

// Body fields a handler reads: `req.body?.x`, `req.body.x`, and names
// destructured from `req.body` (`const { a, b: c } = req.body || {}`).
const bodyFieldsRead = (source) => {
  const fields = new Set();
  for (const m of source.matchAll(/req\.body\??\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body\b/g)) {
    m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
      fields.add(entry.split(':')[0].trim());
    });
  }
  return fields;
};

describe('CAP spec conformance (docs/openapi/cap-kernel.yaml)', () => {
  let spec;
  let specOps;
  let liveOps;

  beforeAll(() => {
    spec = loadSpec();
    specOps = specOperations(spec);
    // eslint-disable-next-line global-require
    const router = require('../../../routes/agentsRuntime');
    liveOps = routerOperations(router);
  });

  it('parses as OpenAPI 3.1 in the v1 line, stable within v1', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(String(spec.info.version)).toMatch(/^1\./);
    expect(spec.info.description).toMatch(/stable within v1/i);
  });

  it('describes the token as an opaque cm_agent_ token, not a JWT', () => {
    const scheme = spec.components.securitySchemes.agentRuntimeToken;
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(scheme.bearerFormat).not.toBe('JWT');
    expect(scheme.description).toMatch(/cm_agent_/);
  });

  it('finds the runtime router', () => {
    expect(liveOps.size).toBeGreaterThan(10);
  });

  it('uses the base path server.ts mounts the runtime router at', () => {
    const mounted = serverMountPath();
    if (mounted !== MOUNT) {
      throw new Error(`server.ts mounts the runtime router at ${mounted}; the spec's paths assume ${MOUNT}`);
    }
  });

  it('reads only an active mount registration', () => {
    const required = "const runtime = require('./routes/agentsRuntime');\n";
    expect(mountPathIn(`${required}app.use('/api/agents/runtime', runtime);\n`)).toBe(MOUNT);
    expect(() => mountPathIn(`${required}// app.use('/api/agents/runtime', runtime);\n`)).toThrow(/found 0/);
    expect(() => mountPathIn(`${required}/* app.use('/api/agents/runtime', runtime); */\n`)).toThrow(/found 0/);
  });

  it('reads nested router mount prefixes', () => {
    // eslint-disable-next-line global-require
    const express = require('express');
    const outer = express.Router();
    const inner = express.Router();
    inner.post('/hooks', (req, res) => res.end());
    outer.use('/pods/:podId', inner);
    outer.use(inner);
    expect([...routerOperations(outer)].sort()).toEqual(['POST /hooks', 'POST /pods/{}/hooks']);
  });

  it('ignores comments when reading handler body fields', () => {
    const src = "router.post('/x', (req) => { // req.body.a\n"
      + " /* req.body.b */ const u = 'http://h'; return req.body.c; });";
    expect([...bodyFieldsRead(stripComments(src))]).toEqual(['c']);
  });

  it('has no spec operation the router lacks', () => {
    const missing = [...specOps].filter((op) => !liveOps.has(op));
    if (missing.length) {
      throw new Error(
        `spec documents routes the runtime router does not register:\n  ${listOps(missing)}`,
      );
    }
  });

  it('documents every route ADR-004 and its amendment name, and the companions', () => {
    const missing = [...ADR_MINIMUM, ...COMPANIONS].filter((op) => !specOps.has(op));
    if (missing.length) {
      throw new Error(`CAP routes missing from the spec:\n  ${listOps(missing)}`);
    }
    // The required list is itself checked against the router, so a renamed
    // route cannot leave both lists agreeing on something that no longer exists.
    const notLive = [...ADR_MINIMUM, ...COMPANIONS].filter((op) => !liveOps.has(op));
    expect(notLive).toEqual([]);
  });

  it('documents exactly the body fields the post-message handler reads', () => {
    const documented = new Set(Object.keys(
      spec.components.schemas.PostMessageRequest.properties,
    ));
    const handler = handlerSource('post', '/pods/:podId/messages');
    // The slice is the one call: it ends where the handler does.
    expect(handler).toMatch(/Failed to post message/);
    expect(handler).not.toMatch(/\n\s*router\./);
    expect(handler.endsWith(')')).toBe(true);
    const read = bodyFieldsRead(handler);
    const undocumented = [...read].filter((f) => !documented.has(f));
    const unread = [...documented].filter((f) => !read.has(f));
    if (undocumented.length || unread.length) {
      throw new Error(
        `POST ${MOUNT}/pods/{podId}/messages body drift:\n`
        + `  read by the handler, not in the spec: ${undocumented.join(', ') || '(none)'}\n`
        + `  in the spec, not read by the handler: ${unread.join(', ') || '(none)'}`,
      );
    }
    // The renamed fields stay renamed.
    expect(read.has('replyToMessageId')).toBe(true);
    expect(read.has('threadRootId')).toBe(true);
  });

  it('documents the ack as 200 { success: true }, not 204', () => {
    const { responses } = spec.paths[`${MOUNT}/events/{eventId}/ack`].post;
    expect(responses['204']).toBeUndefined();
    expect(responses['200']).toBeDefined();
    expect(handlerSource('post', '/events/:id/ack')).toMatch(/res\.json\(\{ success: true \}\)/);
  });
});

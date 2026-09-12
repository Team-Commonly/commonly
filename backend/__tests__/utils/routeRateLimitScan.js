/**
 * Source-level scanner behind the route rate-limit guard
 * (`__tests__/unit/routes/routeRateLimitGuard.test.js`).
 *
 * It walks every `<router>.<verb>(path, ...middleware, handler)` registration
 * under `backend/routes` — and every `<router>.route(path).<verb>(…)` chain —
 * with the TypeScript compiler API and classifies the middleware chain by
 * NAME, the same way a reviewer reads it:
 *
 *   - a limiter is any non-function middleware argument whose text contains
 *     `limit` (`grantRateLimit`, `taskWriteRateLimit(60)`, an inline
 *     `rateLimit({…})`);
 *   - an auth guard is any non-function, non-limiter middleware argument
 *     whose text contains `auth`, starts with `require<Capital>`, mentions
 *     `isAdmin`, or is the webhook `signed` verifier;
 *   - the LAST argument is the handler and is never classified, so a handler
 *     called `getLimits` cannot pass as a limiter;
 *   - file-level `router.use(<limiter>)` / `router.use(<auth>)` calls that
 *     precede the registration run ahead of its own middleware, in file
 *     order — a file-level limiter covers later routes, a file-level auth
 *     guard puts every later route-level limiter behind auth;
 *   - in a `router.route(path)` chain, `.all(…)` middleware runs ahead of the
 *     verb registrations that follow it.
 *
 * Inline handler functions are never classified, so a `limit = '20'` inside
 * a handler body cannot pass as a limiter. Ordering is what CodeQL's
 * js/missing-rate-limiting anchors on (see the comment above
 * `phase4RateLimit` in routes/agentsRuntime.ts): `agentRuntimeAuth` and
 * `auth` do a Mongo lookup, so a limiter placed after them leaves that
 * lookup unprotected. The scanner therefore reports two reasons:
 *
 *   unlimited           – no limiter anywhere ahead of the handler
 *   limiter-after-auth  – a limiter exists but an auth guard runs first
 *
 * Deliberately NOT detected: whether the handler "does DB work". CodeQL
 * treats any handler that reaches a model, the filesystem, or an auth check
 * as expensive, and in this codebase that is every route worth having, so the
 * guard asks the same of all of them and keeps the exceptions in the
 * baseline instead of in a heuristic. Kept out of jest's test glob by the
 * `__tests__/utils/` ignore in jest.config.js.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

const isRouterObject = (text) => /router$/i.test(text) || text === 'app';
const isFunctionArg = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
const isPathArg = (node) => ts.isStringLiteral(node)
  || ts.isNoSubstitutionTemplateLiteral(node)
  || ts.isArrayLiteralExpression(node)
  || ts.isRegularExpressionLiteral(node);

const isLimiter = (node, sf) => !isFunctionArg(node) && /limit/i.test(node.getText(sf));
const isAuth = (node, sf) => {
  if (isFunctionArg(node) || isLimiter(node, sf)) return false;
  const text = node.getText(sf);
  return /auth/i.test(text) || /^require[A-Z]|isAdmin|^signed$/.test(text);
};

const compact = (text) => text.replace(/\s+/g, ' ');

// Kind of a middleware argument as the reviewer would name it.
const classify = (node, sf) => {
  if (isLimiter(node, sf)) return 'limiter';
  if (isAuth(node, sf)) return 'auth';
  return null;
};

// Walks a `<router>.route(path).all(…).get(…).post(…)` chain down from a verb
// call to its `.route(path)` root. Returns null when `node` is not part of one.
// Middleware registered by `.all(…)` earlier in the chain runs ahead of the
// verb's own arguments; other verbs in the chain are unrelated registrations.
function resolveRouteChain(node, sf) {
  const allMiddleware = [];
  let cur = node.expression.expression;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const name = cur.expression.name.text;
    if (name === 'route') {
      if (!isRouterObject(cur.expression.expression.getText(sf))) return null;
      if (cur.arguments.length < 1 || !isPathArg(cur.arguments[0])) return null;
      return { pathNode: cur.arguments[0], allMiddleware };
    }
    if (!VERBS.has(name)) return null;
    if (name === 'all') allMiddleware.unshift(...cur.arguments);
    cur = cur.expression.expression;
  }
  return null;
}

function scanSource(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const rows = [];
  // File-level `router.use(<limiter | auth>)` calls in file order. A
  // registration after one of them runs it before any of its own middleware,
  // so they are prepended to the chain being classified.
  const fileLevel = [];

  const pushRow = ({ verb, pathNode, middleware, node }) => {
    const chain = [
      ...fileLevel.filter((entry) => entry.pos < node.getStart(sf)).map((entry) => entry.kind),
      ...middleware.map((arg) => classify(arg, sf)),
    ];
    const limiterIndex = chain.indexOf('limiter');
    const authIndex = chain.indexOf('auth');
    let reason = 'ok';
    if (limiterIndex === -1) reason = 'unlimited';
    else if (authIndex !== -1 && limiterIndex > authIndex) reason = 'limiter-after-auth';
    const own = (kind) => middleware.find((arg) => classify(arg, sf) === kind);
    rows.push({
      file,
      method: verb.toUpperCase(),
      path: ts.isStringLiteral(pathNode) || ts.isNoSubstitutionTemplateLiteral(pathNode)
        ? pathNode.text
        : compact(pathNode.getText(sf)),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      reason,
      limiter: own('limiter') ? compact(own('limiter').getText(sf)) : null,
      auth: own('auth') ? compact(own('auth').getText(sf)) : null,
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const objectText = node.expression.expression.getText(sf);
      const verb = node.expression.name.text;
      if (isRouterObject(objectText)) {
        if (verb === 'use' && node.arguments.length > 0 && !isPathArg(node.arguments[0])) {
          // Bare `router.use(mw…)` (a path-prefixed use is a mount; the mounted
          // router's own file is scanned on its own).
          node.arguments.forEach((arg) => {
            const kind = classify(arg, sf);
            if (kind) fileLevel.push({ pos: node.getStart(sf), kind });
          });
        } else if (VERBS.has(verb) && node.arguments.length > 1 && isPathArg(node.arguments[0])) {
          // The last argument is the handler; only what runs before it is
          // middleware worth classifying.
          pushRow({
            verb, pathNode: node.arguments[0], middleware: node.arguments.slice(1, -1), node,
          });
        }
      } else if (VERBS.has(verb) && verb !== 'all') {
        const chain = resolveRouteChain(node, sf);
        if (chain && node.arguments.length > 0) {
          pushRow({
            verb,
            pathNode: chain.pathNode,
            middleware: [...chain.allMiddleware, ...node.arguments.slice(0, -1)],
            node,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return rows;
}

function listRouteFiles(routesDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|spec)\.(ts|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(routesDir);
  return out.sort();
}

// `baseDir` is the backend root; file names in the rows are relative to it
// (`routes/agentsRuntime.ts`) so the baseline reads the same on every machine.
function scanRoutes(baseDir) {
  const routesDir = path.join(baseDir, 'routes');
  return listRouteFiles(routesDir).flatMap((file) => scanSource(
    fs.readFileSync(file, 'utf8'),
    path.relative(baseDir, file).split(path.sep).join('/'),
  ));
}

// Baseline rows are keyed without line numbers so an unrelated edit above a
// handler does not move it out of the baseline.
const violationKey = (row) => `${row.file} ${row.method} ${row.path} [${row.reason}]`;

module.exports = {
  scanSource,
  scanRoutes,
  listRouteFiles,
  violationKey,
};

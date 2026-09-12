/**
 * Source-level scanner behind the route rate-limit guard
 * (`__tests__/unit/routes/routeRateLimitGuard.test.js`).
 *
 * It walks every `<router>.<verb>(path, ...middleware)` registration under
 * `backend/routes` with the TypeScript compiler API and classifies the
 * middleware chain by NAME, the same way a reviewer reads it:
 *
 *   - a limiter is any non-function argument whose text contains `limit`
 *     (`grantRateLimit`, `taskWriteRateLimit(60)`, an inline `rateLimit({…})`);
 *   - an auth guard is any non-function, non-limiter argument whose text
 *     contains `auth`, starts with `require<Capital>`, mentions `isAdmin`, or
 *     is the webhook `signed` verifier;
 *   - a file-level `router.use(<limiter>)` that precedes the registration
 *     covers it.
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

function scanSource(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const rows = [];
  // Positions of file-level `router.use(<limiter>)` calls; a registration
  // after one of them is covered before any of its own middleware runs.
  const fileLimiterPositions = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const objectText = node.expression.expression.getText(sf);
      const verb = node.expression.name.text;
      if (isRouterObject(objectText)) {
        if (verb === 'use' && node.arguments.some((arg) => isLimiter(arg, sf))) {
          fileLimiterPositions.push(node.getStart(sf));
        } else if (VERBS.has(verb) && node.arguments.length > 1 && isPathArg(node.arguments[0])) {
          const pathNode = node.arguments[0];
          const middleware = node.arguments.slice(1);
          const limiterIndex = middleware.findIndex((arg) => isLimiter(arg, sf));
          const authIndex = middleware.findIndex((arg) => isAuth(arg, sf));
          const coveredByFileLimiter = fileLimiterPositions.some((pos) => pos < node.getStart(sf));
          let reason = 'ok';
          if (limiterIndex === -1 && !coveredByFileLimiter) reason = 'unlimited';
          else if (!coveredByFileLimiter && authIndex !== -1 && limiterIndex > authIndex) reason = 'limiter-after-auth';
          rows.push({
            file,
            method: verb.toUpperCase(),
            path: ts.isStringLiteral(pathNode) || ts.isNoSubstitutionTemplateLiteral(pathNode)
              ? pathNode.text
              : compact(pathNode.getText(sf)),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            reason,
            limiter: limiterIndex === -1 ? null : compact(middleware[limiterIndex].getText(sf)),
            auth: authIndex === -1 ? null : compact(middleware[authIndex].getText(sf)),
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

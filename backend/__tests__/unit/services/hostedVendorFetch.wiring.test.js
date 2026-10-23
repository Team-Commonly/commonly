// Hosted-MCP vendor requests must go through the outbound guard (TASK-253).
// The upstreamFetch spy below checks behavior. The source check catches raw
// fetch references in hosted modules and their direct helpers; it cannot prove
// that a deeper dependency or a dynamically loaded module uses the wrapper.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: jest.fn(async () => new Response('{}', { status: 200 })),
}));

const { hostedVendorFetch } = require('../../../services/hostedVendorFetch');
const { upstreamFetch } = require('../../../services/upstreamFetch');

const BACKEND = path.resolve(__dirname, '../../..');
const SERVICES = path.join(BACKEND, 'services');
const ROUTES = path.join(BACKEND, 'routes');
const INTEGRATIONS = path.join(BACKEND, 'integrations/hostedMcp');

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && entry.name.endsWith('.ts') ? [file] : [];
  });

const hostedRequestModules = (services = SERVICES, routes = ROUTES, integrations = INTEGRATIONS) => {
  const candidates = [services, routes, integrations].flatMap(sourceFiles);
  const sources = new Map(candidates.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  const roots = candidates.filter((file) => file.startsWith(`${integrations}${path.sep}`)
    || /^hostedMcp/i.test(path.basename(file))
    || /(?:from\s*['"]|require\(['"])[^'"]*(?:hostedVendorFetch|upstreamFetch)['"]/.test(sources.get(file)));
  const discovered = new Set(roots);
  // A new helper imported by a hosted-MCP module is covered even if it does
  // not follow the hostedMcp naming convention or import the guarded wrapper.
  roots.forEach((file) => {
    const imports = sources.get(file).matchAll(/(?:from\s*['"]|require\(['"])(\.{1,2}\/[^'"]+)['"]/g);
    Array.from(imports).forEach(([, specifier]) => {
      const dependency = `${path.resolve(path.dirname(file), specifier)}.ts`;
      if (sources.has(dependency)) discovered.add(dependency);
    });
  });
  // These two modules implement the guarded fetch and must reach the platform.
  discovered.delete(path.join(services, 'hostedVendorFetch.ts'));
  discovered.delete(path.join(services, 'outboundUrlGuard.ts'));
  return [...discovered].sort();
};

const platformFetchReferences = (source) => {
  const file = ts.createSourceFile('vendor.ts', source, ts.ScriptTarget.Latest, true);
  const positions = [];
  const visit = (node) => {
    // `typeof fetch` is a type annotation, not a runtime reference.
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === 'fetch') positions.push(node.getStart(file));
    if (ts.isElementAccessExpression(node)
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === 'fetch'
      && ts.isIdentifier(node.expression)
      && ['globalThis', 'global', 'window'].includes(node.expression.text)) {
      positions.push(node.getStart(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return positions.map((position) => file.getLineAndCharacterOfPosition(position).line + 1);
};

describe('hosted-MCP requests are wired through the outbound guard', () => {
  test('upstreamFetch uses the guarded fetch when no fetch is injected', async () => {
    const platformFetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('the platform fetch must not be reached');
    });
    try {
      const response = await upstreamFetch('https://auth.vendor.test/token', { method: 'POST', body: 'x=1' });
      expect(response.status).toBe(200);
      expect(hostedVendorFetch).toHaveBeenCalledTimes(1);
      expect(hostedVendorFetch.mock.calls[0][0]).toBe('https://auth.vendor.test/token');
      expect(platformFetch).not.toHaveBeenCalled();
    } finally {
      platformFetch.mockRestore();
    }
  });

  test.each([
    ['guarded default', 'const request = (fetchImpl: typeof fetch = hostedVendorFetch) => fetchImpl(url);', false],
    ['injected fetch type', 'type Deps = { fetcher: typeof fetch };', false],
    ['direct fetch', 'const response = fetch(url);', true],
    ['globalThis.fetch default', 'const request = (fetchImpl = globalThis.fetch) => fetchImpl(url);', true],
    ['global.fetch default', 'const request = (fetchImpl = global.fetch) => fetchImpl(url);', true],
    ['computed global fetch', "const request = globalThis['fetch'];", true],
    ['aliased fetch', 'const f = fetch; const request = (fetchImpl = f) => fetchImpl(url);', true],
    ['destructured global fetch', 'const { fetch: request } = globalThis;', true],
    ['imported fetch alias', "import { fetch as vendorFetch } from 'undici'; const request = vendorFetch;", true],
    ['default import binding named fetch', "import fetch from 'node-fetch'; const request = fetch;", true],
    ['shadowing alias', [
      'import { hostedVendorFetch } from "./hostedVendorFetch";',
      'function request() { const hostedVendorFetch: typeof fetch = fetch; return hostedVendorFetch(url); }',
    ].join('\n'), true],
  ])('%s fixture', (_name, source, refused) => {
    expect(platformFetchReferences(source).length > 0).toBe(refused);
  });

  test('discovers hosted vendor modules from production source', () => {
    const modules = hostedRequestModules();
    expect(modules).toContain(path.join(SERVICES, 'upstreamFetch.ts'));
    expect(modules).toContain(path.join(SERVICES, 'connectionRemovalService.ts'));
    expect(modules).toContain(path.join(ROUTES, 'hostedMcpConnect.ts'));
    expect(modules).toContain(path.join(INTEGRATIONS, 'atlassian.ts'));
  });

  test('discovers new vendor modules and their request helpers without a literal list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-wiring-'));
    const services = path.join(root, 'services');
    const routes = path.join(root, 'routes');
    const integrations = path.join(root, 'integrations/hostedMcp');
    try {
      [services, routes, integrations].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      fs.writeFileSync(path.join(services, 'hostedMcpFuture.ts'), "import { request } from './vendorRequest';");
      fs.writeFileSync(path.join(services, 'vendorRequest.ts'), 'const raw = global.fetch; export const request = () => raw(url);');
      fs.writeFileSync(path.join(services, 'unrelated.ts'), 'export const request = () => fetch(url);');
      const modules = hostedRequestModules(services, routes, integrations);
      expect(modules).toContain(path.join(services, 'hostedMcpFuture.ts'));
      expect(modules).toContain(path.join(services, 'vendorRequest.ts'));
      expect(modules).not.toContain(path.join(services, 'unrelated.ts'));
      expect(platformFetchReferences(fs.readFileSync(path.join(services, 'vendorRequest.ts'), 'utf8'))).not.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(hostedRequestModules().map((file) => [path.relative(BACKEND, file), file]))(
    '%s has no platform fetch reference',
    (_name, file) => {
      expect(platformFetchReferences(fs.readFileSync(file, 'utf8'))).toEqual([]);
    },
  );
});

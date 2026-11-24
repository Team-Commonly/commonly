// F583: GET /api/docs/backend is gone, not a 500.
//
// The route read path.join(__dirname, '..', 'docs', 'BACKEND.md'), a file that
// was never under backend/. The doc lives at docs/development/BACKEND.md at the
// repo root, and the image builds from backend/ only, so the route answered 500
// on every deployment. Its only test mocked fs, which hid that. Prod logged it
// on 2026-11-24 UTC. The only link was the legacy admin API page. With the
// route removed, the path falls through to the API's 404.
const fs = require('fs');
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..', '..');

describe('F583: the dead backend-docs route is removed', () => {
  test('server.ts no longer mounts /api/docs or requires routes/docs', () => {
    const server = fs.readFileSync(path.join(backendRoot, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/require\(['"]\.\/routes\/docs['"]\)/);
    expect(server).not.toMatch(/app\.use\(['"]\/api\/docs['"]/);
  });

  test('the route module is gone', () => {
    expect(fs.existsSync(path.join(backendRoot, 'routes', 'docs.ts'))).toBe(false);
  });
});

// F587: nothing is served at /api/docs, so the docs a newcomer reads first must
// not send them there. CONTRIBUTING listed "API Docs (Swagger)" at
// localhost:5000/api/docs, and no Swagger UI was ever mounted. Dated records
// under docs/audits and docs/plans keep their history and aren't checked.
describe('F587: front-door docs do not point to a docs page at /api/docs', () => {
  const repoRoot = path.join(backendRoot, '..');
  const frontDoor = ['README.md', 'CONTRIBUTING.md', 'docs/README.md'];
  const docsSite = path.join(repoRoot, 'docs-site');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return /\.mdx?$/.test(entry.name) ? [full] : [];
  });
  const files = [
    ...frontDoor.map((rel) => path.join(repoRoot, rel)).filter((file) => fs.existsSync(file)),
    ...(fs.existsSync(docsSite) ? walk(docsSite) : []),
  ];

  test('finds the docs it checks', () => {
    expect(files.map((file) => path.relative(repoRoot, file))).toEqual(expect.arrayContaining(['CONTRIBUTING.md']));
  });

  test.each(files.map((file) => [path.relative(repoRoot, file), file]))('%s', (_rel, file) => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/(localhost:\d+|commonly\.me)\/api\/docs\b/);
    expect(text).not.toMatch(/swagger/i);
  });
});

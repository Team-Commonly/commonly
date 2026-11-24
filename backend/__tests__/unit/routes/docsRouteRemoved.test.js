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

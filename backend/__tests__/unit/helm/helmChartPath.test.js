// F87: the helm tests read the chart from the repo, which is not at the same
// place in every runner. In CI and on a host the backend sits inside the
// checkout; under `./dev.sh test` the backend is mounted at /app and the
// repository at /repo:ro (docker-compose.dev.yml), so a path built from
// __dirname alone points at /k8s/helm/commonly and every read throws ENOENT.
const path = require('path');

const { findRepoRoot, REPO_ROOT, HELM_CHART } = require('../../utils/repoRoot');

const has = (...roots) => (p) => roots.some((root) => p === path.join(root, 'k8s/helm/commonly/Chart.yaml'));

describe('repo root for the helm tests (F87)', () => {
  test('uses the checkout the backend sits in when it holds the chart', () => {
    expect(findRepoRoot(['/work/commonly', '/repo'], has('/work/commonly', '/repo'))).toBe('/work/commonly');
  });

  test('falls back to the dev container mount when the relative path has no chart', () => {
    expect(findRepoRoot(['/', '/repo'], has('/repo'))).toBe('/repo');
  });

  test('names every place it looked when no candidate holds the chart', () => {
    expect(() => findRepoRoot(['/', '/repo'], has())).toThrow(/\/, \/repo/);
  });

  test('resolves to a real chart in this runner', () => {
    expect(HELM_CHART).toBe(path.join(REPO_ROOT, 'k8s/helm/commonly'));
    expect(require('fs').existsSync(path.join(HELM_CHART, 'Chart.yaml'))).toBe(true);
  });
});

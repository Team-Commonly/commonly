/**
 * The repository root, for tests that read files outside backend/ (the helm
 * chart above all). On a host and in CI the backend sits inside the checkout,
 * so the root is two levels above __tests__. Under `./dev.sh test` the backend
 * is mounted at /app and the repository at /repo:ro (docker-compose.dev.yml), so
 * the relative path lands at / and the chart is under /repo instead.
 */
const fs = require('fs');
const path = require('path');

const CHART_MARKER = 'k8s/helm/commonly/Chart.yaml';

const findRepoRoot = (candidates, exists = fs.existsSync) => {
  const root = candidates.find((candidate) => exists(path.join(candidate, CHART_MARKER)));
  if (!root) throw new Error(`no ${CHART_MARKER} under any of: ${candidates.join(', ')}`);
  return root;
};

const REPO_ROOT = findRepoRoot([path.resolve(__dirname, '..', '..', '..'), '/repo']);
const HELM_CHART = path.join(REPO_ROOT, 'k8s/helm/commonly');

module.exports = { findRepoRoot, REPO_ROOT, HELM_CHART };

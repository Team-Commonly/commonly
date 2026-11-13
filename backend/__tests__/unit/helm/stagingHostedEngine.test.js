const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

// Regression guard for F437: staging carried no backend.env.hostedEngine, so new
// "Run it here" installs fell back to the Durable Object engine
// (services/hostedEngine.ts engineForNewHostedInstall). Staging has no
// HOSTED_RUNTIME_URL, so every hosted provision there returned 503. Prod
// (values-dev) runs new installs on the native engine since TASK-265; staging
// must match, or a walk of the hosted path on staging tests a path prod no
// longer takes.
const loadValues = (name) => yaml.load(fs.readFileSync(path.join(HELM_CHART,
  name), 'utf8'));

const staging = loadValues('values-staging.yaml');
const dev = loadValues('values-dev.yaml');

describe('staging puts new hosted installs on the same engine as prod', () => {
  test('values-staging sets hostedEngine native', () => {
    expect(staging.backend.env.hostedEngine).toBe('native');
  });

  test('staging matches prod', () => {
    expect(staging.backend.env.hostedEngine).toBe(dev.backend.env.hostedEngine);
  });
});

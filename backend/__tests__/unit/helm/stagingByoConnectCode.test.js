const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

// Staging must hand out the same BYO connect step as prod. Prod (the VM) sets
// BYO_CONNECT_CODE=1, so agent-tokens.ts issues a one-line connect code beside
// the key. Staging had no way to set it, so a D341 walk on staging (2026-11-24)
// got the old four-line command with the full key and tested a step prod no
// longer serves.
const loadValues = (name) => yaml.load(fs.readFileSync(path.join(HELM_CHART, name), 'utf8'), { json: true });
const template = (rel) => fs.readFileSync(path.join(HELM_CHART, rel), 'utf8');
const entry = /- name: BYO_CONNECT_CODE\n\s+value: \{\{ \.Values\.backend\.env\.byoConnectCode \| quote \}\}/;

describe('staging issues BYO connect codes like prod', () => {
  test('the backend reads the flag from values', () => {
    expect(template('templates/core/backend-deployment.yaml')).toMatch(entry);
  });

  test('ops-runner mirrors it', () => {
    expect(template('templates/ops/ops-runner-deployment.yaml')).toMatch(entry);
  });

  test('values-staging turns it on with the exact value the route checks', () => {
    expect(loadValues('values-staging.yaml').backend.env.byoConnectCode).toBe('1');
  });
});

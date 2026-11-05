/**
 * F172: the Commonly Connect signing key reaches the backend only if the chart
 * maps GITHUB_CONNECT_APP_ID / _PRIVATE_KEY from `api-keys` (optional, so an
 * instance without Connect still starts) and `api-keys` references their
 * remote keys behind a default-off flag (a missing remoteRef stalls the whole
 * ExternalSecret). The env names are the ones githubAppNames reads.
 */
const fs = require('fs');
const path = require('path');
const { HELM_CHART } = require('../../utils/repoRoot');
const { githubAppCredentials } = require('../../../services/githubAppNames');

const read = (file) => fs.readFileSync(path.join(HELM_CHART, file), 'utf8');
const deployment = read('templates/core/backend-deployment.yaml');
const apiKeys = read('templates/secrets/api-keys.yaml');
const values = read('values.yaml');

test.each(['GITHUB_CONNECT_APP_ID', 'GITHUB_CONNECT_APP_PRIVATE_KEY'])('the backend maps %s from api-keys, optional', (name) => {
  expect(deployment).toMatch(new RegExp(
    `- name: ${name}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: api-keys\\n\\s+key: ${name}\\n\\s+optional: true\\n`,
  ));
});

test('api-keys references the Connect remote keys only behind githubConnectApp.enabled, off by default', () => {
  expect(apiKeys).toMatch(/{{- if \.Values\.githubConnectApp\.enabled }}\s*\n(?:\s*#.*\n)*\s*- secretKey: GITHUB_CONNECT_APP_ID\n\s+remoteRef:\n\s+key: {{ \$keyPrefix }}github-connect-app-id\n\s+- secretKey: GITHUB_CONNECT_APP_PRIVATE_KEY\n\s+remoteRef:\n\s+key: {{ \$keyPrefix }}github-connect-app-private-key\n\s+{{- end }}/);
  expect(values).toMatch(/\ngithubConnectApp:\n\s+enabled: false\n/);
});

test('the env names the chart maps are the ones the backend reads', () => {
  expect(githubAppCredentials('connect', {
    GITHUB_CONNECT_APP_ID: '1', GITHUB_CONNECT_APP_PRIVATE_KEY: 'k', GITHUB_APP_ID: '2', GITHUB_APP_PRIVATE_KEY: 'j',
  })).toEqual({ id: '1', key: 'k' });
  expect(githubAppCredentials('connect', { GITHUB_APP_ID: '2', GITHUB_APP_PRIVATE_KEY: 'j' })).toBeNull();
});

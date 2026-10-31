/**
 * A pre-registered hosted-MCP entry reads its client id and secret from env
 * names derived from its id (`hostedMcpClientConfigKeys`). Those names reach
 * the backend only if the helm chart maps them from `api-keys`, and `api-keys`
 * carries them only if the ExternalSecret references their Secret Manager keys.
 * Nothing else holds the three layers together (review-checklist rule 7).
 * GitHub's ExternalSecret entries are off by default for self-hosted instances.
 * Dev enables them only after both App client values exist with versions, and
 * both backend refs remain optional.
 */
const fs = require('fs');
const path = require('path');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { hostedMcpClientConfigKeys } = require('../../../services/hostedMcpIntakeService');

const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const deployment = fs.readFileSync(path.join(chart, 'templates/core/backend-deployment.yaml'), 'utf8');
const apiKeys = fs.readFileSync(path.join(chart, 'templates/secrets/api-keys.yaml'), 'utf8');
const values = fs.readFileSync(path.join(chart, 'values.yaml'), 'utf8');
const devValues = fs.readFileSync(path.join(chart, 'values-dev.yaml'), 'utf8');

// `- name: ENV` mapped from api-keys, optional so an instance with the entry's
// flag off still starts. Returns the api-keys key, or null when unmapped.
const apiKeysKeyForEnv = (envName) => {
  const mapping = deployment.match(new RegExp(
    `- name: ${envName}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: api-keys\\n`
    + '\\s+key: ([a-z0-9-]+)\\n\\s+optional: true\\n',
  ));
  return mapping ? mapping[1] : null;
};

const preRegistered = HOSTED_MCP_ENTRIES.filter((entry) => entry.client === 'pre-registered');

test('the pre-registered entries include Google Calendar, so the checks below are not vacuous', () => {
  expect(preRegistered.map((entry) => entry.id)).toContain('google-calendar');
});

// The environment-scoped Secret Manager key prefix is templated so a second
// release (staging) can read commonly-staging-<key> from the same project. The
// default must resolve to the prod prefix, which is what makes the templated
// remoteRef asserted below resolve to commonly-dev-<key> in prod.
test('api-keys defaults the SM key prefix to commonly-dev-', () => {
  expect(apiKeys).toMatch(
    /\$keyPrefix := \.Values\.externalSecrets\.keyPrefix \| default "commonly-dev-"/,
  );
});

// A non-empty table even when the list empties, so the guard above is what
// fails, by name, rather than jest refusing an empty `.each` at load time
// (#2111). The placeholder id is mapped nowhere, so its arms fail too.
const wiringTable = preRegistered.length
  ? preRegistered.map((entry) => [entry.id])
  : [['no-pre-registered-entry']];

test('GitHub client mapping is off by default and enabled only in configured dev', () => {
  expect(preRegistered.map((entry) => entry.id)).toContain('github-mcp');
  expect(values).toMatch(/hostedMcp:\n(?:.|\n)*?githubMcp:\n\s+enabled: false/);
  expect(devValues).toMatch(/hostedMcp:\n(?:.|\n)*?githubMcp:\n\s+enabled: true/);
  expect(apiKeys).toMatch(/{{- if \.Values\.hostedMcp\.githubMcp\.enabled }}[\s\S]*?secretKey: github-mcp-client-id[\s\S]*?secretKey: github-mcp-client-secret[\s\S]*?{{- end }}/);
});

describe.each(wiringTable)('%s client wiring', (entryId) => {
  const { clientId, clientSecret } = hostedMcpClientConfigKeys(entryId);

  test.each([[clientId], [clientSecret]])(
    '%s is mapped from api-keys and referenced by the ExternalSecret',
    (envName) => {
      const key = apiKeysKeyForEnv(envName);
      expect(key).not.toBeNull();
      // remoteRef key is templated `{{ $keyPrefix }}<key>`; $keyPrefix defaults
      // to commonly-dev- (asserted above), so this resolves to commonly-dev-<key>.
      expect(apiKeys).toMatch(new RegExp(
        `- secretKey: ${key}\\n\\s+remoteRef:\\n\\s+key: \\{\\{ \\$keyPrefix \\}\\}${key}\\n`,
      ));
    },
  );
});

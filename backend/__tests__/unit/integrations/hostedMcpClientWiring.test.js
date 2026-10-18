/**
 * A pre-registered hosted-MCP entry reads its client id and secret from env
 * names derived from its id (`hostedMcpClientConfigKeys`). Those names reach
 * the backend only if the helm chart maps them from `api-keys`, and `api-keys`
 * carries them only if the ExternalSecret references their Secret Manager keys.
 * Nothing else holds the three layers together (review-checklist rule 7).
 * GitHub is deliberately pending TASK-225's separate GitHub App registration:
 * its two env values have no deployment mapping yet, so it must stay unavailable.
 * Once that App and its Secret Manager values exist, remove the pending case
 * and wire both values like the other pre-registered entries.
 */
const fs = require('fs');
const path = require('path');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { hostedMcpClientConfigKeys } = require('../../../services/hostedMcpIntakeService');

const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const deployment = fs.readFileSync(path.join(chart, 'templates/core/backend-deployment.yaml'), 'utf8');
const apiKeys = fs.readFileSync(path.join(chart, 'templates/secrets/api-keys.yaml'), 'utf8');

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
// (Vera, #2111). The placeholder id is mapped nowhere, so its arms fail too.
const wiredEntries = preRegistered.filter((entry) => entry.id !== 'github-mcp');
const wiringTable = wiredEntries.length
  ? wiredEntries.map((entry) => [entry.id])
  : [['no-pre-registered-entry']];

test('the pending GitHub App has no deployment mapping until its registration is complete', () => {
  expect(preRegistered.map((entry) => entry.id)).toContain('github-mcp');
  const { clientId, clientSecret } = hostedMcpClientConfigKeys('github-mcp');
  expect(apiKeysKeyForEnv(clientId)).toBeNull();
  expect(apiKeysKeyForEnv(clientSecret)).toBeNull();
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

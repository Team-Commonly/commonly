/**
 * A pre-registered hosted-MCP entry reads its client id and secret from env
 * names derived from its id (`hostedMcpClientConfigKeys`). Those names reach
 * the backend only if the helm chart maps them from `api-keys`, and `api-keys`
 * carries them only if the ExternalSecret references their Secret Manager keys.
 * Nothing else holds the three layers together: an entry added without its
 * wiring reads `not_configured` in production while every other test stays
 * green (review-checklist rule 7, a phantom cross-layer contract). This pins
 * the chain for every pre-registered entry, so the next one cannot ship
 * half-wired.
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

describe.each(preRegistered.map((entry) => [entry.id]))('%s client wiring', (entryId) => {
  const { clientId, clientSecret } = hostedMcpClientConfigKeys(entryId);

  test.each([[clientId], [clientSecret]])(
    '%s is mapped from api-keys and referenced by the ExternalSecret',
    (envName) => {
      const key = apiKeysKeyForEnv(envName);
      expect(key).not.toBeNull();
      expect(apiKeys).toMatch(new RegExp(
        `- secretKey: ${key}\\n\\s+remoteRef:\\n\\s+key: commonly-dev-${key}\\n`,
      ));
    },
  );
});

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Regression guard for the 2026-10-31 staging-walk incident: Scout's onboarding
// REPLY turns failed ("native runtime failed: turn failed") because the staging
// backend points native-runtime LLM calls at the in-cluster `litellm` service
// (LITELLM_BASE_URL=http://litellm:4000), but values-staging carried no `litellm:`
// stanza and so inherited the base default `enabled:false` — no litellm in the
// namespace. The scripted welcome still posted, which hid it. This test fails if
// anyone points staging's backend at a litellm that isn't deployed in the same ns.
const loadValues = (name) => yaml.load(fs.readFileSync(path.join(__dirname,
  `../../../../k8s/helm/commonly/${name}`), 'utf8'));

const staging = loadValues('values-staging.yaml');
const dev = loadValues('values-dev.yaml');

describe('staging LiteLLM is enabled so native-runtime agents (Scout) can answer', () => {
  test('values-staging enables litellm', () => {
    // The staging backend always drives the native runtime at http://litellm:4000,
    // so litellm MUST be enabled in the staging namespace or every agent turn fails.
    expect(staging.litellm).toBeDefined();
    expect(staging.litellm.enabled).toBe(true);
  });

  test('prod (values-dev) also has litellm enabled — same invariant', () => {
    expect(dev.litellm.enabled).toBe(true);
  });

  test('staging is kept small: master key only, no budgeted virtual keys to mint', () => {
    // serviceKeys.fromSecret:true would require commonly-staging-litellm-backend-key /
    // -commonly-bot-key to exist in Secret Manager or ExternalSecrets rejects the whole
    // api-keys bundle. Staging intentionally uses the master key, so this stays false.
    expect(staging.litellm.serviceKeys && staging.litellm.serviceKeys.fromSecret).toBe(false);
  });

  test('staging runs no Codex rotator — it carries no Codex traffic', () => {
    // Base default is true (prod rotates Codex accounts); staging must override to false
    // so the rotator sidecar is not rendered. Scout runs on deepseek-v4-flash.
    expect(staging.litellm.codexAuthRotator.enabled).toBe(false);
  });

  test('staging litellm schedules on dev-pool so Sam-check turns are not reclaimed mid-walk', () => {
    expect(staging.litellm.nodeSelector).toEqual({ pool: 'dev' });
    expect(staging.litellm.tolerations).toEqual([
      { key: 'pool', operator: 'Equal', value: 'dev', effect: 'NoSchedule' },
    ]);
  });
});

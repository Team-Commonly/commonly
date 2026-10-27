/**
 * First-party native apps must name a model the deployment can actually serve.
 *
 * pod-summarizer, pod-welcomer and task-clerk kept the free OpenRouter
 * nemotron route after its key expired on 2026-10-25. LiteLLM still declares
 * that name, so nothing failed at boot; every run died on its first model call
 * with HTTP 404 (6 of 8 pod-summarizer runs in the 48h before 2026-10-27).
 * Declared is not the same as servable, so this pins both.
 */
const fs = require('fs');
const path = require('path');
const { FIRST_PARTY_APPS } = require('../../../config/native-agents/apps');

const litellmConfig = fs.readFileSync(path.join(__dirname,
  '../../../../k8s/helm/commonly/templates/configmaps/litellm-config.yaml'), 'utf8');
const declaredModels = new Set(
  [...litellmConfig.matchAll(/model_name:\s*(\S+)/g)].map((m) => m[1]),
);

describe('first-party native app model routes', () => {
  test.each(FIRST_PARTY_APPS.map((app) => [app.agentName, app.model]))(
    '%s names a model LiteLLM declares',
    (_name, model) => {
      expect(declaredModels.has(model)).toBe(true);
    },
  );

  test.each(FIRST_PARTY_APPS.map((app) => [app.agentName, app.model]))(
    '%s does not route through the expired OpenRouter free tier',
    (_name, model) => {
      expect(model).not.toMatch(/^openrouter\//);
      expect(model).not.toMatch(/:free$/);
    },
  );
});

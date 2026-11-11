/**
 * The stranger journey (k8s/helm/commonly/files/stranger-journey.py) and its
 * chart wiring (F375). Its logic is tested in Python (stranger_journey_test.py,
 * beside this file); this runs that suite and pins the wiring: the optional
 * invite-code env from a Secret, and staging held off until that Secret
 * exists. No helm render, because this jest job has no helm.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

const read = (rel) => fs.readFileSync(path.join(HELM_CHART, rel), 'utf8');

describe('stranger journey', () => {
  test('python unit suite passes', () => {
    const r = spawnSync('python3', ['-I', path.join(__dirname, 'stranger_journey_test.py'),
      path.join(HELM_CHART, 'files/stranger-journey.py')], { encoding: 'utf8', timeout: 60000 });
    if (r.error) throw r.error;
    expect(`${r.stdout}${r.stderr}`).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  });

  test('the invite code reaches the Job only from a Secret, and only when one is named', () => {
    const template = read('templates/journey/stranger-journey.yaml');
    const env = template.slice(template.indexOf('inviteCodeSecret'), template.indexOf('volumeMounts'));
    expect(env).toContain('{{- if .name }}');
    expect(env.indexOf('{{- if .name }}')).toBeLessThan(env.indexOf('JOURNEY_INVITE_CODE'));
    expect(env).toMatch(/JOURNEY_INVITE_CODE\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:/);
    expect(template).not.toMatch(/JOURNEY_INVITE_CODE\s*\n\s*value:/);
    // values.yaml has an unrelated duplicate key js-yaml refuses, so read it as text.
    const base = read('values.yaml');
    expect(base).toMatch(/\n {2}inviteCodeSecret:\n {4}name: ""\n {4}key: ""\n/);
  });

  test('staging points at its own API and runs only with an invite code and an allowed domain', () => {
    // deploy-staging runs this CronJob as the staging-smoke gate. On invite-only,
    // domain-restricted staging a journey with no code, or on a domain staging
    // refuses, fails at signup and blocks every prod deploy.
    const staging = yaml.load(read('values-staging.yaml'));
    expect(staging.strangerJourney.apiUrl).toBe('https://api-staging.commonly.me');
    if (staging.strangerJourney.enabled) {
      expect(staging.strangerJourney.inviteCodeSecret.name).toBeTruthy();
      expect(staging.strangerJourney.inviteCodeSecret.key).toBeTruthy();
      const script = read('files/stranger-journey.py');
      const domain = script.match(/JOURNEY_EMAIL_DOMAIN', '([^']+)'/)[1];
      expect(staging.backend.env.authAllowedDomains.split(',')).toContain(domain);
      // Restricted staging signs in verified accounts only; the sink is how the
      // journey verifies.
      expect(staging.email.sink.enabled).toBe(true);
    }
  });

  test('the sink token reaches the Job only where the sink is on, and only from its Secret', () => {
    const template = read('templates/journey/stranger-journey.yaml');
    const block = template.slice(template.indexOf('{{- if .Values.email.sink.enabled }}'), template.indexOf('volumeMounts'));
    expect(block).toMatch(/JOURNEY_EMAIL_SINK_TOKEN\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name: email-sink\s*\n\s*key: read-token/);
    expect(template).not.toMatch(/JOURNEY_EMAIL_SINK_TOKEN\s*\n\s*value:/);
  });
});

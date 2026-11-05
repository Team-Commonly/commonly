const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

// TASK-284: the seat push tool (`github.push_branch`) lands dark. The backend
// offers it only when SEAT_GITHUB_PUSH_ENABLED is exactly "true"
// (toolBrokerService.seatGithubPushEnabled). Staging turns it on for the
// supervised walk in #2546; production stays off until that walk is recorded.
const helm = HELM_CHART;
// `json: true` keeps the last of a duplicated key, as Helm does: values.yaml
// declares backend.nodeSelector twice, which strict parsing refuses.
const loadValues = (name) => yaml.load(fs.readFileSync(path.join(helm, name), 'utf8'), { json: true });
const template = fs.readFileSync(path.join(helm, 'templates/core/backend-deployment.yaml'), 'utf8');

describe('the seat GitHub push flag', () => {
  test('the backend reads it from values, off when unset', () => {
    expect(template).toMatch(/- name: SEAT_GITHUB_PUSH_ENABLED\n\s+value: \{\{ \.Values\.backend\.env\.seatGithubPushEnabled \| default "false" \| quote \}\}/);
  });

  test('the base default is off', () => {
    expect(loadValues('values.yaml').backend.env.seatGithubPushEnabled).toBe('false');
  });

  test('production (values-dev) does not turn it on', () => {
    const env = (loadValues('values-dev.yaml').backend || {}).env || {};
    expect(env.seatGithubPushEnabled === undefined || env.seatGithubPushEnabled === 'false').toBe(true);
  });

  test('staging turns it on for the supervised walk', () => {
    expect(loadValues('values-staging.yaml').backend.env.seatGithubPushEnabled).toBe('true');
  });
});

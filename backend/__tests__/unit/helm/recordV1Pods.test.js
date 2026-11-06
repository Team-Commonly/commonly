/**
 * Records are on only for the pods RECORD_V1_PODS names (recordService
 * isRecordEnabled). The chart carries it from backend.env.recordV1Pods into the
 * backend (and the worker, which shares that template) and ops-runner, and dev
 * names our two team boards. Before this, nothing set it and every task record
 * read "not available".
 */
const fs = require('fs');
const path = require('path');
const { HELM_CHART } = require('../../utils/repoRoot');

const read = (file) => fs.readFileSync(path.join(HELM_CHART, file), 'utf8');
const WIRING = /\{\{- if \.Values\.backend\.env\.recordV1Pods \}\}\n\s+- name: RECORD_V1_PODS\n\s+value: \{\{ \.Values\.backend\.env\.recordV1Pods \| quote \}\}\n\s+\{\{- end \}\}/;

describe('RECORD_V1_PODS', () => {
  test.each(['templates/core/backend-deployment.yaml', 'templates/ops/ops-runner-deployment.yaml'])(
    '%s takes it from backend.env.recordV1Pods',
    (file) => { expect(read(file)).toMatch(WIRING); },
  );

  test('dev turns records on for the Sharpen and Connectors boards only', () => {
    const dev = read('values-dev.yaml');
    const value = dev.match(/^ {4}recordV1Pods: "([^"]*)"$/m);
    expect(value).not.toBeNull();
    expect(value[1].split(',')).toEqual(['6a8f6dc7a1dccf2e02f31015', '6a692a1be833c668acdb84cf']);
    expect(value[1]).not.toContain('*');
  });

  test('the default chart leaves records off', () => {
    expect(read('values.yaml')).not.toMatch(/recordV1Pods:\s*"\S/);
  });
});

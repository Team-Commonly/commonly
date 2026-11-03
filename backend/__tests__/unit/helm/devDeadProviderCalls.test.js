const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// F78, 2026-11-03: on dev, Google rejects the Gemini key and the OpenAI key is a
// placeholder, so every direct call sent content out and got nothing back.
// Values-level like the other tests here; the Chart Lint CI tier renders it.
const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
// json: true resolves a duplicate key last-wins, as Helm does; values.yaml
// carries one (backend.nodeSelector) that strict parsing rejects.
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const base = yaml.load(read('values.yaml'), { json: true });

describe('dev makes no direct calls to providers whose keys cannot answer', () => {
  test('the Gemini key is off on dev and on by default elsewhere', () => {
    expect(dev.aiProviders.gemini.enabled).toBe(false);
    expect(base.aiProviders.gemini.enabled).toBe(true);
  });

  test('avatars draw a design and embeddings stay off on dev', () => {
    expect(dev.backend.env.avatarProvider).toBe('design');
    expect(dev.backend.env.embeddingProvider).toBe('none');
  });

  // The backend jest job has no helm binary, so this reads the template text;
  // Chart Lint renders it. Both containers must emit the dev values.
  test.each([
    'templates/core/backend-deployment.yaml',
    'templates/ops/ops-runner-deployment.yaml',
  ])('%s emits AVATAR_PROVIDER and EMBEDDING_PROVIDER from backend.env', (file) => {
    const t = read(file);
    expect(t).toContain('- name: AVATAR_PROVIDER\n          value: {{ .Values.backend.env.avatarProvider | quote }}');
    expect(t).toContain('- name: EMBEDDING_PROVIDER\n          value: {{ .Values.backend.env.embeddingProvider | quote }}');
  });

  test.each([
    'templates/core/backend-deployment.yaml',
    'templates/ops/ops-runner-deployment.yaml',
    'templates/agents/commonly-bot-deployment.yaml',
  ])('%s injects GEMINI_API_KEY only under the positive gate', (file) => {
    const t = read(file);
    const at = t.indexOf('- name: GEMINI_API_KEY');
    expect(at).toBeGreaterThan(-1);
    const before = t.slice(0, at)
      .trimEnd()
      .split('\n')
      .pop()
      .trim();
    expect(before).toBe('{{- if .Values.aiProviders.gemini.enabled }}');
  });
});

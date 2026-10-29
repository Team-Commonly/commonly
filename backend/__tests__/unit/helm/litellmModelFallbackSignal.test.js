/**
 * The LiteLLM model-fallback signal (k8s/helm/commonly/files/litellm/
 * model_fallback_signal.py) prints one {"alarm":"model_fallback"} line each time
 * the router answers a failed model group from router_settings.fallbacks
 * (TASK-003). The `model_fallback` log metric counts those lines for SRE's alert.
 *
 * Its logic is tested in Python (litellm_model_fallback_signal_test.py, beside
 * this file). This runs that suite and pins the wiring that makes the line
 * reach the metric: the ConfigMap key, the mount next to config.yaml, the
 * callbacks entry, and the log-metric filter on the litellm container. No helm
 * render, because this jest job has no helm.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '../../../..');
const chart = path.join(repo, 'k8s/helm/commonly');
const signal = path.join(chart, 'files/litellm/model_fallback_signal.py');
const read = (rel) => fs.readFileSync(path.join(chart, rel), 'utf8');

describe('LiteLLM model fallback signal', () => {
  test('python unit suite passes', () => {
    const r = spawnSync('python3', ['-I', path.join(__dirname, 'litellm_model_fallback_signal_test.py'), signal], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.error) throw r.error;
    expect(`${r.stdout}${r.stderr}`).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  });

  test('the ConfigMap carries the module and registers it as a callback', () => {
    const cm = read('templates/configmaps/litellm-config.yaml');
    expect(cm).toContain('  model_fallback_signal.py: |\n    {{- .Files.Get "files/litellm/model_fallback_signal.py" | nindent 4 }}');
    expect(cm).toMatch(/^ {6}callbacks: \[[^\]\n]*"model_fallback_signal\.proxy_handler_instance"[^\]\n]*\]$/m);
  });

  test('the module is mounted next to config.yaml, where LiteLLM resolves callbacks', () => {
    expect(read('templates/agents/litellm-deployment.yaml')).toContain([
      '        - name: litellm-config',
      '          mountPath: /app/model_fallback_signal.py',
      '          subPath: model_fallback_signal.py',
    ].join('\n'));
  });

  test('the log metric counts the line from the litellm container', () => {
    const metrics = JSON.parse(fs.readFileSync(path.join(repo, 'k8s/monitoring/log-metrics.json'), 'utf8'));
    const metric = metrics.find((m) => m.name === 'model_fallback');
    expect(metric).toBeDefined();
    expect(metric.filter).toContain('resource.labels.container_name="litellm"');
    expect(metric.filter).toContain('jsonPayload.alarm="model_fallback"');
    expect(fs.readFileSync(signal, 'utf8')).toContain("'alarm': 'model_fallback'");
  });
});

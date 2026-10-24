/**
 * The LiteLLM DeepSeek tool shim (k8s/helm/commonly/files/litellm/
 * deepseek_tool_shim.py) flattens codex's `namespace` tools into plain
 * function tools for the deepseek-flash-1017 group, which DeepSeek requires.
 *
 * Its logic is tested in Python (litellm_deepseek_tool_shim_test.py, beside
 * this file); this runs that suite and pins the chart wiring that loads the
 * module: the ConfigMap key, the mount next to config.yaml, and the callbacks
 * entry. No helm render, because this jest job has no helm.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const shim = path.join(chart, 'files/litellm/deepseek_tool_shim.py');
const read = (rel) => fs.readFileSync(path.join(chart, rel), 'utf8');

describe('LiteLLM DeepSeek tool shim', () => {
  test('python unit suite passes', () => {
    const r = spawnSync('python3', ['-I', path.join(__dirname, 'litellm_deepseek_tool_shim_test.py'), shim], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.error) throw r.error;
    expect(`${r.stdout}${r.stderr}`).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  });

  test('the ConfigMap carries the module and registers it as a callback', () => {
    const cm = read('templates/configmaps/litellm-config.yaml');
    expect(cm).toContain('  deepseek_tool_shim.py: |\n    {{- .Files.Get "files/litellm/deepseek_tool_shim.py" | nindent 4 }}');
    expect(cm).toContain('callbacks: ["rate_limit_signal.proxy_handler_instance", "deepseek_tool_shim.proxy_handler_instance"]');
  });

  test('the module is mounted next to config.yaml, where LiteLLM resolves callbacks', () => {
    const deploy = read('templates/agents/litellm-deployment.yaml');
    expect(deploy).toContain([
      '        - name: litellm-config',
      '          mountPath: /app/deepseek_tool_shim.py',
      '          subPath: deepseek_tool_shim.py',
    ].join('\n'));
  });

  test('only the deepseek-flash-1017 group is shimmed', () => {
    expect(fs.readFileSync(shim, 'utf8')).toContain("SHIM_MODEL_GROUPS = frozenset({'deepseek-flash-1017'})");
  });
});

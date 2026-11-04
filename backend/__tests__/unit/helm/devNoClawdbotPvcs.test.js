// ADR-021 retired the OpenClaw gateway, and TASK-521 deleted its two PVCs
// from dev on 2026-11-04 after the export was verified restorable. Both
// templates default to enabled, so dev must switch them off or the next
// helm upgrade recreates them empty.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
// values.yaml repeats a key (backend.nodeSelector); json mode keeps the last one.
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const base = yaml.load(read('values.yaml'), { json: true });

describe('dev renders no clawdbot PVCs (TASK-521)', () => {
  test('both persistence volumes are off on dev', () => {
    expect(dev.agents.clawdbot.persistence.config.enabled).toBe(false);
    expect(dev.agents.clawdbot.persistence.workspace.enabled).toBe(false);
  });

  test('each PVC template renders only when its persistence flag is on', () => {
    expect(read('templates/pvcs/clawdbot-config-pvc.yaml'))
      .toMatch(/^\{\{- if \.Values\.agents\.clawdbot\.persistence\.config\.enabled \}\}/);
    expect(read('templates/pvcs/clawdbot-workspace-pvc.yaml'))
      .toMatch(/^\{\{- if \.Values\.agents\.clawdbot\.persistence\.workspace\.enabled \}\}/);
  });

  test('the defaults stay on for other installs', () => {
    expect(base.agents.clawdbot.persistence.config.enabled).toBe(true);
    expect(base.agents.clawdbot.persistence.workspace.enabled).toBe(true);
  });
});

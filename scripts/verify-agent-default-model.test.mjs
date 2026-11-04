// F103: verify-agent-default-model.js must refuse every way a dev default can
// reach DeepSeek, not only a direct route. Fixtures are JSON, which is YAML.
//   node --test scripts/verify-agent-default-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-agent-default-model.js');
const CLAUDE = { model_name: 'claude-haiku-5-5', litellm_params: { model: 'anthropic/claude-haiku-5-5' } };
const DEEPSEEK = { model_name: 'deepseek-v4-flash', litellm_params: { model: 'deepseek/deepseek-v4-flash' } };

const manifest = ({ modelList = [CLAUDE, DEEPSEEK], routerSettings = {}, litellmSettings = {}, primary = 'openrouter/claude-haiku-5-5' } = {}) => {
  const docs = [
    { kind: 'ConfigMap', metadata: { name: 'litellm-config' }, data: { 'config.yaml': JSON.stringify({ model_list: modelList, router_settings: routerSettings, litellm_settings: litellmSettings }) } },
    { kind: 'Deployment', metadata: { name: 'backend' }, spec: { template: { spec: { containers: [{ env: [{ name: 'AGENT_DEFAULT_MODEL', value: 'claude-haiku-5-5' }] }] } } } },
    { kind: 'ConfigMap', metadata: { name: 'clawdbot-config' }, data: { 'moltbot.json': JSON.stringify({
      models: { providers: { openrouter: { baseUrl: 'http://litellm.ns.svc.cluster.local:4000', models: [{ id: 'claude-haiku-5-5' }] } } },
      agents: { defaults: { model: { primary, fallbacks: ['google/gemini-2.5-flash'] } } },
    }) } },
  ];
  return docs.map((d) => JSON.stringify(d)).join('\n---\n');
};
const verify = (input, args = ['--no-deepseek']) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

test('a Claude-only render passes', () => {
  const result = verify(manifest());
  assert.equal(result.status, 0, result.stderr);
});

test('a DeepSeek deployment sharing the Claude name fails, wherever it sits in the list', () => {
  const shadow = { model_name: 'claude-haiku-5-5', litellm_params: { model: 'deepseek/deepseek-v4-flash' } };
  for (const modelList of [[shadow, CLAUDE, DEEPSEEK], [CLAUDE, shadow, DEEPSEEK]]) {
    const result = verify(manifest({ modelList }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"claude-haiku-5-5" reaches deepseek\/deepseek-v4-flash/);
  }
});

test('a fallback from the default to DeepSeek fails, for every fallback kind and settings block', () => {
  for (const key of ['fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks']) {
    for (const block of ['routerSettings', 'litellmSettings']) {
      const result = verify(manifest({ [block]: { [key]: [{ 'claude-haiku-5-5': ['deepseek-v4-flash'] }] } }));
      assert.equal(result.status, 1, `${block}.${key}`);
      assert.match(result.stderr, /through the fallback to "deepseek-v4-flash"/);
    }
  }
});

test('a fallback chain that reaches DeepSeek in two hops fails', () => {
  const hop = { model_name: 'claude-sonnet-5-5', litellm_params: { model: 'anthropic/claude-sonnet-5-5' } };
  const result = verify(manifest({
    modelList: [CLAUDE, hop, DEEPSEEK],
    routerSettings: { fallbacks: [{ 'claude-haiku-5-5': ['claude-sonnet-5-5'] }, { 'claude-sonnet-5-5': ['deepseek-v4-flash'] }] },
  }));
  assert.equal(result.status, 1);
});

test('a DeepSeek default_fallbacks entry fails', () => {
  const result = verify(manifest({ routerSettings: { default_fallbacks: ['deepseek-v4-flash'] } }));
  assert.equal(result.status, 1);
});

test('a google/* primary fails; a google/* fallback is listed but not resolved', () => {
  const result = verify(manifest({ primary: 'google/gemini-2.5-flash' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /goes straight to Google/);
  assert.match(verify(manifest()).stdout, /google\/gemini-2\.5-flash \(direct to Google, not resolved\)/);
});

test('without --no-deepseek, a DeepSeek fallback is allowed (base)', () => {
  const result = verify(manifest({ routerSettings: { fallbacks: [{ 'claude-haiku-5-5': ['deepseek-v4-flash'] }] } }), []);
  assert.equal(result.status, 0, result.stderr);
});

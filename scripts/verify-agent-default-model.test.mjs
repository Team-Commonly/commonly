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
    assert.match(result.stderr, /"claude-haiku-5-5" reaches DeepSeek \(deepseek\/deepseek-v4-flash\)/);
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
  assert.match(result.stderr, /reaches DeepSeek .* through the fallback to "deepseek-v4-flash"/);
});

// Each DeepSeek case must fail for that reason, not because a fixture left a
// name unrouted.
const failsOnDeepseek = (result, label) => {
  assert.equal(result.status, 1, label);
  assert.match(result.stderr, /reaches DeepSeek/, label);
  assert.doesNotMatch(result.stderr, /is not a LiteLLM model_name/, label);
};

test('a DeepSeek default_fallbacks entry, or a `*` fallback rule, fails', () => {
  failsOnDeepseek(verify(manifest({ routerSettings: { default_fallbacks: ['deepseek-v4-flash'] } })), 'default_fallbacks');
  failsOnDeepseek(verify(manifest({ routerSettings: { fallbacks: [{ '*': ['deepseek-v4-flash'] }] } })), '* rule');
});

test('a model_group_alias from the default to DeepSeek fails, whether or not the name also routes', () => {
  for (const target of ['deepseek-v4-flash', { model: 'deepseek-v4-flash', hidden: true }]) {
    for (const modelList of [[DEEPSEEK], [CLAUDE, DEEPSEEK]]) {
      failsOnDeepseek(verify(manifest({ modelList, routerSettings: { model_group_alias: { 'claude-haiku-5-5': target } } })), JSON.stringify(target));
    }
  }
});

test('a default served only through a Claude alias passes', () => {
  const result = verify(manifest({
    modelList: [{ model_name: 'claude-haiku-latest', litellm_params: { model: 'anthropic/claude-haiku-5-5' } }, DEEPSEEK],
    routerSettings: { model_group_alias: { 'claude-haiku-5-5': 'claude-haiku-latest' } },
  }));
  assert.equal(result.status, 0, result.stderr);
});

test('DeepSeek is caught by provider, api_base or case, not only a lowercase prefix', () => {
  for (const litellm_params of [
    { model: 'DeepSeek/deepseek-v4-flash' },
    { model: 'deepseek-v4-flash', custom_llm_provider: 'deepseek' },
    { model: 'openai/deepseek-v4-flash', api_base: 'https://api.deepseek.com/v1' },
    { model: 'openrouter/deepseek/deepseek-r1-0528' },
  ]) {
    failsOnDeepseek(verify(manifest({ modelList: [{ model_name: 'claude-haiku-5-5', litellm_params }] })), JSON.stringify(litellm_params));
  }
});

test('a fallback or alias target with no route fails, with or without --no-deepseek', () => {
  for (const args of [['--no-deepseek'], []]) {
    for (const routerSettings of [
      { fallbacks: [{ 'claude-haiku-5-5': ['no-such-model'] }] },
      { default_fallbacks: ['no-such-model'] },
      { model_group_alias: { 'claude-haiku-5-5': 'no-such-model' } },
    ]) {
      const result = verify(manifest({ routerSettings }), args);
      assert.equal(result.status, 1, `${args} ${JSON.stringify(routerSettings)}`);
      assert.match(result.stderr, /falls back to "no-such-model", which is not a LiteLLM model_name/);
    }
  }
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

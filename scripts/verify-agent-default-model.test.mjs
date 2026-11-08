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

const manifest = ({ modelList = [CLAUDE, DEEPSEEK], routerSettings = {}, litellmSettings = {}, backendEnv = [], extraDocs = [] } = {}) => {
  const docs = [
    { kind: 'ConfigMap', metadata: { name: 'litellm-config' }, data: { 'config.yaml': JSON.stringify({ model_list: modelList, router_settings: routerSettings, litellm_settings: litellmSettings }) } },
    { kind: 'Deployment', metadata: { name: 'backend' }, spec: { template: { spec: { containers: [{ env: [{ name: 'AGENT_DEFAULT_MODEL', value: 'claude-haiku-5-5' }, ...backendEnv] }] } } } },
    ...extraDocs,
  ];
  return docs.map((d) => JSON.stringify(d)).join('\n---\n');
};
const verify = (input, args = ['--no-deepseek']) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

test('a Claude-only render passes', () => {
  const result = verify(manifest({ modelList: [CLAUDE] }));
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
    modelList: [{ model_name: 'claude-haiku-latest', litellm_params: { model: 'anthropic/claude-haiku-5-5' } }],
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

test('without --no-deepseek, a DeepSeek fallback is allowed (base)', () => {
  const result = verify(manifest({ routerSettings: { fallbacks: [{ 'claude-haiku-5-5': ['deepseek-v4-flash'] }] } }), []);
  assert.equal(result.status, 0, result.stderr);
});

// F159: with --no-deepseek (dev), DeepSeek is deleted, not only unused: no
// route, no key on any workload or in any ExternalSecret, and no chat-model
// default naming it.
const litellmDeployment = (env) => ({ kind: 'Deployment', metadata: { name: 'litellm' }, spec: { template: { spec: { containers: [{ env }] } } } });
const keyEnv = { name: 'DEEPSEEK_API_KEY', valueFrom: { secretKeyRef: { name: 'api-keys', key: 'deepseek-api-key' } } };
const externalSecret = (secretKey) => ({ kind: 'ExternalSecret', metadata: { name: 'api-keys' }, spec: { data: [{ secretKey: 'jwt-secret' }, { secretKey }] } });

test('a DeepSeek route no default names still fails with --no-deepseek, and passes without', () => {
  const input = manifest({ modelList: [CLAUDE, { model_name: 'deepseek-flash-1017', litellm_params: { model: 'deepseek/deepseek-flash' } }] });
  const result = verify(input);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /litellm-config routes "deepseek-flash-1017" to DeepSeek \(deepseek\/deepseek-flash\)/);
  assert.equal(verify(input, []).status, 0);
});

test('a DeepSeek key on a workload or in an ExternalSecret fails with --no-deepseek, and passes without', () => {
  for (const [extraDocs, message] of [
    [[litellmDeployment([keyEnv])], /litellm: env DEEPSEEK_API_KEY is set/],
    [[litellmDeployment([{ name: 'X', valueFrom: { secretKeyRef: { name: 'api-keys', key: 'deepseek-api-key' } } }])], /litellm: env X reads secret key deepseek-api-key/],
    [[externalSecret('deepseek-api-key')], /ExternalSecret api-keys maps deepseek-api-key/],
  ]) {
    const input = manifest({ modelList: [CLAUDE], extraDocs });
    const result = verify(input);
    assert.equal(result.status, 1, String(message));
    assert.match(result.stderr, message);
    assert.equal(verify(input, []).status, 0, String(message));
  }
});

test('the chat-model defaults are resolved: DeepSeek fails with --no-deepseek, an unrouted one always', () => {
  for (const name of ['LITELLM_CHAT_MODEL', 'NATIVE_RUNTIME_MODEL', 'LLM_SERVICE_MODEL']) {
    const deepseek = manifest({ backendEnv: [{ name, value: 'deepseek-v4-flash' }] });
    failsOnDeepseek(verify(deepseek), name);
    assert.equal(verify(deepseek, []).status, 0, name);
    const unrouted = verify(manifest({ modelList: [CLAUDE], backendEnv: [{ name, value: 'deepseek-v4-flash' }] }), []);
    assert.equal(unrouted.status, 1, name);
    assert.match(unrouted.stderr, new RegExp(`backend ${name}: "deepseek-v4-flash" is not a LiteLLM model_name`));
  }
  const bot = { kind: 'Deployment', metadata: { name: 'commonly-bot' }, spec: { template: { spec: { containers: [{ env: [{ name: 'AGENT_MODEL', value: 'deepseek-v4-flash' }] }] } } } };
  failsOnDeepseek(verify(manifest({ extraDocs: [bot] })), 'commonly-bot AGENT_MODEL');
  assert.equal(verify(manifest({ modelList: [CLAUDE], backendEnv: [{ name: 'LITELLM_CHAT_MODEL', value: 'claude-haiku-5-5' }] })).status, 0);
});

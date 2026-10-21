#!/usr/bin/env node
/** Run against an installed, pinned dsh binary before adding its version to the adapter. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPatch, resolveCommonlyMcp, TESTED_DSH_VERSIONS } from '../src/lib/adapters/dsh.js';

const binary = process.env.DSH_BINARY || 'dsh';
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
assert.equal(version.status, 0, 'dsh --version failed');
assert.match(version.stdout, /0\.2\.1-rc\.2/);
assert.deepEqual(TESTED_DSH_VERSIONS, ['0.2.1-rc.2']);

const root = await mkdtemp(join(tmpdir(), 'commonly-dsh-probe-'));
await chmod(root, 0o700);
const cwd = join(root, 'workspace');
await mkdir(cwd);
const run = (args, home, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, {
    cwd,
    env: {
      PATH: process.env.PATH, HOME: home, DSH_HOME: home,
      DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_TELEMETRY_DISABLED: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
const writePatch = async (name, rows) => {
  const path = join(root, `${name}.patch.yml`);
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  return path;
};
const section = (text, id) => {
  const start = text.indexOf(`- id: ${id}\n`);
  if (start < 0) return '';
  const end = text.indexOf('\n- id: ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
const requireComposed = (text) => {
  assert.match(section(text, 'llm-pi-ai'), /api: openai-completions/);
  assert.match(section(text, 'llm-pi-ai'), /baseURL: http:\/\/127\.0\.0\.1:9999\/v1/);
  assert.match(section(text, 'llm-pi-ai'), /reasoning: high/);
  assert.match(section(text, 'llm-pi-ai'), /thinkingFormat: deepseek/);
  assert.match(section(text, 'llm-pi-ai'), /supportsDeveloperRole: false/);
  assert.match(section(text, 'llm-pi-ai'), /supportsStore: false/);
  assert.match(section(text, 'agent-default-model'), /provider: commonly/);
  assert.match(section(text, 'llm-deepseek'), /disabled: true/);
  assert.match(section(text, 'llm-deepseek-account'), /disabled: true/);
  assert.match(section(text, 'session-log-deepseek'), /enabled: false/);
  assert.match(section(text, 'sandbox-policy'), /mode: workspace-write/);
  assert.match(section(text, 'mcp-commonly'), /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(section(text, 'mcp-commonly'), /COMMONLY_TOKEN_FILE:/);
};

const serverBodies = [];
const frames = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native reply' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  serverBodies.push({ body, authorization: req.headers.authorization, xApiKey: req.headers['x-api-key'] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  res.end();
});
let piServer;

try {
  const mcp = resolveCommonlyMcp([], {
    credentialFile: join(root, 'fake-credential-path'), instanceUrl: 'https://api.commonly.me',
  });
  const rows = buildPatch({ proxyBaseURL: 'http://127.0.0.1:9999/v1', model: 'deepseek-flash', cwd, mcp,
    effort: 'high', deepseekOfficial: true });
  const home = join(root, 'config-home');
  const dump = async (name, patchRows) => {
    const path = await writePatch(name, patchRows);
    const result = await run(['--profile', 'headless', '--patch', path, '--dump-config'], home);
    assert.equal(result.code, 0, `${name}: dump failed: ${result.stderr}`);
    return result.stdout;
  };
  requireComposed(await dump('good', rows));
  const mutants = [
    ['wrong-api', (copy) => { copy[0].config.providers.commonly.api = 'openai-responses'; }],
    ['thinking-off', (copy) => { delete copy[0].config.providers.commonly.reasoning; }],
    ['developer-role-on', (copy) => { copy[0].config.providers.commonly.compat.supportsDeveloperRole = true; }],
    ['store-on', (copy) => { copy[0].config.providers.commonly.compat.supportsStore = true; }],
    ['wrong-model-route', (copy) => { copy[1].config.provider = 'deepseek-official'; }],
    ['native-on', (copy) => { copy[2].disabled = false; }],
    ['native-account-on', (copy) => { copy[3].disabled = false; }],
    ['upload-on', (copy) => { copy[4].config.enabled = true; }],
    ['misspelled-upload-row', (copy) => { copy[4].id = 'session-log-deepseek-typo'; }],
    ['sandbox-off', (copy) => { copy[5].config.mode = 'danger-full-access'; }],
    ['mcp-gone', (copy) => { copy.pop(); }],
  ];
  for (const [name, mutate] of mutants) {
    const copy = structuredClone(rows);
    mutate(copy);
    const composed = await dump(name, copy);
    assert.throws(() => requireComposed(composed), undefined, `${name} survived`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const nativeURL = `http://127.0.0.1:${server.address().port}`;
  const nativeRows = [{ id: 'llm-deepseek', config: { baseURL: nativeURL, apiKeyEnv: 'DEEPSEEK_API_KEY' } }];
  // dsh reads a project's .env, but an inherited key must win over an agent-written one.
  await writeFile(join(cwd, '.env'), 'DEEPSEEK_API_KEY=project-shadow\nCOMMONLY_DSH_PROXY_KEY=project-shadow\n');
  const nativeRun = async (name, disabled) => {
    const before = serverBodies.length;
    const path = await writePatch(name, disabled
      ? [...nativeRows, { id: 'session-log-deepseek', config: { enabled: false } }] : nativeRows);
    const result = await run(['--profile', 'headless', '--patch', path, '--json', name], join(root, `${name}-home`), {
      DEEPSEEK_API_KEY: 'probe-native-key',
    });
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /"type":"final"/);
    const bodies = serverBodies.slice(before);
    assert.ok(bodies.length >= 1, `${name}: no native request reached the mock`);
    return bodies;
  };
  const defaultBodies = await nativeRun('native-default', false);
  const disabledBodies = await nativeRun('native-disabled', true);
  assert.ok(defaultBodies.every(({ body }) => Object.hasOwn(body, 'dsh_session_log')),
    'native default did not send the session log');
  assert.ok(disabledBodies.every(({ body }) => !Object.hasOwn(body, 'dsh_session_log')),
    'native disable patch still sent the session log');
  assert.ok([...defaultBodies, ...disabledBodies].every(({ authorization, xApiKey }) => authorization === 'Bearer probe-native-key' || xApiKey === 'probe-native-key'),
    `project .env replaced the inherited key (${[...defaultBodies, ...disabledBodies].map(({ authorization, xApiKey }) => `${authorization || '-'} / ${xApiKey || '-'}`).join(', ')})`);

  const piBodies = [];
  piServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    piBodies.push({ body, authorization: req.headers.authorization });
    if (body.messages?.some((message) => message.role === 'developer') || Object.hasOwn(body, 'store')) {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'DeepSeek rejects developer role and store' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of [
      { choices: [{ delta: { role: 'assistant', content: 'proxy reply' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    piServer.once('error', reject);
    piServer.listen(0, '127.0.0.1', resolve);
  });
  const piURL = `http://127.0.0.1:${piServer.address().port}/v1`;
  const piRows = buildPatch({ proxyBaseURL: piURL, model: 'deepseek-flash', cwd, mcp,
    effort: 'high', deepseekOfficial: true }).slice(0, -1);
  const piResult = await run(['--profile', 'headless', '--patch', await writePatch('pi-env-precedence', piRows),
    '--json', 'PI_ENV_PRECEDENCE'], join(root, 'pi-home'), { COMMONLY_DSH_PROXY_KEY: 'probe-proxy-key' });
  assert.equal(piResult.code, 0, `pi-ai request failed: ${piResult.stderr}`);
  assert.match(piResult.stdout, /"type":"final"/);
  assert.ok(piBodies.length >= 1, 'pi-ai route sent no request');
  assert.ok(piBodies.every(({ authorization }) => authorization === 'Bearer probe-proxy-key'),
    'project .env replaced the inherited proxy bearer');
  const modelBody = piBodies.find(({ body }) => JSON.stringify(body.messages || []).includes('PI_ENV_PRECEDENCE'))?.body;
  assert.equal(modelBody?.messages?.[0]?.role, 'system', 'pi-ai did not send the system prompt as system');
  assert.equal(Object.hasOwn(modelBody, 'store'), false, 'pi-ai sent an unsupported store field');
  assert.equal(modelBody?.thinking?.type, 'enabled', 'pi-ai did not enable DeepSeek thinking');
  assert.equal(modelBody?.reasoning_effort, 'high', 'pi-ai lost the reasoning effort');

  const genericBefore = piBodies.length;
  const genericRows = buildPatch({ proxyBaseURL: piURL, model: 'other-model', cwd, mcp,
    effort: 'high', deepseekOfficial: false }).slice(0, -1);
  const genericResult = await run(['--profile', 'headless', '--patch', await writePatch('pi-generic-compat', genericRows),
    '--json', 'PI_GENERIC_COMPAT'], join(root, 'pi-generic-home'), { COMMONLY_DSH_PROXY_KEY: 'probe-proxy-key' });
  assert.equal(genericResult.code, 0, `generic pi-ai request failed: ${genericResult.stderr}`);
  assert.match(genericResult.stdout, /"type":"final"/);
  const genericModel = piBodies.slice(genericBefore)
    .find(({ body }) => JSON.stringify(body.messages || []).includes('PI_GENERIC_COMPAT'))?.body;
  assert.equal(genericModel?.messages?.[0]?.role, 'system', 'generic provider used developer role');
  assert.equal(Object.hasOwn(genericModel, 'store'), false, 'generic provider sent store');
  for (const rejected of [
    { messages: [{ role: 'developer', content: 'unsupported' }] },
    { messages: [{ role: 'system', content: 'ok' }], store: false },
  ]) {
    const response = await fetch(`${piURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer probe-proxy-key' },
      body: JSON.stringify(rejected),
    });
    assert.equal(response.status, 422, 'stand-in accepted a DeepSeek-incompatible request');
  }

  await writeFile(join(cwd, '.env'), 'DSH_HOME=/tmp/project-shadow\n');
  const beforeRefusal = serverBodies.length;
  const blocked = await run(['--profile', 'headless', '--patch', await writePatch('bootstrap-only', nativeRows), '--json', 'blocked'],
    join(root, 'bootstrap-only-home'), { DEEPSEEK_API_KEY: 'probe-native-key' });
  assert.notEqual(blocked.code, 0, 'project .env relocated DSH_HOME');
  assert.equal(serverBodies.length, beforeRefusal, 'bootstrap refusal contacted the provider');
  process.stdout.write(`PASS dsh ${TESTED_DSH_VERSIONS[0]}: composed rows, ${mutants.length} killed mutants, native request bodies default=${defaultBodies.length} with log / disabled=${disabledBodies.length} without log; planted .env key precedence, pi-ai thinking, system role, no store (official and generic), and bootstrap refusal\n`);
} finally {
  if (piServer) await new Promise((resolve) => piServer.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

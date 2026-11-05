const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildLlmPodSummary, handleEvent } = require('./index');

const messages = [
  { username: 'Sam', content: 'The deploy fix landed.' },
  { username: 'Rivet', content: 'The token blocker remains open.' },
];

const fakeClient = (reply) => ({
  baseUrl: 'fake-llm',
  chat: async (...args) => {
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(...args) : reply;
  },
});

const runSummaryRequest = async (reply) => {
  const originalFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/messages?limit=30')) return { ok: true, json: async () => ({ messages }) };
    if (url.endsWith('/context')) return { ok: true, json: async () => ({ pod: { name: 'Sharpen' } }) };
    if (url.endsWith('/summaries')) {
      writes.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith('/events/event-1/ack')) {
      writes.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await handleEvent(
      { runtimeToken: 'test-token' },
      { _id: 'event-1', type: 'summary.request', podId: 'pod-1', payload: { silent: true } },
      { summaryClient: fakeClient(reply) },
    );
    return writes;
  } finally {
    global.fetch = originalFetch;
  }
};

test('buildLlmPodSummary turns a complete model reply into prose', async () => {
  const summary = await buildLlmPodSummary({
    messages,
    podName: 'Sharpen',
    client: fakeClient((_system, prompt, options) => {
      assert.match(prompt, /Sam: The deploy fix landed\./);
      assert.equal(options.maxTokens, 900);
      return '{"summary":"The deploy fix landed.","highlights":["Token blocker remains"]}';
    }),
  });
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.summary, 'The deploy fix landed.\n\nHighlights:\n\n- Token blocker remains');
});

test('summary.request persists a complete LLM summary before acknowledging', async () => {
  const writes = await runSummaryRequest(
    '{"summary":"The deploy fix landed.","highlights":["Token blocker remains"]}',
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.summary, 'The deploy fix landed.\n\nHighlights:\n\n- Token blocker remains');
  assert.equal(writes[0].body.eventId, 'event-1');
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});

test('summary.request stores recovered prose when the model reply ends mid-envelope', async () => {
  const writes = await runSummaryRequest(
    '{"summary":"The deploy fix landed. The token blocker remains open. Nobody',
  );
  assert.equal(writes.length, 2);
  assert.ok(writes[0].url.endsWith('/summaries'));
  assert.equal(writes[0].body.summary, 'The deploy fix landed. The token blocker remains open.');
  assert.ok(!writes[0].body.summary.startsWith('{'));
  assert.ok(!writes[0].body.summary.includes('"summary"'));
  assert.equal(writes[0].body.messageCount, 2);
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});

test('summary.request stores heuristic prose and acknowledges after an LLM error', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  let writes;
  console.warn = (line) => warnings.push(line);
  try {
    writes = await runSummaryRequest(new Error('LLM unavailable'));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /feature=pod-summary model=\S+ failed; using heuristic summary/);
  assert.equal(writes.length, 2);
  assert.ok(writes[0].url.endsWith('/summaries'));
  assert.match(writes[0].body.summary, /^A quick update from Sharpen:/);
  assert.match(writes[0].body.summary, /The deploy fix landed\./);
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});


test('deployed and standalone pod summaries request the routed non-Claude default', () => {
  const chart = path.resolve(__dirname, '../../../k8s/helm/commonly/templates');
  const deployment = fs.readFileSync(path.join(chart, 'agents/commonly-bot-deployment.yaml'), 'utf8');
  // Without aiProviders.anthropic (F92 puts the bot on the native model under
  // it), the bot's default is the backend's.
  const model = deployment.match(/- name: AGENT_MODEL\n(?:\s+#.*\n|\s+\{\{-? if .*\n\s+value: .*\n)*\s+\{\{- else \}\}\n\s+value: "([^"]+)"/)[1];
  const backend = fs.readFileSync(path.join(chart, 'core/backend-deployment.yaml'), 'utf8');
  const backendModel = backend.match(/- name: LITELLM_CHAT_MODEL[\s\S]*?value: "([^"]+)"/)[1];
  assert.equal(model, backendModel);
  const router = fs.readFileSync(path.join(chart, 'configmaps/litellm-config.yaml'), 'utf8');
  const groups = [...router.matchAll(/- model_name: ([^\n]+)\n\s+litellm_params:\n\s+model: ([^\n]+)/g)];
  const route = groups.find((group) => group[1] === model);
  assert.ok(route, `No route for ${model}`);
  assert.doesNotMatch(`${model} ${route[2]}`, /claude|anthropic/i);
  for (const deployed of [false, true]) {
    const env = { ...process.env, LITELLM_BASE_URL: 'http://fake-llm' };
    delete env.COMMONLY_SOCIAL_REPHRASE_MODEL;
    delete env.AGENT_MODEL;
    if (deployed) env.AGENT_MODEL = model;
    // Fresh process exercises actual client + request body, without singleton
    // env leakage or a paid model call.
    const result = execFileSync(process.execPath, ['-e', `
      const { buildLlmPodSummary } = require('./index');
      global.fetch = async (_url, options) => {
        process.stdout.write(JSON.parse(options.body).model);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"summary":"Done"}' } }] }) };
      };
      buildLlmPodSummary({ messages: [{ username: 'Sam', content: 'Done' }] }).catch(() => process.exit(1));
    `], { cwd: __dirname, env, encoding: 'utf8' });
    assert.equal(result, model);
  }
});


for (const [mode, reason] of [
  ['http-error', 'failed'],
  ['missing', 'rejected=missing-summary'],
  ['blank', 'rejected=missing-summary'],
  ['copied', 'rejected=source-overlap'],
]) {
  test(`${mode} social rewrite names its feature/model and still posts heuristic content`, () => {
    const env = {
      ...process.env,
      COMMONLY_TEST_REWRITE_MODE: mode,
      COMMONLY_TEST_REWRITE_REASON: reason,
      COMMONLY_SOCIAL_POST_TO_FEED: '1',
      COMMONLY_SOCIAL_REPHRASE_ENABLED: '1',
      COMMONLY_SOCIAL_REPHRASE_MODEL: 'deepseek-v4-flash',
      COMMONLY_SOCIAL_IMAGE_ENABLED: '0',
      COMMONLY_SOCIAL_PUBLISH_EXTERNAL: '0',
      LITELLM_BASE_URL: 'http://fake-llm',
      OPENROUTER_API_KEY: '',
      GEMINI_API_KEY: '',
    };
    const result = execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { handleEvent } = require('./index');
      const calls = [];
      const warnings = [];
      console.warn = (line) => warnings.push(line);
      global.fetch = async (url, options = {}) => {
        calls.push({ url, body: options.body && JSON.parse(options.body) });
        let data = {};
        if (url.endsWith('/context')) data = { pod: { name: 'Testing' } };
        else if (url.endsWith('/api/posts?category=Social')) data = [{ content: 'Testing deploy finished', source: { provider: 'x' } }];
        else if (url.endsWith('/social-policy')) data = { policy: { socialMode: 'rewrite' } };
        else if (url.endsWith('/v1/chat/completions')) {
          if (process.env.COMMONLY_TEST_REWRITE_MODE === 'http-error') return { ok: false, status: 401, text: async () => 'bad key' };
          const reply = process.env.COMMONLY_TEST_REWRITE_MODE === 'missing' ? { why: 'No summary' }
            : { summary: process.env.COMMONLY_TEST_REWRITE_MODE === 'blank' ? '  ' : 'Testing deploy finished' };
          data = { choices: [{ message: { content: JSON.stringify(reply) } }] };
        }
        else if (url.includes('category=Social')) data = [];
        return { ok: true, json: async () => data };
      };
      handleEvent({ runtimeToken: 'test', userToken: 'test' }, { _id: 'curate-1', type: 'curate', podId: 'pod-1' }).then(() => {
        assert.deepEqual(warnings, ['[commonly-bot] feature=social-rephrase model=deepseek-v4-flash ' + process.env.COMMONLY_TEST_REWRITE_REASON + '; using heuristic feed post']);
        const feed = calls.find((call) => call.url.endsWith('/api/posts'));
        assert.match(feed.body.content, /A notable update/);
        assert.ok(calls.at(-1).url.endsWith('/curate-1/ack'));
      }).catch((error) => { console.error(error); process.exit(1); });
    `], { cwd: __dirname, env, encoding: 'utf8' });
    assert.equal(result, '');
  });

}

// D243 (F91) brings back one Claude route on purpose: LiteLLM's native-model
// route and its key, both inside `aiProviders.anthropic.enabled`. Everything
// #2704 removed stays removed outside that gate, and nothing falls back to or
// from Claude.
const ANTHROPIC_GATE = /\{\{-? if \.Values\.aiProviders\.anthropic\.enabled \}\}[\s\S]*?\{\{-? end \}\}/g;
const outsideAnthropicGate = (text) => text.replace(ANTHROPIC_GATE, '');

test('chart and dynamic gateways no longer consume a direct Anthropic key or route', () => {
  const root = path.resolve(__dirname, '../../..');
  const chart = path.join(root, 'k8s/helm/commonly');
  const rawRoutes = fs.readFileSync(path.join(chart, 'templates/configmaps/litellm-config.yaml'), 'utf8');
  const routes = outsideAnthropicGate(rawRoutes);
  // The gated route is the only Claude route, and the gate is what holds it.
  assert.match(rawRoutes, /model: anthropic\/\{\{ \.Values\.aiProviders\.anthropic\.nativeModel \}\}/);
  assert.equal((rawRoutes.match(/model:\s*anthropic\//gi) || []).length, 1);
  const directRoute = /model_name:\s*claude-|model:\s*anthropic\//i;
  const directKeyOrFallback = /ANTHROPIC_API_KEY|["']claude-[^"']*["']/;
  assert.match('      - model_name: claude-haiku-4-5', directRoute);
  assert.match('          model: anthropic/claude-haiku-4-5-20251001', directRoute);
  assert.match('          api_key: os.environ/ANTHROPIC_API_KEY', directKeyOrFallback);
  assert.match('        - {"claude-haiku-4-5": ["deepseek-v4-flash"]}', directKeyOrFallback);
  assert.doesNotMatch(routes, directRoute);
  assert.doesNotMatch(routes, directKeyOrFallback);
  // Only LiteLLM may hold the key, inside the gate. Every other file is read
  // whole, gate included: the backend and ops-runner gates carry model names,
  // never a key.
  const keyRef = /ANTHROPIC_API_KEY|anthropic-api-key|anthropicApiKey/;
  assert.match('{{- if .Values.aiProviders.anthropic.enabled }}\n        - name: ANTHROPIC_API_KEY\n        {{- end }}', keyRef);
  assert.doesNotMatch(outsideAnthropicGate(fs.readFileSync(path.join(chart, 'templates/agents/litellm-deployment.yaml'), 'utf8')), keyRef);
  for (const file of [
    'templates/core/backend-deployment.yaml',
    'templates/ops/ops-runner-deployment.yaml',
    'templates/agents/clawdbot-deployment.yaml',
    'templates/agents/commonly-bot-deployment.yaml',
    'templates/secrets/local-secrets.yaml',
    'values-local.yaml',
  ]) {
    assert.doesNotMatch(fs.readFileSync(path.join(chart, file), 'utf8'), keyRef);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'backend/services/gatewayProvisionerServiceK8s.ts'), 'utf8'), /ANTHROPIC_API_KEY|anthropic-api-key/);
});

// F92: with aiProviders.anthropic the bot's model is Claude Haiku. A Claude
// model gets thinking off and no sampling value (Haiku 5.5 rejects one), and a
// failure is not retried on OpenRouter or Gemini, so connected-chat text never
// reaches another provider.
test('a Claude model: thinking off, no temperature, and no other provider on failure', async () => {
  const LiteLLMClient = require('../shared/litellm-client');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: false, status: 500, text: async () => 'upstream down', json: async () => ({}) };
  };
  try {
    const client = new LiteLLMClient({
      baseUrl: 'http://litellm:4000', model: 'claude-haiku-5-5', openRouterApiKey: 'or-test', geminiApiKey: 'g-test',
    });
    await assert.rejects(client.chatCompletion([{ role: 'user', content: 'hi' }], { temperature: 0.5 }), /LiteLLM request failed: 500/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://litellm:4000/v1/chat/completions');
    assert.equal(seen[0].body.model, 'claude-haiku-5-5');
    assert.deepEqual(seen[0].body.thinking, { type: 'disabled' });
    assert.equal(seen[0].body.disable_fallbacks, true);
    assert.equal('temperature' in seen[0].body, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('CONTROL: a non-Claude model keeps its temperature and its fallback', async () => {
  const LiteLLMClient = require('../shared/litellm-client');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (seen.length === 1) return { ok: false, status: 500, text: async () => 'down', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  try {
    const client = new LiteLLMClient({ baseUrl: 'http://litellm:4000', model: 'deepseek-v4-flash', openRouterApiKey: 'or-test' });
    await client.chatCompletion([{ role: 'user', content: 'hi' }], { temperature: 0.5 });
    assert.equal(seen[0].body.temperature, 0.5);
    assert.equal(seen.length, 2);
    assert.match(seen[1].url, /openrouter/);
  } finally {
    global.fetch = realFetch;
  }
});

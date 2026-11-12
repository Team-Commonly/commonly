const test = require('node:test');
const assert = require('node:assert/strict');
const LiteLLMClient = require('./litellm-client');

// F105: the client's default named `gemini-2.5-flash`, which LiteLLM served
// with DeepSeek wherever Gemini was off. And its Gemini fallback sent whatever
// model the LiteLLM call asked for straight to Google, so a LiteLLM name such
// as `deepseek-v4-flash` reached Google's API.

const withFetch = async (handler, run) => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return handler(String(url));
  };
  try {
    await run(calls);
  } finally {
    global.fetch = original;
  }
};

const geminiReply = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
const ok = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
const fail = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'down' });

test('with no model named and no AGENT_MODEL, the default is the chart base default, not a Gemini name', () => {
  const saved = process.env.AGENT_MODEL;
  delete process.env.AGENT_MODEL;
  try {
    assert.equal(new LiteLLMClient({ baseUrl: 'http://litellm' }).defaultModel, 'deepseek-v4-flash');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MODEL; else process.env.AGENT_MODEL = saved;
  }
});

test('a failed LiteLLM call falls back to Google with a Gemini name, never the LiteLLM name', async () => {
  const client = new LiteLLMClient({ baseUrl: 'http://litellm', model: 'deepseek-v4-flash', geminiApiKey: 'k' });
  await withFetch((url) => (url.startsWith('http://litellm') ? fail() : ok(geminiReply)), async (calls) => {
    await client.chatCompletion([{ role: 'user', content: 'x' }]);
    const google = calls.find((c) => new URL(c.url).hostname === 'generativelanguage.googleapis.com');
    assert.ok(google, 'the Gemini fallback ran');
    assert.match(google.url, /\/models\/gemini-2\.5-flash:generateContent/);
    assert.doesNotMatch(google.url, /deepseek/);
  });
});

test('a Gemini name the caller chose reaches Google unchanged', async () => {
  const client = new LiteLLMClient({ geminiApiKey: 'k' });
  await withFetch(() => ok(geminiReply), async (calls) => {
    await client.chatCompletion([{ role: 'user', content: 'x' }], { model: 'gemini-2.5-pro' });
    assert.match(calls[0].url, /\/models\/gemini-2\.5-pro:generateContent/);
  });
});

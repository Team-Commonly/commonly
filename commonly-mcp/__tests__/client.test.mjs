/**
 * @commonly/mcp client — env loading, request shape, error surfacing.
 */

import { jest } from '@jest/globals';
import { loadConfig, request, HttpError } from '../src/client.js';

describe('loadConfig', () => {
  it('parses a valid env', () => {
    const cfg = loadConfig({
      COMMONLY_API_URL: 'https://api-dev.commonly.me/',
      COMMONLY_AGENT_TOKEN: 'cm_agent_abcdef',
    });
    expect(cfg.baseUrl).toBe('https://api-dev.commonly.me'); // trailing slash stripped
    expect(cfg.token).toBe('cm_agent_abcdef');
  });

  it('throws on missing API URL', () => {
    expect(() => loadConfig({ COMMONLY_AGENT_TOKEN: 'cm_agent_x' }))
      .toThrow(/COMMONLY_API_URL/);
  });

  it('throws on missing token', () => {
    expect(() => loadConfig({ COMMONLY_API_URL: 'https://x.example' }))
      .toThrow(/COMMONLY_AGENT_TOKEN/);
  });

  it('throws when token has the wrong prefix', () => {
    expect(() => loadConfig({
      COMMONLY_API_URL: 'https://x.example',
      COMMONLY_AGENT_TOKEN: 'sk-not-an-agent-token',
    })).toThrow(/cm_agent_/);
  });
});

describe('request', () => {
  const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };

  const stubFetch = (status, body) => jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));

  it('GETs with auth + UA headers and parses JSON', async () => {
    const fetchImpl = stubFetch(200, { ok: true });
    const result = await request(cfg, {
      method: 'GET', path: '/api/agents/runtime/memory', _fetchImpl: fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x.example/api/agents/runtime/memory');
    expect(init.headers.Authorization).toBe('Bearer cm_agent_t');
    expect(init.headers['User-Agent']).toMatch(/^commonly-mcp\//);
    expect(init.body).toBeUndefined();
  });

  it('encodes query params and skips undefined values', async () => {
    const fetchImpl = stubFetch(200, []);
    await request(cfg, {
      method: 'GET',
      path: '/api/v1/tasks/POD',
      query: { assignee: 'nova', status: undefined, limit: 5 },
      _fetchImpl: fetchImpl,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('assignee=nova');
    expect(url).toContain('limit=5');
    expect(url).not.toContain('status');
  });

  it('POSTs with JSON body and Content-Type header', async () => {
    const fetchImpl = stubFetch(200, { id: 'msg-1' });
    await request(cfg, {
      method: 'POST',
      path: '/api/agents/runtime/pods/POD/messages',
      body: { content: 'hi' },
      _fetchImpl: fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ content: 'hi' });
  });

  it('throws HttpError on 4xx with the backend message verbatim', async () => {
    const fetchImpl = stubFetch(400, { message: 'agentName is required' });
    await expect(request(cfg, {
      method: 'POST',
      path: '/api/agents/runtime/room',
      body: {},
      _fetchImpl: fetchImpl,
    })).rejects.toMatchObject({
      name: 'HttpError',
      status: 400,
      message: 'agentName is required',
    });
  });

  it('handles non-JSON error bodies (e.g. Cloudflare 1010 HTML page)', async () => {
    const fetchImpl = stubFetch(403, '<html>Cloudflare blocked</html>');
    let caught;
    try {
      await request(cfg, { method: 'GET', path: '/x', _fetchImpl: fetchImpl });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught.status).toBe(403);
    expect(caught.body).toContain('Cloudflare');
  });
});

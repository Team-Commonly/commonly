// `readTextFromAllowedHost` keeps the first `maxBytes` of an oversized body
// (F646): the stream is read chunk by chunk, cut at exactly `maxBytes`, and the
// reader is cancelled so the rest is never downloaded. The global fetch is a spy.
const { readTextFromAllowedHost, fetchTextFromAllowedHost } = require('../../../services/outboundUrlGuard');

const OPTIONS = {
  allowedOrigins: new Map([['api.github.com', 'https://api.github.com/']]),
  maxBytes: 10_000,
};

// A body of `chunks` chunks of `size` bytes each, recording how far it was read
// and whether the reader cancelled it.
const streamed = (chunks, size) => {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.pulled >= chunks) { controller.close(); return; }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() { state.cancelled = true; },
  });
  return { response: new Response(body, { headers: { 'x-ratelimit-remaining': '42' } }), state };
};

describe('readTextFromAllowedHost', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });
  afterEach(() => fetchSpy.mockRestore());

  test('cuts a body past maxBytes at exactly maxBytes, cancels the reader, and says it cut', async () => {
    const { response, state } = streamed(100, 4096);
    fetchSpy.mockResolvedValue(response);
    const result = await readTextFromAllowedHost('https://api.github.com/x', OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBe(OPTIONS.maxBytes);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(100);
    expect(result.headers.get('x-ratelimit-remaining')).toBe('42');
  });

  test('a body within maxBytes is whole and not marked cut', async () => {
    const { response, state } = streamed(2, 4096);
    fetchSpy.mockResolvedValue(response);
    const result = await readTextFromAllowedHost('https://api.github.com/x', OPTIONS);
    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(result.text)).toBe(8192);
    expect(state.cancelled).toBe(false);
  });

  test('a non-2xx answer returns its headers with an empty body', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 429, headers: { 'retry-after': '9' } }));
    const result = await readTextFromAllowedHost('https://api.github.com/x', OPTIONS);
    expect(result).toMatchObject({ ok: false, status: 429, text: '', truncated: false });
    expect(result.headers.get('retry-after')).toBe('9');
  });

  test('fetchTextFromAllowedHost still throws past maxBytes rather than cutting', async () => {
    fetchSpy.mockResolvedValue(streamed(100, 4096).response);
    await expect(fetchTextFromAllowedHost('https://api.github.com/x', OPTIONS)).rejects.toThrow(/exceeds/);
  });
});

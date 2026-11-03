/**
 * TASK-267a: one search function, provider chosen by SEARCH_PROVIDER.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const axios = require('axios').default;
const { searchWeb, isSearchConfigured, searchProvider } = require('../../../services/webSearchService');

describe('webSearchService', () => {
  const previous = { key: process.env.SEARCH_API_KEY, provider: process.env.SEARCH_PROVIDER };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SEARCH_API_KEY = 'search_test_key';
    delete process.env.SEARCH_PROVIDER;
  });
  afterAll(() => {
    if (previous.key === undefined) delete process.env.SEARCH_API_KEY; else process.env.SEARCH_API_KEY = previous.key;
    if (previous.provider === undefined) delete process.env.SEARCH_PROVIDER; else process.env.SEARCH_PROVIDER = previous.provider;
  });

  test('Exa by default: a fixed origin, the key in its header, five results with clipped text', async () => {
    axios.post.mockResolvedValue({
      data: {
        results: [
          { title: 'Ship notes', url: 'https://example.com/a', text: 'x'.repeat(5000), publishedDate: '2026-10-01T00:00:00Z' },
          { title: 'Bad link', url: 'javascript:alert(1)', text: 'dropped' },
          { title: 'Control\u0007chars', url: 'https://example.com/b', text: 'ok\u0000text' },
        ],
      },
    });

    const outcome = await searchWeb('commonly agent pods');

    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect(body).toMatchObject({ query: 'commonly agent pods', numResults: 5, contents: { text: { maxCharacters: 1500 } } });
    expect(options.headers).toEqual({ 'x-api-key': 'search_test_key' });
    expect(options.timeout).toBeGreaterThan(0);
    expect(outcome.provider).toBe('exa');
    expect(outcome.results.map((r) => r.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(outcome.results[0].text.length).toBeLessThanOrEqual(1501);
    expect(outcome.results[1]).toMatchObject({ title: 'Controlchars', text: 'oktext' });
  });

  test('SEARCH_PROVIDER=tavily swaps the provider with no other change', async () => {
    process.env.SEARCH_PROVIDER = 'tavily';
    axios.post.mockResolvedValue({ data: { results: [{ title: 'T', url: 'https://example.com/t', content: 'snippet' }] } });

    const outcome = await searchWeb('q');

    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(body).toMatchObject({ query: 'q', max_results: 5, search_depth: 'basic' });
    expect(options.headers).toEqual({ Authorization: 'Bearer search_test_key' });
    expect(outcome).toEqual({ provider: 'tavily', results: [{ title: 'T', url: 'https://example.com/t', text: 'snippet' }] });
  });

  test('is configured only with a key and a known provider, and refuses otherwise', async () => {
    expect(isSearchConfigured()).toBe(true);
    process.env.SEARCH_PROVIDER = 'brave';
    expect(isSearchConfigured()).toBe(false);
    await expect(searchWeb('q')).rejects.toThrow(/not configured/);
    process.env.SEARCH_PROVIDER = 'exa';
    delete process.env.SEARCH_API_KEY;
    expect(isSearchConfigured()).toBe(false);
    await expect(searchWeb('q')).rejects.toThrow(/not configured/);
    expect(axios.post).not.toHaveBeenCalled();
    expect(searchProvider()).toBe('exa');
  });

  test('SEARCH_PROVIDER=keenable works without a key, using the public endpoint', async () => {
    process.env.SEARCH_PROVIDER = 'keenable';
    delete process.env.SEARCH_API_KEY;
    expect(isSearchConfigured()).toBe(true);
    axios.post.mockResolvedValue({
      data: {
        results: [
          {
            title: 'K', url: 'https://example.com/k', description: 'desc', snippet: 'long',
          },
          { title: 'No URL', description: 'dropped' },
          { title: 'S', url: 'https://example.com/s', snippet: 'y'.repeat(5000) },
        ],
      },
    });

    const outcome = await searchWeb('q');

    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.keenable.ai/v1/search/public');
    expect(body).toEqual({ query: 'q', max_results: 5 });
    expect(options.headers).toEqual({ 'X-Keenable-Title': 'Commonly' });
    expect(outcome.provider).toBe('keenable');
    expect(outcome.results.map((r) => r.url))
      .toEqual(['https://example.com/k', 'https://example.com/s']);
    expect(outcome.results[0].text).toBe('desc');
    expect(outcome.results[1].text.length).toBeLessThanOrEqual(1501);
  });

  test('SEARCH_PROVIDER=keenable with a key uses the keyed endpoint', async () => {
    process.env.SEARCH_PROVIDER = 'keenable';
    axios.post.mockResolvedValue({ data: { results: [] } });

    await searchWeb('q');

    const [url, , options] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.keenable.ai/v1/search');
    expect(options.headers).toEqual({ 'X-Keenable-Title': 'Commonly', 'X-API-Key': 'search_test_key' });
  });

  test('an empty query is refused without a request', async () => {
    await expect(searchWeb('   ')).rejects.toThrow(/empty/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

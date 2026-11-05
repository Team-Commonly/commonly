// @ts-nocheck
// ADR-002 Phase 1b — signed-URL helper: mint + cache + in-flight coalescing.

import {
  getSignedAttachmentUrl,
  __resetSignedAttachmentUrlCacheForTests,
} from './signedAttachmentUrl';

jest.mock('./apiBaseUrl', () => ({
  __esModule: true,
  default: () => 'https://api.example',
}));

describe('getSignedAttachmentUrl', () => {
  beforeEach(() => {
    __resetSignedAttachmentUrlCacheForTests();
    localStorage.setItem('token', 'test-jwt');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    localStorage.clear();
    delete global.fetch;
  });

  it('returns null for falsy input', async () => {
    await expect(getSignedAttachmentUrl(null)).resolves.toBeNull();
    await expect(getSignedAttachmentUrl('')).resolves.toBeNull();
  });

  it('returns the input unchanged when it does not look like an uploads URL', async () => {
    const v = await getSignedAttachmentUrl('https://external.example/image.png');
    expect(v).toBe('https://external.example/image.png');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mints a signed URL for a relative uploads path and caches it', async () => {
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/api/uploads/pic.png?t=tok', expiresIn: 300 }),
    });

    const first = await getSignedAttachmentUrl('/api/uploads/pic.png');
    expect(first).toBe('https://api.example/api/uploads/pic.png?t=tok');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example/api/uploads/pic.png/url',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-jwt' },
      }),
    );

    const second = await getSignedAttachmentUrl('/api/uploads/pic.png');
    expect(second).toBe('https://api.example/api/uploads/pic.png?t=tok');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('extracts the fileName from an absolute URL before minting', async () => {
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/api/uploads/photo.jpg?t=xyz', expiresIn: 300 }),
    });

    const v = await getSignedAttachmentUrl('https://api-dev.example/api/uploads/photo.jpg');
    expect(v).toBe('https://api.example/api/uploads/photo.jpg?t=xyz');
    expect((fetch as jest.Mock).mock.calls[0][0]).toBe(
      'https://api.example/api/uploads/photo.jpg/url',
    );
  });

  it('returns null when unauthenticated (no token in localStorage)', async () => {
    localStorage.clear();
    await expect(getSignedAttachmentUrl('/api/uploads/pic.png')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null when the mint endpoint returns a non-2xx response', async () => {
    (fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(getSignedAttachmentUrl('/api/uploads/denied.png')).resolves.toBeNull();
  });

  it('evicts the oldest cache entry once the cap is reached', async () => {
    // Mint 501 distinct files. The 1st should have been evicted by the time
    // the 501st is stored, so re-requesting the 1st issues a fresh fetch
    // while a mid-range (e.g. 250th) entry still hits cache.
    let counter = 0;
    (fetch as jest.Mock).mockImplementation((url: string) => {
      counter += 1;
      const name = decodeURIComponent(url.replace('https://api.example/api/uploads/', '').replace('/url', ''));
      return Promise.resolve({
        ok: true,
        json: async () => ({ url: `/api/uploads/${name}?t=tok-${counter}`, expiresIn: 300 }),
      });
    });

    for (let i = 0; i < 501; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await getSignedAttachmentUrl(`/api/uploads/f${i}.png`);
    }
    expect(fetch).toHaveBeenCalledTimes(501);

    // f250 is still in cache → no new fetch
    await getSignedAttachmentUrl('/api/uploads/f250.png');
    expect(fetch).toHaveBeenCalledTimes(501);

    // f0 was evicted → new fetch
    await getSignedAttachmentUrl('/api/uploads/f0.png');
    expect(fetch).toHaveBeenCalledTimes(502);
  });

  it('coalesces concurrent calls for the same fileName into a single mint request', async () => {
    let resolveFetch;
    (fetch as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve({
              ok: true,
              json: async () => ({ url: '/api/uploads/race.png?t=one', expiresIn: 300 }),
            });
        }),
    );

    const a = getSignedAttachmentUrl('/api/uploads/race.png');
    const b = getSignedAttachmentUrl('/api/uploads/race.png');
    // Mints go out one microtask later, so a whole render's worth can batch.
    await new Promise((r) => { setTimeout(r, 0); });
    resolveFetch();
    const [va, vb] = await Promise.all([a, b]);

    expect(va).toBe('https://api.example/api/uploads/race.png?t=one');
    expect(vb).toBe(va);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // A pod chat draws one thumbnail per image message, each asking for its own
  // URL in the same render. One mint per thumbnail 429'd a viewer with more than
  // 30 images on screen (the limiter allows 30 a minute per token). Every mint
  // asked for in one tick now goes out as one batch request.
  describe('batching', () => {
    const batchResponse = (names, refused = []) => ({
      ok: true,
      status: 200,
      json: async () => ({
        urls: Object.fromEntries(names.filter((n) => !refused.includes(n))
          .map((n) => [n, { url: `/api/uploads/${n}?t=tok-${n}`, expiresIn: 300 }])),
        refused,
      }),
    });
    const bodyOf = (call) => JSON.parse(call[1].body).fileNames;

    it('mints 50 thumbnails asked for together with one request', async () => {
      (fetch as jest.Mock).mockImplementation((url, init) => Promise.resolve(batchResponse(JSON.parse(init.body).fileNames)));
      const names = Array.from({ length: 50 }, (_, i) => `thumb-${i}.png`);

      const urls = await Promise.all(names.map((n) => getSignedAttachmentUrl(`/api/uploads/${n}`)));

      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch as jest.Mock).mock.calls[0][0]).toBe('https://api.example/api/uploads/urls');
      expect((fetch as jest.Mock).mock.calls[0][1]).toEqual(expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' }),
      }));
      expect(bodyOf((fetch as jest.Mock).mock.calls[0]).sort()).toEqual([...names].sort());
      urls.forEach((url, i) => expect(url).toBe(`https://api.example/api/uploads/thumb-${i}.png?t=tok-thumb-${i}.png`));

      // ...and they are cached: asking again sends nothing.
      await Promise.all(names.map((n) => getSignedAttachmentUrl(`/api/uploads/${n}`)));
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('splits more than 50 into requests of at most 50', async () => {
      (fetch as jest.Mock).mockImplementation((url, init) => Promise.resolve(batchResponse(JSON.parse(init.body).fileNames)));
      const names = Array.from({ length: 120 }, (_, i) => `t-${i}.png`);

      await Promise.all(names.map((n) => getSignedAttachmentUrl(`/api/uploads/${n}`)));

      expect((fetch as jest.Mock).mock.calls.map((c) => bodyOf(c).length)).toEqual([50, 50, 20]);
    });

    it('gives null for a name the server refused and a URL for the rest', async () => {
      (fetch as jest.Mock).mockImplementation((url, init) => Promise.resolve(batchResponse(JSON.parse(init.body).fileNames, ['private.png'])));

      const [mine, theirs] = await Promise.all([
        getSignedAttachmentUrl('/api/uploads/mine.png'),
        getSignedAttachmentUrl('/api/uploads/private.png'),
      ]);
      expect(mine).toBe('https://api.example/api/uploads/mine.png?t=tok-mine.png');
      expect(theirs).toBeNull();
    });

    it('asks one at a time when the server has no batch route yet', async () => {
      (fetch as jest.Mock).mockImplementation((url) => {
        if (url.endsWith('/api/uploads/urls')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        const name = url.replace('https://api.example/api/uploads/', '').replace('/url', '');
        return Promise.resolve({ ok: true, json: async () => ({ url: `/api/uploads/${name}?t=one`, expiresIn: 300 }) });
      });

      const urls = await Promise.all([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(urls).toEqual(['https://api.example/api/uploads/a.png?t=one', 'https://api.example/api/uploads/b.png?t=one']);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('gives null for every name in a refused batch (429), and does not cache it', async () => {
      (fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

      const urls = await Promise.all([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(urls).toEqual([null, null]);
      expect(fetch).toHaveBeenCalledTimes(1);

      (fetch as jest.Mock).mockImplementation((url, init) => Promise.resolve(batchResponse(JSON.parse(init.body).fileNames)));
      await Promise.all([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects every caller when the batch request itself throws, as a single mint does', async () => {
      (fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));

      const results = await Promise.allSettled([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    });

    it('settles every caller when the batch answer is not usable, so the file can mint again later', async () => {
      (fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => null });
      const first = await Promise.allSettled([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(first.map((r) => r.status === 'fulfilled' && r.value)).toEqual([null, null]);

      (fetch as jest.Mock).mockImplementation((url, init) => Promise.resolve(batchResponse(JSON.parse(init.body).fileNames)));
      const again = await Promise.all([getSignedAttachmentUrl('/api/uploads/a.png'), getSignedAttachmentUrl('/api/uploads/b.png')]);
      expect(again).toEqual(['https://api.example/api/uploads/a.png?t=tok-a.png', 'https://api.example/api/uploads/b.png?t=tok-b.png']);
    });
  });
});

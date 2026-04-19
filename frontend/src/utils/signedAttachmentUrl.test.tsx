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
    resolveFetch();
    const [va, vb] = await Promise.all([a, b]);

    expect(va).toBe('https://api.example/api/uploads/race.png?t=one');
    expect(vb).toBe(va);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

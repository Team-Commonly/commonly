import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import {
  REPO_API_URL,
  STAR_CACHE_KEY,
  STAR_CACHE_MS,
  fetchStarCount,
  formatStarCount,
  readStarCache,
  useGithubStarCount,
  writeStarCache,
} from '../githubStars';

/**
 * D153. The landing page shows the repo's live star count, read from GitHub's
 * public API. No number is ever shown unless GitHub gave one.
 */

const Probe: React.FC = () => {
  const count = useGithubStarCount();
  return <span data-testid="stars">{count === null ? 'no count' : formatStarCount(count, 'en')}</span>;
};

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('githubStars', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  describe('fetchStarCount', () => {
    it('reads stargazers_count from GitHub', async () => {
      const request = jest.fn().mockResolvedValue(jsonResponse(200, { stargazers_count: 1234 }));
      await expect(fetchStarCount(request)).resolves.toBe(1234);
      expect(request).toHaveBeenCalledWith(REPO_API_URL);
    });

    it('returns null on a rate limit, so no number is shown', async () => {
      const request = jest.fn().mockResolvedValue(jsonResponse(403, { message: 'rate limit' }));
      await expect(fetchStarCount(request)).resolves.toBeNull();
    });

    it('returns null when the body has no numeric count', async () => {
      const request = jest.fn().mockResolvedValue(jsonResponse(200, { stargazers_count: 'many' }));
      await expect(fetchStarCount(request)).resolves.toBeNull();
    });

    it('returns null when the request itself fails', async () => {
      const request = jest.fn().mockRejectedValue(new TypeError('network down'));
      await expect(fetchStarCount(request)).resolves.toBeNull();
    });
  });

  describe('readStarCache and writeStarCache', () => {
    it('returns a count written less than an hour ago', () => {
      const storage = window.localStorage;
      writeStarCache(storage, 42, 1_000_000);
      expect(readStarCache(storage, 1_000_000 + STAR_CACHE_MS - 1)).toBe(42);
    });

    it('treats an entry older than an hour as stale', () => {
      const storage = window.localStorage;
      writeStarCache(storage, 42, 1_000_000);
      expect(readStarCache(storage, 1_000_000 + STAR_CACHE_MS + 1)).toBeNull();
    });

    it('treats an entry from the future as stale', () => {
      const storage = window.localStorage;
      writeStarCache(storage, 42, 2_000_000);
      expect(readStarCache(storage, 1_000_000)).toBeNull();
    });

    it('ignores a malformed entry instead of throwing', () => {
      window.localStorage.setItem(STAR_CACHE_KEY, '{"count":"x"}');
      expect(readStarCache(window.localStorage, Date.now())).toBeNull();
      window.localStorage.setItem(STAR_CACHE_KEY, 'not json');
      expect(readStarCache(window.localStorage, Date.now())).toBeNull();
    });

    it('does not throw when storage is blocked', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(readStarCache(window.localStorage, Date.now())).toBeNull();
      expect(() => writeStarCache(window.localStorage, 7, Date.now())).not.toThrow();
    });
  });

  describe('useGithubStarCount', () => {
    it('shows the live count after a fetch and caches it', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { stargazers_count: 1200 }));
      render(<Probe />);
      expect(await screen.findByText('1.2K')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readStarCache(window.localStorage, Date.now())).toBe(1200);
    });

    it('makes no request while a fresh cache exists', async () => {
      writeStarCache(window.localStorage, 900, Date.now());
      render(<Probe />);
      expect(await screen.findByText('900')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refetches once the cache has expired', async () => {
      writeStarCache(window.localStorage, 900, Date.now() - STAR_CACHE_MS - 1000);
      fetchMock.mockResolvedValue(jsonResponse(200, { stargazers_count: 950 }));
      render(<Probe />);
      expect(await screen.findByText('950')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shows no number on a 403, and does not cache one', async () => {
      fetchMock.mockResolvedValue(jsonResponse(403, {}));
      render(<Probe />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.getByTestId('stars')).toHaveTextContent('no count');
      expect(window.localStorage.getItem(STAR_CACHE_KEY)).toBeNull();
    });

    it('still shows the count when storage throws', async () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      fetchMock.mockResolvedValue(jsonResponse(200, { stargazers_count: 77 }));
      render(<Probe />);
      expect(await screen.findByText('77')).toBeInTheDocument();
    });
  });
});

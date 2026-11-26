// F646: a sandboxed agent (no network of its own) reads a public GitHub pull
// request through Commonly. The service builds every GitHub URL itself from a
// validated owner/repo/number, sends no credential, and trims the result.
//
// No request leaves the process: the global fetch is spied on per test.
const {
  parsePublicPrRef,
  readPublicPullRequest,
  PublicPrError,
  PUBLIC_PR_LIMITS,
  GITHUB_HEADROOM_FLOOR,
  resetPublicPrStateForTests,
  publicPrCacheSizeForTests,
} = require('../../../services/githubPublicPr');

const PR_JSON = {
  number: 7,
  title: 'Add a thing',
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/acme/widgets/pull/7',
  user: { login: 'octocat', id: 1, avatar_url: 'https://x' },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/widgets' } },
  head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octocat/widgets' } },
  body: 'Fixes the widget.',
  additions: 3,
  deletions: 1,
  changed_files: 2,
  // fields the trimmed shape must not carry through
  _links: { self: { href: 'https://api.github.com/x' } },
  node_id: 'PR_x',
};

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+added',
  'diff --git a/notes/new.md b/notes/new.md',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/notes/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' }, ...init,
});
const textResponse = (body, init = {}) => new Response(body, { status: 200, ...init });

// Answers by the Accept header: JSON for the PR, the diff media type for the diff.
const github = ({ pr = PR_JSON, diff = DIFF, files } = {}) => async (url, init) => {
  const accept = init?.headers?.Accept || '';
  if (String(url).includes('/files')) return jsonResponse(files || []);
  if (accept.includes('diff')) return typeof diff === 'function' ? diff() : textResponse(diff);
  return typeof pr === 'function' ? pr() : jsonResponse(pr);
};

const refusalOf = (promise) => promise.then(
  () => { throw new Error('expected a refusal'); },
  (error) => error,
);

describe('parsePublicPrRef', () => {
  test('accepts a valid owner, repo and number', () => {
    expect(parsePublicPrRef({ owner: 'acme', repo: 'widgets.js', number: '7' }))
      .toEqual({ owner: 'acme', repo: 'widgets.js', number: 7 });
  });

  test.each([
    [{ owner: '-acme', repo: 'w', number: '1' }],
    [{ owner: 'acme-', repo: 'w', number: '1' }],
    [{ owner: 'a'.repeat(40), repo: 'w', number: '1' }],
    [{ owner: 'ac/me', repo: 'w', number: '1' }],
    [{ owner: 'acme', repo: '..', number: '1' }],
    [{ owner: 'acme', repo: '.', number: '1' }],
    [{ owner: 'acme', repo: 'w/x', number: '1' }],
    [{ owner: 'acme', repo: 'w%2fx', number: '1' }],
    [{ owner: 'acme', repo: 'r'.repeat(101), number: '1' }],
    [{ owner: 'acme', repo: 'w', number: '0' }],
    [{ owner: 'acme', repo: 'w', number: '-1' }],
    [{ owner: 'acme', repo: 'w', number: '1.5' }],
    [{ owner: 'acme', repo: 'w', number: '99999999999' }],
    [{ owner: 'acme', repo: 'w', number: '01' }],
    [{ owner: ['acme'], repo: 'w', number: '1' }],
    [{ owner: 'acme', repo: 'w' }],
    [{}],
  ])('refuses %j', (query) => {
    const error = (() => { try { parsePublicPrRef(query); return null; } catch (e) { return e; } })();
    expect(error).toBeInstanceOf(PublicPrError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_pr_ref');
  });
});

describe('readPublicPullRequest', () => {
  let fetchSpy;

  beforeEach(() => {
    resetPublicPrStateForTests();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('returns the trimmed PR shape, with the file list read from the diff', async () => {
    fetchSpy.mockImplementation(github());
    const { pr, fromCache } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(fromCache).toBe(false);
    expect(pr).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Add a thing',
      state: 'open',
      draft: false,
      author: 'octocat',
      base: { ref: 'main', sha: 'b'.repeat(40) },
      head: { ref: 'feature', sha: 'a'.repeat(40), repo: 'octocat/widgets' },
      body: 'Fixes the widget.',
      changedFiles: 2,
      additions: 3,
      deletions: 1,
      files: [
        { path: 'src/a.js', status: 'modified', additions: 2, deletions: 1 },
        { path: 'notes/new.md', status: 'added', additions: 1, deletions: 0 },
      ],
      diff: DIFF,
      truncated: false,
      truncatedParts: [],
    });
  });

  test('builds the api.github.com URLs itself, and asks for the diff media type', async () => {
    fetchSpy.mockImplementation(github());
    await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    // An open PR's diff is read at the revision the PR answer named.
    expect(urls).toEqual([
      'https://api.github.com/repos/acme/widgets/pulls/7',
      `https://api.github.com/repos/acme/widgets/compare/${'b'.repeat(40)}...${'a'.repeat(40)}`,
    ]);
    expect(fetchSpy.mock.calls[1][1].headers.Accept).toBe('application/vnd.github.diff');
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeDefined();
    }
  });

  test('never sends an Authorization header or a cookie, whatever the server env holds', async () => {
    const saved = { GITHUB_PAT: process.env.GITHUB_PAT, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    process.env.GITHUB_PAT = 'ghp_should_never_leave';
    process.env.GITHUB_TOKEN = 'ghp_should_never_leave_either';
    try {
      fetchSpy.mockImplementation(github());
      await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
      expect(fetchSpy).toHaveBeenCalled();
      for (const [, init] of fetchSpy.mock.calls) {
        const names = Object.keys(init.headers || {}).map((h) => h.toLowerCase());
        expect(names).not.toContain('authorization');
        expect(names).not.toContain('cookie');
        expect(JSON.stringify(init.headers)).not.toContain('ghp_');
      }
    } finally {
      Object.entries(saved).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      });
    }
  });

  test('a private or missing PR is a clean 404 pr_not_found_or_private', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'secret', number: 1 }));
    expect(error).toBeInstanceOf(PublicPrError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('pr_not_found_or_private');
  });

  test.each([
    ['403 with no remaining quota', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'RESET' }, 120],
    ['429 with retry-after', 429, { 'retry-after': '30' }, 30],
  ])('GitHub rate limit (%s) maps to 503 github_rate_limited with a retry-after', async (_label, status, headers, expected) => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const resolved = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v === 'RESET' ? reset : v]));
    fetchSpy.mockResolvedValue(jsonResponse({ message: 'API rate limit exceeded' }, { status, headers: resolved }));
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(error.status).toBe(503);
    expect(error.code).toBe('github_rate_limited');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(expected - 2);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(expected + 1);
  });

  test('once rate-limited, later reads answer 503 without calling GitHub until the reset', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': '60' } }));
    await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    fetchSpy.mockClear();
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'other', number: 2 }));
    expect(error.code).toBe('github_rate_limited');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a 403 that is not a rate limit is an upstream error, not a rate limit', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message: 'blocked' }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } }));
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(error.status).toBe(502);
    expect(error.code).toBe('github_unavailable');
  });

  test('truncates the diff, the body and the file list to their caps and says so', async () => {
    const fileCount = PUBLIC_PR_LIMITS.maxFiles + 5;
    const bigDiff = Array.from({ length: fileCount }, (_, i) => [
      `diff --git a/f${i}.txt b/f${i}.txt`,
      '--- a/f' + i + '.txt',
      '+++ b/f' + i + '.txt',
      '@@ -1 +1 @@',
      `+${'x'.repeat(900)}`,
    ].join('\n')).join('\n');
    expect(Buffer.byteLength(bigDiff)).toBeGreaterThan(PUBLIC_PR_LIMITS.maxDiffBytes);
    fetchSpy.mockImplementation(github({
      pr: { ...PR_JSON, body: 'b'.repeat(PUBLIC_PR_LIMITS.maxBodyChars + 10) },
      diff: bigDiff,
    }));
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(Buffer.byteLength(pr.diff)).toBeLessThanOrEqual(PUBLIC_PR_LIMITS.maxDiffBytes);
    expect(pr.body).toHaveLength(PUBLIC_PR_LIMITS.maxBodyChars);
    expect(pr.files).toHaveLength(PUBLIC_PR_LIMITS.maxFiles);
    expect(pr.truncated).toBe(true);
    expect(pr.truncatedParts.sort()).toEqual(['body', 'diff', 'files']);
  });

  test('a diff GitHub will not render falls back to the files endpoint, trimmed of patches', async () => {
    fetchSpy.mockImplementation(github({
      diff: () => jsonResponse({ message: 'diff too large' }, { status: 406 }),
      files: [{ filename: 'big.bin', status: 'renamed', previous_filename: 'old.bin', additions: 0, deletions: 0, patch: 'SECRET-PATCH' }],
    }));
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(pr.files).toEqual([{ path: 'big.bin', status: 'renamed', previousPath: 'old.bin', additions: 0, deletions: 0 }]);
    expect(pr.diff).toBe('');
    expect(pr.truncated).toBe(true);
    expect(pr.truncatedParts).toContain('diff');
    expect(fetchSpy.mock.calls.map(([u]) => String(u))).toContain(
      'https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=1',
    );
  });

  test('a redirect off api.github.com is never followed', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 301, headers: { location: 'https://evil.example/repos/x' } }));
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(error.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a second read of the same PR at the same head is served from the cache', async () => {
    fetchSpy.mockImplementation(github());
    await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    fetchSpy.mockClear();
    const { pr: again, fromCache } = await readPublicPullRequest({ owner: 'ACME', repo: 'Widgets', number: 7 });
    expect(again.title).toBe('Add a thing');
    expect(fromCache).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('headroom floor', () => {
    const reset = () => String(Math.floor(Date.now() / 1000) + 600);
    const withBudget = (remaining) => async (url, init) => {
      const headers = { 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': reset() };
      return (init.headers.Accept.includes('diff')
        ? new Response(DIFF, { headers })
        : new Response(JSON.stringify(PR_JSON), { headers }));
    };

    test('once GitHub reports the floor left, a new read is refused before GitHub reaches 0', async () => {
      fetchSpy.mockImplementation(withBudget(GITHUB_HEADROOM_FLOOR));
      // The read that saw the floor finishes: it had already started.
      await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
      fetchSpy.mockClear();
      const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'other', number: 2 }));
      expect(error.status).toBe(503);
      expect(error.code).toBe('github_rate_limited');
      expect(error.sentGithubNothing).toBe(true);
      expect(error.retryAfterSeconds).toBeGreaterThan(590);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('with room for a whole read above the floor, reads carry on', async () => {
      // A read can send 6 requests, so it starts only with floor + 6 left.
      fetchSpy.mockImplementation(withBudget(GITHUB_HEADROOM_FLOOR + 6));
      await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
      await readPublicPullRequest({ owner: 'acme', repo: 'other', number: 2 });
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    test('a PR read recently is still served from the cache under the floor', async () => {
      const realNow = Date.now;
      fetchSpy.mockImplementation(withBudget(GITHUB_HEADROOM_FLOOR));
      await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
      fetchSpy.mockClear();
      // Past the minute a head is normally trusted, inside the result's ten.
      const later = realNow() + 5 * 60 * 1000;
      jest.spyOn(Date, 'now').mockImplementation(() => later);
      try {
        const { pr, fromCache } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
        expect(pr.title).toBe('Add a thing');
        expect(fromCache).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        Date.now.mockRestore();
      }
    });
  });
});

describe('bounds in time and memory', () => {
  let fetchSpy;
  beforeEach(() => {
    resetPublicPrStateForTests();
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  const answer = (diff, headers = {}) => async (_url, init) => (init.headers.Accept.includes('diff')
    ? new Response(diff, { headers })
    : new Response(JSON.stringify(PR_JSON), { headers }));
  const elapsedMs = (started) => Number(process.hrtime.bigint() - started) / 1e6;

  test('a long run of replacement characters before a newline does not stall the diff cut', async () => {
    // ~66k invalid UTF-8 bytes on one line, decoded to U+FFFD, then enough
    // lines to push the diff past its 200 KB cap.
    const diff = Buffer.concat([
      Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+'),
      Buffer.alloc(66_000, 0xff),
      Buffer.from(`\n${`+${'y'.repeat(99)}\n`.repeat(2000)}`),
    ]);
    fetchSpy.mockImplementation(answer(diff));
    const started = process.hrtime.bigint();
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    const ms = elapsedMs(started);
    expect(pr.truncatedParts).toContain('diff');
    expect(Buffer.byteLength(pr.diff)).toBeLessThanOrEqual(PUBLIC_PR_LIMITS.maxDiffBytes);
    expect(pr.diff.endsWith('\n')).toBe(true);
    expect(ms).toBeLessThan(50);
  });

  test('a diff line with no newline in the cap is cut on a character boundary', async () => {
    // One line of 3-byte characters longer than the cap, so the cap holds no
    // newline to cut at. The leading '+' makes the cap fall mid-character.
    const diff = `+${'€'.repeat(PUBLIC_PR_LIMITS.maxDiffBytes)}`;
    fetchSpy.mockImplementation(answer(diff));
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(Buffer.byteLength(pr.diff)).toBeLessThanOrEqual(PUBLIC_PR_LIMITS.maxDiffBytes);
    expect(pr.diff).not.toContain('�');
    expect(pr.diff.endsWith('€')).toBe(true);
  });

  test('a header path with many " b/" parts reads the last one, quickly', async () => {
    const path = `${'q b/'.repeat(50_000)}end.txt`;
    fetchSpy.mockImplementation(answer(`diff --git a/${path} b/${path}\n`));
    const started = process.hrtime.bigint();
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(elapsedMs(started)).toBeLessThan(50);
    expect(pr.files[0].path.endsWith('end.txt')).toBe(true);
  });

  test('a diff over the 4 MB read cap is cut, with files and diff marked truncated, not a 502', async () => {
    const line = `+${'z'.repeat(199)}\n`;
    const diff = Array.from({ length: 50 }, (_, i) => `diff --git a/f${i} b/f${i}\n@@ -0,0 +1 @@\n${line.repeat(500)}`)
      .join('');
    expect(Buffer.byteLength(diff)).toBeGreaterThan(PUBLIC_PR_LIMITS.maxDiffParseBytes);
    fetchSpy.mockImplementation(answer(diff));
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(pr.truncatedParts.sort()).toEqual(['diff', 'files']);
    expect(pr.files.length).toBeLessThan(50);
    expect(Buffer.byteLength(pr.diff)).toBeLessThanOrEqual(PUBLIC_PR_LIMITS.maxDiffBytes);
  });

  test('expired cache entries are swept when a new one is stored', async () => {
    let offset = 0;
    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
    try {
      const big = `diff --git a/x b/x\n@@ -0,0 +1 @@\n${`+${'w'.repeat(999)}\n`.repeat(300)}`;
      fetchSpy.mockImplementation(answer(big));
      for (let n = 1; n <= 50; n += 1) {
        await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: n });
      }
      expect(publicPrCacheSizeForTests()).toEqual({ heads: 50, results: 50 });
      offset += 11 * 60 * 1000;
      await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 51 });
      expect(publicPrCacheSizeForTests()).toEqual({ heads: 1, results: 1 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('parallel reads reserve requests against the last known budget', async () => {
    // Learn remaining = 22 from one read, then start three together.
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    fetchSpy.mockImplementation(answer(DIFF, { 'x-ratelimit-remaining': '22', 'x-ratelimit-reset': reset }));
    await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 1 });
    const settled = await Promise.allSettled([2, 3, 4]
      .map((number) => readPublicPullRequest({ owner: 'acme', repo: 'widgets', number })));
    // Each read reserves 6 requests; two fit between 22 and the floor of 10.
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    const refused = settled.find((s) => s.status === 'rejected').reason;
    expect(refused.code).toBe('github_rate_limited');
    expect(refused.sentGithubNothing).toBe(true);
  });

  test('a secondary limit hold is not lifted by an in-flight answer with budget left', async () => {
    // Read 1 is in flight when read 2 hits a secondary limit; read 1's answer
    // then reports budget left, which must not lift read 2's retry-after.
    // The budget is learned first, so both reads are admitted together
    // rather than read 2 waiting on read 1 as the unknown-budget probe.
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    fetchSpy.mockImplementation(answer(DIFF, { 'x-ratelimit-remaining': '40', 'x-ratelimit-reset': reset }));
    await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 9 });
    let releaseFirst;
    const firstAnswer = new Promise((resolve) => { releaseFirst = resolve; });
    fetchSpy.mockImplementation(async (url, init) => {
      // Read 1's PR and its diff (an open PR's diff is read by revision).
      if (String(url).includes('/pulls/1') || String(url).includes('/compare/')) {
        await firstAnswer;
        return answer(DIFF, { 'x-ratelimit-remaining': '40' })(url, init);
      }
      return new Response('{}', { status: 403, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '30' } });
    });
    const first = readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 1 });
    await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 2 }));
    releaseFirst();
    await first;
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 3 }));
    expect(error.code).toBe('github_rate_limited');
    expect(error.sentGithubNothing).toBe(true);
  });
});

describe('rate limits, admission and revisions', () => {
  let fetchSpy;
  beforeEach(() => {
    resetPublicPrStateForTests();
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'c'.repeat(40);
  const flush = () => new Promise((resolve) => { setImmediate(resolve); });

  test('a secondary-limit 403 with budget left holds, and the next read sends GitHub nothing', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(
      { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
      { status: 403, headers: { 'x-ratelimit-remaining': '42' } },
    ));
    const first = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(first.status).toBe(503);
    expect(first.code).toBe('github_rate_limited');
    expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    fetchSpy.mockClear();
    const next = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'other', number: 2 }));
    expect(next.code).toBe('github_rate_limited');
    expect(next.sentGithubNothing).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a 429 with no Retry-After holds for at least 60 seconds, even with a near primary reset', async () => {
    const soon = String(Math.floor(Date.now() / 1000) + 5);
    fetchSpy.mockResolvedValue(jsonResponse({}, {
      status: 429, headers: { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': soon },
    }));
    const first = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    fetchSpy.mockClear();
    const later = Date.now() + 59 * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => later);
    const next = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'other', number: 2 }));
    expect(next.sentGithubNothing).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('with an unknown budget, two concurrent reads make one network probe before admission', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const headers = { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': reset };
    let releaseProbe;
    const probeAnswer = new Promise((resolve) => { releaseProbe = resolve; });
    let calls = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) await probeAnswer;
      return init.headers.Accept.includes('diff')
        ? new Response(DIFF, { headers })
        : new Response(JSON.stringify(PR_JSON), { headers });
    });
    const reads = [1, 2].map((number) => readPublicPullRequest({ owner: 'acme', repo: 'widgets', number }));
    await flush();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseProbe();
    const settled = await Promise.allSettled(reads);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test('a head-cache hit after a merge returns the fresh state with the cached diff', async () => {
    fetchSpy.mockImplementation(github());
    await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    // Past the minute a head is trusted without asking; same head, now merged.
    const later = Date.now() + 2 * 60 * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => later);
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(github({
      pr: {
        ...PR_JSON, state: 'closed', merged: true, merged_at: '2026-11-26T00:00:00Z', title: 'Add a thing (merged)',
      },
      diff: () => { throw new Error('the diff must come from the cache'); },
    }));
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(pr.state).toBe('merged');
    expect(pr.title).toBe('Add a thing (merged)');
    expect(pr.diff).toBe(DIFF);
    expect(pr.head.sha).toBe(SHA_A);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a head that moves mid-read: the returned diff is the one at the returned SHA', async () => {
    // GitHub answers the PR at head A once, then at head B: a push lands
    // between the metadata read and the diff read.
    const DIFF_B = DIFF.replace('+hello', '+hello from B');
    let prReads = 0;
    fetchSpy.mockImplementation(async (url, init) => {
      if (init.headers.Accept.includes('diff')) {
        return textResponse(String(url).includes(`...${SHA_A}`) ? DIFF : DIFF_B);
      }
      prReads += 1;
      const sha = prReads === 1 ? SHA_A : SHA_B;
      return jsonResponse({ ...PR_JSON, head: { ...PR_JSON.head, sha } });
    });
    const { pr } = await readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 });
    expect(pr.head.sha).toBe(SHA_A);
    expect(pr.diff).toBe(DIFF);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(6);
  });

  test('a head that moves during the /files fallback is refused and nothing is cached', async () => {
    let prReads = 0;
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).includes('/files')) {
        return jsonResponse([{ filename: 'big.bin', status: 'modified', additions: 1, deletions: 0 }]);
      }
      if (init.headers.Accept.includes('diff')) return jsonResponse({ message: 'too large' }, { status: 406 });
      prReads += 1;
      const sha = prReads === 1 ? SHA_A : SHA_B;
      return jsonResponse({ ...PR_JSON, head: { ...PR_JSON.head, sha } });
    });
    const error = await refusalOf(readPublicPullRequest({ owner: 'acme', repo: 'widgets', number: 7 }));
    expect(error).toBeInstanceOf(PublicPrError);
    expect(error.code).toBe('pr_changed_during_read');
    expect(publicPrCacheSizeForTests().results).toBe(0);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

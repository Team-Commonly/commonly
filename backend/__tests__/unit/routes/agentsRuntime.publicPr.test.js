// F646: GET /api/agents/runtime/github/public-pr. Two people's sandboxed
// agents were asked to review a public PR and neither could reach GitHub. The
// route reads a public PR through Commonly for an installed agent, and only
// that: the caller must be an agent, the ref is validated, and GitHub's own
// answers map to clean codes. GitHub is a spy on the global fetch.
const express = require('express');
const request = require('supertest');

// The mocked auth admits a caller only when the test names one, so the
// refusal arm runs the handler with no agent on the request.
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  if (req.headers['x-test-agent'] === 'yes') {
    req.agentUser = { _id: 'agent-1' };
    req.agentInstallations = [{ podId: 'pod-1', status: 'active' }];
  } else if (req.headers['x-test-agent'] === 'no-install') {
    req.agentUser = { _id: 'agent-2' };
    req.agentInstallations = [];
  }
  next();
});

const { resetPublicPrStateForTests } = require('../../../services/githubPublicPr');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

const PR_JSON = {
  number: 3,
  title: 'T',
  state: 'closed',
  merged: true,
  draft: false,
  user: { login: 'dev' },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  head: { ref: 'f', sha: 'c'.repeat(40), repo: { full_name: 'dev/r' } },
  body: null,
  additions: 1,
  deletions: 0,
  changed_files: 1,
};
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+y\n';

const get = (query, agent = 'yes') => request(app)
  .get('/api/agents/runtime/github/public-pr')
  .set('x-test-agent', agent)
  .query(query);

describe('GET /api/agents/runtime/github/public-pr', () => {
  let fetchSpy;

  beforeEach(() => {
    resetPublicPrStateForTests();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  test('returns the trimmed PR to an installed agent', async () => {
    fetchSpy.mockImplementation(async (_url, init) => (init.headers.Accept.includes('diff')
      ? new Response(DIFF)
      : new Response(JSON.stringify(PR_JSON))));
    const res = await get({ owner: 'dev', repo: 'r', number: '3' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      owner: 'dev', repo: 'r', number: 3, title: 'T', state: 'merged', author: 'dev', body: '',
      files: [{ path: 'x', status: 'modified', additions: 1, deletions: 0 }],
      diff: DIFF,
      truncated: false,
    });
  });

  test.each([
    [{ owner: 'dev', repo: 'r' }],
    [{ owner: 'dev', repo: 'r', number: 'abc' }],
    [{ owner: 'dev', repo: '../x', number: '3' }],
    [{ owner: 'https://evil.example', repo: 'r', number: '3' }],
    [{ owner: 'dev', repo: 'r', number: '3', url: 'https://evil.example/x' }],
  ])('refuses %j with 400 and calls nothing', async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pr_ref');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a private or missing PR answers 404 pr_not_found_or_private', async () => {
    fetchSpy.mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    const res = await get({ owner: 'dev', repo: 'private', number: '3' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('pr_not_found_or_private');
  });

  test('GitHub rate limiting answers 503 github_rate_limited with Retry-After', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '45' } }));
    const res = await get({ owner: 'dev', repo: 'r', number: '3' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('github_rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(44);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(44);
  });

  test('a caller that is not an agent is refused before GitHub is called', async () => {
    const res = await get({ owner: 'dev', repo: 'r', number: '3' }, 'none');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_installation_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('the hourly cap: 15 reads per agent', () => {
    let offset;
    let nowSpy;
    beforeEach(() => {
      offset = 0;
      const base = Date.now();
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
      fetchSpy.mockImplementation(async (_url, init) => {
        const headers = { 'x-ratelimit-remaining': '50' };
        return init.headers.Accept.includes('diff')
          ? new Response(DIFF, { headers })
          : new Response(JSON.stringify(PR_JSON), { headers });
      });
    });
    afterEach(() => nowSpy.mockRestore());

    // Each test is its own agent: both limiters key on the token.
    const read = (token, number) => request(app)
      .get('/api/agents/runtime/github/public-pr')
      .set('x-test-agent', 'yes')
      .set('Authorization', `Bearer cm_agent_${token}`)
      .query({ owner: 'dev', repo: 'r', number: String(number) });
    // Reads in batches under the 10-a-minute limit, a minute apart.
    const readMany = async (token, numbers) => {
      const statuses = [];
      for (let i = 0; i < numbers.length; i += 1) {
        if (i > 0 && i % 10 === 0) offset += 61_000;
        statuses.push((await read(token, numbers[i])).status);
      }
      return statuses;
    };
    const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);

    test('the 16th uncached read in an hour is refused with 429', async () => {
      const statuses = await readMany('hourA', range(1, 15));
      expect(statuses).toEqual(Array(15).fill(200));
      offset += 61_000;
      const sixteenth = await read('hourA', 16);
      expect(sixteenth.status).toBe(429);
      expect(sixteenth.body.message).toMatch(/per hour/);
    });

    test('a cache hit is given back, so it does not use the hour', async () => {
      // One read of PR 1, then nine repeats inside the minute its head is trusted.
      expect(await readMany('hourB', Array(10).fill(1))).toEqual(Array(10).fill(200));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      offset += 61_000;
      // Fourteen more uncached reads make 15 that reached GitHub; all pass.
      expect(await readMany('hourB', range(2, 14))).toEqual(Array(14).fill(200));
      offset += 61_000;
      expect((await read('hourB', 99)).status).toBe(429);
    });
  });

  test('an agent with no active installation is refused before GitHub is called', async () => {
    const res = await get({ owner: 'dev', repo: 'r', number: '3' }, 'no-install');
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

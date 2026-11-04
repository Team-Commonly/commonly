// D248: after a GitHub authorization, a person with no installation of the
// App has nothing for the agent to read. The entry asks GitHub which
// installations this user token can see; none means the access step is next.
const { githubNeedsAccessSetup } = require('../../../integrations/hostedMcp/githubMcp');

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('githubNeedsAccessSetup', () => {
  test('asks /user/installations with the user token, and none means the access step', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { total_count: 0, installations: [] }));
    await expect(githubNeedsAccessSetup('user-token', { fetchImpl })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/user/installations?per_page=1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer user-token');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  test('an installation means no access step', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { total_count: 1, installations: [{ id: 1 }] }));
    await expect(githubNeedsAccessSetup('user-token', { fetchImpl })).resolves.toBe(false);
  });

  test('anything it cannot read is not a reason to send the person elsewhere', async () => {
    const unreadable = [
      jest.fn().mockResolvedValue(reply(401, { message: 'Bad credentials' })),
      jest.fn().mockResolvedValue(reply(200, { installations: [] })),
      jest.fn().mockRejectedValue(new Error('timeout')),
    ];
    const answers = await Promise.all(unreadable.map((fetchImpl) => githubNeedsAccessSetup('user-token', { fetchImpl })));
    expect(answers).toEqual([false, false, false]);
    await expect(githubNeedsAccessSetup('', { fetchImpl: jest.fn() })).resolves.toBe(false);
  });

  test('with no fetch injected, the check goes through the guarded vendor fetch', async () => {
    await jest.isolateModulesAsync(async () => {
      const guarded = jest.fn().mockResolvedValue(reply(200, { total_count: 0 }));
      jest.doMock('../../../services/hostedVendorFetch', () => ({ hostedVendorFetch: guarded }));
      const mod = require('../../../integrations/hostedMcp/githubMcp');
      await expect(mod.githubNeedsAccessSetup('user-token')).resolves.toBe(true);
      expect(guarded).toHaveBeenCalledWith('https://api.github.com/user/installations?per_page=1', expect.any(Object));
    });
  });

  test('the GitHub entry carries the check exactly when it has an install page', () => {
    const original = process.env.GITHUB_MCP_APP_SLUG;
    try {
      process.env.GITHUB_MCP_APP_SLUG = 'commonly-connect';
      jest.isolateModules(() => {
        const mod = require('../../../integrations/hostedMcp/githubMcp');
        expect(mod.GITHUB_MCP_ENTRY.accessPage).toBe('https://github.com/apps/commonly-connect/installations/new');
        expect(mod.GITHUB_MCP_ENTRY.needsAccessSetup).toBe(mod.githubNeedsAccessSetup);
      });
      delete process.env.GITHUB_MCP_APP_SLUG;
      jest.isolateModules(() => {
        const mod = require('../../../integrations/hostedMcp/githubMcp');
        expect(mod.GITHUB_MCP_ENTRY.accessPage).toBeUndefined();
        expect(mod.GITHUB_MCP_ENTRY.needsAccessSetup).toBeUndefined();
      });
    } finally {
      if (original === undefined) delete process.env.GITHUB_MCP_APP_SLUG;
      else process.env.GITHUB_MCP_APP_SLUG = original;
    }
  });
});

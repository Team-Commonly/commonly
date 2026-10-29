// PAT liveness: presence (GITHUB_PAT is set) is not the same as the credential
// working. checkPatLiveness asks GitHub, and only a 401 counts as a rejection.
// Anything else is unknown (live: null), so a flaky upstream never reads as a
// dead credential.
const axios = require('axios');
const GitHubAppService = require('../../../services/githubAppService');

describe('GitHubAppService.checkPatLiveness', () => {
  const savedPat = process.env.GITHUB_PAT;
  let get;

  beforeEach(() => {
    process.env.GITHUB_PAT = 'ghp_test_token';
    get = jest.spyOn(axios, 'get');
  });

  afterEach(() => {
    if (savedPat === undefined) delete process.env.GITHUB_PAT; else process.env.GITHUB_PAT = savedPat;
    jest.restoreAllMocks();
  });

  it('reports absent without any network call when no PAT is set', async () => {
    delete process.env.GITHUB_PAT;
    await expect(GitHubAppService.checkPatLiveness()).resolves.toEqual({ live: false, status: 'absent' });
    expect(get).not.toHaveBeenCalled();
  });

  it('reports accepted when GitHub answers 200 to the rate-limit probe', async () => {
    get.mockResolvedValue({ status: 200, data: {} });
    await expect(GitHubAppService.checkPatLiveness()).resolves.toEqual({
      live: true, status: 'accepted', upstreamStatus: 200,
    });
    expect(get).toHaveBeenCalledWith(
      'https://api.github.com/rate_limit',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ghp_test_token' }) }),
    );
  });

  it('bounds the probe with a 5 second timeout so a hung GitHub cannot hold /status', async () => {
    get.mockResolvedValue({ status: 200, data: {} });
    await GitHubAppService.checkPatLiveness();
    expect(get.mock.calls[0][1]).toEqual(expect.objectContaining({ timeout: 5000 }));
  });

  it('reports rejected on a 401, which is the outage signature', async () => {
    get.mockRejectedValue({ message: 'Request failed with status code 401', response: { status: 401 } });
    await expect(GitHubAppService.checkPatLiveness()).resolves.toEqual({
      live: false, status: 'rejected', upstreamStatus: 401,
    });
  });

  it('reports unknown, not dead, on a 5xx', async () => {
    get.mockRejectedValue({ message: 'Request failed with status code 503', response: { status: 503 } });
    const result = await GitHubAppService.checkPatLiveness();
    expect(result.live).toBeNull();
    expect(result.status).toBe('unreachable');
    expect(result.upstreamStatus).toBe(503);
  });

  it('reports unknown, not dead, on a 403 (never guess the confident direction)', async () => {
    get.mockRejectedValue({ message: 'Request failed with status code 403', response: { status: 403 } });
    const result = await GitHubAppService.checkPatLiveness();
    expect(result.live).toBeNull();
    expect(result.status).toBe('unreachable');
  });

  it('reports unknown on a network failure with no response at all', async () => {
    get.mockRejectedValue({ message: 'socket hang up' });
    await expect(GitHubAppService.checkPatLiveness()).resolves.toEqual({
      live: null, status: 'unreachable', upstreamStatus: undefined, detail: 'socket hang up',
    });
  });
});

/**
 * F172: an installation token is signed by the App its connection belongs to.
 * `tools` (commonly-tools, GITHUB_APP_*) and `connect` (Commonly Connect,
 * GITHUB_CONNECT_APP_*) each sign with their own id and key; a row with no
 * `app` is a tools row; a Connect call with no Connect key refuses by name and
 * never reaches for the tools key. Tokens are cached per (App, installation).
 */
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
const { generateKeyPairSync } = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const GitHubAppService = require('../../../services/githubAppService');
const { githubAppOfConfig } = require('../../../services/githubAppService');

const keyPair = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const tools = keyPair();
const connect = keyPair();

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID_COMMONLY',
  'GITHUB_PAT', 'GITHUB_CONNECT_APP_ID', 'GITHUB_CONNECT_APP_PRIVATE_KEY'];
const saved = {};

const signerOf = (call) => {
  const bearer = String(call[2].headers.Authorization).replace(/^Bearer /, '');
  for (const [name, pair] of [['tools', tools], ['connect', connect]]) {
    try {
      const claims = jwt.verify(bearer, pair.publicKey, { algorithms: ['RS256'] });
      return { app: name, iss: claims.iss };
    } catch { /* not this key */ }
  }
  return { app: 'unknown' };
};

let minted = 0;
beforeEach(() => {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.GITHUB_APP_ID = '111';
  process.env.GITHUB_APP_PRIVATE_KEY = tools.privateKey;
  process.env.GITHUB_CONNECT_APP_ID = '222';
  process.env.GITHUB_CONNECT_APP_PRIVATE_KEY = connect.privateKey;
  GitHubAppService._resetTokenCache();
  axios.post.mockReset();
  axios.get.mockReset();
  minted = 0;
  axios.post.mockImplementation(async () => {
    minted += 1;
    return { data: { token: `tok-${minted}`, expires_at: new Date(Date.now() + 3600000).toISOString() } };
  });
  axios.get.mockResolvedValue({ data: { number: 7 } });
});

afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

describe('githubAppOfConfig', () => {
  it('reads a row with no app as tools, names both Apps, and refuses anything else', () => {
    expect(githubAppOfConfig(undefined)).toBe('tools');
    expect(githubAppOfConfig(null)).toBe('tools');
    expect(githubAppOfConfig('tools')).toBe('tools');
    expect(githubAppOfConfig('connect')).toBe('connect');
    expect(githubAppOfConfig('Connect')).toBeNull();
    expect(githubAppOfConfig('')).toBeNull();
    expect(githubAppOfConfig({})).toBeNull();
  });
});

describe('per-App signing', () => {
  it('a Connect connection signs with the Connect App id and key', async () => {
    await GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '900', app: 'connect', repositoryId: '555', forceApp: true, 
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe('https://api.github.com/app/installations/900/access_tokens');
    expect(signerOf(axios.post.mock.calls[0])).toEqual({ app: 'connect', iss: '222' });
  });

  it('a tools connection signs with the tools App id and key', async () => {
    await GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '901', app: 'tools', forceApp: true, 
    });
    expect(signerOf(axios.post.mock.calls[0])).toEqual({ app: 'tools', iss: '111' });
  });

  it('an installation named without its App is refused, never defaulted to tools', async () => {
    await expect(GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '902', forceApp: true,
    })).rejects.toThrow('github_app_required');
    await expect(GitHubAppService._apiHeaders('903')).rejects.toThrow('github_app_required');
    await expect(GitHubAppService.getInstallationToken('903')).rejects.toMatchObject({ code: 'github_app_not_configured' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('a call that names no installation uses the tools default installation', async () => {
    process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY = '42';
    await GitHubAppService.getPullRequest({ owner: 'o', repo: 'r', pullNumber: 1 });
    expect(axios.post.mock.calls[0][0]).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(signerOf(axios.post.mock.calls[0])).toEqual({ app: 'tools', iss: '111' });
  });
});

describe('a Connect token is never installation-wide (CodeRabbit, #3481)', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['not digits', '55a'],
    ['signed', '-5'],
    ['decimal', '5.5'],
    ['zero', '0'],
    ['leading zeros only', '000'],
    ['past the safe-integer range', '9007199254740993'],
    ['exponent notation', '1e3'],
    ['hex', '0x1f'],
    ['plus-signed', '+5'],
    ['padded', ' 5'],
  ])('refuses a %s repository id before signing anything', async (_label, repositoryId) => {
    await expect(GitHubAppService.getInstallationToken('900', 'connect', repositoryId))
      .rejects.toMatchObject({ code: 'github_repository_required' });
    await expect(GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '900', app: 'connect', repositoryId, forceApp: true,
    })).rejects.toMatchObject({ code: 'github_repository_required' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('tools still mints without a repository id, and ignores a malformed one', async () => {
    await GitHubAppService.getInstallationToken('901', 'tools');
    await GitHubAppService.getInstallationToken('902', 'tools', 'not-an-id');
    expect(axios.post.mock.calls.map((call) => call[1])).toEqual([{}, {}]);
  });
});

describe('token reuse margin and fresh mints (CodeRabbit, #3481)', () => {
  it('never hands out a cached token with less than 10 minutes left', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'nine-min', expires_at: new Date(Date.now() + 9 * 60000).toISOString() } });
    await GitHubAppService.getInstallationToken('906', 'connect', '555');
    const again = await GitHubAppService.getInstallationToken('906', 'connect', '555');
    expect(again.token).not.toBe('nine-min');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('a fresh request skips the cache', async () => {
    const a = await GitHubAppService.getInstallationToken('907', 'connect', '555');
    const b = await GitHubAppService.getInstallationToken('907', 'connect', '555', { fresh: true });
    expect(a.token).not.toBe(b.token);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});

describe('M1: a Connect token is narrowed to the connection repository', () => {
  it('asks GitHub for a token covering only that repository id', async () => {
    await GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '900', app: 'connect', repositoryId: '555', forceApp: true,
    });
    expect(axios.post.mock.calls[0][1]).toEqual({ repository_ids: [555] });
  });

  it('a tools token is not narrowed, even when a repository id is passed', async () => {
    await GitHubAppService.getInstallationToken('901', 'tools', '555');
    expect(axios.post.mock.calls[0][1]).toEqual({});
  });

  it('caches per repository, so one repository\'s narrowed token never serves another', async () => {
    const a = await GitHubAppService.getInstallationToken('900', 'connect', '555');
    const b = await GitHubAppService.getInstallationToken('900', 'connect', '556');
    expect(a.token).not.toBe(b.token);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});

describe('Connect with no key configured', () => {
  it.each([
    ['no id', () => { delete process.env.GITHUB_CONNECT_APP_ID; }],
    ['no key', () => { delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY; }],
    ['neither', () => { delete process.env.GITHUB_CONNECT_APP_ID; delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY; }],
  ])('refuses github_app_not_configured (%s) and never signs with the tools key', async (_label, unset) => {
    unset();
    process.env.GITHUB_PAT = 'shared-pat';
    await expect(GitHubAppService.getPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, installationId: '900', app: 'connect', repositoryId: '555', forceApp: true,
    })).rejects.toMatchObject({ code: 'github_app_not_configured' });
    await expect(GitHubAppService.getInstallationToken('900', 'connect', '555'))
      .rejects.toMatchObject({ code: 'github_app_not_configured' });
    expect(() => GitHubAppService.generateAppJWT('connect')).toThrow('github_app_not_configured');
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(GitHubAppService.isAppConfigured('connect')).toBe(false);
  });

  it('a Connect call never falls to the PAT or the default installation', async () => {
    process.env.GITHUB_PAT = 'shared-pat';
    process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY = '42';
    await expect(GitHubAppService._apiHeaders(undefined, false, 'connect')).rejects.toThrow('github_not_configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('an App name that is neither refuses', async () => {
    await expect(GitHubAppService.getInstallationToken('900', 'other'))
      .rejects.toMatchObject({ code: 'github_app_not_configured' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('token cache', () => {
  it('reuses a token per (App, installation) and never serves one App\'s token for the other', async () => {
    const a = await GitHubAppService.getInstallationToken('900', 'connect', '555');
    const b = await GitHubAppService.getInstallationToken('900', 'connect', '555');
    expect(a.token).toBe(b.token);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const c = await GitHubAppService.getInstallationToken('900', 'tools');
    expect(c.token).not.toBe(a.token);
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(signerOf(axios.post.mock.calls[1]).app).toBe('tools');
  });

  it('mints again when the cached token is about to expire', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'soon', expires_at: new Date(Date.now() + 60000).toISOString() } });
    await GitHubAppService.getInstallationToken('905', 'connect', '555');
    await GitHubAppService.getInstallationToken('905', 'connect', '555');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});

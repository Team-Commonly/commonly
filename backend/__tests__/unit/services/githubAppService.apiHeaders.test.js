// Credential precedence for backend GitHub calls: the App installation token is
// the default, and the shared GITHUB_PAT is used only when no App is configured.
const GitHubAppService = require('../../../services/githubAppService');

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_INSTALLATION_ID_COMMONLY',
  'GITHUB_PAT',
];

describe('GitHubAppService._apiHeaders credential precedence', () => {
  const saved = {};
  let mint;
  let warn;

  beforeEach(() => {
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    mint = jest.spyOn(GitHubAppService, 'getInstallationToken')
      .mockResolvedValue({ token: 'app-installation-token', expiresAt: null });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
    jest.restoreAllMocks();
  });

  const configureApp = () => {
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_PRIVATE_KEY = 'pem';
    process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY = '42';
  };

  it('uses the App installation token when both the App and GITHUB_PAT are configured', async () => {
    configureApp();
    process.env.GITHUB_PAT = 'shared-pat';
    const headers = await GitHubAppService._apiHeaders();
    expect(headers.Authorization).toBe('Bearer app-installation-token');
    expect(mint).toHaveBeenCalledWith('42');
    expect(warn).not.toHaveBeenCalled();
  });

  it('mints for an explicit installationId over the default one', async () => {
    configureApp();
    await GitHubAppService._apiHeaders('99');
    expect(mint).toHaveBeenCalledWith('99');
  });

  it('falls back to GITHUB_PAT only when no App is configured, and logs it', async () => {
    process.env.GITHUB_PAT = 'shared-pat';
    const headers = await GitHubAppService._apiHeaders();
    expect(headers.Authorization).toBe('Bearer shared-pat');
    expect(mint).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to GITHUB_PAT'));
  });

  it('never falls back to the PAT for an app-only request', async () => {
    process.env.GITHUB_PAT = 'shared-pat';
    await expect(GitHubAppService._apiHeaders(undefined, true)).rejects.toThrow('github_not_configured');
    await expect(GitHubAppService._apiHeaders('99')).rejects.toThrow('github_not_configured');
    expect(mint).not.toHaveBeenCalled();
  });

  it('rejects an explicit empty installationId instead of using the default or the PAT', async () => {
    configureApp();
    process.env.GITHUB_PAT = 'shared-pat';
    await expect(GitHubAppService._apiHeaders('')).rejects.toThrow('github_not_configured');
    expect(mint).not.toHaveBeenCalled();
  });

  it('throws when nothing is configured', async () => {
    await expect(GitHubAppService._apiHeaders()).rejects.toThrow('github_not_configured');
  });
});

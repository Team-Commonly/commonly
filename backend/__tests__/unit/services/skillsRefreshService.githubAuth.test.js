// skills-refresh GitHub auth: one credential per run, minted through
// GitHubAppService (App token by default), a failed mint makes no repo request,
// and with no credential configured the requests go out unauthenticated.
const fs = require('fs');
const os = require('os');
const path = require('path');
const GitHubAppService = require('../../../services/githubAppService');
const { refreshSkillsIndex } = require('../../../services/skillsRefreshService');

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe('skillsRefreshService GitHub auth', () => {
  let tmpDir;
  let savedPath;
  let fetchMock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-refresh-'));
    savedPath = process.env.SKILLS_CATALOG_PATH;
    process.env.SKILLS_CATALOG_PATH = path.join(tmpDir, 'index.json');
    fetchMock = jest.fn(async (url) => {
      if (String(url).startsWith('https://api.github.com/repos/')) {
        return jsonResponse({ stargazers_count: 7, forks_count: 1 });
      }
      return jsonResponse({ items: [{ repo: 'a/one' }, { repo: 'b/two' }, { repo: 'a/one' }] });
    });
    global.fetch = fetchMock;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.SKILLS_CATALOG_PATH;
    else process.env.SKILLS_CATALOG_PATH = savedPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete global.fetch;
    jest.restoreAllMocks();
  });

  const repoCalls = () => fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith('https://api.github.com/repos/'));

  it('mints one App credential per run and sends it on every repo request', async () => {
    jest.spyOn(GitHubAppService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(GitHubAppService, 'isPatConfigured').mockReturnValue(true);
    const headers = jest.spyOn(GitHubAppService, '_apiHeaders')
      .mockResolvedValue({ Authorization: 'Bearer app-installation-token' });

    const result = await refreshSkillsIndex();

    expect(headers).toHaveBeenCalledTimes(1);
    expect(repoCalls()).toHaveLength(2);
    repoCalls().forEach(([, init]) => {
      expect(init.headers.Authorization).toBe('Bearer app-installation-token');
    });
    expect(result.reposUpdated).toBe(2);
  });

  it('stops before any repo request when the credential mint fails', async () => {
    jest.spyOn(GitHubAppService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(GitHubAppService, '_apiHeaders').mockRejectedValue(new Error('mint refused'));

    const result = await refreshSkillsIndex();

    expect(repoCalls()).toHaveLength(0);
    expect(result.errors.map((e) => e.message)).toContainEqual(expect.stringContaining('mint refused'));
    expect(result.reposUpdated).toBe(0);
    expect(result.wroteFile).toBe(true);
  });

  it('goes unauthenticated when no App or PAT is configured', async () => {
    jest.spyOn(GitHubAppService, 'isConfigured').mockReturnValue(false);
    jest.spyOn(GitHubAppService, 'isPatConfigured').mockReturnValue(false);
    const headers = jest.spyOn(GitHubAppService, '_apiHeaders');

    await refreshSkillsIndex();

    expect(headers).not.toHaveBeenCalled();
    expect(repoCalls()).toHaveLength(2);
    repoCalls().forEach(([, init]) => {
      expect(init.headers.Authorization).toBeUndefined();
    });
  });
});

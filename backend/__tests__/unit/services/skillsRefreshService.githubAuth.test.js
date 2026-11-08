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
  let savedUpstream;
  let fetchMock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-refresh-'));
    savedPath = process.env.SKILLS_CATALOG_PATH;
    process.env.SKILLS_CATALOG_PATH = path.join(tmpDir, 'index.json');
    savedUpstream = process.env.SKILLS_UPSTREAM_INDEX_URL;
    process.env.SKILLS_UPSTREAM_INDEX_URL = 'https://upstream.test/index.json';
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
    if (savedUpstream === undefined) delete process.env.SKILLS_UPSTREAM_INDEX_URL;
    else process.env.SKILLS_UPSTREAM_INDEX_URL = savedUpstream;
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

// F332: the default upstream is gone (404 on every run), so there is no default.
describe('skillsRefreshService upstream index', () => {
  let tmpDir;
  let saved;
  let fetchMock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-upstream-'));
    saved = { catalog: process.env.SKILLS_CATALOG_PATH, upstream: process.env.SKILLS_UPSTREAM_INDEX_URL };
    process.env.SKILLS_CATALOG_PATH = path.join(tmpDir, 'index.json');
    fs.writeFileSync(process.env.SKILLS_CATALOG_PATH, JSON.stringify({
      updatedAt: '2026-02-05T00:00:00.000Z', items: [{ repo: 'a/one' }],
    }));
    delete process.env.SKILLS_UPSTREAM_INDEX_URL;
    fetchMock = jest.fn(async () => jsonResponse({ stargazers_count: 3, forks_count: 0 }));
    global.fetch = fetchMock;
    jest.spyOn(GitHubAppService, 'isConfigured').mockReturnValue(false);
    jest.spyOn(GitHubAppService, 'isPatConfigured').mockReturnValue(false);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (saved.catalog === undefined) delete process.env.SKILLS_CATALOG_PATH;
    else process.env.SKILLS_CATALOG_PATH = saved.catalog;
    if (saved.upstream === undefined) delete process.env.SKILLS_UPSTREAM_INDEX_URL;
    else process.env.SKILLS_UPSTREAM_INDEX_URL = saved.upstream;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete global.fetch;
    jest.restoreAllMocks();
  });

  it('with no upstream set, reads the local catalog without fetching an index or warning', async () => {
    const result = await refreshSkillsIndex();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(['https://api.github.com/repos/a/one']);
    expect(result.errors).toEqual([]);
    expect(result.catalogItems).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
    // A local updatedAt is not an upstream refresh.
    const written = JSON.parse(fs.readFileSync(process.env.SKILLS_CATALOG_PATH, 'utf8'));
    expect(written.upstreamRefreshedAt).toBeNull();
    expect(written.localRefreshedAt).toEqual(expect.any(String));
  });

  it('with an upstream set, fetches it, and a failed fetch still falls back to the local catalog', async () => {
    process.env.SKILLS_UPSTREAM_INDEX_URL = 'https://upstream.test/index.json';
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    const result = await refreshSkillsIndex();
    expect(fetchMock.mock.calls[0][0]).toBe('https://upstream.test/index.json');
    expect(result.errors).toHaveLength(1);
    expect(result.catalogItems).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[skills-refresh] Upstream index fetch failed; falling back to local catalog:',
      'Upstream index fetch failed: 404 Not Found',
    );
    expect(result.wroteFile).toBe(true);
    const written = JSON.parse(fs.readFileSync(process.env.SKILLS_CATALOG_PATH, 'utf8'));
    expect(written.items[0].stars).toBe(3);
    expect(written.upstreamRefreshedAt).toBeNull();
  });
});

// A catalog source that no longer has the skill is not our server failing
// (#2189). 1,655 of the 1,659 built-in catalog entries point at
// github.com/openclaw/skills, which went 404 in May 2026, and every import of
// one returned a 500. Now: a legacy entry is fetched from ClawHub, where the
// skills that are still published live; a source without the skill is a 404
// with a plain message; a source that cannot be read is a 502. As in the guard
// test beside this one, the catalog service and the fetch guard are REAL and
// only the global `fetch` is replaced.
const request = require('supertest');
const express = require('express');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({}));
jest.mock('../../../models/Gateway', () => ({}));
jest.mock('../../../models/SkillRating', () => ({}));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../services/podAssetService', () => ({ upsertImportedSkillAsset: jest.fn() }));
jest.mock('../../../services/agentProvisionerService', () => ({
  getOpenClawConfigPath: jest.fn(),
  syncOpenClawSkills: jest.fn(),
  getGatewaySkillEntries: jest.fn(),
  syncGatewaySkillEnv: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const PodAssetService = require('../../../services/podAssetService');
const skillsRoutes = require('../../../routes/skills');

const app = express();
app.use(express.json());
app.use('/api/skills', skillsRoutes);

const GITHUB_SOURCE = 'https://github.com/acme/skills/blob/main/skills/notes/SKILL.md';
const RAW_SOURCE = 'https://raw.githubusercontent.com/acme/skills/main/skills/notes/SKILL.md';
const LISTING_URL = 'https://api.github.com/repos/acme/skills/contents/skills/notes?ref=main';

const importBody = (overrides) => ({ podId: 'pod-1', name: 'notes', ...overrides });

const LEGACY_SOURCE = 'https://github.com/openclaw/skills/tree/main/skills/acme/notes/SKILL.md';
const CLAWHUB_META = 'https://clawhub.ai/api/skill?owner=acme&slug=notes';
const CLAWHUB_ZIP = 'https://clawhub.ai/api/v1/download?slug=notes&version=1.2.0';
const SOURCE_MISSING = 'This skill is no longer published at its source.';
const SOURCE_UNREACHABLE = "Couldn't reach this skill's source. Try again in a few minutes.";

const zipOf = (files) => {
  const zip = new AdmZip();
  Object.entries(files).forEach(([name, text]) => zip.addFile(name, Buffer.from(text)));
  return zip.toBuffer();
};
const zipResponse = (buf) => new Response(buf, { headers: { 'content-length': String(buf.length) } });

describe('a catalog source without the skill is a 404 or a 502, never a 500', () => {
  let fetchSpy;
  let routes;

  beforeEach(() => {
    const pod = { _id: 'pod-1', createdBy: 'user-1', members: [] };
    Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(pod) });
    AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    PodAssetService.upsertImportedSkillAsset.mockReset();
    PodAssetService.upsertImportedSkillAsset.mockResolvedValue({ _id: 'asset-1' });
    routes = {};
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (!routes[url]) throw new Error(`unexpected outbound request in test: ${url}`);
      return routes[url]();
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const requestedUrls = () => fetchSpy.mock.calls.map(([url]) => url);

  test('a legacy catalog entry still published on ClawHub imports from there, with its other files', async () => {
    routes[CLAWHUB_META] = () => new Response(JSON.stringify({ latestVersion: { version: '1.2.0' } }));
    routes[CLAWHUB_ZIP] = () => zipResponse(zipOf({ 'SKILL.md': '# Notes', 'references/a.md': '# a' }));

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(201);
    // The dead GitHub repository is never asked, and both ClawHub calls go
    // through the fetch guard: redirects by hand, every hop on clawhub.ai.
    expect(requestedUrls()).toEqual([CLAWHUB_META, CLAWHUB_ZIP]);
    fetchSpy.mock.calls.forEach(([, init]) => expect(init).toEqual(expect.objectContaining({ redirect: 'manual' })));
    const written = PodAssetService.upsertImportedSkillAsset.mock.calls[0][0];
    expect(written.markdown).toBe('# Notes');
    expect(written.metadata.sourceUrl).toBe('clawhub:acme/notes@1.2.0');
    expect(written.metadata.extraFiles).toEqual([{ path: 'references/a.md', content: '# a' }]);
  });

  test.each([
    ['ClawHub does not know it', () => { routes[CLAWHUB_META] = () => new Response('{}', { status: 404 }); }],
    ['ClawHub lists it with nothing published', () => { routes[CLAWHUB_META] = () => new Response('{}'); }],
    ['the published bundle has no SKILL.md', () => {
      routes[CLAWHUB_META] = () => new Response(JSON.stringify({ latestVersion: { version: '1.2.0' } }));
      routes[CLAWHUB_ZIP] = () => zipResponse(zipOf({ 'README.md': '# readme' }));
    }],
  ])('a legacy catalog entry is a 404 with a plain message when %s', async (_case, arrange) => {
    arrange();

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: SOURCE_MISSING, code: 'skill_source_missing' });
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  test.each([
    ['ClawHub cannot be reached', () => { routes[CLAWHUB_META] = () => { throw new TypeError('fetch failed'); }; }],
    ['ClawHub fails', () => { routes[CLAWHUB_META] = () => new Response('{}', { status: 503 }); }],
    ['the download is not a zip', () => {
      routes[CLAWHUB_META] = () => new Response(JSON.stringify({ latestVersion: { version: '1.2.0' } }));
      routes[CLAWHUB_ZIP] = () => new Response('not a zip');
    }],
  ])('a legacy catalog entry is a 502 when %s', async (_case, arrange) => {
    arrange();

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: SOURCE_UNREACHABLE, code: 'skill_source_unreachable' });
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  // ClawHub is a third party now reachable from a request, so it gets the
  // GitHub path's rule: a redirect that leaves clawhub.ai is never followed.
  test('a ClawHub redirect off clawhub.ai is not followed, and the import is a 502', async () => {
    routes[CLAWHUB_META] = () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: SOURCE_UNREACHABLE, code: 'skill_source_unreachable' });
    expect(requestedUrls()).toEqual([CLAWHUB_META]);
    // The mocked fetch never follows a redirect itself, so the status alone
    // cannot tell; what proves it is that the request told fetch not to.
    expect(fetchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  // The caps and the allowlist only show when the input is otherwise good: a
  // VALID zip or VALID metadata over its cap imports without the cap and is a
  // 502 with it, and a redirect to another https host is requested only if
  // the allowlist lets it (Sprint Review's re-gate on #2195: an over-cap body
  // of zeros failed as "not a zip" whether or not the cap ran).
  test('a valid ClawHub bundle that streams past 2 MB is a 502, not an import', async () => {
    routes[CLAWHUB_META] = () => new Response(JSON.stringify({ latestVersion: { version: '1.2.0' } }));
    // Random bytes do not compress, so the zip itself stays over the cap.
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# Notes'));
    zip.addFile('padding.bin', crypto.randomBytes(2 * 1024 * 1024 + 1024));
    const oversized = zip.toBuffer();
    expect(oversized.length).toBeGreaterThan(2 * 1024 * 1024);
    routes[CLAWHUB_ZIP] = () => new Response(oversized);

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('skill_source_unreachable');
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  test('valid ClawHub metadata over 256 KB is a 502, not an import', async () => {
    const meta = { latestVersion: { version: '1.2.0' }, readme: 'x'.repeat(256 * 1024 + 1) };
    routes[CLAWHUB_META] = () => new Response(JSON.stringify(meta));
    routes[CLAWHUB_ZIP] = () => zipResponse(zipOf({ 'SKILL.md': '# Notes' }));

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(502);
    expect(requestedUrls()).toEqual([CLAWHUB_META]);
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  test('a ClawHub redirect to another https host is never requested', async () => {
    routes[CLAWHUB_META] = () => new Response(null, {
      status: 302,
      headers: { location: 'https://skills.example.com/api/skill?owner=acme&slug=notes' },
    });

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: LEGACY_SOURCE }));

    expect(res.status).toBe(502);
    expect(requestedUrls()).toEqual([CLAWHUB_META]);
  });

  test('requirements for a legacy entry ClawHub does not have is the same 404', async () => {
    routes[CLAWHUB_META] = () => new Response('{}', { status: 404 });

    const res = await request(app).get('/api/skills/requirements').query({ sourceUrl: LEGACY_SOURCE });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: SOURCE_MISSING, code: 'skill_source_missing' });
  });

  test('a GitHub source without the file is a 404 on import and on requirements', async () => {
    routes[RAW_SOURCE] = () => new Response('Not Found', { status: 404 });

    const imported = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: GITHUB_SOURCE }));
    const required = await request(app).get('/api/skills/requirements').query({ sourceUrl: GITHUB_SOURCE });

    expect(imported.status).toBe(404);
    expect(imported.body.code).toBe('skill_source_missing');
    expect(required.status).toBe(404);
    expect(required.body.code).toBe('skill_source_missing');
  });

  test('a GitHub source that errors is a 502, not a 500', async () => {
    routes[RAW_SOURCE] = () => new Response('busy', { status: 503 });

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: GITHUB_SOURCE }));

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('skill_source_unreachable');
  });

  test('pasted content with a legacy source URL imports without any request', async () => {
    const res = await request(app).post('/api/skills/import').send(importBody({
      content: '# Notes (pasted)',
      sourceUrl: LEGACY_SOURCE,
    }));

    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(PodAssetService.upsertImportedSkillAsset.mock.calls[0][0].metadata.extraFiles).toEqual([]);
  });

  // Unchanged behaviour, pinned here beside the rest: fetchSkillDirectoryFiles
  // already swallows a failed listing, so the SKILL.md still imports.
  test("a failed listing of a skill's other files still imports its SKILL.md", async () => {
    routes[RAW_SOURCE] = () => new Response('# Notes');
    routes[LISTING_URL] = () => new Response('rate limited', { status: 403 });

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: GITHUB_SOURCE }));

    expect(res.status).toBe(201);
    expect(requestedUrls()).toEqual([RAW_SOURCE, LISTING_URL]);
    const written = PodAssetService.upsertImportedSkillAsset.mock.calls[0][0];
    expect(written.markdown).toBe('# Notes');
    expect(written.metadata.extraFiles).toEqual([]);
  });
});

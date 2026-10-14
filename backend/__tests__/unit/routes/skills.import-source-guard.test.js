// The skill routes that fetch a caller-supplied source URL: POST /import and
// GET /requirements. The catalog service and the fetch guard are REAL here; only
// the global `fetch` is replaced, so "no outbound request" is asserted on the
// one function every request would have to pass through.
const request = require('supertest');
const express = require('express');

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

const REFUSED_MESSAGE = 'Skill source URL must be an https link on github.com or raw.githubusercontent.com.';
const GITHUB_SOURCE = 'https://github.com/acme/skills/blob/main/skills/notes/SKILL.md';
const RAW_SOURCE = 'https://raw.githubusercontent.com/acme/skills/main/skills/notes/SKILL.md';
const LISTING_URL = 'https://api.github.com/repos/acme/skills/contents/skills/notes?ref=main';

const importBody = (overrides) => ({ podId: 'pod-1', name: 'notes', ...overrides });

describe('skill source fetches are confined to GitHub', () => {
  let fetchSpy;
  // url -> Response factory; any URL not listed fails the test loudly.
  let routes;

  beforeEach(() => {
    const pod = { _id: 'pod-1', createdBy: 'user-1', members: [] };
    Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(pod) });
    AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    PodAssetService.upsertImportedSkillAsset.mockResolvedValue({ _id: 'asset-1' });
    routes = {};
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (!routes[url]) throw new Error(`unexpected outbound request in test: ${url}`);
      return routes[url]();
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  const requestedUrls = () => fetchSpy.mock.calls.map(([url]) => url);

  test('control: a GitHub source is fetched as raw content and imported', async () => {
    // Proves this fixture reaches the fetch and the write, so the 400s below are
    // the guard's and not a pod-access or validation refusal.
    routes[RAW_SOURCE] = () => new Response('---\nname: notes\n---\n# Notes');
    routes[LISTING_URL] = () => new Response('[]');

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: GITHUB_SOURCE }));

    expect(res.status).toBe(201);
    expect(requestedUrls()).toEqual([RAW_SOURCE, LISTING_URL]);
    expect(PodAssetService.upsertImportedSkillAsset).toHaveBeenCalledTimes(1);
    expect(PodAssetService.upsertImportedSkillAsset.mock.calls[0][0].markdown).toBe('---\nname: notes\n---\n# Notes');
  });

  test.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://[::ffff:127.0.0.1]/',
    'http://10.0.0.1:8080/admin',
    'https://skills.example.com/SKILL.md',
    'file:///etc/hostname',
  ])('POST /import with source %s is a 400, makes no request and writes nothing', async (sourceUrl) => {
    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: REFUSED_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  test('POST /import whose GitHub source redirects off GitHub is a 400 after one request', async () => {
    routes[RAW_SOURCE] = () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });

    const res = await request(app).post('/api/skills/import').send(importBody({ sourceUrl: GITHUB_SOURCE }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: REFUSED_MESSAGE });
    expect(requestedUrls()).toEqual([RAW_SOURCE]);
    expect(PodAssetService.upsertImportedSkillAsset).not.toHaveBeenCalled();
  });

  test('a directory listing entry whose download_url is off GitHub is never requested', async () => {
    const extraUrl = 'https://raw.githubusercontent.com/acme/skills/main/skills/notes/references/a.md';
    const offHostUrl = 'http://10.0.0.1/b.md';
    const listing = [
      { path: 'skills/notes/references/a.md', download_url: extraUrl },
      { path: 'skills/notes/references/b.md', download_url: offHostUrl },
    ].map((entry) => ({ type: 'file', size: 5, ...entry }));
    routes[LISTING_URL] = () => new Response(JSON.stringify(listing));
    routes[extraUrl] = () => new Response('# a');

    const res = await request(app).post('/api/skills/import').send(importBody({
      content: '# Notes (pasted)',
      sourceUrl: GITHUB_SOURCE,
    }));

    expect(res.status).toBe(201);
    expect(requestedUrls()).toEqual([LISTING_URL, extraUrl]);
    const { metadata } = PodAssetService.upsertImportedSkillAsset.mock.calls[0][0];
    expect(metadata.extraFiles).toEqual([{ path: 'references/a.md', content: '# a' }]);
  });

  test('pasted content with a non-GitHub source URL imports without fetching it', async () => {
    // The two ClawHub entries in the catalog take this path: their sourceUrl is
    // kept as metadata, never fetched, so the guard does not block them.
    const res = await request(app).post('/api/skills/import').send(importBody({
      content: '# Pasted',
      sourceUrl: 'https://www.clawhub.ai/kantorcodes/registry-broker-skills',
    }));

    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(PodAssetService.upsertImportedSkillAsset.mock.calls[0][0].metadata.sourceUrl)
      .toBe('https://www.clawhub.ai/kantorcodes/registry-broker-skills');
  });

  test('GET /requirements with a refused source is a 400 and makes no request', async () => {
    const res = await request(app)
      .get('/api/skills/requirements')
      .query({ sourceUrl: 'https://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: REFUSED_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('control: GET /requirements fetches a GitHub source', async () => {
    routes[RAW_SOURCE] = () => new Response('Set OPENAI_API_KEY before running.');

    const res = await request(app).get('/api/skills/requirements').query({ sourceUrl: GITHUB_SOURCE });

    expect(res.status).toBe(200);
    expect(res.body.requirements).toEqual(['OPENAI_API_KEY']);
    expect(requestedUrls()).toEqual([RAW_SOURCE]);
  });
});

const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/skillsCatalogService', () => ({
  loadCatalog: jest.fn(),
  fetchSkillContentFromSource: jest.fn(),
}));

const SkillsCatalogService = require('../../../services/skillsCatalogService');
const skillsRoutes = require('../../../routes/skills');

const app = express();
app.use(express.json());
app.use('/api/skills', skillsRoutes);

describe('skills requirements endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when sourceUrl is missing', async () => {
    const res = await request(app).get('/api/skills/requirements');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sourceUrl');
  });

  it('extracts credential hints from skill content', async () => {
    SkillsCatalogService.fetchSkillContentFromSource.mockResolvedValue({
      content: 'Set OPENAI_API_KEY and SERPAPI_KEY before running.',
      resolvedUrl: 'https://example.com/skill.md',
    });

    const res = await request(app)
      .get('/api/skills/requirements')
      .query({ sourceUrl: 'https://example.com/skill.md' });

    expect(res.status).toBe(200);
    expect(res.body.requirements).toEqual(['OPENAI_API_KEY', 'SERPAPI_KEY']);
  });
});

const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../controllers/podController', () => ({
  getAllPods: jest.fn((_, res) => res.json([])),
  getPodsByType: jest.fn((_, res) => res.json([])),
  getPodById: jest.fn((_, res) => res.json({})),
  createPod: jest.fn((_, res) => res.status(201).json({})),
  joinPod: jest.fn((_, res) => res.json({})),
  leavePod: jest.fn((_, res) => res.json({})),
  removeMember: jest.fn((_, res) => res.json({})),
  deletePod: jest.fn((_, res) => res.status(204).send()),
}));

jest.mock('../../../services/podContextService', () => ({
  getPodContext: jest.fn(),
}));

jest.mock('../../../services/podMemorySearchService', () => ({
  searchPodMemory: jest.fn(),
  getAssetExcerpt: jest.fn(),
}));

const PodMemorySearchService = require('../../../services/podMemorySearchService');
const podRoutes = require('../../../routes/pods');

describe('Pod context memory routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pods', podRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/pods/:id/context/search', () => {
    it('returns 400 when query is missing', async () => {
      const res = await request(app).get('/api/pods/pod-1/context/search');

      expect(res.status).toBe(400);
      expect(PodMemorySearchService.searchPodMemory).not.toHaveBeenCalled();
    });

    it('calls service with parsed params', async () => {
      PodMemorySearchService.searchPodMemory.mockResolvedValue({
        query: 'incident',
        usedTextSearch: true,
        results: [],
      });

      const res = await request(app)
        .get('/api/pods/pod-1/context/search')
        .query({
          query: 'incident',
          limit: 999,
          includeSkills: 'true',
          types: 'summary, integration-summary',
        });

      expect(res.status).toBe(200);
      expect(PodMemorySearchService.searchPodMemory).toHaveBeenCalledWith({
        podId: 'pod-1',
        userId: 'user-1',
        query: 'incident',
        limit: 40,
        includeSkills: true,
        types: ['summary', 'integration-summary'],
      });
    });

    it('maps service errors with status codes', async () => {
      PodMemorySearchService.searchPodMemory.mockRejectedValue({
        status: 403,
        code: 'NOT_A_MEMBER',
        message: 'Not authorized for this pod',
      });

      const res = await request(app)
        .get('/api/pods/pod-1/context/search')
        .query({ query: 'incident' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
      expect(res.body.message).toBe('Not authorized for this pod');
    });
  });

  describe('GET /api/pods/:id/context/assets/:assetId', () => {
    it('calls service with clamped line params', async () => {
      PodMemorySearchService.getAssetExcerpt.mockResolvedValue({
        assetId: 'asset-1',
        title: 'Summary',
        type: 'summary',
        text: 'Excerpt',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      });

      const res = await request(app)
        .get('/api/pods/pod-1/context/assets/asset-1')
        .query({ from: 0, lines: 500 });

      expect(res.status).toBe(200);
      expect(PodMemorySearchService.getAssetExcerpt).toHaveBeenCalledWith({
        podId: 'pod-1',
        userId: 'user-1',
        assetId: 'asset-1',
        from: 1,
        lines: 100,
      });
    });

    it('maps service errors with status codes', async () => {
      PodMemorySearchService.getAssetExcerpt.mockRejectedValue({
        status: 404,
        code: 'ASSET_NOT_FOUND',
        message: 'Asset not found',
      });

      const res = await request(app)
        .get('/api/pods/pod-1/context/assets/asset-1')
        .query({ from: 1, lines: 10 });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ASSET_NOT_FOUND');
      expect(res.body.message).toBe('Asset not found');
    });
  });
});

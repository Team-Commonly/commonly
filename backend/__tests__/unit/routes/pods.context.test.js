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
  deletePod: jest.fn((_, res) => res.status(204).send()),
}));

jest.mock('../../../services/podContextService', () => ({
  getPodContext: jest.fn(),
}));

const PodContextService = require('../../../services/podContextService');
const podRoutes = require('../../../routes/pods');

describe('GET /api/pods/:id/context', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pods', podRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls PodContextService with clamped limits and task', async () => {
    PodContextService.getPodContext.mockResolvedValue({
      pod: {
        id: 'pod-1',
        name: 'Pod',
        description: '',
        type: 'chat',
      },
      task: 'incident',
      stats: {
        summaries: 0,
        assets: 0,
        tags: 0,
        skills: 0,
      },
      skills: [],
      tags: [],
      summaries: [],
      assets: [],
    });

    const res = await request(app)
      .get('/api/pods/pod-1/context')
      .query({
        summaryLimit: 999,
        assetLimit: 0,
        tagLimit: 999,
        skillLimit: 999,
        skillMode: 'LLM',
        skillRefreshHours: 999,
        task: 'incident',
      });

    expect(res.status).toBe(200);
    expect(PodContextService.getPodContext).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: 'pod-1',
        userId: 'user-1',
        task: 'incident',
        summaryLimit: 20,
        assetLimit: 1,
        tagLimit: 40,
        skillLimit: 12,
        skillMode: 'llm',
        skillRefreshHours: 72,
      }),
    );
  });

  it('maps service errors with status codes', async () => {
    PodContextService.getPodContext.mockRejectedValue({
      status: 403,
      code: 'NOT_A_MEMBER',
      message: 'Not authorized for this pod',
    });

    const res = await request(app).get('/api/pods/pod-1/context');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    expect(res.body.message).toBe('Not authorized for this pod');
  });
});

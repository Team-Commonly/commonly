const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const header = req.header ? req.header('authorization') : null;
  if (header && header.startsWith('Bearer human-')) { req.userId = header.slice(13); return next(); }
  return res.status(401).json({ msg: 'unauth' });
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentAuthorizedPodIds = ['pod-a', 'pod-b'];
  return next();
});
const mockPodFind = jest.fn();
jest.mock('../../../models/Pod', () => ({ find: (...args) => mockPodFind(...args) }));
const mockList = jest.fn(async (input) => ({ items: [], nextCursor: null, total: 0, limit: 50, input }));
jest.mock('../../../services/artifactService', () => ({
  ARTIFACT_KINDS: ['image', 'page', 'doc'],
  listArtifacts: (...args) => mockList(...args),
}));

const routes = require('../../../routes/artifacts');

describe('GET /api/artifacts (dualAuth, two scope resolvers)', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use('/api/artifacts', routes);
    mockList.mockClear();
    mockPodFind.mockReset();
    mockPodFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'pod-x' }, { _id: 'pod-y' }] }) });
  });

  it('resolves a human scope from pod membership, never from admin bypass', async () => {
    const res = await request(app).get('/api/artifacts?kind=page&q=plan&limit=7').set('Authorization', 'Bearer human-u1').expect(200);
    expect(mockPodFind).toHaveBeenCalledWith({ members: 'u1' });
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scopePodIds: ['pod-x', 'pod-y'], kind: 'page', q: 'plan', limit: '7', podId: null }));
    expect(res.body.items).toEqual([]);
  });

  it('resolves an agent scope from its active installations without touching Pod', async () => {
    await request(app).get('/api/artifacts?podId=pod-a').set('Authorization', 'Bearer cm_agent_abc').expect(200);
    expect(mockPodFind).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scopePodIds: ['pod-a', 'pod-b'], podId: 'pod-a' }));
  });

  it('refuses a fixed podId outside the scope with 403 and an unknown kind with 400', async () => {
    await request(app).get('/api/artifacts?podId=pod-z').set('Authorization', 'Bearer human-u1').expect(403);
    await request(app).get('/api/artifacts?kind=video').set('Authorization', 'Bearer human-u1').expect(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('requires a credential', async () => {
    await request(app).get('/api/artifacts').expect(401);
  });
});

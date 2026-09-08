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
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({ find: (...args) => mockPodFind(...args), findById: (...args) => mockPodFindById(...args) }));
const mockCanView = jest.fn(async () => false);
jest.mock('../../../services/dmService', () => ({ canViewPod: (...args) => mockCanView(...args) }));
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
    mockPodFindById.mockReset();
    mockPodFindById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: '64b7f0c2e4b0a1a2b3c4d5e6', type: 'agent-dm', members: [] }) }) });
    mockCanView.mockReset();
    mockCanView.mockResolvedValue(false);
  });

  it('a named pod outside membership still reads when canViewPod says yes (admin / agent-dm fan-out), scoped to that pod', async () => {
    mockCanView.mockResolvedValue(true);
    await request(app).get('/api/artifacts?podId=64b7f0c2e4b0a1a2b3c4d5e6').set('Authorization', 'Bearer human-u1').expect(200);
    expect(mockCanView).toHaveBeenCalledWith('u1', expect.objectContaining({ _id: '64b7f0c2e4b0a1a2b3c4d5e6' }));
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scopePodIds: ['64b7f0c2e4b0a1a2b3c4d5e6'], podId: '64b7f0c2e4b0a1a2b3c4d5e6' }));
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

  it('an agent never widens through canViewPod: an out-of-scope podId is 403 even where membership would grant (sprint-review 66465)', async () => {
    mockCanView.mockResolvedValue(true);
    await request(app).get('/api/artifacts?podId=pod-z').set('Authorization', 'Bearer cm_agent_abc').expect(403);
    expect(mockPodFindById).not.toHaveBeenCalled();
    expect(mockCanView).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a malformed podId outside the scope is 403, never a CastError 500', async () => {
    await request(app).get('/api/artifacts?podId=not-an-object-id').set('Authorization', 'Bearer human-u1').expect(403);
    expect(mockPodFindById).not.toHaveBeenCalled();
  });

  it('refuses a fixed podId outside the scope with 403 and an unknown kind with 400', async () => {
    await request(app).get('/api/artifacts?podId=64b7f0c2e4b0a1a2b3c4d5e6').set('Authorization', 'Bearer human-u1').expect(403);
    await request(app).get('/api/artifacts?kind=video').set('Authorization', 'Bearer human-u1').expect(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('requires a credential', async () => {
    await request(app).get('/api/artifacts').expect(401);
  });
});

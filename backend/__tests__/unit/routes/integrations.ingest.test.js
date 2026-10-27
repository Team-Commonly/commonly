const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../models/Integration', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../../../integrations', () => ({
  get: jest.fn(() => ({ ingestEvent: jest.fn().mockResolvedValue([]) })),
}));

jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));

const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const integrationRoutes = require('../../../routes/integrations');

describe('integration ingest route', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'user' });
    Pod.findById.mockResolvedValue(null);
  });

  it('ingests normalized messages into the buffer', async () => {
    Integration.findById.mockReturnValue({
      lean: () => ({
        _id: 'integration-1',
        type: 'slack',
        createdBy: 'user-1',
        config: { maxBufferSize: 200 },
      }),
    });

    const res = await request(app)
      .post('/api/integrations/ingest')
      .send({
        provider: 'slack',
        integrationId: 'integration-1',
        messages: [
          {
            externalId: 'm1',
            authorId: 'u1',
            authorName: 'Alice',
            content: 'Hello',
            timestamp: new Date().toISOString(),
            attachments: [],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'integration-1',
      expect.objectContaining({
        $push: {
          'config.messageBuffer': expect.objectContaining({
            $each: expect.any(Array),
            $slice: -200,
          }),
        },
      }),
    );
  });

  it('returns 404 when integration is missing', async () => {
    Integration.findById.mockReturnValue({
      lean: () => null,
    });

    const res = await request(app)
      .post('/api/integrations/ingest')
      .send({
        provider: 'slack',
        integrationId: 'missing',
        event: { type: 'message' },
      });

    expect(res.status).toBe(404);
  });

  it('rejects mismatched provider', async () => {
    Integration.findById.mockReturnValue({
      lean: () => ({
        _id: 'integration-1',
        type: 'slack',
        createdBy: 'user-1',
        config: {},
      }),
    });

    const res = await request(app)
      .post('/api/integrations/ingest')
      .send({
        provider: 'telegram',
        integrationId: 'integration-1',
        event: { type: 'message' },
      });

    expect(res.status).toBe(400);
  });

  // The session path is gated like the ingest-token mint: the integration's
  // creator, the pod's creator while still a member, or an admin.
  it('refuses a signed-in caller who could not mint an ingest token, and writes nothing', async () => {
    Integration.findById.mockReturnValue({
      lean: () => ({
        _id: 'integration-1',
        type: 'slack',
        createdBy: 'someone-else',
        podId: 'pod-1',
        config: {},
      }),
    });
    Pod.findById.mockResolvedValue({ createdBy: 'someone-else', members: ['someone-else', 'user-1'] });

    const res = await request(app)
      .post('/api/integrations/ingest')
      .send({
        provider: 'slack',
        integrationId: 'integration-1',
        messages: [{
          externalId: 'm1', authorId: 'u1', authorName: 'Mallory', content: 'hi', timestamp: new Date().toISOString(), 
        }],
      });

    expect(res.status).toBe(403);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin session ingest into an integration it did not create', async () => {
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'admin' });
    Integration.findById.mockReturnValue({
      lean: () => ({
        _id: 'integration-1', type: 'slack', createdBy: 'someone-else', config: {}, 
      }),
    });

    const res = await request(app)
      .post('/api/integrations/ingest')
      .send({
        provider: 'slack',
        integrationId: 'integration-1',
        messages: [{
          externalId: 'm1', authorId: 'u1', authorName: 'Ops', content: 'hi', timestamp: new Date().toISOString(), 
        }],
      });

    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });
});

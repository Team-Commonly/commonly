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

const Integration = require('../../../models/Integration');
const integrationRoutes = require('../../../routes/integrations');

describe('integration ingest route', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ingests normalized messages into the buffer', async () => {
    Integration.findById.mockReturnValue({
      lean: () => ({
        _id: 'integration-1',
        type: 'slack',
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
});

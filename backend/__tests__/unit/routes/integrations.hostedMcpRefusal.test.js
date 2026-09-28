const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});
jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  initialize: jest.fn().mockResolvedValue(true),
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  fetchMessages: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
})));
jest.mock('../../../models/Integration', () => {
  function Integration(data) {
    Object.assign(this, data);
    this._id = data._id || 'integration-1';
    this.save = jest.fn().mockResolvedValue(this);
  }
  Integration.findById = jest.fn();
  Integration.findOne = jest.fn();
  Integration.findByIdAndUpdate = jest.fn();
  Integration.aggregate = jest.fn().mockResolvedValue([]);
  return Integration;
});

const Pod = require('../../../models/Pod');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

// TASK-172: a `hosted-mcp` row may only be written by the entry's OAuth
// callback, so `createdBy` is the person who consented and `config.entryId` is
// fixed by the server. The generic POST refuses the type BY NAME (scope §2).
//
// The refusal has a twin it must be distinguishable from: the manifest lookup
// a few lines below answers 400 for ANY type it does not know, and removing the
// named refusal does not change that status — it changes only the message. So
// the assertion is on the message, and the control below runs the twin so a
// message assertion that matched everything would fail.
describe('POST /api/integrations — hosted-mcp is refused by name', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockResolvedValue({ _id: 'pod-1', members: [{ toString: () => 'user-1' }] });
  });

  const post = (type) => request(app)
    .post('/api/integrations')
    .send({ podId: '64b64c7f8a9e2f0012345678', type, config: { entryId: 'linear' } });

  it('refuses the type and names the flow that can create one', async () => {
    const res = await post('hosted-mcp');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('hosted-mcp');
    expect(res.body.message).toContain('/api/integrations/connect/hosted-mcp/:entryId/start');
    // The refusal is unconditional: a body that supplies the record's own keys
    // is refused for the same reason, not admitted because it looks complete.
    const supplied = await request(app)
      .post('/api/integrations')
      .send({
        podId: '64b64c7f8a9e2f0012345678',
        type: 'hosted-mcp',
        config: { entryId: 'linear', grantedScope: 'read openid', credentialRef: 'forged' },
      });
    expect(supplied.status).toBe(400);
    expect(supplied.body.message).toContain('/api/integrations/connect/hosted-mcp/:entryId/start');
  });

  it('positive control: an unknown type is refused by the manifest lookup, with its own message', async () => {
    const res = await post('not-a-connector-type');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unsupported integration type');
    expect(res.body.message).not.toContain('/api/integrations/connect/hosted-mcp');
  });
});

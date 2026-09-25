/**
 * `/agent-dm` must not resolve a person's row as an agent (TASK-133 b, wren
 * 73994).
 *
 * The route's existence probe matched the derived username with no `isBot`
 * term, and `getOrCreateAgentUser` runs AFTER it and BEFORE the §3.7 co-pod
 * check — so the probe was the only thing standing between an arbitrary agent
 * token and a person's row. The derived name is plain lowercase, so plenty of
 * real handles match it (`openclaw`, `codex`, …). A miss is a 404, mirroring
 * the legacy `/room` probe which carries the same term for the same reason.
 *
 * The mock below is faithful to the query it is handed rather than returning a
 * fixed value, so the second assertion can show the term is what excludes the
 * row — an inert mock would make the 404 mean nothing.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1', username: 'caller-agent', botMetadata: { agentName: 'caller' } };
  req.agentAuthorizedPodIds = [];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));

const probeQueries = [];
const PERSON_ROW = {
  _id: 'person-1',
  username: 'claude-code',
  isBot: false,
  botMetadata: {},
};

jest.mock('../../../models/User', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  findById: jest.fn(),
  findOne: jest.fn((query) => {
    probeQueries.push(query);
    const candidate = [PERSON_ROW].find((row) => {
      const flagOk = query.isBot === undefined ? true : row.isBot === query.isBot;
      const usernameOk = !query.$or
        || query.$or.some((branch) => branch.username && branch.username === row.username);
      return flagOk && usernameOk;
    });
    return { select: () => ({ lean: async () => candidate || null }) };
  }),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: ['agent-room', 'agent-dm'],
  buildAgentUsername: jest.fn((a, b) => (b && b !== 'default' ? `${a}-${b}` : a)),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  resolveAgentDisplayLabel: jest.fn(() => 'Agent'),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');
const User = require('../../../models/User');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

describe('/agent-dm target probe', () => {
  beforeEach(() => {
    probeQueries.length = 0;
  });

  it('404s for a person holding the derived name, and the isBot term is what excludes them', async () => {
    const res = await request(app)
      .post('/api/agents/runtime/agent-dm')
      .send({ target: { agentName: 'claude-code' } });

    expect(res.status).toBe(404);

    const probe = probeQueries[probeQueries.length - 1];
    expect(probe.isBot).toBe(true);

    // Counterfactual, same faithful mock: drop the term and that row comes back.
    // So the 404 above is the term doing the work, not an empty fixture.
    const withoutTerm = await User.findOne({ $or: [{ username: 'claude-code' }] })
      .select('_id isBot')
      .lean();
    expect(withoutTerm).toMatchObject({ _id: 'person-1', isBot: false });
  });
});

/**
 * TASK-099 site 9 — `maxContextTokens: 0` means UNCAPPED to PodContextService,
 * so it must not also be a failure value.
 *
 * These close a gap @sprint-review found by mutation on #1519: the new 400 and
 * the new `contextBudget` field shipped with no test, so deleting either left
 * the suite fully green. That is exactly the defect the PR is about — a
 * fallback nobody can observe — one level up, in the coverage rather than the
 * code. Each case below pairs the failure with the success value it collided
 * with, the same shape as the service tests.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallations = [{ podId: 'pod-1', status: 'active', agentName: 'a', instanceId: 'i' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((a) => a),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'agent-user-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/agentMessageService', () => ({ getRecentMessages: jest.fn() }));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({
  getPodContext: jest.fn().mockResolvedValue({ _status: 'success', stats: {} }),
}));
jest.mock('../../../services/globalModelConfigService', () => ({ getConfig: jest.fn() }));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));

const express = require('express');
const request = require('supertest');
const GlobalModelConfigService = require('../../../services/globalModelConfigService');
const PodContextService = require('../../../services/podContextService');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

const get = (qs = '') => request(app).get(`/api/agents/runtime/pods/pod-1/context${qs}`);
const budgetPassedToService = () => PodContextService.getPodContext.mock.calls[0][0].maxContextTokens;

describe('GET /pods/:podId/context — the context budget (TASK-099 site 9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PodContextService.getPodContext.mockResolvedValue({ _status: 'success', stats: {} });
  });

  it('a malformed maxContextTokens is a 400, not a silent uncap', async () => {
    // parseLimit's NaN fallback is 0, and 0 means UNCAPPED downstream — so the
    // pre-fix behaviour was to honour a typo by removing the budget entirely.
    const res = await get('?maxContextTokens=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxContextTokens/);
    expect(PodContextService.getPodContext).not.toHaveBeenCalled();
  });

  it('a well-formed maxContextTokens is honoured and attributed to the query', async () => {
    const res = await get('?maxContextTokens=8000');
    expect(res.status).toBe(200);
    expect(budgetPassedToService()).toBe(8000);
    expect(res.body.contextBudget).toEqual({ applied: true, source: 'query' });
  });

  it('a configured contextLimit reserves 25% and says so', async () => {
    GlobalModelConfigService.getConfig.mockResolvedValue({ llmService: { contextLimit: 100000 } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(budgetPassedToService()).toBe(75000);
    expect(res.body.contextBudget).toEqual({ applied: true, source: 'model-config' });
  });

  it('an UNCONFIGURED contextLimit is uncapped and named as unconfigured', async () => {
    GlobalModelConfigService.getConfig.mockResolvedValue({ llmService: {} });
    const res = await get();
    expect(budgetPassedToService()).toBe(0);
    expect(res.body.contextBudget).toEqual({ applied: false, source: 'unconfigured' });
  });

  it('a config-store OUTAGE is uncapped too, and is distinguishable from unconfigured', async () => {
    // Both send `maxContextTokens: 0`, which is the whole problem: the response
    // field is the only thing that can tell an operator which one happened.
    GlobalModelConfigService.getConfig.mockRejectedValue(new Error('mongo down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await get();
    expect(budgetPassedToService()).toBe(0);
    expect(res.body.contextBudget).toEqual({ applied: false, source: 'config-unavailable' });
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

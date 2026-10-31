/**
 * TASK-015 — an inline webhook reply must actually post, and a failed post
 * must not be recorded as posted.
 *
 * The old path called agentMessageService.postAgentMessage, which does not
 * exist, so the TypeError was swallowed and the event still settled as
 * `posted`. These tests drive the real deliverEventViaWebhook (through the
 * static seam), with only the network and persistence edges mocked.
 */

jest.mock('../../../models/AgentEvent', () => ({
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../services/outboundUrlGuard', () => ({
  postToPublicAddress: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn(),
}));

jest.mock('../../../services/agentMentionService', () => ({
  enqueueMentions: jest.fn().mockResolvedValue(undefined),
  enqueueDmEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../services/agentSendFreshness', () => ({
  unseenMessages: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));

jest.mock('../../../models/Integration', () => ({}));
jest.mock('../../../models/Gateway', () => ({ findById: jest.fn() }));
jest.mock('../../../services/agentDigestFoldService', () => ({
  foldExpiredDigests: jest.fn().mockResolvedValue(0),
  readFoldedDigest: jest.fn().mockResolvedValue(null),
  settleFoldedDigest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(),
}));

const AgentEvent = require('../../../models/AgentEvent');
const { postToPublicAddress } = require('../../../services/outboundUrlGuard');
const AgentMessageService = require('../../../services/agentMessageService');
const AgentMentionService = require('../../../services/agentMentionService');
const AgentSendFreshness = require('../../../services/agentSendFreshness');
const PodModel = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const AgentEventService = require('../../../services/agentEventService');

const installation = {
  displayName: 'Echo',
  config: { runtime: { webhookUrl: 'https://agent.example.com/hook' } },
};

const event = {
  _id: 'evt_inline_001',
  type: 'chat.mention',
  podId: 'pod_inline',
  agentName: 'echo-agent',
  instanceId: 'default',
  createdAt: new Date().toISOString(),
  payload: {},
};

const agentUser = { _id: 'user_echo', username: 'echo-agent' };

const respondWith = (body) => postToPublicAddress.mockResolvedValue({
  ok: true,
  status: 200,
  text: JSON.stringify(body),
});

const recordedDelivery = () => {
  const call = AgentEvent.findByIdAndUpdate.mock.calls.at(-1);
  return call[1].delivery;
};

beforeEach(() => {
  jest.clearAllMocks();
  AgentEventService.attachLegacyDigest = jest.fn().mockResolvedValue(undefined);
  AgentEventService.settleLegacyDigest = jest.fn().mockResolvedValue(undefined);
  AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
  AgentSendFreshness.unseenMessages.mockResolvedValue(null);
  PodModel.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ type: 'team' }) }),
  });
  AgentMessageService.postMessage.mockResolvedValue({
    success: true,
    message: { _id: 'msg_1', content: 'hi' },
  });
});

describe('webhook inline reply (TASK-015)', () => {
  test('posted reply goes through postMessage and is recorded as posted', async () => {
    respondWith({ outcome: 'posted', content: 'hi there' });

    await AgentEventService.deliverEventViaWebhook(installation, event);

    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'echo-agent',
      podId: 'pod_inline',
      content: 'hi there',
      installationConfig: installation.config,
    }));
    expect(recordedDelivery()).toEqual(expect.objectContaining({ outcome: 'posted' }));
  });

  test('a mention-enqueue runs for the posted reply, as on the CAP route', async () => {
    respondWith({ outcome: 'posted', content: 'hi there' });

    await AgentEventService.deliverEventViaWebhook(installation, event);
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod_inline',
      userId: 'user_echo',
    }));
  });

  test('a post that throws is recorded as error, never as posted', async () => {
    AgentMessageService.postMessage.mockRejectedValue(new Error('db down'));
    respondWith({ outcome: 'posted', content: 'hi there' });

    await AgentEventService.deliverEventViaWebhook(installation, event);

    expect(recordedDelivery()).toEqual(expect.objectContaining({
      outcome: 'error',
      reason: 'inline_post_failed',
    }));
  });

  test('a reply held by the freshness gate is recorded as skipped, not posted', async () => {
    AgentSendFreshness.unseenMessages.mockResolvedValue({ code: 'UNSEEN_MESSAGES' });
    respondWith({ outcome: 'posted', content: 'hi there' });

    await AgentEventService.deliverEventViaWebhook(installation, event);

    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(recordedDelivery()).toEqual(expect.objectContaining({
      outcome: 'skipped',
      reason: 'unseen_messages',
    }));
  });

  test('a non-posted outcome never calls postMessage', async () => {
    respondWith({ outcome: 'no_action', reason: 'nothing_to_add' });

    await AgentEventService.deliverEventViaWebhook(installation, event);

    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(recordedDelivery()).toEqual(expect.objectContaining({ outcome: 'no_action' }));
  });
});

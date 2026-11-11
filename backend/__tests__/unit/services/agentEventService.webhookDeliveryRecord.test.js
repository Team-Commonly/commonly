/**
 * A push webhook's status is measured: each delivery records whether the
 * endpoint answered, keyed to the URL it went to, and never stores the URL or
 * the transport error text. Drives the real deliverEventViaWebhook with only
 * the network and persistence edges mocked.
 */

jest.mock('../../../models/AgentEvent', () => ({
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/outboundUrlGuard', () => ({
  postToPublicAddress: jest.fn(),
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() },
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
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEventService = require('../../../services/agentEventService');
const { webhookUrlHash } = require('../../../services/agentStateService');

const URL = 'https://user:secret@agent.example.com/hook?token=abc';
const installation = {
  _id: 'inst_1',
  agentName: 'echo-agent',
  config: { runtime: { webhookUrl: URL } },
};
const event = {
  _id: 'evt_1', type: 'chat.mention', podId: 'pod_1', agentName: 'echo-agent', instanceId: 'default', payload: {},
};

const sets = () => AgentInstallation.updateOne.mock.calls.map(([filter, update]) => ({ filter, update }));
const named = (name) => Object.assign(new Error('boom https://user:secret@agent.example.com'), { name });

beforeEach(() => {
  jest.clearAllMocks();
  AgentEventService.attachLegacyDigest = jest.fn().mockResolvedValue(undefined);
  AgentEventService.settleLegacyDigest = jest.fn().mockResolvedValue(undefined);
  AgentInstallation.updateOne.mockResolvedValue({ matchedCount: 1 });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe('webhook delivery outcome', () => {
  test('an endpoint that answers 2xx is recorded as answered, against the URL hash', async () => {
    postToPublicAddress.mockResolvedValue({ ok: true, status: 200, text: '{}' });
    await AgentEventService.deliverEventViaWebhook(installation, event);
    const [{ filter, update }] = sets();
    expect(filter).toEqual({ _id: 'inst_1', 'webhookDelivery.urlHash': webhookUrlHash(URL) });
    expect(Object.keys(update.$set).sort()).toEqual(['webhookDelivery.lastAttemptAt', 'webhookDelivery.lastOkAt']);
  });

  test('a non-2xx answer is a failure with its HTTP status', async () => {
    postToPublicAddress.mockResolvedValue({ ok: false, status: 502, text: '' });
    await AgentEventService.deliverEventViaWebhook(installation, event);
    const [{ update }] = sets();
    expect(update.$set).toMatchObject({ 'webhookDelivery.lastFailure': 'http', 'webhookDelivery.lastFailureStatus': 502 });
    expect(update.$set['webhookDelivery.lastFailedAt']).toBeInstanceOf(Date);
    expect(update.$set['webhookDelivery.lastOkAt']).toBeUndefined();
    expect(AgentEvent.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test.each([
    ['AbortError', undefined, 'timeout'],
    ['OutboundUrlRefusedError', 'refused', 'refused'],
    // A lapsed domain or tunnel can't be reached; Commonly isn't refusing it.
    ['OutboundUrlRefusedError', 'unresolved', 'network'],
    // A redirect loop is the endpoint's own answer.
    ['OutboundUrlRefusedError', 'redirects', 'http'],
    ['TypeError', undefined, 'network'],
  ])('a thrown %s (%s) is recorded as %s, with no status and no error text', async (name, kind, failure) => {
    postToPublicAddress.mockRejectedValue(Object.assign(named(name), kind ? { kind } : {}));
    await AgentEventService.deliverEventViaWebhook(installation, event);
    const [{ update }] = sets();
    expect(update.$set['webhookDelivery.lastFailure']).toBe(failure);
    expect(update.$unset).toEqual({ 'webhookDelivery.lastFailureStatus': 1 });
    const stored = JSON.stringify(sets());
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('agent.example.com');
  });

  test('a 2xx whose body passed the cap still answered; a non-2xx one did not', async () => {
    const tooLarge = (status) => Object.assign(new Error('response body exceeds 1 bytes'), { code: 'RESPONSE_TOO_LARGE', status });
    postToPublicAddress.mockRejectedValueOnce(tooLarge(200));
    await AgentEventService.deliverEventViaWebhook(installation, event);
    expect(sets()[0].update.$set['webhookDelivery.lastOkAt']).toBeInstanceOf(Date);
    AgentInstallation.updateOne.mockClear();
    postToPublicAddress.mockRejectedValueOnce(tooLarge(500));
    await AgentEventService.deliverEventViaWebhook(installation, event);
    expect(sets()[0].update.$set['webhookDelivery.lastFailure']).toBe('network');
  });

  test('a failure on our side after the endpoint answered is not recorded as the endpoint failing', async () => {
    postToPublicAddress.mockResolvedValue({ ok: true, status: 200, text: '{}' });
    AgentEvent.findByIdAndUpdate.mockRejectedValueOnce(new Error('mongo down'));
    await AgentEventService.deliverEventViaWebhook(installation, event);
    expect(sets()).toHaveLength(1);
    expect(sets()[0].update.$set['webhookDelivery.lastOkAt']).toBeInstanceOf(Date);
  });

  test('the first outcome for a new URL replaces the old URL\'s record whole', async () => {
    AgentInstallation.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    postToPublicAddress.mockResolvedValue({ ok: false, status: 500, text: '' });
    await AgentEventService.deliverEventViaWebhook(installation, event);
    const [, second] = sets();
    expect(second.filter).toEqual({ _id: 'inst_1' });
    expect(second.update.$set.webhookDelivery).toEqual(expect.objectContaining({
      urlHash: webhookUrlHash(URL), lastFailure: 'http', lastFailureStatus: 500,
    }));
    expect(second.update.$set.webhookDelivery.lastOkAt).toBeUndefined();
  });

  test('a failed record write never breaks delivery', async () => {
    AgentInstallation.updateOne.mockRejectedValue(new Error('write refused'));
    postToPublicAddress.mockResolvedValue({ ok: true, status: 200, text: '{}' });
    await expect(AgentEventService.deliverEventViaWebhook(installation, event)).resolves.toBeUndefined();
    expect(AgentEvent.findByIdAndUpdate).toHaveBeenCalled();
  });
});

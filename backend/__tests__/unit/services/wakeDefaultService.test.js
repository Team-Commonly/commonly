/**
 * What a new install of a person's own agent wakes on.
 *
 * ADR-018 D8.1 (2026-10-21) made every agent a person brings wake on each
 * human message. F669 (2026-11-26) narrows that: in a pod
 * with other people it wakes on mentions only, because each wake runs on the
 * owner's own Claude or Codex account. Where the owner is the only person, and
 * in the owner's direct message, it still wakes on every message. The Bring
 * your own page and `commonly agent attach` follow the same rule, and every new
 * install gets a digest wake once a day.
 */
jest.mock('../../../models/User', () => ({ exists: jest.fn() }));

const User = require('../../../models/User');
const {
  personAgentWakeDefault, isPersonBroughtAgent, podHasOtherHumans, personAgentInstallDefaults,
} = require('../../../services/wakeDefaultService');

const NOW = new Date('2026-11-26T09:00:00Z');
const OWN_AGENT = { runtime: { runtimeType: 'webhook', host: 'byo' } };
const ON_COMPUTER = { runtime: { runtimeType: 'wrapper' } };
// What `commonly agent attach` sends (cli performAttach): the CLI's own runtime
// type, the adapter, and host 'byo'.
const ATTACHED = { runtime: { runtimeType: 'claude-code', adapter: 'claude', host: 'byo' } };
const ATTACHED_CODEX = { runtime: { runtimeType: 'codex', adapter: 'codex', host: 'byo' } };

const SHARED_POD = { type: 'chat', otherHumans: true };
const OWNER_ONLY_POD = { type: 'chat', otherHumans: false };
const DIRECT_MESSAGE = { type: 'agent-room', otherHumans: false };

describe('the default wake for a new install of a person\'s own agent', () => {
  test('in a pod with other people it wakes on mentions only', () => {
    expect(personAgentWakeDefault(OWN_AGENT, SHARED_POD, NOW)).toEqual({
      wakeOnMessage: { enabled: false, reason: 'person-agent-shared-pod', defaultedAt: NOW.toISOString() },
      boardWake: { enabled: false },
      digestWake: { afterMinutes: 1440 },
    });
  });

  test('in a pod where the owner is the only person it wakes on every human message', () => {
    expect(personAgentWakeDefault(OWN_AGENT, OWNER_ONLY_POD, NOW)).toEqual({
      wakeOnMessage: {
        enabled: true, humanOnly: true, reason: 'person-agent-default', defaultedAt: NOW.toISOString(),
      },
      boardWake: { enabled: false },
      digestWake: { afterMinutes: 1440 },
    });
  });

  test('in the owner\'s direct message it wakes on every human message', () => {
    expect(personAgentWakeDefault(OWN_AGENT, DIRECT_MESSAGE, NOW).wakeOnMessage)
      .toEqual(expect.objectContaining({ enabled: true, humanOnly: true }));
  });

  test('the Bring your own page and agent attach get the same answer in every kind of pod', () => {
    for (const pod of [SHARED_POD, OWNER_ONLY_POD, DIRECT_MESSAGE]) {
      const page = personAgentWakeDefault(OWN_AGENT, pod, NOW);
      expect(personAgentWakeDefault(ON_COMPUTER, pod, NOW)).toEqual(page);
      expect(personAgentWakeDefault(ATTACHED, pod, NOW)).toEqual(page);
      expect(personAgentWakeDefault(ATTACHED_CODEX, pod, NOW)).toEqual(page);
    }
  });

  test('every new install gets a digest wake once a day, unless the request set one', () => {
    expect(personAgentWakeDefault(ATTACHED, SHARED_POD, NOW).digestWake).toEqual({ afterMinutes: 1440 });
    expect(personAgentWakeDefault({ ...ATTACHED, digestWake: { afterMinutes: 120 } }, SHARED_POD, NOW))
      .not.toHaveProperty('digestWake');
  });

  test('an explicit wakeOnMessage in the request wins, either way, and still gets the daily digest', () => {
    for (const wakeOnMessage of [{ enabled: false }, { enabled: true }]) {
      expect(personAgentWakeDefault({ ...ATTACHED, wakeOnMessage }, OWNER_ONLY_POD, NOW))
        .toEqual({ digestWake: { afterMinutes: 1440 } });
    }
  });

  test('an explicit boardWake in the request is left alone', () => {
    const patch = personAgentWakeDefault({ ...OWN_AGENT, boardWake: { enabled: true } }, SHARED_POD, NOW);
    expect(patch.wakeOnMessage.enabled).toBe(false);
    expect(patch).not.toHaveProperty('boardWake');
  });

  test('hosted agents, first-party apps and push webhooks are untouched', () => {
    for (const runtime of [
      { runtimeType: 'hosted' },
      { runtimeType: 'hosted', host: 'cloud' },
      { runtimeType: 'native' },
      { runtimeType: 'claude-code' },
      { runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://example.test/hook' },
      { runtimeType: 'webhook' },
    ]) {
      expect(personAgentWakeDefault({ runtime }, SHARED_POD, NOW)).toBeNull();
    }
  });

  test('a runtime only Commonly runs gets no default, even labelled host byo', () => {
    for (const runtimeType of ['hosted', 'native', 'internal', 'moltbot', 'managed-agents']) {
      expect(personAgentWakeDefault({ runtime: { runtimeType, host: 'byo' } }, SHARED_POD, NOW)).toBeNull();
    }
    // Codex is a cloud runtime only without host byo; attach's codex keeps the default.
    expect(personAgentWakeDefault(ATTACHED_CODEX, SHARED_POD, NOW)).not.toBeNull();
  });

  test('isPersonBroughtAgent reads the normalized runtime block', () => {
    expect(isPersonBroughtAgent({ runtime: { runtimeType: ' Wrapper ' } })).toBe(true);
    expect(isPersonBroughtAgent(ATTACHED)).toBe(true);
    expect(isPersonBroughtAgent({})).toBe(false);
  });
});

describe('whether a pod has people other than the owner', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a pod whose only member is the owner has none, with no lookup', async () => {
    expect(await podHasOtherHumans({ members: ['owner'] }, 'owner')).toBe(false);
    expect(User.exists).not.toHaveBeenCalled();
  });

  test('other members count only when one of them is a person', async () => {
    User.exists.mockResolvedValueOnce(null);
    expect(await podHasOtherHumans({ members: ['owner', 'bot-1'] }, 'owner')).toBe(false);
    expect(User.exists).toHaveBeenCalledWith({ _id: { $in: ['bot-1'] }, isBot: { $ne: true } });
    User.exists.mockResolvedValueOnce({ _id: 'friend' });
    expect(await podHasOtherHumans({ members: ['owner', 'friend'] }, 'owner')).toBe(true);
  });

  test('a lookup that fails reads as shared, so the default is the cheaper one', async () => {
    User.exists.mockRejectedValueOnce(new Error('down'));
    expect(await podHasOtherHumans({ members: ['owner', 'someone'] }, 'owner')).toBe(true);
  });

  test('personAgentInstallDefaults looks at the pod only for a person\'s own agent', async () => {
    User.exists.mockResolvedValueOnce({ _id: 'friend' });
    const pod = { type: 'chat', members: ['owner', 'friend'] };
    expect((await personAgentInstallDefaults(ATTACHED, pod, 'owner', NOW)).wakeOnMessage.enabled).toBe(false);
    expect(await personAgentInstallDefaults({ runtime: { runtimeType: 'native' } }, pod, 'owner', NOW)).toBeNull();
    expect(User.exists).toHaveBeenCalledTimes(1);
  });
});

/**
 * Native turns can carry the pod's recent messages inline (manifest
 * `recentMessages`). Without it a turn is [system, user] only, and a follow-up
 * like "which CLI?" reached Scout with no memory of the question it answered
 * (2026-10-14).
 *
 * Contract under test:
 *  - opted in: the user message sent to the model opens with the last N prior
 *    messages, oldest first, with the message being answered left out
 *  - not opted in: no fetch, and the user message is unchanged
 *  - a failed fetch never fails the turn
 *  - one long message cannot crowd out the rest
 *  - the manifest field projects onto the install, and Scout opts in
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
}));

jest.mock('../../../models/AgentRun', () => ({ create: jest.fn() }));

jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));

jest.mock('../../../services/messageClaimHandoffService', () => ({
  release: jest.fn().mockResolvedValue({ released: true }),
}));

jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));

jest.mock('../../../models/Message', () => ({ find: jest.fn() }));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const PgMessage = require('../../../models/pg/Message');
const MongoMessage = require('../../../models/Message');
const {
  runAgent, RECENT_MESSAGE_CHARS, RECENT_MESSAGES_MAX,
} = require('../../../services/nativeRuntimeService');
const { buildInstallationConfig } = require('../../../scripts/seed-native-agents');
const { scoutApp } = require('../../../config/native-agents/scout');

const row = (id, username, content) => ({ id, content, userId: { username } });

const installationWith = (extra = {}) => ({
  podId: 'pod-1',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  config: {
    runtime: { runtimeType: 'native' },
    systemPrompt: 'help',
    model: 'test/model',
    tools: [],
    ...extra,
  },
});

const trigger = {
  type: 'chat.mention',
  eventId: 'evt-1',
  payload: { messageId: 'm4', content: 'claude code' },
};

const sentUserMessage = () => {
  const body = axios.post.mock.calls[0][1];
  return body.messages.find((m) => m.role === 'user').content;
};

describe('native runtime: recent pod messages inline (recentMessages)', () => {
  const previousEnv = {
    baseUrl: process.env.LITELLM_BASE_URL, masterKey: process.env.LITELLM_MASTER_KEY, pgHost: process.env.PG_HOST,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The pod-message read follows PG_HOST; the unit setup unsets it.
    process.env.PG_HOST = 'pg.test';
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined),
    }));
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      headers: {},
    });
  });

  afterAll(() => {
    if (previousEnv.baseUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = previousEnv.baseUrl;
    if (previousEnv.masterKey === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = previousEnv.masterKey;
    if (previousEnv.pgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = previousEnv.pgHost;
  });

  test('an opted-in turn opens with the prior messages, oldest first, and leaves out the one it answers', async () => {
    PgMessage.findByPodId.mockResolvedValue([
      row('m1', 'hamza', 'how do I use Commonly with my CLI?'),
      row('m2', 'scout', 'Which CLI do you use?'),
      row('m3', 'hamza', 'one sec'),
      row('m4', 'hamza', 'claude code'),
    ]);
    await runAgent(installationWith({ recentMessages: 3 }), trigger);

    expect(PgMessage.findByPodId).toHaveBeenCalledWith('pod-1', 4, null);
    const sent = sentUserMessage();
    expect(sent.startsWith('Recent messages in this pod, oldest first')).toBe(true);
    const block = sent.split('\n\n')[0];
    expect(block).toContain('- hamza: how do I use Commonly with my CLI?\n- scout: Which CLI do you use?\n- hamza: one sec');
    expect(block).not.toContain('claude code');
  });

  test('a turn that does not opt in fetches nothing and sends the message as before', async () => {
    await runAgent(installationWith(), trigger);
    expect(PgMessage.findByPodId).not.toHaveBeenCalled();
    expect(sentUserMessage()).not.toContain('Recent messages in this pod');
  });

  test('a failed fetch never fails the turn', async () => {
    PgMessage.findByPodId.mockRejectedValue(new Error('pg down'));
    MongoMessage.find.mockImplementation(() => { throw new Error('mongo down'); });
    const result = await runAgent(installationWith({ recentMessages: 3 }), trigger);
    expect(result.status).toBe('succeeded');
    expect(sentUserMessage()).not.toContain('Recent messages in this pod');
  });

  test('one long message is clipped, and the count is capped', async () => {
    PgMessage.findByPodId.mockResolvedValue([row('m1', 'hamza', 'x'.repeat(RECENT_MESSAGE_CHARS + 500)), row('m4', 'hamza', 'claude code')]);
    await runAgent(installationWith({ recentMessages: 999 }), trigger);
    expect(PgMessage.findByPodId).toHaveBeenCalledWith('pod-1', RECENT_MESSAGES_MAX + 1, null);
    const line = sentUserMessage().split('\n').find((l) => l.startsWith('- hamza: x'));
    expect(line.length).toBeLessThanOrEqual('- hamza: '.length + RECENT_MESSAGE_CHARS + 1);
  });

  test('the manifest field projects onto the install, and Scout opts in', () => {
    expect(buildInstallationConfig({ ...scoutApp }).recentMessages).toBe(scoutApp.recentMessages);
    expect(scoutApp.recentMessages).toBeGreaterThan(0);
    const { recentMessages, ...withoutField } = scoutApp;
    expect(buildInstallationConfig(withoutField)).not.toHaveProperty('recentMessages');
  });
});

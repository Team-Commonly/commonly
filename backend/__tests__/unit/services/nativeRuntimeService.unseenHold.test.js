/**
 * F530: a hosted agent gets the read-before-commit hold a connected agent gets.
 * A connected agent's post with unseen pod messages since its last read is held
 * with 409 unseen_messages (#2580, agentSendFreshness). The native runtime
 * posted through AgentMessageService.postMessage directly, so a hosted agent
 * answered over a reply that landed while it was thinking. Anthropic's
 * "Worse Together" study (11-11) names this guard as the best platform fix when
 * each person brings their own agent.
 *
 * A hosted turn has no read cursor: it holds from the point the turn itself
 * read to. A held post is not a failure. The tool result carries the messages
 * it missed, and the model decides again.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Release room' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn() }));
jest.mock('../../../services/agentMentionService', () => ({ enqueueAgentPost: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/agentSendFreshness', () => ({ readStart: jest.fn(), unseenMessages: jest.fn() }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  listHostedInstallationsForUser: jest.fn().mockResolvedValue([]),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const User = require('../../../models/User');
const AgentMessageService = require('../../../services/agentMessageService');
const Freshness = require('../../../services/agentSendFreshness');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const BOT = '507f1f77bcf86cd799439033';
const scout = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message', 'commonly_claim_task'] },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: '@scout which CLI should the new teammate install?' },
};
const REPLY = 'Install the Claude Code CLI; the pod guide has the command.';
const START = { at: new Date('2026-11-14T10:00:00Z'), revision: 40 };
const REREAD = { at: new Date('2026-11-14T10:00:05Z'), revision: 42 };
const missed = {
  code: 'unseen_messages',
  unseenCount: 1,
  messages: [{
    id: '777', author: 'codex', content: 'Already answered: use the Claude Code CLI.', createdAt: new Date(), 
  }],
  message: 'There is 1 unseen message. (connected-agent wording)',
};

const callsTool = (name, args) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});
// One response asking for several calls, in order.
const callsTools = (...calls) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(([name, args], i) => (
          { id: `c${i + 1}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })), 
      }, 
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});
const says = (content) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
});
// What the model was shown on its Nth call.
const sentToModel = (n) => JSON.stringify(axios.post.mock.calls[n][1].messages);

describe('a hosted turn holds a post over messages it has not seen (F530)', () => {
  const savedEnv = { ...process.env };
  let saved;
  beforeEach(() => {
    jest.clearAllMocks();
    // A queued once-value a failed test left behind would feed the next test.
    axios.post.mockReset();
    Freshness.readStart.mockReset();
    Freshness.unseenMessages.mockReset();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    saved = [];
    AgentRun.create.mockImplementation(async (doc) => {
      const run = { _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) };
      saved.push(run);
      return run;
    });
    User.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: BOT }) }) });
    AgentMessageService.postMessage.mockImplementation(async ({ content }) => ({
      success: true, message: { id: 9001, content, userId: { _id: BOT, username: 'scout' } },
    }));
    Freshness.readStart.mockResolvedValueOnce(START).mockResolvedValue(REREAD);
    Freshness.unseenMessages.mockResolvedValue(null);
  });
  afterAll(() => { process.env = savedEnv; });

  test('a post with an unseen reply is held, the model is shown it, and its next post lands', async () => {
    Freshness.unseenMessages.mockResolvedValueOnce(missed).mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Codex has it: the Claude Code CLI.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    // Held from the turn's own start, not from a cursor it never kept.
    expect(Freshness.unseenMessages.mock.calls[0]).toEqual([BOT, POD, expect.objectContaining({ since: START })]);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe('Codex has it: the Claude Code CLI.');
    const shown = sentToModel(1);
    expect(shown).toContain('unseen_messages');
    expect(shown).toContain('Already answered: use the Claude Code CLI.');
    // No continueAnyway here: a hosted agent has no such flag.
    expect(shown).not.toContain('continueAnyway');
    // The messages it was shown count as read: the next check starts after them.
    expect(Freshness.unseenMessages.mock.calls[1][2].since).toEqual(REREAD);
    expect(saved[0].status).toBe('succeeded');
  });

  test('a held post is not a failed turn when the model then declines', async () => {
    Freshness.unseenMessages.mockResolvedValueOnce(missed).mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, { ...ask, type: 'heartbeat', payload: {} });

    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(saved[0].status).toBe('succeeded');
  });

  test('a reply written without the tool is held too, and the model decides again', async () => {
    Freshness.unseenMessages.mockResolvedValueOnce(missed).mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(says(REPLY))
      .mockResolvedValueOnce(says('Codex has it: the Claude Code CLI.'));

    await runAgent(scout, ask);

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(sentToModel(1)).toContain('Already answered: use the Claude Code CLI.');
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe('Codex has it: the Claude Code CLI.');
  });

  test('a task claim is held the same way', async () => {
    Freshness.unseenMessages.mockResolvedValueOnce(missed).mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_claim_task', { taskId: 'N-1' }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    const shown = sentToModel(1);
    expect(shown).toContain('unseen_messages');
    expect(shown).toContain('Already answered: use the Claude Code CLI.');
    const claim = saved[0].turns[0].toolCalls.find((c) => c.name === 'commonly_claim_task');
    expect(claim.error).toBe('unseen_messages');
  });

  test("the turn's own posts are not messages it has to read", async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'One more thing: run it from the repo root.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(2);
    expect(Freshness.unseenMessages.mock.calls[1][2].ignoreIds).toEqual(['9001']);
  });

  test('the guidance says how to end the turn, and where the rest are when only some fit', async () => {
    Freshness.unseenMessages
      .mockResolvedValueOnce({ ...missed, unseenCount: 14 })
      .mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    const shown = sentToModel(1);
    expect(shown).toContain('reply with exactly NO_REPLY');
    expect(shown).toContain('14 new messages came in');
    expect(shown).toContain('the newest 1 are in messages');
    expect(shown).toContain('commonly_read_context');
  });

  // CodeRabbit on #4159: moving the start past messages the hold had no room
  // to show would let the next call through without them.
  test('messages a hold had no room to show still hold the next call', async () => {
    Freshness.unseenMessages
      .mockResolvedValueOnce({ ...missed, unseenCount: 14 })
      .mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Codex has it: the Claude Code CLI.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    const next = Freshness.unseenMessages.mock.calls[1][2];
    expect(next.since).toEqual(START);
    expect(next.ignoreIds).toEqual(['777']);
  });

  test('a message a hold had no room for holds the next post, and the model is shown it', async () => {
    // A pod of 12 messages after the turn's start, the oldest an instruction.
    // The check answers from the boundary and ignored ids it is given, newest
    // first and at most `limit`, as agentSendFreshness does: if the boundary
    // moved past the instruction, no later check could show it.
    const INSTRUCTION = 'Hold off: the install guide moves on Monday.';
    const pod = Array.from({ length: 12 }, (_, i) => ({
      id: String(800 + i),
      revision: START.revision + 1 + i,
      author: 'sam',
      content: i === 0 ? INSTRUCTION : `Note ${i}.`,
      createdAt: new Date(),
    }));
    // After the turn's start, a re-read sees the whole pod.
    Freshness.readStart.mockReset();
    Freshness.readStart.mockResolvedValueOnce(START).mockResolvedValue({ at: new Date(), revision: pod[pod.length - 1].revision });
    Freshness.unseenMessages.mockImplementation(async (_user, _pod, { since, ignoreIds, limit }) => {
      const unseen = pod.filter((m) => m.revision > since.revision && !ignoreIds.includes(m.id));
      if (!unseen.length) return null;
      return { code: 'unseen_messages', unseenCount: unseen.length, messages: unseen.slice().reverse().slice(0, limit) };
    });
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Codex has it: the Claude Code CLI.' }))
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Claude Code CLI, but the guide moves Monday.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    // The transcript is one array the runtime keeps adding to: read the holds in order.
    const holds = axios.post.mock.calls[3][1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    expect(holds[0].unseenCount).toBe(12);
    expect(holds[0].messages).toHaveLength(10);
    expect(holds[0].messages.map(({ content }) => content)).not.toContain(INSTRUCTION);
    expect(holds[1].reason).toBe('unseen_messages');
    expect(holds[1].messages.map(({ content }) => content)).toContain(INSTRUCTION);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe('Claude Code CLI, but the guide moves Monday.');
  });

  test('a second claim in the same response is held with the first, before the model has read the hold', async () => {
    Freshness.unseenMessages.mockResolvedValueOnce(missed).mockResolvedValue(null);
    axios.post
      .mockResolvedValueOnce(callsTools(['commonly_claim_task', { taskId: 'N-1' }], ['commonly_claim_task', { taskId: 'N-2' }]))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    const claims = saved[0].turns[0].toolCalls.filter((c) => c.name === 'commonly_claim_task');
    expect(claims.map((c) => c.error)).toEqual(['unseen_messages', 'unseen_messages']);
    expect(Freshness.unseenMessages).toHaveBeenCalledTimes(1);
  });

  test('a slow call earlier in the response spends the room, so a later post goes through unchecked', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      Freshness.unseenMessages.mockResolvedValue(missed).mockResolvedValueOnce(null);
      AgentMessageService.postMessage.mockImplementationOnce(async ({ content }) => {
        offset = 50000;
        return { success: true, message: { id: 9001, content, userId: { _id: BOT, username: 'scout' } } };
      });
      axios.post
        .mockResolvedValueOnce(callsTools(
          ['commonly_post_message', { content: REPLY }],
          ['commonly_post_message', { content: 'One more thing: run it from the repo root.' }],
        ))
        .mockResolvedValueOnce(says('NO_REPLY'));

      await runAgent(scout, ask);

      expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(2);
      expect(Freshness.unseenMessages).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  test('a hold found only after the reads ran out the room lets the post through', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      Freshness.unseenMessages.mockImplementation(async () => {
        offset = 50000;
        return missed;
      });
      axios.post
        .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
        .mockResolvedValueOnce(says('NO_REPLY'));

      await runAgent(scout, ask);

      expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
      expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe(REPLY);
    } finally {
      clock.mockRestore();
    }
  });

  // A hold costs another model call. Late in the turn the clock cap would end
  // the run before it, so the reply posts rather than becoming a failure line.
  test('late in the turn a post goes through rather than be held into the clock cap', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      Freshness.unseenMessages.mockResolvedValue(missed);
      axios.post
        .mockImplementationOnce(async () => {
          offset = 50000;
          return callsTool('commonly_post_message', { content: REPLY });
        })
        .mockResolvedValueOnce(says('NO_REPLY'));

      await runAgent(scout, ask);

      expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
      expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe(REPLY);
      expect(Freshness.unseenMessages).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("the turn's last allowed step posts without a hold: there is no step after it to reply in", async () => {
    Freshness.unseenMessages.mockResolvedValue(missed);
    for (let i = 0; i < 9; i += 1) axios.post.mockResolvedValueOnce(callsTool('not_a_tool', {}));
    axios.post.mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }));

    await runAgent(scout, ask);

    expect(axios.post).toHaveBeenCalledTimes(10);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(Freshness.unseenMessages).not.toHaveBeenCalled();
  });

  test('when freshness cannot be read, the turn posts as it did before', async () => {
    Freshness.readStart.mockReset().mockRejectedValue(new Error('pg down'));
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: REPLY }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });
});

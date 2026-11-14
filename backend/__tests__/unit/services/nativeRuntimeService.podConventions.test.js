/**
 * F124 (TASK-766): a native turn carries its pod's conventions in the user
 * message, below the owner's system prompt, and only when the pod has some.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockPod = { row: null };
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockImplementation(async () => mockPod.row) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ isBot: false }) }) })),
  find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([{ _id: '507f1f77bcf86cd799439099', username: 'alice' }]) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
  sanitizeAgentContent: jest.fn((text) => text),
}));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439099';
const install = {
  podId: POD,
  agentName: 'helper',
  instanceId: 'default',
  displayName: 'Helper',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'], systemPrompt: 'Owner says: be brief.' },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: 'What is next?' },
};
const says = (content) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
});
const firstCallMessages = () => axios.post.mock.calls[0][1].messages;

describe('pod conventions in a native turn', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    axios.post.mockReset();
    axios.post.mockResolvedValue(says('On it.'));
  });
  afterAll(() => { process.env = savedEnv; });

  test('the user message opens with them, and the system prompt stays the owner\'s', async () => {
    mockPod.row = {
      _id: POD,
      name: 'Build',
      conventionsRevision: 3,
      conventions: { text: 'Reply in a thread. Tag the row owner.', updatedAt: new Date(), updatedBy: OWNER },
    };
    await runAgent(install, ask);
    const [system, user] = firstCallMessages();
    expect(system).toEqual({ role: 'system', content: 'Owner says: be brief.' });
    expect(user.role).toBe('user');
    expect(user.content).toContain('=== Pod conventions');
    expect(user.content).toContain('set by alice; revision 3');
    expect(user.content).toContain('Reply in a thread. Tag the row owner.');
    expect(user.content.indexOf('Pod conventions')).toBeLessThan(user.content.indexOf('What is next?'));
  });

  test('a pod without them adds nothing', async () => {
    mockPod.row = { _id: POD, name: 'Build' };
    await runAgent(install, ask);
    const [, user] = firstCallMessages();
    expect(user.content).not.toContain('Pod conventions');
    expect(user.content).toContain('What is next?');
  });
});

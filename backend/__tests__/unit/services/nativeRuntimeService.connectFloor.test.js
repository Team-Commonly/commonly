/**
 * TASK-417 / ADR-020 — the connect-intent floor. A connect-intent message from
 * a person gets a connect_local_agent card even when Scout's model proposes
 * nothing that turn. The floor only proposes: the owner still approves.
 */
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/ApprovalAction', () => ({ exists: jest.fn() }));
jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: jest.fn(),
  suggestLocalAgentName: jest.fn(),
}));

const User = require('../../../models/User');
const ApprovalAction = require('../../../models/ApprovalAction');
const { proposeAction, suggestLocalAgentName } = require('../../../services/approvalActionService');
const { isConnectIntent, connectIntentFloor, connectRequestAnswered } = require('../../../services/nativeRuntimeService');

const humanSender = (isBot = false) => User.findById.mockImplementation(() => ({
  select: () => ({ lean: async () => ({ isBot }) }),
}));

const trigger = (content, overrides = {}) => ({
  type: 'message.posted',
  payload: {
    messageId: 'm1',
    userId: 'u1',
    content,
    ...overrides,
  },
});

const floorInput = (content, overrides = {}) => ({
  trigger: trigger(content),
  podId: 'pod1',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  runId: 'run1',
  installationConfig: {},
  noOutboundRelay: false,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  humanSender(false);
  ApprovalAction.exists.mockResolvedValue(null);
  suggestLocalAgentName.mockResolvedValue('sam-claude');
  proposeAction.mockResolvedValue({ ok: true });
});

describe('isConnectIntent', () => {
  it.each([
    'connect my Claude Code to Commonly',
    'can you link my laptop so my codex runs here?',
    'set up a local agent for me',
  ])('matches a connect request: %s', (text) => {
    expect(isConnectIntent(text)).toBe(true);
  });

  it.each([
    'what can you do?',
    'create a pod for the team',
    'connect with the team on Friday', // no machine/tool named
    'attach a photo from my laptop',
    'link: https://claude.ai/chat/abc',
    'connect to claude.ai for research',
    'connect to the Claude API',
    'link to the Claude docs',
  ])('does not match: %s', (text) => {
    expect(isConnectIntent(text)).toBe(false);
  });
});

describe('connectIntentFloor', () => {
  it('proposes a connect_local_agent card for a human connect request', async () => {
    const posted = await connectIntentFloor(floorInput('connect my Claude Code to Commonly'));

    expect(posted).toBe(true);
    expect(proposeAction).toHaveBeenCalledTimes(1);
    expect(proposeAction.mock.calls[0][0]).toEqual(expect.objectContaining({
      actionType: 'connect_local_agent',
      params: { name: 'sam-claude', adapter: 'claude' },
      podId: 'pod1',
    }));
  });

  it('picks codex when the person names it', async () => {
    await connectIntentFloor(floorInput('link my codex to this pod'));

    expect(suggestLocalAgentName).toHaveBeenCalledWith('codex', 'u1');
    expect(proposeAction.mock.calls[0][0].params.adapter).toBe('codex');
  });

  it('does nothing when another agent sent the message', async () => {
    humanSender(true);

    expect(await connectIntentFloor(floorInput('connect my Claude Code'))).toBe(false);
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it('does nothing for a non-Scout agent', async () => {
    expect(await connectIntentFloor(floorInput('connect my Claude Code', { agentName: 'sage' })))
      .toBe(false);
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it('does nothing when the message has no connect intent', async () => {
    expect(await connectIntentFloor(floorInput('what can you do?'))).toBe(false);
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it('does not stack a second card while one is pending in the pod', async () => {
    ApprovalAction.exists.mockResolvedValue({ _id: 'existing' });

    expect(await connectIntentFloor(floorInput('connect my Claude Code'))).toBe(false);
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it('reports a refused proposal as not posted', async () => {
    proposeAction.mockResolvedValue({ ok: false, error: 'no owner' });

    expect(await connectIntentFloor(floorInput('connect my Claude Code'))).toBe(false);
  });
});

describe('connectRequestAnswered', () => {
  it('is answered when Scout posted a reply without proposing a card', () => {
    expect(connectRequestAnswered(true, 'Here is how to connect your Claude Code.')).toBe(true);
  });

  it('is answered by a proposed card alone', () => {
    expect(connectRequestAnswered(true, undefined)).toBe(true);
  });

  it('is answered by the text fallback alone', () => {
    expect(connectRequestAnswered(false, 'Sure, open the connect page.')).toBe(true);
  });

  it('is open only when the turn posted nothing', () => {
    expect(connectRequestAnswered(false, undefined)).toBe(false);
  });
});

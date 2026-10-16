/**
 * A native turn is told only about tools it has (QA walk, 2026-10-16: a hosted
 * agent claimed commonly_read_file and pointed a person at commonly_attach_file,
 * and another offered "a coding specialist like @codex"). The kernel writes its
 * mention frames for every runtime; the native driver rewrites the ones it
 * cannot honour (nativeKernelCue). This suite runs REAL kernel-built content
 * through that rewrite, so a new kernel clause naming a tool native lacks fails
 * here rather than in front of a stranger.
 *
 * Contract under test:
 *  - the kernel's mention content splits into its tagged frames and the message
 *  - before the rewrite it names tools native lacks (the positive control)
 *  - after it, every commonly_* name is a native tool, and the message is intact
 *  - content that is not kernel-framed passes through unchanged
 */

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: { getLatestPodSummary: jest.fn() },
  summarizePodMessages: jest.fn(),
}));
jest.mock('../../../models/AgentEvent', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../services/welcomeWakeService', () => ({ maybeFireWelcomeWake: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ findById: jest.fn(async () => null) }));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  followByParticipation: jest.fn().mockResolvedValue(true),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');

const referenceWake = async () => {
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([
      { agentName: 'seat-a', instanceId: 'default', displayName: 'Seat A' },
    ]),
  });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  User.find.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });
  User.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
  }));
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-1'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1', 'bot-1'] }),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);

  await AgentMentionService.enqueueMentions({
    podId: 'pod-1',
    userId: 'user-1',
    username: 'alice',
    message: { id: 'm-1', content: 'hi @seat-a' },
  });
  const call = AgentEventService.enqueue.mock.calls.find(([a]) => a.type === 'chat.mention');
  return call[0].payload.content;
};

beforeEach(() => { jest.clearAllMocks(); });

const { splitKernelFrames, frameTagOf } = require('../../../services/kernelFrames');
const { nativeCueFromKernel } = require('../../../services/nativeKernelCue');
const { NATIVE_TOOL_NAMES } = require('../../../services/nativeRuntimeService');

const toolNamesIn = (text) => [...new Set(text.match(/commonly_[a-z_]+/g) || [])];

describe('native cue from kernel-built mention content', () => {
  test('the reference wake splits into its four tagged frames and the message', async () => {
    const { frames, body } = splitKernelFrames(await referenceWake());

    expect(frames.map(frameTagOf)).toEqual(['Pod context', 'Trigger', 'Collaboration', 'Reply mechanics']);
    expect(body).toBe('hi @seat-a');
  });

  test('before the rewrite the kernel names tools native lacks; after it, only native tools', async () => {
    const content = await referenceWake();
    const foreign = toolNamesIn(content).filter((name) => !NATIVE_TOOL_NAMES.includes(name));
    expect(foreign).toEqual(expect.arrayContaining(['commonly_attach_file', 'commonly_read_file', 'commonly_dm_agent']));

    const cue = nativeCueFromKernel(content, 'pod-1');

    expect(toolNamesIn(cue).filter((name) => !NATIVE_TOOL_NAMES.includes(name))).toEqual([]);
    expect(cue).not.toMatch(/codex|token file|threadRootId/);
    expect(cue).toMatch(/this conversation is in pod `pod-1`/);
    expect(cue).toMatch(/You cannot open or attach files here/);
    expect(cue).toContain('[Reply mechanics:');
    expect(cue).toContain('[Trigger: this turn was raised by **alice**');
    expect(cue.endsWith('\n\nhi @seat-a')).toBe(true);
  });

  test('content that is not kernel-framed passes through unchanged', () => {
    expect(nativeCueFromKernel('A human just added you to this workspace.', 'pod-1'))
      .toBe('A human just added you to this workspace.');
  });
});

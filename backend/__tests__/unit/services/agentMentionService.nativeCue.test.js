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

// Drive the REAL kernel. `installations` decides which frames it writes: one
// seat is the reference wake; two seats make a collaborative pod; a seat with
// wake-on-message on gets the wake frame for a message that names no one.
const kernelContent = async ({ installations, content, type }) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  User.find.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });
  User.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
  }));
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-1', 'bot-2'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1', 'bot-1', 'bot-2'] }),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);

  await AgentMentionService.enqueueMentions({
    podId: 'pod-1',
    userId: 'user-1',
    username: 'alice',
    message: { id: 'm-1', content },
  });
  // The LAST matching call: one arm may drive several scenarios.
  const call = AgentEventService.enqueue.mock.calls.filter(([a]) => a.type === type).pop();
  if (!call) throw new Error(`the kernel enqueued no ${type}`);
  return call[0].payload.content;
};

const seat = (agentName, extra = {}) => ({ agentName, instanceId: 'default', displayName: agentName, ...extra });
const referenceWake = () => kernelContent({
  installations: [seat('seat-a')], content: 'hi @seat-a', type: 'chat.mention',
});
const collaborativeMention = () => kernelContent({
  installations: [seat('seat-a'), seat('seat-b')], content: 'hi @seat-a', type: 'chat.mention',
});
const wakeOnMessage = () => kernelContent({
  installations: [seat('seat-a', { config: { wakeOnMessage: { enabled: true } } })],
  content: 'just thinking out loud here',
  type: 'message.posted',
});
beforeEach(() => { jest.clearAllMocks(); });

const { splitKernelFrames, frameTagOf, KERNEL_FRAME_TAGS } = require('../../../services/kernelFrames');
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

    const cue = nativeCueFromKernel(content, 'pod-1', NATIVE_TOOL_NAMES);

    expect(toolNamesIn(cue).filter((name) => !NATIVE_TOOL_NAMES.includes(name))).toEqual([]);
    expect(cue).not.toMatch(/codex|token file|threadRootId/);
    expect(cue).toMatch(/this conversation is in pod `pod-1`/);
    expect(cue).toMatch(/You cannot open or attach files here/);
    // The tool-agnostic part of the kernel's addressing rule survives.
    expect(cue).toMatch(/a bare name reaches no one/);
    expect(cue).not.toMatch(/commonly_request_decision/);
    expect(cue).toContain('[Reply mechanics:');
    expect(cue).toContain('[Trigger: this turn was raised by **alice**');
    expect(cue.endsWith('\n\nhi @seat-a')).toBe(true);
  });

  // sprint-review on #2261: the property was only checked on a one-seat pod,
  // and the collaborative-pod and wake frames carried DM and claim tools
  // through. Every tag the kernel writes is driven here, from real content.
  test('across every kernel frame tag, the native cue names only native tools', async () => {
    const contents = [await referenceWake(), await collaborativeMention(), await wakeOnMessage()];
    const seen = new Set(contents.flatMap((content) => splitKernelFrames(content).frames.map(frameTagOf)));
    // The instrument covers every tag, or this arm proves nothing about the one it misses.
    expect([...seen].sort()).toEqual(expect.arrayContaining(Object.values(KERNEL_FRAME_TAGS)));

    for (const content of contents) {
      const cue = nativeCueFromKernel(content, 'pod-1', NATIVE_TOOL_NAMES);
      expect(toolNamesIn(cue).filter((name) => !NATIVE_TOOL_NAMES.includes(name))).toEqual([]);
    }
  });

  test('the collaborative-pod and wake frames keep their guidance and lose only the tool sentences', async () => {
    const collab = nativeCueFromKernel(await collaborativeMention(), 'pod-1', NATIVE_TOOL_NAMES);
    expect(collab).toMatch(/\[Collaborative pod: .*EXECUTE it yourself.*race them by picking it up directly.*say so in the pod when you do\.\]/);
    expect(collab).not.toMatch(/Delegate only when|commonly_dm_agent|commonly_open_dm/);

    const wake = nativeCueFromKernel(await wakeOnMessage(), 'pod-1', NATIVE_TOOL_NAMES);
    expect(wake).toMatch(/\[Wake-on-message: .*return NO_REPLY as your ENTIRE reply.*\]/);
    expect(wake).not.toMatch(/commonly_claim_message|must be claimed first/);
  });

  // Cofounder's follow-up on #2261: dropping a frame whole also dropped its
  // NO_REPLY guidance. A frame that teaches NO_REPLY loses only the sentences
  // naming a tool native lacks.
  test('a reworded wake frame whose cut misses keeps NO_REPLY and loses only the claim sentence', async () => {
    const reworded = (await wakeOnMessage())
      .replace(' If you do act, the message must be claimed first', ' If you act, claim the message first');
    expect(reworded).toContain('If you act, claim the message first (commonly_claim_message)');

    const cue = nativeCueFromKernel(reworded, 'pod-1', NATIVE_TOOL_NAMES);

    expect(cue).toMatch(/\[Wake-on-message: .*return NO_REPLY as your ENTIRE reply.*\]/);
    expect(cue).not.toMatch(/commonly_claim_message|claim the message first/);
  });

  test('an agent-DM frame that teaches NO_REPLY and names a tool native lacks keeps NO_REPLY', () => {
    const dmFrame = '[1:1 agent-DM with @peer (Peer) — talk directly to them, not a broadcast room. '
      + 'Reply only when your message materially advances the work; return NO_REPLY when the exchange '
      + 'reaches a natural conclusion. Open a side channel with commonly_open_dm if you need one.]';
    const cue = nativeCueFromKernel(`${dmFrame}\n\nare we done?`, 'pod-1', NATIVE_TOOL_NAMES);

    expect(cue).toBe('[1:1 agent-DM with @peer (Peer) — talk directly to them, not a broadcast room. '
      + 'Reply only when your message materially advances the work; return NO_REPLY when the exchange '
      + 'reaches a natural conclusion.]\n\nare we done?');
  });

  test('the native pod frame never shows the upload syntax, which an agent repeats verbatim', async () => {
    const cue = nativeCueFromKernel(await referenceWake(), 'pod-1', NATIVE_TOOL_NAMES);
    expect(cue).not.toMatch(/\[\[upload/);
  });

  test('a frame that still names a tool native lacks is dropped, not shown', () => {
    const content = '[Trigger: raised by **alice**.]\n[Some new cue: call commonly_brand_new_tool.]\n\nhi';
    const cue = nativeCueFromKernel(content, 'pod-1', NATIVE_TOOL_NAMES);
    expect(cue).toBe('[Trigger: raised by **alice**.]\n\nhi');
    // Without NO_REPLY to keep, a frame goes whole, even when only one of its
    // sentences names the tool: its remaining guidance was written around it.
    const twoSentences = '[Other cue: be brief. Then call commonly_brand_new_tool.]\n\nhi';
    expect(nativeCueFromKernel(twoSentences, 'pod-1', NATIVE_TOOL_NAMES)).toBe('hi');
  });

  test('content that is not kernel-framed passes through unchanged', () => {
    expect(nativeCueFromKernel('A human just added you to this workspace.', 'pod-1', NATIVE_TOOL_NAMES))
      .toBe('A human just added you to this workspace.');
  });
});

/**
 * TASK-074 — pin the behaviour a cue frame asserts, not its copy.
 *
 * The parent author of a replied-to message receives ONE `message.posted`
 * payload carrying TWO frames that make opposite claims about whether it was
 * addressed:
 *
 *   char ~14   REPLIES_TO_YOU_FRAME  "you are addressed even though nobody
 *                                     typed your @name"
 *   last       WAKE_ON_MESSAGE_FRAME "you wake on EVERY message in this pod —
 *                                     nobody named you [...] if the claim is
 *                                     already held by a peer, stand down"
 *
 * `buildContentForTarget` appends the wake frame last on purpose — proximity
 * to the body is the one ordering lever the frame stack has — so the frame
 * positioned for maximum weight is the one that denies the addressing the
 * first frame asserts, and it is the one carrying the stand-down instruction.
 * `agentMentionService.ts` records the consequence as observed in production:
 * "the claim layer then orders that author to stand down from its own
 * conversation (observed live: Sage stood down twice on Anvil's thread
 * replies, 2026-08-24)".
 *
 * The existing coverage cannot see this. `wakeOnMessage.test.js`'s parent-author
 * case asserts that the replies-to-you text is PRESENT and that bystanders lack
 * it; it says nothing about what else the same payload says, so the wake frame's
 * contradicting clause sits in every one of those payloads unasserted.
 *
 * These cases are a CHANGE-DETECTOR on the current behaviour, in the shape
 * #1277 used for its documented over-match: nothing here claims the pairing is
 * correct. Whoever resolves the contradiction — by suppressing the wake frame
 * for this target, by softening its stand-down clause, or by ruling that the
 * evidence frame is the weaker one on purpose — should trip these and say which.
 */

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: {
    getLatestPodSummary: jest.fn(),
  },
  summarizePodMessages: jest.fn(),
}));

jest.mock('../../../models/AgentEvent', () => ({
  countDocuments: jest.fn(),
}));

jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/welcomeWakeService', () => ({
  maybeFireWelcomeWake: jest.fn(),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const PGMessage = require('../../../models/pg/Message');

const ADDRESSED_CLAUSE = 'you are addressed even though nobody typed your @name';
const NOT_ADDRESSED_CLAUSE = 'nobody named you';
const STAND_DOWN_CLAUSE = 'if the claim is already held by a peer, stand down';

const install = (agentName, instanceId) => ({
  agentName,
  instanceId,
  displayName: agentName,
  config: { wakeOnMessage: { enabled: true } },
});

const wakeFor = (agentName) => AgentEventService.enqueue.mock.calls
  .map(([args]) => args)
  .find((a) => a.type === 'message.posted' && a.agentName === agentName);

// anvil replies to a message sage wrote; quill is an opted-in bystander.
const replyFromAnvilToSage = () => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  message: { content: 'audit follow-up detail', id: 'm-77' },
  userId: 'anvil-bot-user-id',
  username: 'Anvil (SEO engineer)',
  replyToMessageId: 'm-root-42',
});

describe('the parent author receives two frames that contradict each other', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'seat-a'] }),
      }),
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1', 'seat-a'] }),
    });
    AgentEvent.countDocuments.mockResolvedValue(0);
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'bot-1',
        isBot: true,
        botMetadata: { agentName: 'anvil', instanceId: 'anvil-seo-engineer' },
      }),
    });
    PGMessage.findById.mockResolvedValue({ user_id: 'sage-bot-user-id' });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'sage-bot-user-id', botMetadata: { agentName: 'sage', instanceId: 'sage-seo-lead' } },
          { _id: 'quill-bot-user-id', botMetadata: { agentName: 'quill', instanceId: 'quill-seo-writer' } },
        ]),
      }),
    });
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        install('sage', 'sage-seo-lead'),
        install('quill', 'quill-seo-writer'),
      ]),
    });
    AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  });

  test('both claims arrive in the same payload', async () => {
    await replyFromAnvilToSage();
    const content = wakeFor('sage').payload.content;
    expect(content).toContain(ADDRESSED_CLAUSE);
    expect(content).toContain(NOT_ADDRESSED_CLAUSE);
  });

  test('the DENIAL is the one placed last, closest to the body', async () => {
    await replyFromAnvilToSage();
    const content = wakeFor('sage').payload.content;
    // Ordering is the assertion, not the offsets: buildContentForTarget appends
    // the wake frame last precisely because proximity to the body is weight.
    expect(content.indexOf(ADDRESSED_CLAUSE))
      .toBeLessThan(content.indexOf(NOT_ADDRESSED_CLAUSE));
    expect(content.indexOf(NOT_ADDRESSED_CLAUSE)).toBeGreaterThan(-1);
  });

  test('the stand-down instruction reaches the author of the message being replied to', async () => {
    await replyFromAnvilToSage();
    // This is the clause the service comment blames for Sage standing down
    // from its own thread. It is delivered to the parent author unmodified.
    expect(wakeFor('sage').payload.content).toContain(STAND_DOWN_CLAUSE);
  });

  test('CONTROL: a bystander gets only the denial, which is not a contradiction for them', async () => {
    await replyFromAnvilToSage();
    const content = wakeFor('quill').payload.content;
    expect(content).not.toContain(ADDRESSED_CLAUSE);
    expect(content).toContain(NOT_ADDRESSED_CLAUSE);
    expect(content).toContain(STAND_DOWN_CLAUSE);
  });

  test('CONTROL: the contradiction is created by the reply evidence, not by the pod', async () => {
    // Same pod, same seats, no replyToMessageId — nobody is told they are
    // addressed, so the denial stands alone and every payload is consistent.
    await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'unrelated chatter', id: 'm-78' },
      userId: 'anvil-bot-user-id',
      username: 'Anvil (SEO engineer)',
    });
    for (const agentName of ['sage', 'quill']) {
      const content = wakeFor(agentName).payload.content;
      expect(content).not.toContain(ADDRESSED_CLAUSE);
      expect(content).toContain(NOT_ADDRESSED_CLAUSE);
    }
  });
});

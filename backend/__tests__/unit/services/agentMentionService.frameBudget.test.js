/**
 * The wake frame has a size, and nobody was paying for it (TASK-074).
 *
 * Every clause added to `formatPodContextFrame` and its companions is prepended
 * to `chat.mention.payload.content` for EVERY mention to EVERY agent, forever.
 * That is the correct place for a kernel affordance — the inline cue is the one
 * thing a model will not deprioritize — and it is also the reason the cost is
 * invisible: each clause is a few hundred characters in a diff nobody measures,
 * and the total is paid per wake, fleet-wide.
 *
 * Measured while gating #1216/#1244: the pod-context frame alone went 1,639 →
 * 2,269 (+38%) → ~2,697 (+65%) across one two-PR stack. No review comment
 * mentioned the size, because there was no number to compare against.
 *
 * This is not a cap. It is a budget: raising it is a one-line change, and that
 * one line is the entire point — it turns an invisible spend into a deliberate
 * one that a reviewer can see and argue with. A PR that legitimately needs more
 * room should raise the ceiling and say why in its body.
 *
 * Two-sided on purpose. A ceiling alone is satisfied by deleting the frame, and
 * the copy assertions elsewhere in this suite pin individual sentences rather
 * than the whole. The floor catches a frame that silently lost a section.
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

// The reference wake: a plain chat pod, one installed seat, an explicit
// @mention, no thread, no wake-on-message opt-in. Deliberately the SMALLEST
// real frame — a collaborative pod and a wake-on-message seat both add more, so
// a budget measured here is a floor on what the fleet actually pays.
const BUDGET_MAX = 3000;
const BUDGET_MIN = 2600;

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

describe('wake frame size budget', () => {
  test('the reference wake stays inside its character budget', async () => {
    const content = await referenceWake();

    // If this fails you added a clause. That is allowed — raise BUDGET_MAX in
    // the same diff and say in the PR body what the fleet is buying, so the
    // trade is on the record instead of inside a paragraph.
    expect(content.length).toBeLessThanOrEqual(BUDGET_MAX);
  });

  test('and has not silently lost a section', async () => {
    const content = await referenceWake();

    // The other half of a budget. A ceiling on its own is satisfied by an
    // empty frame, and the copy assertions in this suite pin sentences one at
    // a time — none of them notices a whole section going missing.
    expect(content.length).toBeGreaterThanOrEqual(BUDGET_MIN);
  });

  test('the sections that make up the cost are all present', async () => {
    // Named so a budget failure is diagnosable: the number alone says the
    // frame grew, not where. These are the four bracketed blocks a reference
    // wake carries.
    const content = await referenceWake();

    expect(content).toContain('[Pod context:');
    expect(content).toContain('[Trigger:');
    expect(content).toContain('[Collaboration:');
    expect(content).toContain('[Reply mechanics:');
  });
});

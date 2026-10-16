/**
 * agentAnswerService.humansAnsweredBy: who an agent's post answers.
 *
 * QA walk 5 (2026-10-16): since #2269 an agent a person @-mentioned answers
 * even when another agent (Scout) won the claim race, so it holds no claim and
 * posts no reply edge. Its first answer then answered nobody, and "Give your
 * agent its first task" completed only on the second. The native run now names
 * the message it is answering (answeringMessageId), which answers its author
 * when that message is in the same pod.
 */

const mockLiveClaims = jest.fn();
jest.mock('../../../services/messageClaimService', () => ({ liveClaimsHeldBy: (...args) => mockLiveClaims(...args) }));
const mockPgFindById = jest.fn();
jest.mock('../../../models/pg/Message', () => ({ findById: (...args) => mockPgFindById(...args) }));
const mockTaskExists = jest.fn();
const mockTaskUpdate = jest.fn();
jest.mock('../../../models/Task', () => ({
  exists: (...args) => mockTaskExists(...args),
  findOneAndUpdate: (...args) => mockTaskUpdate(...args),
}));
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({ findById: (...args) => mockPodFindById(...args) }));
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: jest.fn() }));

const { humansAnsweredBy } = require('../../../services/agentAnswerService');
const { completeFirstTaskOnAnswer, FIRST_TASK_SOURCE_REF } = require('../../../services/starterTaskService');

const POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER = 'cccccccccccccccccccccccc';
const messages = {
  78385: { id: 78385, pod_id: POD, userId: { _id: OWNER, username: 'stranger' } },
  78390: { id: 78390, pod_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', userId: { _id: OWNER, username: 'stranger' } },
};

beforeEach(() => {
  mockLiveClaims.mockReset().mockResolvedValue([]);
  mockPgFindById.mockReset().mockImplementation(async (id) => messages[id] || null);
  mockTaskExists.mockReset().mockResolvedValue({ _id: 't2' });
  mockTaskUpdate.mockReset().mockResolvedValue({ taskId: 'TASK-002', status: 'done' });
  mockPodFindById.mockReset().mockReturnValue({ select: () => ({ lean: async () => ({ createdBy: OWNER }) }) });
});

const ask = (extra = {}) => humansAnsweredBy({
  podId: POD, agentName: 'stranger-agent', instanceId: 'default', ...extra,
});

describe('humansAnsweredBy', () => {
  test('with no claim and no reply edge, a post answers nobody (the walk-5 miss)', async () => {
    expect([...await ask()]).toEqual([]);
  });

  test("the message the run is answering answers its author, with no claim held", async () => {
    expect([...await ask({ answeringMessageId: '78385' })]).toEqual([OWNER]);
  });

  test("a run's trigger in another pod answers nobody here", async () => {
    expect([...await ask({ answeringMessageId: '78390' })]).toEqual([]);
  });

  test('a claimed trigger is read once, not twice', async () => {
    mockLiveClaims.mockResolvedValue(['78385']);
    expect([...await ask({ answeringMessageId: '78385' })]).toEqual([OWNER]);
    expect(mockPgFindById).toHaveBeenCalledTimes(1);
  });

  test('an id that is not a message id is ignored', async () => {
    expect([...await ask({ answeringMessageId: 'not-a-message' })]).toEqual([]);
    expect(mockPgFindById).not.toHaveBeenCalled();
  });
});

describe('"Give your agent its first task" with the real answer rule', () => {
  // The walk-5 shape: Scout won the claim on the stranger's first ask, the
  // stranger's hosted agent answered anyway (#2269), and the card must complete
  // on that first answer, not the second.
  test('an addressed agent that lost the claim completes it with its first answer', async () => {
    await completeFirstTaskOnAnswer({
      podId: POD, agentName: 'stranger-agent', instanceId: 'default', agentLabel: 'stranger-agent',
      content: 'Here is the summary.', answeringMessageId: '78385',
    });
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdate.mock.calls[0][0].sourceRef).toBe(FIRST_TASK_SOURCE_REF);
  });

  test('without the run naming its trigger, the same answer leaves it open', async () => {
    await completeFirstTaskOnAnswer({
      podId: POD, agentName: 'stranger-agent', instanceId: 'default', agentLabel: 'stranger-agent',
      content: 'Here is the summary.',
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });
});

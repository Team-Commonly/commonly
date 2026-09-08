jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../models/Task', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), find: jest.fn() }));

const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const User = require('../../../models/User');
const PodFocusService = require('../../../services/podFocusService');

const POD = '507f1f77bcf86cd799439011';
const HUMAN = '507f1f77bcf86cd799439012';
const OTHER = '507f1f77bcf86cd799439013';
const TASK = 'TASK-1';

const chain = (value) => {
  const lean = jest.fn().mockResolvedValue(value);
  const select = jest.fn().mockReturnValue({ lean });
  return { select, lean };
};

const focusPod = (revision = 0) => ({
  _id: POD,
  createdBy: HUMAN,
  members: [HUMAN, OTHER],
  focusRevision: revision,
});

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(chain({ _id: HUMAN, isBot: false, role: 'user' }));
  User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  Task.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findOneAndUpdate.mockReturnValue({ lean: jest.fn().mockResolvedValue(focusPod(1)) });
});

describe('PodFocusService', () => {
  test('requires a stored human even when the caller presents a creator id', async () => {
    User.findById.mockReturnValue(chain({ _id: HUMAN, isBot: true, role: 'admin' }));
    await expect(PodFocusService.update({
      podId: POD, userId: HUMAN, expectedRevision: 0, focus: null,
    })).rejects.toMatchObject({ status: 403, code: 'FOCUS_HUMAN_REQUIRED' });
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  test('rejects duplicate refs without mutating the pod', async () => {
    Pod.findById.mockReturnValue(chain(focusPod()));
    await expect(PodFocusService.update({
      podId: POD,
      userId: HUMAN,
      expectedRevision: 0,
      focus: { goal: 'Ship', scope: 'Pilot', ownerUserId: HUMAN, nextTaskIds: [TASK, TASK] },
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_FOCUS' });
    expect(Pod.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('validates task refs in this pod and saves the whole focus at the next revision', async () => {
    Pod.findById.mockReturnValue(chain(focusPod()));
    Task.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{ taskId: TASK, title: 'Ship', status: 'pending' }]) });
    const saved = { ...focusPod(1), focus: {
      goal: 'Ship', scope: 'Pilot', ownerUserId: HUMAN, nextTaskIds: [TASK],
      revision: 1, updatedAt: new Date(), updatedBy: HUMAN,
    } };
    Pod.findOneAndUpdate.mockReturnValue({ lean: jest.fn().mockResolvedValue(saved) });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: HUMAN, username: 'alice', isBot: false }]),
      }),
    });

    const result = await PodFocusService.update({
      podId: POD,
      userId: HUMAN,
      expectedRevision: 0,
      focus: { goal: ' Ship ', scope: 'Pilot', ownerUserId: HUMAN, nextTaskIds: [TASK] },
    });

    expect(Pod.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: POD, members: expect.anything(), $or: expect.any(Array) }),
      expect.objectContaining({ $set: expect.objectContaining({ focusRevision: 1 }) }),
      { new: true },
    );
    expect(result.revision).toBe(1);
    expect(result.focus.goal).toBe('Ship');
    expect(result.focus.nextTasks[0]).toMatchObject({ taskId: TASK, available: true });
  });

  test('rejects a stale revision before writing', async () => {
    Pod.findById.mockReturnValue(chain(focusPod(2)));
    await expect(PodFocusService.update({
      podId: POD, userId: HUMAN, expectedRevision: 1, focus: null,
    })).rejects.toMatchObject({ status: 409, code: 'FOCUS_CONFLICT' });
    expect(Pod.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not let a global admin bypass the stored human check', async () => {
    User.findById.mockReturnValue(chain({ _id: HUMAN, isBot: false, role: 'admin' }));
    Pod.findById.mockReturnValue(chain({ ...focusPod(), members: [OTHER] }));

    const result = await PodFocusService.update({
      podId: POD, userId: HUMAN, expectedRevision: 0, focus: null,
    });

    expect(result.revision).toBe(1);
    expect(Pod.findOneAndUpdate).toHaveBeenCalled();
  });

  test('rejects an owner id that is only present in the membership array', async () => {
    Pod.findById.mockReturnValue(chain(focusPod()));
    User.findById
      .mockReturnValueOnce(chain({ _id: HUMAN, isBot: false, role: 'user' }))
      .mockReturnValueOnce(chain(null));

    await expect(PodFocusService.update({
      podId: POD,
      userId: HUMAN,
      expectedRevision: 0,
      focus: { goal: 'Ship', scope: 'Pilot', ownerUserId: OTHER, nextTaskIds: [] },
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_FOCUS' });
    expect(Pod.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('marks a dangling owner unavailable even when its id remains in membership', async () => {
    const saved = { ...focusPod(1), focus: {
      goal: 'Ship', scope: 'Pilot', ownerUserId: OTHER, nextTaskIds: [],
      revision: 1, updatedAt: new Date(), updatedBy: HUMAN,
    } };
    Pod.findById.mockReturnValue(chain(saved));
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: HUMAN, username: 'alice', isBot: false }]),
      }),
    });

    const result = await PodFocusService.readForPod({ pod: saved, podId: POD });
    expect(result.focus.owner).toMatchObject({ userId: OTHER, available: false, label: null });
  });

  test('reports an owner membership race as validation, not a revision conflict', async () => {
    Pod.findById
      .mockReturnValueOnce(chain(focusPod()))
      .mockReturnValueOnce(chain({ ...focusPod(), members: [HUMAN], focusRevision: 0 }));
    Pod.findOneAndUpdate.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    await expect(PodFocusService.update({
      podId: POD,
      userId: HUMAN,
      expectedRevision: 0,
      focus: { goal: 'Ship', scope: 'Pilot', ownerUserId: OTHER, nextTaskIds: [] },
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_FOCUS', fields: { ownerUserId: 'must be a current pod member' } });
  });
});

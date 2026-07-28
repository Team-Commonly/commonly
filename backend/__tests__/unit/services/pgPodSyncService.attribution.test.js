/**
 * Regression: the PG backfill let a non-member grant themselves access.
 *
 * `PGPod.create` inserts its `created_by` argument into `pod_members` as a side
 * effect. `syncPodFromMongo` was passing the REQUESTING user as `created_by`,
 * and `pgMessageController.getMessages` ran that backfill BEFORE its membership
 * check — so a non-member asking for a pod not yet mirrored into PG caused the
 * server to insert them as a member, and the check on the next line read that
 * row back and let them through. A complete read bypass.
 *
 * The manufactured row is worse than a one-request bypass: PG `pod_members` is
 * also trusted as a positive access signal by `reactionController` and by
 * `isMemberWithFallback` on every later request, so it persists.
 *
 * Two properties are pinned here:
 *   1. `created_by` mirrors the Mongo pod's real owner, never the requester
 *   2. the requester is not silently added to the member list
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockPGPod = { create: jest.fn(), addMember: jest.fn().mockResolvedValue(undefined) };
const mockMongoPod = { findById: jest.fn() };

jest.mock('../../../models/pg/Pod', () => mockPGPod);
jest.mock('../../../models/Pod', () => mockMongoPod);

const { syncPodFromMongo } = require('../../../services/pgPodSyncService');

const OWNER = 'real-owner-id';
const INTRUDER = 'intruder-id';
const MEMBER = 'legit-member-id';
const POD = 'pod-123';

describe('syncPodFromMongo attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPGPod.create.mockResolvedValue({ id: POD });
    mockMongoPod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        name: 'Private Pod',
        description: '',
        type: 'chat',
        createdBy: OWNER,
        members: [MEMBER],
      }),
    });
  });

  test('created_by is the Mongo pod owner, NOT whoever triggered the backfill', async () => {
    await syncPodFromMongo(POD, INTRUDER);

    const createdBy = mockPGPod.create.mock.calls[0][3];
    expect(createdBy).toBe(OWNER);
    expect(createdBy).not.toBe(INTRUDER);
  });

  test('the requester is not inserted into the member list', async () => {
    await syncPodFromMongo(POD, INTRUDER);

    // addMember is called for the real Mongo members only. PGPod.create adds
    // created_by separately, which is now the owner — so the intruder appears
    // nowhere.
    const added = mockPGPod.addMember.mock.calls.map((c) => c[1]);
    expect(added).toContain(MEMBER);
    expect(added).not.toContain(INTRUDER);
    expect(mockPGPod.create.mock.calls[0][3]).not.toBe(INTRUDER);
  });

  test('falls back to the requester only when Mongo has no owner recorded', async () => {
    mockMongoPod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        name: 'Ownerless', type: 'chat', members: [],
      }),
    });

    await syncPodFromMongo(POD, INTRUDER);

    expect(mockPGPod.create.mock.calls[0][3]).toBe(INTRUDER);
  });

  test('returns null for a pod that does not exist in Mongo', async () => {
    mockMongoPod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    await expect(syncPodFromMongo(POD, INTRUDER)).resolves.toBeNull();
    expect(mockPGPod.create).not.toHaveBeenCalled();
  });
});

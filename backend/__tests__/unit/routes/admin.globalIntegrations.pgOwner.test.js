// F183: the 39 stale PG `pods.created_by` values on 2026-11-05 were all written
// by a PG backfill that named whoever triggered it as owner instead of the
// pod's Mongo `createdBy`. `syncPodFromMongo` stopped doing that in #766; the
// global social-feed pod's own backfill still did, so a second admin linking a
// feed to a pod another admin created minted a wrong PG owner.
process.env.PG_HOST = 'localhost';

jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/pg/Pod', () => ({
  findById: jest.fn(),
  create: jest.fn(),
  addMember: jest.fn(),
}));
jest.mock('../../../services/feedCredentials', () => ({
  storeFeedTokens: jest.fn(), readFeedAccessToken: jest.fn(), hasFeedAccessToken: jest.fn(),
}));

const PGPod = require('../../../models/pg/Pod');
const { ensureGlobalPodPostgresSync } = require('../../../routes/admin/globalIntegrations');

describe('ensureGlobalPodPostgresSync owner (F183)', () => {
  afterEach(() => jest.clearAllMocks());

  it("creates the PG row with the pod's Mongo owner, not the admin who triggered it", async () => {
    PGPod.findById.mockResolvedValue(undefined);
    await ensureGlobalPodPostgresSync({
      pod: { _id: 'p1', name: 'Global Social Feed', type: 'chat', createdBy: { toString: () => 'first-admin' } },
      userId: 'second-admin',
    });
    expect(PGPod.create).toHaveBeenCalledWith('Global Social Feed', expect.any(String), 'chat', 'first-admin', 'p1');
    // The requester is a Mongo member (the caller adds them), so the mirror lists them too.
    expect(PGPod.addMember).toHaveBeenCalledWith('p1', 'second-admin');
  });

  it('falls back to the requester only when the Mongo pod has no owner', async () => {
    PGPod.findById.mockResolvedValue(undefined);
    await ensureGlobalPodPostgresSync({ pod: { _id: 'p1', name: 'G', type: 'chat' }, userId: 'admin' });
    expect(PGPod.create).toHaveBeenCalledWith('G', expect.any(String), 'chat', 'admin', 'p1');
  });
});

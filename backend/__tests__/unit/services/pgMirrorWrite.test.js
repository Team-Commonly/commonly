// F183: the Mongo-first writes that used to skip the PG mirror call these
// helpers after their Mongo write. Each is best-effort: a PG failure is logged
// and never reaches the request.
process.env.PG_HOST = 'localhost';

jest.mock('../../../models/pg/Pod', () => ({
  findById: jest.fn(),
  addMember: jest.fn(),
  removeMember: jest.fn(),
  update: jest.fn(),
}));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({ syncUserToPostgreSQL: jest.fn() }));

const PGPod = require('../../../models/pg/Pod');
const { syncPodFromMongo } = require('../../../services/pgPodSyncService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const {
  mirrorMemberAdded, mirrorMemberRemoved, mirrorPodRenamed, mirrorPodCreated, mirrorUser, MIRROR_TIMEOUT_MS,
} = require('../../../services/pgMirrorWrite');

describe('pgMirrorWrite (F183)', () => {
  afterEach(() => jest.clearAllMocks());

  it('adds a member row when the PG pod exists', async () => {
    PGPod.findById.mockResolvedValue({ id: 'p1' });
    await expect(mirrorMemberAdded('p1', 'u1')).resolves.toBe(true);
    expect(PGPod.addMember).toHaveBeenCalledWith('p1', 'u1');
    expect(syncPodFromMongo).not.toHaveBeenCalled();
  });

  it('backfills the whole pod from Mongo when PG has no pod row, instead of an FK-failing insert', async () => {
    PGPod.findById.mockResolvedValue(undefined);
    syncPodFromMongo.mockResolvedValue({ id: 'p1' });
    await expect(mirrorMemberAdded('p1', 'u1')).resolves.toBe(true);
    expect(syncPodFromMongo).toHaveBeenCalledWith('p1', 'u1');
    expect(PGPod.addMember).not.toHaveBeenCalled();
  });

  it('copies a newly created Mongo pod into PG when it has no PG row', async () => {
    PGPod.findById.mockResolvedValue(undefined);
    await expect(mirrorPodCreated('p1')).resolves.toBe(true);
    expect(syncPodFromMongo).toHaveBeenCalledWith('p1', '');
  });

  it('leaves an existing PG pod row alone on create', async () => {
    PGPod.findById.mockResolvedValue({ id: 'p1' });
    await expect(mirrorPodCreated('p1')).resolves.toBe(true);
    expect(syncPodFromMongo).not.toHaveBeenCalled();
  });

  // F183: a new User reached PG `users` only on its first post or page load,
  // so every nightly diff counted the day's signups and new agents as missing.
  it('writes a user through syncUserToPostgreSQL, the one sync every user path shares', async () => {
    const user = { _id: 'u1' };
    AgentIdentityService.syncUserToPostgreSQL.mockResolvedValue(true);
    await expect(mirrorUser(user)).resolves.toBe(true);
    expect(AgentIdentityService.syncUserToPostgreSQL).toHaveBeenCalledWith(user);
  });

  it('reports a user sync that returned false as a failure, and logs it, without throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentIdentityService.syncUserToPostgreSQL.mockResolvedValue(false);
    await expect(mirrorUser({ _id: 'u1' })).resolves.toBe(false);
    AgentIdentityService.syncUserToPostgreSQL.mockRejectedValue(new Error('pg down'));
    await expect(mirrorUser({ _id: 'u1' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[pg-mirror] %s failed: %s', 'user sync user=u1', expect.any(String));
    warn.mockRestore();
  });

  it('removes a member row', async () => {
    await expect(mirrorMemberRemoved('p1', 'u1')).resolves.toBe(true);
    expect(PGPod.removeMember).toHaveBeenCalledWith('p1', 'u1');
  });

  it('writes the renamed name with the pod description through PGPod.update', async () => {
    await expect(mirrorPodRenamed('p1', 'New', 'desc')).resolves.toBe(true);
    expect(PGPod.update).toHaveBeenCalledWith('p1', 'New', 'desc');
  });

  it('swallows and logs a PG failure, so the Mongo write still answers', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    PGPod.findById.mockResolvedValue({ id: 'p1' });
    PGPod.addMember.mockRejectedValue(new Error('pg down'));
    PGPod.removeMember.mockRejectedValue(new Error('pg down'));
    PGPod.update.mockRejectedValue(new Error('pg down'));
    await expect(mirrorMemberAdded('p1', 'u1')).resolves.toBe(false);
    await expect(mirrorMemberRemoved('p1', 'u1')).resolves.toBe(false);
    await expect(mirrorPodRenamed('p1', 'n', '')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[pg-mirror] %s failed: %s', expect.any(String), 'pg down');
    warn.mockRestore();
  });

  // CodeQL js/tainted-format-string on #3500: the label carries request ids, so
  // it must never be console's format string. Every warn uses one constant.
  it('never puts a caller value in the format string position', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    PGPod.removeMember.mockRejectedValue(new Error('pg down'));
    await mirrorMemberRemoved('%s%o', '%d');
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['[pg-mirror] %s failed: %s']);
    warn.mockRestore();
  });

  // #3500 review: join, leave and install await these on the request path. A
  // hung PG must cost the request at most MIRROR_TIMEOUT_MS, never the request.
  it('gives up on a hung PG write after MIRROR_TIMEOUT_MS and reports false', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      PGPod.removeMember.mockImplementation(() => new Promise(() => {}));
      let settled = null;
      const pending = mirrorMemberRemoved('p1', 'u1').then((v) => { settled = v; });
      await jest.advanceTimersByTimeAsync(MIRROR_TIMEOUT_MS - 1);
      expect(settled).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[pg-mirror] %s failed: %s', 
        'member remove pod=p1 user=u1',
        `timed out after ${MIRROR_TIMEOUT_MS} ms`,
      );
      expect(MIRROR_TIMEOUT_MS).toBe(1500);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does nothing when no PG mirror is configured', async () => {
    const saved = process.env.PG_HOST;
    delete process.env.PG_HOST;
    try {
      await expect(mirrorMemberAdded('p1', 'u1')).resolves.toBe(true);
      expect(PGPod.findById).not.toHaveBeenCalled();
    } finally {
      process.env.PG_HOST = saved;
    }
  });
});

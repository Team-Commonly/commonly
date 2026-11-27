/**
 * F666: first listen also closes the installer's stalled-connect attention
 * row. That close is an addition to the F576 intro rewrite, so it must never
 * cost the rewrite its count. On the Service Tests tier (no Mongo connection
 * in the pg test, Mongoose's 10 s buffer) an awaited close in front of the
 * rewrite outlived the 2 s bound, and every first-listen rewrite answered 0.
 */
const mockPool = { query: jest.fn() };
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));
jest.mock('../../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: () => {} }) }) }));
const mockResolve = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  resolveStalledConnectForAgent: (...args) => mockResolve(...args),
}));

const { snapshotPointer } = require('../../../services/installIntroCopy');
const { settleInstallIntroOnFirstListen } = require('../../../services/installIntroOnListen');

// A never-connected intro as installs wrote it before F651, which stopped
// posting one; rows like it stay in pods, and the first listen still settles them.
const NEVER = "Hi all — I'm Rivet, just joined the pod. As I post this, nothing is running me yet, "
  + "so mentioning me won't reach anyone. Whoever installed me can connect me from my Settings — "
  + `then @rivet will get through. ${snapshotPointer('rivet')}`;

// Real-shaped ObjectId hex strings, as the bot user and pod ids are in production.
const AGENT_ID = '6560a1b2c3d4e5f6a7b8c9d0';
const POD_ID = '6560a1b2c3d4e5f6a7b8c9d1';

const previousHost = process.env.PG_HOST;
beforeAll(() => { process.env.PG_HOST = 'fake'; });
afterAll(() => {
  if (previousHost === undefined) delete process.env.PG_HOST;
  else process.env.PG_HOST = previousHost;
});

let writes;
beforeEach(() => {
  writes = 0;
  mockResolve.mockReset();
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(async (sql) => {
    if (/^\s*SELECT/i.test(sql)) {
      const row = { id: 7, pod_id: POD_ID, content: NEVER, payload: { kind: 'install-intro' } };
      return { rows: [row] };
    }
    writes += 1;
    return { rows: [{ id: 7 }] };
  });
});

describe('first-listen rewrite beside the stalled-connect close (F666)', () => {
  it('a close that never settles still lets the rewrite answer its count', async () => {
    mockResolve.mockReturnValue(new Promise(() => {}));
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT_ID, podIds: [POD_ID] })).toBe(1);
    expect(writes).toBe(1);
    expect(mockResolve).toHaveBeenCalledWith(AGENT_ID);
  });

  it('a close that rejects or throws still lets the rewrite answer its count', async () => {
    mockResolve.mockRejectedValueOnce(new Error('mongo down'));
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT_ID, podIds: [POD_ID] })).toBe(1);
    mockResolve.mockImplementationOnce(() => { throw new Error('sync throw'); });
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT_ID, podIds: [POD_ID] })).toBe(1);
  });

  it('a prompt close has finished by the time the settle returns', async () => {
    let closed = false;
    mockResolve.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); closed = true; });
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT_ID, podIds: [POD_ID] })).toBe(1);
    expect(closed).toBe(true);
  });
});

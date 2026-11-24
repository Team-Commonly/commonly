// Real Mongo: the once-per-seat guarantee is the unique _id index, so a mock
// cannot prove it. Two concurrent first calls with one token must leave one row.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const { recordByoEvent, runStopsFor, seatRegisteredKey } = require('../../services/byoTelemetry');

const rows = () => mongoose.connection.db.collection('byo_telemetry').find({}).toArray();

describe('byo_telemetry seat-registered on real Mongo', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    // clearMongoDb only resets model collections; byo_telemetry is a raw collection.
    await mongoose.connection.db.collection('byo_telemetry').deleteMany({});
  });

  it('two concurrent first calls with one token leave exactly one row', async () => {
    const key = seatRegisteredKey('token-record-hash');

    await Promise.all([
      recordByoEvent('human-1', 'seat-registered', {}, key),
      recordByoEvent('human-1', 'seat-registered', {}, key),
    ]);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]._id).toBe(key);
    expect(stored[0]).toEqual(expect.objectContaining({ userId: 'human-1', step: 'seat-registered' }));
    expect(stored[0].at).toBeInstanceOf(Date);
  });

  it('a different token for the same installer is a separate seat row', async () => {
    await Promise.all([
      recordByoEvent('human-1', 'seat-registered', {}, seatRegisteredKey('token-a')),
      recordByoEvent('human-1', 'seat-registered', {}, seatRegisteredKey('token-b')),
    ]);

    expect(await rows()).toHaveLength(2);
  });

  it('keyless browser rows keep a Mongo-generated _id', async () => {
    await recordByoEvent('human-1', 'seat-created');
    await recordByoEvent('human-1', 'seat-created');

    const stored = await rows();
    expect(stored).toHaveLength(2);
    stored.forEach((row) => expect(row._id).toBeInstanceOf(mongoose.Types.ObjectId));
  });
});

// F571: the connect page reads a person's run-stopped rows back, for their own
// installations only, whichever form (string or ObjectId) the owner was stored in.
describe('runStopsFor on real Mongo', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await mongoose.connection.db.collection('byo_telemetry').deleteMany({});
  });

  it('returns only this owner\'s run-stopped rows for the named installations, newest first', async () => {
    const owner = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const mine = new mongoose.Types.ObjectId();
    const notListed = new mongoose.Types.ObjectId();
    await recordByoEvent(owner, 'run-stopped', { reason: 'no-token', installationId: mine }, `run-stopped:${mine}:no-token`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await recordByoEvent(owner, 'run-stopped', { reason: 'token-refused', installationId: mine }, `run-stopped:${mine}:token-refused`);
    await recordByoEvent(owner, 'run-stopped', { reason: 'token-refused', installationId: notListed });
    await recordByoEvent(other, 'run-stopped', { reason: 'token-refused', installationId: mine });
    await recordByoEvent(owner, 'seat-registered', { installationId: mine });

    const found = await runStopsFor(String(owner), [mine]);

    expect(found.map((row) => row.reason)).toEqual(['token-refused', 'no-token']);
    found.forEach((row) => {
      expect(Object.keys(row).sort()).toEqual(['at', 'installationId', 'reason']);
      expect(String(row.installationId)).toBe(String(mine));
    });
    expect(await runStopsFor(String(owner), [])).toEqual([]);
  });
});

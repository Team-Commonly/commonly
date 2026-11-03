// Real Mongo: the once-per-seat guarantee is the unique _id index, so a mock
// cannot prove it. Two concurrent first calls with one token must leave one row.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const { recordByoEvent, seatRegisteredKey, byoCopiesSince } = require('../../services/byoTelemetry');

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

  // The copy marks on the user are write-once, so a later agent needs these
  // timed rows to say what was copied for it (TASK-345).
  it('counts copies by kind from the given time on, for that person only, matching the string userId', async () => {
    const since = new Date('2026-11-02T16:52:00Z');
    const at = (iso) => new Date(iso);
    await mongoose.connection.db.collection('byo_telemetry').insertMany([
      { userId: 'human-1', step: 'cli-command-copied', at: at('2026-10-20T10:00:00Z') },
      { userId: 'human-1', step: 'mcp-command-copied', at: at('2026-11-02T16:53:00Z') },
      { userId: 'human-1', step: 'mcp-command-copied', at: at('2026-11-02T16:54:00Z') },
      { userId: 'human-1', step: 'page-viewed', at: at('2026-11-02T16:55:00Z') },
      { userId: 'human-2', step: 'cli-command-copied', at: at('2026-11-02T17:00:00Z') },
    ]);
    expect(await byoCopiesSince('human-1', since)).toEqual({ mcp: 2, listener: 0 });

    await mongoose.connection.db.collection('byo_telemetry').insertMany([
      { userId: 'human-1', step: 'cli-command-copied', at: at('2026-11-02T17:05:00Z') },
      { userId: 'human-1', step: 'daemon-command-copied', at: at('2026-11-02T17:06:00Z') },
    ]);
    expect(await byoCopiesSince('human-1', since)).toEqual({ mcp: 2, listener: 2 });
    // An ObjectId caller is matched by its string form.
    const id = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('byo_telemetry').insertOne({ userId: String(id), step: 'mcp-command-copied', at: at('2026-11-03T00:00:00Z') });
    expect(await byoCopiesSince(id, since)).toEqual({ mcp: 1, listener: 0 });
  });
});

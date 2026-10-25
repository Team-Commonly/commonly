/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const mongoose = require('mongoose');
const Cursor = require('../../../models/AgentPodReadCursor');
const { getReadWatermark, advanceReadWatermark } = require('../../../repositories/agentPodReadCursorRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

const at = (seconds) => new Date(Date.UTC(2026, 9, 25, 0, 0, seconds));
describe('read cursor repository (Mongo implementation)', () => {
  const agent = new mongoose.Types.ObjectId();
  const pod = new mongoose.Types.ObjectId();
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => { await Cursor.deleteMany({}); });

  it('returns null for an absent cursor and only a plain watermark after a round trip', async () => {
    expect(await getReadWatermark(agent, pod)).toBeNull();
    await advanceReadWatermark(agent, pod, { readAt: at(1) });
    const value = await getReadWatermark(agent, pod);
    expect(value).toEqual({ readAt: at(1) });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value.save).toBeUndefined();
    const row = await Cursor.findById(`${agent}:${pod}`).lean();
    expect(String(row.agentUserId)).toBe(String(agent));
    expect(String(row.podId)).toBe(String(pod));
    expect(row.readRevision).toBeUndefined();
  });

  it('preserves independent maxima and an existing revision when omitted', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: 3 });
    await advanceReadWatermark(agent, pod, { readAt: at(1), readRevision: 5 });
    expect(await getReadWatermark(String(agent), String(pod))).toEqual({ readAt: at(2), readRevision: 5 });
    await advanceReadWatermark(agent, pod, { readAt: at(4) });
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(4), readRevision: 5 });
  });

  it('isolates both the agent and pod parts of the key', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2) });
    expect(await getReadWatermark(new mongoose.Types.ObjectId(), pod)).toBeNull();
    expect(await getReadWatermark(agent, new mongoose.Types.ObjectId())).toBeNull();
  });

  it('concurrent first reads converge on one row without rolling either maximum back', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => advanceReadWatermark(agent, pod, {
      readAt: at(i), readRevision: 20 - i,
    })));
    expect(await Cursor.countDocuments({})).toBe(1);
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(19), readRevision: 20 });
  });

  it('retries only duplicate-key upserts and propagates other write/read errors', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(1) });
    const update = jest.spyOn(Cursor, 'updateOne').mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: 0 });
    expect(update.mock.calls[1]).toEqual([{ _id: `${agent}:${pod}` }, { $max: { readAt: at(2), readRevision: 0 } }]);
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(2), readRevision: 0 });
    update.mockRejectedValueOnce(new Error('down'));
    await expect(advanceReadWatermark(agent, pod, { readAt: at(3) })).rejects.toThrow('down');
    jest.spyOn(Cursor, 'findOne').mockImplementationOnce(() => { throw new Error('read down'); });
    await expect(getReadWatermark(agent, pod)).rejects.toThrow('read down');
  });
});

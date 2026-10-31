/**
 * TASK-718: the creator rule the backfill stamps from. This decides which rows
 * may be attributed at all; the write path (compare-and-set, idempotence) is in
 * the service test.
 */
const mongoose = require('mongoose');
const { CREATED_BY_PREFIX, decideCreator } = require('../../../scripts/backfill-task-created-by');

describe('decideCreator', () => {
  const wren = new mongoose.Types.ObjectId();

  it('takes the creator from a first "Created by" update', () => {
    expect(decideCreator({ updates: [{ text: 'Created by wren · assigned to wren', authorId: String(wren) }] }))
      .toEqual({ creatorId: String(wren) });
  });

  it('reads an ObjectId authorId as its hex string', () => {
    expect(decideCreator({ updates: [{ text: 'Created by wren', authorId: wren }] }))
      .toEqual({ creatorId: wren.toHexString() });
  });

  it('never takes a claimant as the creator', () => {
    // A row whose first update is a claim carries the claimant's id. Granting the
    // creator override on that id would let the claimant override its own lease.
    expect(decideCreator({
      updates: [
        { text: 'Claimed by wren', authorId: String(wren) },
        { text: 'Created by lily-shen', authorId: String(wren) },
      ],
    })).toEqual({ reason: 'no-created-by-first-update' });
  });

  it('does not read a "Created by" update that is not first', () => {
    expect(decideCreator({
      updates: [
        { text: 'lily-shen updated: notes', authorId: String(wren) },
        { text: 'Created by wren', authorId: String(wren) },
      ],
    })).toEqual({ reason: 'no-created-by-first-update' });
  });

  it('leaves a row null when its "Created by" update has no author', () => {
    expect(decideCreator({ updates: [{ text: 'Created by system', authorId: null }] }))
      .toEqual({ reason: 'created-by-without-author' });
    expect(decideCreator({ updates: [{ text: 'Created by system', authorId: '   ' }] }))
      .toEqual({ reason: 'created-by-without-author' });
  });

  it('handles a row with no updates', () => {
    expect(decideCreator({ updates: [] })).toEqual({ reason: 'no-created-by-first-update' });
    expect(decideCreator({ updates: null })).toEqual({ reason: 'no-created-by-first-update' });
    expect(decideCreator({})).toEqual({ reason: 'no-created-by-first-update' });
  });

  it('matches the prefix the create path writes', () => {
    expect(CREATED_BY_PREFIX).toBe('Created by ');
  });
});

describe('requiring the backfill runs nothing', () => {
  it('does not exit, because main() sits behind require.main === module', () => {
    const originalUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    // An unguarded main() exits here when MONGO_URI is missing, synchronously.
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        require('../../../scripts/backfill-task-created-by');
      });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      if (originalUri !== undefined) process.env.MONGO_URI = originalUri;
    }
  });
});

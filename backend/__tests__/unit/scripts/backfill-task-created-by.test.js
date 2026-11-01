/**
 * TASK-718: the creator rule the backfill stamps from, and the reading of the
 * frozen id file. This decides which rows may be attributed at all, and what an
 * SRE run may apply; the write path (compare-and-set, idempotence, the frozen
 * set at apply time) is in the service test.
 */
const mongoose = require('mongoose');
const {
  CREATED_BY_PREFIX,
  backfillTaskCreatedBy,
  decideCreator,
  parseArgs,
  parseIdsText,
  renderIdsText,
} = require('../../../scripts/backfill-task-created-by');

const ID_A = '6ae5a1fc0a8ccf82743b94b8';
const ID_B = '6ae6757a0a8ccf827470b00b';

describe('decideCreator', () => {
  const wren = new mongoose.Types.ObjectId();
  const createdAt = new Date('2026-10-30T12:00:00.000Z');
  // The create path writes the row and its init update a few ms apart, so the
  // init update carries the row's author name and its own createdAt.
  const init = (text, { author = 'wren', at = createdAt } = {}) => ({
    text, author, authorId: String(wren), createdAt: at,
  });

  it('takes the creator from a first "Created by" update', () => {
    expect(decideCreator({ createdAt, updates: [init('Created by wren · assigned to wren')] }))
      .toEqual({ creatorId: String(wren) });
  });

  it('reads an ObjectId authorId as its hex string', () => {
    expect(decideCreator({ createdAt, updates: [{ ...init('Created by wren'), authorId: wren }] }))
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

  it('leaves a row null when the name in its "Created by" text is not its author', () => {
    expect(decideCreator({ createdAt, updates: [init('Created by lily-shen', { author: 'wren' })] }))
      .toEqual({ reason: 'created-by-not-its-author' });
    // "wren2" is not "wren": the name ends at a space or at the end of the text.
    expect(decideCreator({ createdAt, updates: [init('Created by wren2 · notes', { author: 'wren' })] }))
      .toEqual({ reason: 'created-by-not-its-author' });
  });

  it('leaves a row null when its "Created by" update was not written at the create', () => {
    // A note can open with "Created by " too. Only the create writes the stamp.
    const later = new Date(createdAt.getTime() + 60 * 60 * 1000);
    expect(decideCreator({ createdAt, updates: [init('Created by wren', { at: later })] }))
      .toEqual({ reason: 'created-by-not-at-create' });
    expect(decideCreator({ updates: [init('Created by wren')] }))
      .toEqual({ reason: 'created-by-not-at-create' });
  });

  it('accepts an init update a few ms after the row, as the create path writes it', () => {
    const shortly = new Date(createdAt.getTime() + 20);
    expect(decideCreator({ createdAt, updates: [init('Created by wren', { at: shortly })] }))
      .toEqual({ creatorId: String(wren) });
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

describe('parseIdsText', () => {
  it('reads one ObjectId per line, skipping blanks and CRLF, keeping each id once', () => {
    expect(parseIdsText(`${ID_A}\r\n\n  ${ID_B}  \n${ID_A}\n`)).toEqual([ID_A, ID_B]);
  });

  it('refuses a line that is not an ObjectId, naming the line and not its content', () => {
    expect(() => parseIdsText(`${ID_A}\nTASK-718 wren\n`))
      .toThrow(/^line 2 of the ids file is not an ObjectId$/);
  });
});

describe('renderIdsText', () => {
  it('writes one id per line, and nothing for an empty set', () => {
    expect(renderIdsText([ID_A, ID_B])).toBe(`${ID_A}\n${ID_B}\n`);
    expect(renderIdsText([])).toBe('');
  });
});

describe('backfillTaskCreatedBy', () => {
  it('refuses an apply over an empty id set before it reads the database', async () => {
    await expect(backfillTaskCreatedBy({ apply: true, ids: [] })).rejects.toThrow('the frozen id set is empty');
  });
});

describe('parseArgs', () => {
  it('a dry run writes the ids it would stamp to --out, and reads no file', () => {
    expect(parseArgs(['--out', 'ids.txt'])).toEqual({ apply: false, outPath: 'ids.txt' });
  });

  it('an apply takes its frozen set from --ids, and refuses to run without one', () => {
    expect(parseArgs(['--apply', '--ids', 'ids.txt'])).toEqual({ apply: true, idsPath: 'ids.txt' });
    expect(() => parseArgs(['--apply'])).toThrow(/--apply needs --ids/);
  });

  it('an out file does not go with an apply', () => {
    expect(() => parseArgs(['--apply', '--ids', 'ids.txt', '--out', 'more.txt']))
      .toThrow(/does not go with --apply/);
  });

  it('a flag with no path is refused', () => {
    expect(() => parseArgs(['--out'])).toThrow('--out needs a file path');
    expect(() => parseArgs(['--ids', '--apply'])).toThrow('--ids needs a file path');
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

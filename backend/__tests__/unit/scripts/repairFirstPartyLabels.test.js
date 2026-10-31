// The planner behind scripts/repair-first-party-labels (TASK-551). Each repair
// rule is pinned on its own, the rows it must leave alone are pinned too, and
// a label another agent already holds is held rather than written.
const {
  planLabelRepairs, splitRepairs, mirrorLabel, takenByLabel, writeRepair,
} = require('../../../scripts/repair-first-party-labels');

const row = (overrides) => ({
  id: 'u1',
  username: 'scout',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'scout',
  ...overrides,
});

describe('planLabelRepairs', () => {
  it('gives a first-party agent stored under its bare agentName its curated label', () => {
    expect(planLabelRepairs([row({ displayName: 'scout' })])).toEqual([
      {
        id: 'u1', username: 'scout', from: 'scout', to: 'Scout', reason: 'first-party',
      },
    ]);
  });

  it('fills a blank first-party label', () => {
    expect(planLabelRepairs([row({ displayName: '' })])).toEqual([
      expect.objectContaining({ from: '', to: 'Scout', reason: 'first-party' }),
    ]);
  });

  it('strips the (Default) suffix from a first-party default-instance row', () => {
    expect(planLabelRepairs([row({ displayName: 'Scout (Default)' })])).toEqual([
      {
        id: 'u1', username: 'scout', from: 'Scout (Default)', to: 'Scout', reason: 'default-suffix',
      },
    ]);
  });

  it('leaves a non-first-party default row alone', () => {
    expect(planLabelRepairs([
      row({ agentName: 'pixel', username: 'pixel', displayName: 'Pixel (Default)' }),
    ])).toEqual([]);
  });

  it('does not strip a (Default) suffix when the stripped label is not the curated label of its agent', () => {
    expect(planLabelRepairs([
      row({ displayName: 'My Scout (Default)' }),
    ])).toEqual([]);
  });

  it('leaves a (Default) label alone on an agent with no curated name', () => {
    expect(planLabelRepairs([
      row({ agentName: 'helper', username: 'helper', displayName: 'Scout (Default)' }),
    ])).toEqual([]);
  });

  it('leaves a named instance alone, even when its label ends in (Default)', () => {
    expect(planLabelRepairs([
      row({ instanceId: 'scout-demo', displayName: 'Scout (Default)' }),
    ])).toEqual([]);
  });

  it('does not strip a suffix that is the whole label', () => {
    expect(planLabelRepairs([
      row({ displayName: ' (Default)' }),
    ])).toEqual([]);
  });

  it('leaves a blank label alone for an agent without a curated name', () => {
    expect(planLabelRepairs([
      row({ agentName: 'pixel', username: 'pixel', displayName: '' }),
    ])).toEqual([]);
  });

  it('is idempotent: correct labels produce no repairs', () => {
    expect(planLabelRepairs([
      row({ displayName: 'Scout' }),
      row({
        id: 'u2', agentName: 'pixel', username: 'pixel', displayName: 'Pixel',
      }),
    ])).toEqual([]);
  });

  it('holds a first-party default row whose label a named peer already holds', () => {
    const rows = [
      row({ displayName: 'Scout (Default)' }),
      row({
        id: 'u2', agentName: 'openclaw', username: 'scout-named', instanceId: 'scout', displayName: 'Scout',
      }),
    ];
    expect(planLabelRepairs(rows, takenByLabel(rows))).toEqual([
      expect.objectContaining({ id: 'u1', to: 'Scout', heldBy: ['scout'] }),
    ]);
  });

  it('repairs a label that only a per-user row holds', () => {
    const rows = [
      row({ displayName: 'Scout (Default)' }),
      row({
        id: 'u2', username: 'scout-u0da521ab41', instanceId: 'u0da521ab41', displayName: 'Scout',
      }),
    ];
    const [repair] = planLabelRepairs(rows, takenByLabel(rows));
    expect(repair.to).toBe('Scout');
    expect(repair.heldBy).toBeUndefined();
  });

  it('per-user rows neither hold nor contest a label', () => {
    const rows = [
      row({
        id: 'u1', username: 'scout-a', instanceId: 'u0da521ab41', displayName: 'scout',
      }),
      row({
        id: 'u2', username: 'scout-b', instanceId: 'uabcdef0123', displayName: '',
      }),
    ];
    expect(planLabelRepairs(rows, takenByLabel(rows))).toEqual([
      {
        id: 'u1', username: 'scout-a', from: 'scout', to: 'Scout', reason: 'first-party',
      },
      {
        id: 'u2', username: 'scout-b', from: '', to: 'Scout', reason: 'first-party',
      },
    ]);
  });

  it('holds both non-per-user repairs that would land on one label in the same run', () => {
    expect(planLabelRepairs([
      row({ id: 'u1', instanceId: 'default', displayName: 'Scout (Default)' }),
      row({
        id: 'u2', username: 'scout-named', instanceId: 'scout', displayName: '',
      }),
    ])).toEqual([
      expect.objectContaining({ id: 'u1', heldBy: ['scout'] }),
      expect.objectContaining({ id: 'u2', heldBy: ['default'] }),
    ]);
  });
  it('a community scout holds the Scout repair, whatever the case of its label', () => {
    const rows = [
      row({ displayName: 'scout' }),
      row({
        id: 'u2', agentName: 'openclaw', username: 'scout-community', instanceId: 'scout', displayName: 'scout',
      }),
    ];
    expect(planLabelRepairs(rows, takenByLabel(rows))).toEqual([
      expect.objectContaining({ id: 'u1', to: 'Scout', heldBy: ['scout'] }),
    ]);
  });

  it('does not hold a bare scout row against its own repair', () => {
    const rows = [row({ displayName: 'scout' })];
    const [repair] = planLabelRepairs(rows, takenByLabel(rows));
    expect(repair).toEqual({
      id: 'u1', username: 'scout', from: 'scout', to: 'Scout', reason: 'first-party',
    });
    expect(repair.heldBy).toBeUndefined();
  });
});

describe('takenByLabel', () => {
  it('keys each non-blank label by its trimmed, lowercased form, holding row ids', () => {
    const rows = [
      row({ id: 'u1', displayName: ' Scout ' }),
      row({
        id: 'u2', agentName: 'openclaw', username: 'scout-community', instanceId: 'scout', displayName: 'scout',
      }),
      row({ id: 'u3', displayName: '' }),
    ];
    expect(takenByLabel(rows)).toEqual(new Map([['scout', ['u1', 'u2']]]));
  });
});

describe('splitRepairs', () => {
  it('skips a first-party default row whose target label a named peer holds, and never writes it', () => {
    const rows = [
      row({ displayName: 'Scout (Default)' }),
      row({
        id: 'u2', agentName: 'openclaw', username: 'lab', instanceId: 'lab', displayName: 'Scout',
      }),
    ];
    const { writable, skipped } = splitRepairs(planLabelRepairs(rows, takenByLabel(rows)));
    expect(writable).toEqual([]);
    expect(skipped).toEqual([expect.objectContaining({ id: 'u1', to: 'Scout', heldBy: ['lab'] })]);
  });

  it('still writes a per-user repair onto the label a skipped row would have taken', () => {
    const rows = [
      row({ displayName: 'Scout (Default)' }),
      row({
        id: 'u2', username: 'scout-u0da521ab41', instanceId: 'u0da521ab41', displayName: 'scout',
      }),
      row({
        id: 'u3', agentName: 'openclaw', username: 'lab', instanceId: 'lab', displayName: 'Scout',
      }),
    ];
    const { writable, skipped } = splitRepairs(planLabelRepairs(rows, takenByLabel(rows)));
    expect(skipped.map((r) => r.id)).toEqual(['u1']);
    expect(writable.map((r) => r.id)).toEqual(['u2']);
  });
});

describe('mirrorLabel', () => {
  it('sets the PG username of the row and reports that a row took it', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }), end: jest.fn() };
    await expect(mirrorLabel(pool, 'u1', 'Scout')).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE users SET username = $2, updated_at = $3 WHERE _id = $1',
      ['u1', 'Scout', expect.any(Date)],
    );
  });

  it('reports false when the PG update matches no row', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0 }), end: jest.fn() };
    await expect(mirrorLabel(pool, 'u1', 'Scout')).resolves.toBe(false);
  });

  it('reports false, and touches nothing, when PG is not configured', async () => {
    await expect(mirrorLabel(null, 'u1', 'Scout')).resolves.toBe(false);
  });
});

describe('writeRepair', () => {
  const repair = {
    id: 'u1', username: 'scout', from: 'scout', to: 'Scout', reason: 'first-party',
  };

  it('stops before the Mongo write when the PG mirror updates no row', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0 }), end: jest.fn() };
    const writeMongo = jest.fn().mockResolvedValue(undefined);
    await expect(writeRepair(pool, repair, writeMongo)).resolves.toBe(false);
    expect(writeMongo).not.toHaveBeenCalled();
  });

  it('writes PG first, then Mongo, when the PG mirror updates the row', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }), end: jest.fn() };
    const writeMongo = jest.fn().mockResolvedValue(undefined);
    await expect(writeRepair(pool, repair, writeMongo)).resolves.toBe(true);
    expect(pool.query.mock.invocationCallOrder[0]).toBeLessThan(writeMongo.mock.invocationCallOrder[0]);
    expect(writeMongo).toHaveBeenCalledWith('u1', 'Scout');
  });

  it('writes Mongo alone when PG is not configured', async () => {
    const writeMongo = jest.fn().mockResolvedValue(undefined);
    await expect(writeRepair(null, repair, writeMongo)).resolves.toBe(true);
    expect(writeMongo).toHaveBeenCalledWith('u1', 'Scout');
  });
});

// The planner behind scripts/repair-first-party-labels (TASK-551). Each repair
// rule is pinned on its own, the rows it must leave alone are pinned too, and
// a label another agent already holds is held rather than written.
const { planLabelRepairs, splitRepairs } = require('../../../scripts/repair-first-party-labels');

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
    const takenBy = new Map([['Scout', ['scout']]]);
    expect(planLabelRepairs([row({ displayName: 'Scout (Default)' })], takenBy)).toEqual([
      expect.objectContaining({ to: 'Scout', heldBy: ['scout'] }),
    ]);
  });

  it('repairs a label that only a per-user row holds', () => {
    const takenBy = new Map([['Scout', ['u0da521ab41']]]);
    const [repair] = planLabelRepairs([row({ displayName: 'Scout (Default)' })], takenBy);
    expect(repair.to).toBe('Scout');
    expect(repair.heldBy).toBeUndefined();
  });

  it('per-user rows neither hold nor contest a label', () => {
    const takenBy = new Map([['Scout', ['uabcdef0123']]]);
    expect(planLabelRepairs([
      row({
        id: 'u1', username: 'scout-a', instanceId: 'u0da521ab41', displayName: 'scout',
      }),
      row({
        id: 'u2', username: 'scout-b', instanceId: 'uabcdef0123', displayName: '',
      }),
    ], takenBy)).toEqual([
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
});

describe('splitRepairs', () => {
  it('skips a first-party default row whose target label a named peer holds, and never writes it', () => {
    const repairs = planLabelRepairs([row({ displayName: 'Scout (Default)' })], new Map([['Scout', ['lab']]]));
    const { writable, skipped } = splitRepairs(repairs);
    expect(writable).toEqual([]);
    expect(skipped).toEqual([expect.objectContaining({ id: 'u1', to: 'Scout', heldBy: ['lab'] })]);
  });

  it('still writes a per-user repair onto the label a skipped row would have taken', () => {
    const repairs = planLabelRepairs([
      row({ displayName: 'Scout (Default)' }),
      row({
        id: 'u2', username: 'scout-u0da521ab41', instanceId: 'u0da521ab41', displayName: 'scout',
      }),
    ], new Map([['Scout', ['lab']]]));
    const { writable, skipped } = splitRepairs(repairs);
    expect(skipped.map((r) => r.id)).toEqual(['u1']);
    expect(writable.map((r) => r.id)).toEqual(['u2']);
  });
});

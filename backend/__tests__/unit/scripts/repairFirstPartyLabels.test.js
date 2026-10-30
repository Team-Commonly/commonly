// The planner behind scripts/repair-first-party-labels (TASK-551). Each repair
// rule is pinned on its own, and the rows it must leave alone are pinned too.
const { planLabelRepairs } = require('../../../scripts/repair-first-party-labels');

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
      { id: 'u1', username: 'scout', from: 'scout', to: 'Scout', reason: 'first-party' },
    ]);
  });

  it('fills a blank first-party label', () => {
    expect(planLabelRepairs([row({ displayName: '' })])).toEqual([
      expect.objectContaining({ from: '', to: 'Scout', reason: 'first-party' }),
    ]);
  });

  it('strips the (Default) suffix from a default-instance row', () => {
    expect(planLabelRepairs([
      row({ agentName: 'pixel', username: 'pixel', displayName: 'Pixel (Default)' }),
    ])).toEqual([
      { id: 'u1', username: 'pixel', from: 'Pixel (Default)', to: 'Pixel', reason: 'default-suffix' },
    ]);
  });

  it('repairs a first-party row that also carries the (Default) suffix', () => {
    expect(planLabelRepairs([row({ displayName: 'Scout (Default)' })])).toEqual([
      expect.objectContaining({ from: 'Scout (Default)', to: 'Scout' }),
    ]);
  });

  it('leaves a named instance alone, even when its label ends in (Default)', () => {
    expect(planLabelRepairs([
      row({ instanceId: 'scout-demo', displayName: 'Scout (Default)' }),
    ])).toEqual([]);
  });

  it('does not strip a suffix that is the whole label', () => {
    expect(planLabelRepairs([
      row({ agentName: 'pixel', displayName: ' (Default)' }),
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
      row({ id: 'u2', agentName: 'pixel', username: 'pixel', displayName: 'Pixel' }),
    ])).toEqual([]);
  });
});

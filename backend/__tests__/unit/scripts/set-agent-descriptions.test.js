jest.mock('mongoose', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), updateOne: jest.fn() }));

const { planDescriptions, DESCRIPTIONS } = require('../../../scripts/set-agent-descriptions');

describe('set-agent-descriptions plan', () => {
  test('matches by displayName first, then username, and reports what would change', () => {
    const rows = [
      { _id: 'u1', username: 'ux-lead', botMetadata: { displayName: 'UX Lead', description: '' } },
      { _id: 'u2', username: 'hq-support', botMetadata: { displayName: 'Commonly Support', description: 'Answers strangers in HQ. Never quotes, never guesses; escalates with the thread link.' } },
      { _id: 'u3', username: 'kai', botMetadata: { displayName: 'Kai (Connectors)' } },
      { _id: 'u4', username: 'someone-else', botMetadata: { displayName: 'Scout' } },
    ];
    const { plan, unmatched } = planDescriptions(rows);
    const byUser = Object.fromEntries(plan.map((p) => [p.username, p]));
    expect(byUser['ux-lead'].changed).toBe(true);
    expect(byUser['hq-support'].changed).toBe(false); // idempotent: same sentence already there
    expect(byUser['kai'].userId).toBe('u3'); // displayName miss → username hit
    expect(plan.some((p) => p.username === 'someone-else')).toBe(false); // never creates or guesses
    expect(unmatched).toEqual(DESCRIPTIONS.map((d) => d.seat).filter((s) => !['UX Lead', 'Commonly Support', 'Kai'].includes(s)));
  });

  test('every sentence obeys the brief: one sentence, under 100 characters, no quotes, role first', () => {
    for (const d of DESCRIPTIONS) {
      expect(d.description.length).toBeLessThan(100);
      expect(d.description).not.toMatch(/[“”"]/);
      expect(d.description.trim().endsWith('.')).toBe(true);
    }
  });
});

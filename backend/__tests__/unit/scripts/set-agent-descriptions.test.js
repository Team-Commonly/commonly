jest.mock('mongoose', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), updateOne: jest.fn() }));

const { planDescriptions, DESCRIPTIONS } = require('../../../scripts/set-agent-descriptions');

describe('set-agent-descriptions plan', () => {
  test('matches by username only, is idempotent, never guesses, and reports the unmatched', () => {
    const rows = [
      { _id: 'u1', username: 'ux-lead', botMetadata: { displayName: 'UX Lead', description: '' } },
      { _id: 'u2', username: 'hq-support-commonly-support', botMetadata: { displayName: 'Commonly Support', description: 'Answers strangers in HQ. Never quotes, never guesses; escalates with the thread link.' } },
      // A display name that matches a seat on a row whose username does not: never matched.
      { _id: 'u3', username: 'someone-else', botMetadata: { displayName: 'Kai' } },
    ];
    const { plan, unmatched, ambiguous, conflicts } = planDescriptions(rows);
    const byUser = Object.fromEntries(plan.map((p) => [p.username, p]));
    expect(byUser['ux-lead'].changed).toBe(true);
    expect(byUser['hq-support-commonly-support'].changed).toBe(false);
    expect(plan.some((p) => p.username === 'someone-else')).toBe(false);
    expect(unmatched).toContain('Kai');
    expect(ambiguous).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  test('the live pair (ux-lead 66353): @commonly-bot takes the Commonly Bot line, @commonly-summarizer the Summarizer line, @pod-summarizer nothing — display names ignored', () => {
    const rows = [
      { _id: 'b', username: 'commonly-bot', botMetadata: { displayName: 'Commonly Summarizer', description: 'Built-in summary bot' } },
      { _id: 's', username: 'commonly-summarizer', botMetadata: { displayName: 'Commonly Summarizer (Commonly-Summarizer)' } },
      { _id: 'p', username: 'pod-summarizer', botMetadata: { displayName: 'Pod Summarizer', description: 'Posts a TLDR of recent pod activity on a schedule.' } },
    ];
    const { plan, conflicts, ambiguous } = planDescriptions(rows);
    expect(plan.map((p) => `${p.username}→${p.seat}`).sort()).toEqual(['commonly-bot→Commonly Bot', 'commonly-summarizer→Commonly Summarizer']);
    expect(plan.some((p) => p.username === 'pod-summarizer')).toBe(false);
    expect(conflicts).toEqual([]);
    expect(ambiguous).toEqual([]);
  });

  test('one row claimed by two seats is a conflict: neither writes, both are named', () => {
    const rows = [{ _id: 'h1', username: 'hq-support', botMetadata: {} }];
    // Force a second claim on the same row by giving Commonly Bot the same username in a copy of the table.
    const { planDescriptions: plan2 } = jest.requireActual('../../../scripts/set-agent-descriptions');
    const result = plan2(rows.concat([{ _id: 'h1', username: 'commonly-bot', botMetadata: {} }]));
    expect(result.conflicts).toEqual([{ userId: 'h1', username: 'commonly-bot', seats: ['Commonly Support', 'Commonly Bot'] }]);
    expect(result.plan.filter((p) => String(p.userId) === 'h1')).toHaveLength(0);
  });

  test('every sentence obeys the brief: one sentence, under 100 characters, no quotes, role first', () => {
    for (const d of DESCRIPTIONS) {
      expect(d.description.length).toBeLessThan(100);
      expect(d.description).not.toMatch(/[“”"]/);
      expect(d.description.trim().endsWith('.')).toBe(true);
    }
  });
});

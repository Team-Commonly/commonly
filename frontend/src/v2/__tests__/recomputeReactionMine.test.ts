// Guards the socket `mine`-broadcast fix (2026-07-24). emitReactionChange sends
// one user's `mine` view to the whole room, so other clients must recompute it
// from the reaction's user list — otherwise clicking your own reaction re-adds
// instead of removing (the "un-react didn't revert" report) and chips
// mis-highlight.
import { recomputeReactionMine } from '../hooks/useV2PodDetail';

describe('recomputeReactionMine', () => {
  test('mine=true when the current user is in the reaction user list', () => {
    const out = recomputeReactionMine(
      [{ emoji: '👍', count: 2, mine: false, users: [{ id: 'a' }, { id: 'me' }] }],
      'me',
    );
    expect(out[0].mine).toBe(true);
  });

  test('mine=false when the user is NOT in the list — even if the wire said true (the bug)', () => {
    const out = recomputeReactionMine(
      [{ emoji: '👍', count: 1, mine: true, users: [{ id: 'other' }] }],
      'me',
    );
    expect(out[0].mine).toBe(false);
  });

  test('falls back to the wire mine when users is absent (older server / Mongo fallback)', () => {
    const out = recomputeReactionMine([{ emoji: '👍', count: 1, mine: true }], 'me');
    expect(out[0].mine).toBe(true);
  });

  test('falls back to the wire mine when userId is missing', () => {
    const out = recomputeReactionMine(
      [{ emoji: '👍', count: 1, mine: true, users: [{ id: 'other' }] }],
      undefined,
    );
    expect(out[0].mine).toBe(true);
  });
});

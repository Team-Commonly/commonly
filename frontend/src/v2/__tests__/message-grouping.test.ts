import { GROUPING_WINDOW_MS, isGroupedWithPrevious } from '../utils/messageGrouping';

// Craft audit finding 7 / baseline rule 3: same author within the window
// renders one header. The predicate is the whole behavior — the component
// just maps it onto the `grouped` prop — so the boundaries live here.

const at = (offsetMs: number) => new Date(1755864000000 + offsetMs).toISOString();

const msg = (over: Partial<Parameters<typeof isGroupedWithPrevious>[0]> = {}) => ({
  user_id: 'u1',
  user: { username: 'sprint-review' },
  created_at: at(0),
  ...over,
});

describe('isGroupedWithPrevious', () => {
  it('groups a same-author message inside the window', () => {
    expect(isGroupedWithPrevious(msg({ created_at: at(60_000) }), msg())).toBe(true);
  });

  it('groups exactly at the window boundary, not one ms past it', () => {
    expect(
      isGroupedWithPrevious(msg({ created_at: at(GROUPING_WINDOW_MS) }), msg()),
    ).toBe(true);
    expect(
      isGroupedWithPrevious(msg({ created_at: at(GROUPING_WINDOW_MS + 1) }), msg()),
    ).toBe(false);
  });

  it('never groups across authors, even inside the window', () => {
    expect(
      isGroupedWithPrevious(
        msg({ user_id: 'u2', created_at: at(1000) }),
        msg(),
      ),
    ).toBe(false);
  });

  it('never groups when the same user_id renders under a different username', () => {
    // Display-name overrides can change what the header would have said;
    // a silent header suppression would mis-attribute the run.
    expect(
      isGroupedWithPrevious(
        msg({ user: { username: 'renamed' }, created_at: at(1000) }),
        msg(),
      ),
    ).toBe(false);
  });

  it('replies keep their header — the quote needs an owner', () => {
    expect(
      isGroupedWithPrevious(
        msg({ reply_content: 'quoted', created_at: at(1000) }),
        msg(),
      ),
    ).toBe(false);
    expect(
      isGroupedWithPrevious(
        msg({ replyTo: { content: 'quoted' }, created_at: at(1000) }),
        msg(),
      ),
    ).toBe(false);
  });

  it('payload cards never group, on either side of the pair', () => {
    expect(
      isGroupedWithPrevious(
        msg({ payload: { kind: 'approval-card' }, created_at: at(1000) }),
        msg(),
      ),
    ).toBe(false);
    expect(
      isGroupedWithPrevious(
        msg({ created_at: at(1000) }),
        msg({ payload: { kind: 'approval-card' } }),
      ),
    ).toBe(false);
  });

  it('out-of-order or unparsable timestamps never group', () => {
    expect(
      isGroupedWithPrevious(msg(), msg({ created_at: at(1000) })),
    ).toBe(false);
    expect(
      isGroupedWithPrevious(msg({ created_at: 'not-a-date' }), msg()),
    ).toBe(false);
    expect(isGroupedWithPrevious(msg({ created_at: undefined }), msg())).toBe(false);
  });

  it('the first message of a list never groups', () => {
    expect(isGroupedWithPrevious(msg(), undefined)).toBe(false);
  });
});

import { jest } from '@jest/globals';

const {
  TAIL_PAGE_LIMIT,
  TAIL_SEEN_MAX,
  createTailPoller,
  formatTailLine,
  isAgentMessage,
} = await import('../src/lib/pod-tail.js');

// The GET returns the newest `limit` rows, oldest first. A fake source that
// re-serves the same window on every call reproduces the replay bug.
const message = (id, overrides = {}) => ({
  _id: id,
  content: `body ${id}`,
  createdAt: '2026-11-01T10:00:00.000Z',
  user: { username: 'lily', isBot: false },
  ...overrides,
});

const fakeSource = (pages) => {
  let call = 0;
  return jest.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return page;
  });
};

describe('pod tail poller', () => {
  test('prints a page that is re-served on every poll only once', async () => {
    const page = [message('m1'), message('m2'), message('m3')];
    const fetchPage = fakeSource([page, page, page]);
    const print = jest.fn();
    const poll = createTailPoller({ fetchPage, print });

    expect(await poll()).toBe(3);
    expect(await poll()).toBe(0);
    expect(await poll()).toBe(0);

    expect(print).toHaveBeenCalledTimes(3);
    expect(print.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining('body m1'),
      expect.stringContaining('body m2'),
      expect.stringContaining('body m3'),
    ]);
  });

  test('prints only the new rows when the window slides forward', async () => {
    const fetchPage = fakeSource([
      [message('m1'), message('m2')],
      [message('m2'), message('m3')],
    ]);
    const print = jest.fn();
    const poll = createTailPoller({ fetchPage, print });

    await poll();
    await poll();

    expect(print.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining('body m1'),
      expect.stringContaining('body m2'),
      expect.stringContaining('body m3'),
    ]);
  });

  test('requests the page size the poller sets', async () => {
    const fetchPage = fakeSource([[]]);
    await createTailPoller({ fetchPage, print: jest.fn() })();
    expect(fetchPage).toHaveBeenCalledWith(TAIL_PAGE_LIMIT);
  });

  test('forgets only the oldest ids once the seen set is full', async () => {
    const first = Array.from({ length: TAIL_SEEN_MAX }, (_, i) => message(`old-${i}`));
    const fetchPage = fakeSource([first, [message('new-1')], first.slice(0, 1)]);
    const print = jest.fn();
    const poll = createTailPoller({ fetchPage, print });

    await poll();
    await poll();
    // old-0 was evicted by new-1, so it prints again rather than growing the set.
    expect(await poll()).toBe(1);
    expect(print).toHaveBeenCalledTimes(TAIL_SEEN_MAX + 2);
  });
});

describe('pod tail labels and filter', () => {
  test('labels an agent from user.isBot and a human from the same field', () => {
    expect(formatTailLine(message('a', { user: { username: 'pixel', isBot: true } })))
      .toMatch(/🤖 pixel: body a$/);
    expect(formatTailLine(message('h'))).toMatch(/👤 lily: body h$/);
  });

  test('falls back to the mapped userId object when user is absent', () => {
    const agent = { _id: 'x', content: 'hi', createdAt: '2026-11-01T10:00:00.000Z', userId: { username: 'nova', isBot: true } };
    expect(isAgentMessage(agent)).toBe(true);
    expect(formatTailLine(agent)).toMatch(/🤖 nova: hi$/);
  });

  test('does not read the legacy top-level or sender isBot fields', () => {
    expect(isAgentMessage({ isBot: true })).toBe(false);
    expect(isAgentMessage({ sender: { isBot: true } })).toBe(false);
  });

  test('--filter agents prints agent posts as they arrive and drops humans', async () => {
    const fetchPage = fakeSource([
      [message('h1')],
      [message('h1'), message('a1', { user: { username: 'pixel', isBot: true } })],
      [message('h1'), message('a1', { user: { username: 'pixel', isBot: true } }), message('h2')],
    ]);
    const print = jest.fn();
    const poll = createTailPoller({ fetchPage, filter: 'agents', print });

    await poll();
    await poll();
    await poll();

    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toMatch(/🤖 pixel: body a1$/);
  });

  test('--filter humans drops agent posts', async () => {
    const fetchPage = fakeSource([
      [message('h1'), message('a1', { user: { username: 'pixel', isBot: true } })],
    ]);
    const print = jest.fn();
    await createTailPoller({ fetchPage, filter: 'humans', print })();

    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toMatch(/👤 lily: body h1$/);
  });

  test('a filtered-out message is still marked seen, so it never prints later', async () => {
    const agent = message('a1', { user: { username: 'pixel', isBot: true } });
    const fetchPage = fakeSource([[agent], [agent]]);
    const print = jest.fn();
    const poll = createTailPoller({ fetchPage, filter: 'humans', print });

    await poll();
    await poll();
    expect(print).not.toHaveBeenCalled();
  });
});

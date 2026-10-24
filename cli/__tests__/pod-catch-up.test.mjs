import { jest } from '@jest/globals';
import { catchUpBeforeTurn } from '../src/lib/pod-catch-up.js';

const hold = () => Object.assign(new Error('unread'), { status: 409, body: { code: 'unseen_messages', unseenCount: 14373 } });

test('a quiet pod does not skip history', async () => {
  const client = { get: jest.fn(async () => ({ ok: true })), post: jest.fn() };
  expect(await catchUpBeforeTurn(client, 'p')).toBe('');
  expect(client.post).not.toHaveBeenCalled();
});

test('a backlog produces a fresh turn frame with the returned conversation and honest skipped count', async () => {
  const client = { get: jest.fn(async () => { throw hold(); }), post: jest.fn(async () => ({
    catchUp: { skippedCount: 14353 }, messages: [{ id: 'latest', content: 'new instruction' }],
  })) };
  const frame = await catchUpBeforeTurn(client, 'p');
  expect(client.post).toHaveBeenCalledWith('/api/agents/runtime/pods/p/catch-up', { confirmSkipHistory: true });
  expect(frame).toContain('Skipped 14353 unread historical messages. They were not read.');
  expect(frame).toContain('new instruction');
});

test.each([Object.assign(new Error('auth'), { status: 403 }),
  Object.assign(new Error('other conflict'), { status: 409, body: { code: 'other' } }),
  new Error('network')])('does not convert another failure into permission to skip history: %s', async (error) => {
  const client = { get: jest.fn(async () => { throw error; }), post: jest.fn() };
  await expect(catchUpBeforeTurn(client, 'p')).rejects.toBe(error);
  expect(client.post).not.toHaveBeenCalled();
});

test('failed catch-up and malformed receipts prevent generation', async () => {
  const client = { get: jest.fn(async () => { throw hold(); }), post: jest.fn(async () => ({})) };
  await expect(catchUpBeforeTurn(client, 'p')).rejects.toThrow('Invalid catch-up receipt');
  client.post.mockRejectedValueOnce(new Error('store unavailable'));
  await expect(catchUpBeforeTurn(client, 'p')).rejects.toThrow('store unavailable');
});


test.each([1, 25, 50])('reads %s unread messages normally without requesting a skip', async (unseenCount) => {
  const client = { get: jest.fn(async (route) => {
    if (route.endsWith('/send-freshness')) throw Object.assign(hold(), { body: { code: 'unseen_messages', unseenCount } });
    return { messages: [{ content: 'ordinary tail' }] };
  }), post: jest.fn() };
  const frame = await catchUpBeforeTurn(client, 'p');
  expect(client.get).toHaveBeenLastCalledWith('/api/agents/runtime/pods/p/messages', { limit: 50 });
  expect(client.post).not.toHaveBeenCalled();
  expect(frame).toContain('ordinary tail');
  expect(frame).not.toContain('Skipped');
});

test('51 unread messages exceed the ordinary cap and request explicit catch-up', async () => {
  const client = { get: jest.fn(async () => { throw Object.assign(hold(), { body: { code: 'unseen_messages', unseenCount: 51 } }); }),
    post: jest.fn(async () => ({ messages: [], catchUp: { skippedCount: 31 } })) };
  expect(await catchUpBeforeTurn(client, 'p')).toContain('Skipped 31');
  expect(client.post).toHaveBeenCalledTimes(1);
});

test.each([404, 405])('an older backend without catch-up (%s) retains existing turn behavior', async (status) => {
  const client = { get: jest.fn(async () => { throw hold(); }), post: jest.fn(async () => {
    throw Object.assign(new Error('unsupported route'), { status });
  }) };
  expect(await catchUpBeforeTurn(client, 'p')).toBe('');
});

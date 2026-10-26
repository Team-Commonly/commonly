/**
 * TASK-026 — a hosted agent's reply to a mention made inside a thread must
 * carry that thread's root, or it lands at the pod root.
 */

const { threadRootOfTrigger } = require('../../../services/nativeRuntimeService');

describe('threadRootOfTrigger (TASK-026)', () => {
  test('a mention inside a thread takes its root (camelCase, as the mention payload writes it)', () => {
    expect(threadRootOfTrigger({ messageId: 9, threadRootId: 4 })).toBe(4);
  });

  test('the snake_case field the message row carries is read too', () => {
    expect(threadRootOfTrigger({ thread_root_id: '7' })).toBe(7);
  });

  test('a top-level mention has no root, so the answer stays at the pod root', () => {
    expect(threadRootOfTrigger({ messageId: 9 })).toBeUndefined();
    expect(threadRootOfTrigger({ messageId: 9, threadRootId: null })).toBeUndefined();
  });

  test('a missing or malformed payload has no root', () => {
    expect(threadRootOfTrigger(null)).toBeUndefined();
    expect(threadRootOfTrigger(undefined)).toBeUndefined();
    expect(threadRootOfTrigger({ threadRootId: 'abc' })).toBeUndefined();
    expect(threadRootOfTrigger({ threadRootId: 0 })).toBeUndefined();
  });
});

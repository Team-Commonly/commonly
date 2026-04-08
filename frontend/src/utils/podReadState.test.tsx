// @ts-nocheck
import {
  readPodLastReadAt,
  writePodLastReadAt,
  resolveLatestMessageTimestampMs,
  markPodReadFromMessages,
} from './podReadState';

describe('podReadState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('writes and reads pod cursor timestamps', () => {
    writePodLastReadAt('u1', 'p1', 1700000000000);
    expect(readPodLastReadAt('u1', 'p1')).toBe(1700000000000);
  });

  test('resolves latest timestamp from mixed message shapes', () => {
    const latest = resolveLatestMessageTimestampMs([
      { created_at: '2024-01-01T00:00:00.000Z' },
      { createdAt: '2024-01-01T01:00:00.000Z' },
      { timestamp: '2024-01-01T00:30:00.000Z' },
    ]);
    expect(latest).toBe(new Date('2024-01-01T01:00:00.000Z').getTime());
  });

  test('markPodReadFromMessages keeps monotonic cursor', () => {
    writePodLastReadAt('u1', 'p1', new Date('2024-01-01T02:00:00.000Z').getTime());
    markPodReadFromMessages({
      userId: 'u1',
      podId: 'p1',
      messages: [{ createdAt: '2024-01-01T01:00:00.000Z' }],
    });
    expect(readPodLastReadAt('u1', 'p1')).toBe(new Date('2024-01-01T02:00:00.000Z').getTime());
  });
});

import { buildThreadView } from '../utils/threadView';

const claim = (id: number, taskId: string, opts: Partial<any> = {}) => ({
  id: String(id),
  pod_id: 'pod-1',
  user_id: 'u1',
  content: '',
  message_type: 'system',
  created_at: `2026-10-31T10:0${id % 10}:00Z`,
  thread_root_id: opts.thread_root_id ?? null,
  payload: { kind: 'system-action', action: 'task-claimed', taskId, actorName: 'Scout' },
} as any);

const text = (id: number) => ({
  id: String(id),
  pod_id: 'pod-1',
  user_id: 'u2',
  content: `m${id}`,
  message_type: 'text',
  created_at: `2026-10-31T10:0${id % 10}:00Z`,
  thread_root_id: null,
} as any);

const state = (ids: number[]) => new Map(
  ids.map((i) => [String(i), { threadRootId: i, following: null, collapsed: true }]),
) as any;

describe('consecutive claim lines fold into one summary item', () => {
  test('two adjacent claims become one claims item, in order', () => {
    const items = buildThreadView([claim(1, 'TASK-674'), claim(2, 'TASK-675')], state([]));
    expect(items.map((i) => i.kind)).toEqual(['claims']);
    expect(items[0]).toMatchObject({ kind: 'claims', key: '1' });
    expect((items[0] as any).messages.map((m: any) => m.id)).toEqual(['1', '2']);
  });

  test('a single claim stays a plain message', () => {
    const items = buildThreadView([text(1), claim(2, 'TASK-674'), text(3)], state([]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'message']);
  });

  test('a normal message between claims ends the run', () => {
    const items = buildThreadView(
      [claim(1, 'TASK-674'), claim(2, 'TASK-675'), text(3), claim(4, 'TASK-676'), claim(5, 'TASK-677')],
      state([]),
    );
    expect(items.map((i) => i.kind)).toEqual(['claims', 'message', 'claims']);
  });

  test('a claim that roots a thread stays a message so its card still renders', () => {
    const items = buildThreadView(
      [claim(1, 'TASK-674'), claim(2, 'TASK-675'), claim(3, 'TASK-676', {}), claim(4, 'TASK-677', { thread_root_id: 3 })],
      state([3]),
    );
    expect(items.map((i) => i.kind)).toEqual(['claims', 'message', 'card']);
    expect(items[1]).toMatchObject({ kind: 'message', message: { id: '3' } });
  });
});

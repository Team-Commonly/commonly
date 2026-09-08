import { jest } from '@jest/globals';

const {
  FOCUS_FRAME_MAX_CODE_POINTS,
  FOCUS_TASK_TITLE_MAX_CODE_POINTS,
  PodFocusError,
  formatPodFocusFrame,
  readPodFocus,
} = await import('../src/lib/pod-focus.js');

const populatedRead = (overrides = {}) => ({
  podId: 'pod-1',
  revision: 7,
  focus: {
    goal: 'Ship the shared pod focus pilot',
    scope: 'CLI delivery only',
    owner: { userId: 'user-1', label: 'Lily', available: true },
    nextTasks: [
      {
        taskId: 'TASK-129',
        available: true,
        title: 'Add the turn-start read',
        status: 'claimed',
        assignee: 'kai',
        updatedAt: '2026-09-08T02:00:00.000Z',
      },
      {
        taskId: 'TASK-130',
        available: false,
        title: 'Unavailable task',
        status: null,
        assignee: null,
        updatedAt: null,
      },
    ],
  },
  ...overrides,
});

describe('pod focus formatter', () => {
  test('renders an explicit no-focus value', () => {
    const frame = formatPodFocusFrame({ podId: 'pod-empty', revision: 9, focus: null });
    expect(frame).toContain('pod: pod-empty');
    expect(frame).toContain('revision: 9');
    expect(frame).toContain('No focus set.');
    expect(frame).toContain('not instructions');
  });

  test('preserves protected fields and task order while bounding Unicode titles', () => {
    const longTitle = '🧭'.repeat(200) + '\nsecond paragraph';
    const frame = formatPodFocusFrame(populatedRead({
      focus: {
        ...populatedRead().focus,
        nextTasks: populatedRead().focus.nextTasks.map((task, index) => (
          index === 0 ? { ...task, title: longTitle } : task
        )),
      },
    }));
    expect(Array.from(frame).length).toBeLessThanOrEqual(FOCUS_FRAME_MAX_CODE_POINTS);
    expect(frame).toContain('revision: 7');
    expect(frame).toContain('goal: Ship the shared pod focus pilot');
    expect(frame).toContain('scope: CLI delivery only');
    expect(frame).toContain('owner: Lily (user-1)');
    expect(frame).toContain('TASK-129 → TASK-130');
    expect(frame).toContain('…');
    expect(frame).toContain('full task details in board / get_context.');
    expect(Array.from(longTitle).length).toBeGreaterThan(FOCUS_TASK_TITLE_MAX_CODE_POINTS);
    expect(frame).not.toContain(longTitle);
  });

  test('fails closed when protected fields exceed the cap', () => {
    const read = populatedRead({
      focus: {
        ...populatedRead().focus,
        owner: { userId: 'u', label: 'x'.repeat(200), available: true },
      },
    });
    expect(() => formatPodFocusFrame(read, { maxCodePoints: 100 })).toThrow(PodFocusError);
    try {
      formatPodFocusFrame(read, { maxCodePoints: 100 });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'FOCUS_FRAME_PROTECTED_OVERFLOW',
        allowedCodePoints: 100,
      });
      expect(error.measuredCodePoints).toBeGreaterThan(100);
    }
  });

  test('uses Unicode code points, not UTF-16 units, for the budget', () => {
    const read = populatedRead({
      focus: {
        ...populatedRead().focus,
        goal: '😀'.repeat(20),
      },
    });
    const frame = formatPodFocusFrame(read, { maxCodePoints: 300 });
    expect(Array.from(frame).length).toBeLessThanOrEqual(300);
    expect(frame).toContain(`goal: ${'😀'.repeat(20)}`);
  });

  test('keeps all ten ordered task ids with multi-paragraph labels inside the cap', () => {
    const nextTasks = Array.from({ length: 10 }, (_, index) => ({
      taskId: `TASK-${200 + index}`,
      available: true,
      title: `Task ${index}\n\n${'detail '.repeat(80)}`,
      status: 'pending',
      assignee: 'kai',
      updatedAt: '2026-09-08T02:00:00.000Z',
    }));
    const frame = formatPodFocusFrame(populatedRead({
      focus: { ...populatedRead().focus, nextTasks },
    }));
    expect(Array.from(frame).length).toBeLessThanOrEqual(FOCUS_FRAME_MAX_CODE_POINTS);
    expect(frame).toContain(nextTasks.map((task) => task.taskId).join(' → '));
    for (const task of nextTasks) expect(frame).toContain(task.taskId);
    expect(frame).toContain('full task details in board / get_context.');
  });
});

describe('pod focus runtime read', () => {
  test('reads the event pod through runtime context with skill synthesis disabled', async () => {
    const get = jest.fn().mockResolvedValue({
      focus: { ...populatedRead(), podId: 'pod/1', revision: 8 },
    });
    const read = await readPodFocus({ get }, 'pod/1');
    expect(get).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod%2F1/context',
      { skillMode: 'none' },
    );
    expect(read).toMatchObject({ podId: 'pod/1', revision: 8, focus: populatedRead().focus });
  });

  test('turn-start read failures are explicit and retryable', async () => {
    const get = jest.fn().mockRejectedValue(new Error('context unavailable'));
    await expect(readPodFocus({ get }, 'pod-1')).rejects.toMatchObject({
      code: 'pod_focus_read_failed',
      podId: 'pod-1',
    });
  });

  test.each([
    ['missing DTO', {}],
    ['flattened focus', { focus: populatedRead().focus, revision: 2 }],
    ['wrong pod', { focus: { ...populatedRead(), podId: 'other-pod' } }],
    ['invalid revision', { focus: { ...populatedRead(), revision: '9' } }],
    ['missing focus value', { focus: { podId: 'pod-1', revision: 9 } }],
  ])('rejects %s instead of inventing a rollout shape', async (_label, body) => {
    const get = jest.fn().mockResolvedValue(body);
    await expect(readPodFocus({ get }, 'pod-1')).rejects.toMatchObject({
      code: 'pod_focus_contract_invalid',
      podId: 'pod-1',
    });
  });
});

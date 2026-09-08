import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-focus-run-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => sessionsTmpDir },
    homedir: () => sessionsTmpDir,
  };
});

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;
const { getSession } = await import('../src/lib/session-store.js');

const noopTimeout = () => 0;
const drain = async () => {
  for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const event = (overrides = {}) => ({
  _id: 'focus-event-1',
  type: 'chat.mention',
  podId: 'pod-focus',
  agentName: 'focus-stub',
  payload: { content: 'continue the current work' },
  ...overrides,
});

describe('performRun pod-focus turn seam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('reads focus once immediately before spawn and injects the explicit no-focus value', async () => {
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: [event()] };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) return {
        focus: { podId: 'pod-focus', revision: 0, focus: null },
      };
      return {};
    });
    const post = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get, post });
    const spawn = jest.fn().mockResolvedValue({ text: 'done' });

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drain();
    stop();

    expect(get).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-focus/context',
      { skillMode: 'none' },
    );
    const focusGetIndex = get.mock.calls.findIndex(([route]) => route.endsWith('/context'));
    expect(get.mock.invocationCallOrder[focusGetIndex]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    expect(spawn.mock.calls[0][0]).toContain('No focus set.');
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/focus-event-1/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('does not spawn or acknowledge when the turn-start focus read fails', async () => {
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: [event({ _id: 'focus-fail-1' })] };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) throw new Error('focus backend unavailable');
      return {};
    });
    const post = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get, post });
    const spawn = jest.fn().mockResolvedValue({ text: 'must not run' });
    const errors = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
      onError: (error) => errors.push(error),
    });
    await drain();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([route]) => route.includes('/ack'))).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      code: 'agent_spawn_retry_scheduled',
      focusDiagnostic: {
        errorCode: 'pod_focus_read_failed',
        eventIds: ['focus-fail-1'],
        podId: 'pod-focus',
        focusRevision: null,
        measuredCodePoints: null,
        allowedCodePoints: 8000,
      },
    });
  });

  test('protected overflow fails closed with a bounded turn-start diagnostic', async () => {
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: [event({ _id: 'focus-overflow-1' })] };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) return {
        focus: {
          podId: 'pod-focus',
          revision: 9,
          focus: {
            goal: 'Repair the focus record',
            scope: 'CLI only',
            owner: { userId: 'u1', label: 'x'.repeat(9000), available: true },
            nextTasks: [],
          },
        },
      };
      return {};
    });
    const post = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get, post });
    const spawn = jest.fn().mockResolvedValue({ text: 'must not run' });
    const errors = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
      onError: (error) => errors.push(error),
    });
    await drain();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([route]) => route.includes('/ack'))).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      focusDiagnostic: {
        errorCode: 'FOCUS_FRAME_PROTECTED_OVERFLOW',
        eventIds: ['focus-overflow-1'],
        podId: 'pod-focus',
        focusRevision: 9,
        allowedCodePoints: 8000,
      },
    });
    expect(errors[0].focusDiagnostic.measuredCodePoints).toBeGreaterThan(8000);
  });

  test('same-pod batch overflow fails every event closed with one bounded diagnostic', async () => {
    const events = [
      event({ _id: 'focus-batch-overflow-a', payload: { content: 'first event' } }),
      event({ _id: 'focus-batch-overflow-b', payload: { content: 'second event' } }),
    ];
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events, inboxCount: 2 };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) return {
        focus: {
          podId: 'pod-focus',
          revision: 11,
          focus: {
            goal: 'Repair the focus record',
            scope: 'CLI only',
            owner: { userId: 'u1', label: 'x'.repeat(9000), available: true },
            nextTasks: [],
          },
        },
      };
      return {};
    });
    const post = jest.fn(async (route) => (route.endsWith('/claim') ? { claimed: true } : {}));
    createClient.mockReturnValue({ get, post, del: jest.fn() });
    const spawn = jest.fn().mockResolvedValue({ text: 'must not run' });
    const errors = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
      onError: (error) => errors.push(error),
    });
    await drain();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([route]) => route.includes('/ack'))).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      focusDiagnostic: {
        errorCode: 'FOCUS_FRAME_PROTECTED_OVERFLOW',
        eventIds: ['focus-batch-overflow-a', 'focus-batch-overflow-b'],
        podId: 'pod-focus',
        focusRevision: 11,
        allowedCodePoints: 8000,
      },
    });
    expect(errors[0].focusDiagnostic.measuredCodePoints).toBeGreaterThan(8000);
  });

  test('one same-pod batch performs one fresh focus read for the composite turn', async () => {
    const events = [
      event({ _id: 'focus-batch-a', payload: { content: 'first event' } }),
      event({ _id: 'focus-batch-b', payload: { content: 'second event' } }),
    ];
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events, inboxCount: 2 };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) return {
        focus: {
          podId: 'pod-focus',
          revision: 3,
          focus: {
            goal: 'Ship focus',
            scope: 'CLI only',
            owner: { userId: 'u1', label: 'Kai', available: true },
            nextTasks: [{ taskId: 'TASK-129', available: true, title: 'Read at turn start' }],
          },
        },
      };
      return {};
    });
    const post = jest.fn(async (route) => (route.endsWith('/claim') ? { claimed: true } : {}));
    createClient.mockReturnValue({ get, post, del: jest.fn() });
    const spawn = jest.fn().mockResolvedValue({ text: 'batch done' });

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drain();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.filter(([route]) => route.endsWith('/context'))).toHaveLength(1);
    expect(spawn.mock.calls[0][0]).toContain('revision: 3');
    expect(spawn.mock.calls[0][0]).toContain('first event');
    expect(spawn.mock.calls[0][0]).toContain('second event');
  });

  test('resumed sessions read the current focus again at their turn boundary', async () => {
    let eventTurn = 0;
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') {
        const id = eventTurn === 0 ? 'resume-a' : 'resume-b';
        eventTurn += 1;
        return { events: [event({ _id: id })] };
      }
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) return {
        focus: { podId: 'pod-focus', revision: eventTurn, focus: null },
      };
      return {};
    });
    const post = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get, post });
    const sessions = [];
    const prompts = [];
    const spawn = jest.fn(async (prompt, context) => {
      prompts.push(prompt);
      sessions.push(context.sessionId);
      return { text: 'resume ok', newSessionId: 'session-42' };
    });
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const first = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter,
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drain();
    first.stop();
    expect(getSession('focus-stub', 'pod-focus')).toBe('session-42');

    const second = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter,
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drain();
    second.stop();

    expect(sessions).toEqual([null, 'session-42']);
    expect(prompts[0]).toContain('revision: 1');
    expect(prompts[1]).toContain('revision: 2');
    expect(get.mock.calls.filter(([route]) => route.endsWith('/context'))).toHaveLength(2);
  });

  test('a repaired focus is consumed on the next retry without replaying stale work', async () => {
    let repaired = false;
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: [event({ _id: 'repair-1' })] };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      if (route.endsWith('/context')) {
        return repaired ? {
          focus: {
            podId: 'pod-focus',
            revision: 10,
            focus: null,
          },
        } : {
          focus: {
            podId: 'pod-focus',
            revision: 9,
            focus: {
              goal: 'Repair the focus record',
              scope: 'CLI only',
              owner: { userId: 'u1', label: 'x'.repeat(9000), available: true },
              nextTasks: [],
            },
          },
        };
      }
      return {};
    });
    const post = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get, post });
    const spawn = jest.fn().mockResolvedValue({ text: 'repaired turn' });
    const firstErrors = [];
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const first = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter,
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
      onError: (error) => firstErrors.push(error),
    });
    await drain();
    first.stop();
    expect(firstErrors[0].focusDiagnostic.errorCode).toBe('FOCUS_FRAME_PROTECTED_OVERFLOW');
    expect(post.mock.calls.filter(([route]) => route.includes('/ack'))).toHaveLength(0);

    repaired = true;
    const second = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_focus',
      adapter,
      agentName: 'focus-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drain();
    second.stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toContain('revision: 10');
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/repair-1/ack',
      { result: { outcome: 'posted' } },
    );
  });
});

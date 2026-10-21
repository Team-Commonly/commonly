// The welcome's hosted start, one click to a live agent (TASK-290). Two clicks
// that land before the button can disable (a fast double click, a keyboard
// repeat) still start one agent: the second is dropped while the first runs.
import { act, renderHook } from '@testing-library/react';
import { useWelcomeHostedStart } from '../hooks/useWelcomeHostedStart';
import type { V2ApiClient } from '../hooks/useV2Api';

const START = { id: 'run-hosted', label: 'Run an agent here', href: '/v2/agents/byo?pod=pod-1&mode=hosted', action: 'run-hosted' };

test('a second run while the first is in flight sends nothing', async () => {
  let finishResolve: (value: unknown) => void = () => {};
  const post = jest.fn((url: string) => {
    if (url === '/api/hosted/welcome-start') {
      return new Promise((resolve) => { finishResolve = resolve; });
    }
    return Promise.resolve({ ready: true });
  });
  const api = { post, get: jest.fn(), patch: jest.fn(), put: jest.fn(), del: jest.fn() } as unknown as V2ApiClient;
  const onLive = jest.fn();
  const { result } = renderHook(() => useWelcomeHostedStart(api, { onLive, onOpenPage: jest.fn() }));

  let first: Promise<void> = Promise.resolve();
  let second: Promise<void> = Promise.resolve();
  act(() => {
    first = result.current.run('41', START);
    second = result.current.run('41', START);
  });
  await act(async () => {
    finishResolve({ podId: 'pod-1', existing: null, agentName: 'maya-agent' });
    await Promise.all([first, second]);
  });

  expect(post.mock.calls.map(([url]) => url)).toEqual([
    '/api/hosted/welcome-start', '/api/registry/install', '/api/hosted/provision',
  ]);
  expect(onLive).toHaveBeenCalledTimes(1);
  expect(result.current.state).toEqual({ messageId: '41', status: 'live' });
});

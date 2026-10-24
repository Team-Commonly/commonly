// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAgentSettings } from '../agents/useAgentSettings';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const Probe = () => {
  const { installation, podId, update, updatePod } = useAgentSettings('maya-claude', 'default');
  return <div>
    <span>{installation?.displayName || 'loading'}</span>
    <button type="button" onClick={() => { void update({ displayName: 'Maya Updated' }); }}>
      Save
    </button>
    <button type="button" onClick={() => { void updatePod('pod-2', {
      wakeOnMessage: true, humanOnly: true, boardWake: false,
      heartbeatEnabled: true, heartbeatMinutes: 60,
    }); }}>Save Wake</button>
    <span data-testid="pod">{podId}</span>
  </div>;
};

test('reads one accessible installation and patches it with the instance id', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', config: {},
    } } });
  });
  axios.patch.mockResolvedValue({ data: { agent: {} } });
  render(<Probe />);
  await screen.findByText('Maya');
  expect(axios.get).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude', { params: { instanceId: 'default' } },
  );
  expect(axios.get).not.toHaveBeenCalledWith(
    '/api/registry/pods/pod-other/agents/maya-claude', expect.anything(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { displayName: 'Maya Updated', instanceId: 'default' },
  ));
  expect(screen.getByTestId('pod')).toHaveTextContent('pod-1');
  expect(axios.get.mock.calls.some(([url]) => url.startsWith('/api/agent-memory/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save Wake' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/agents/maya-claude/manage-settings/pods/pod-2',
    { wakeOnMessage: true, humanOnly: true, boardWake: false,
      heartbeatEnabled: true, heartbeatMinutes: 60 },
    { params: { instanceId: 'default' } },
  ));
});

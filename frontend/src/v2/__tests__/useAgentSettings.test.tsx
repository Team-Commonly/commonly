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
      wakeOnMessage: true, boardWake: false, heartbeatMinutes: 60,
    }); }}>Save pod</button>
    <span data-testid="pod">{podId}</span>
  </div>;
};

test('reads one accessible installation and patches it with the instance id', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', config: {},
    } } });
  });
  axios.patch.mockResolvedValue({ data: { agent: {} } });
  render(<Probe />);
  await screen.findByText('Maya');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { displayName: 'Maya Updated', instanceId: 'default' },
  ));
  expect(screen.getByTestId('pod')).toHaveTextContent('pod-1');
  fireEvent.click(screen.getByRole('button', { name: 'Save pod' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/agents/maya-claude/manage-settings/pods/pod-2',
    { wakeOnMessage: true, boardWake: false, heartbeatMinutes: 60 },
    { params: { instanceId: 'default' } },
  ));
});

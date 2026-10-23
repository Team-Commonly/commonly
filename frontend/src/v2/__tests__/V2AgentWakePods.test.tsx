import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentWakePods from '../agents/V2AgentWakePods';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const client = (jest.requireMock('axios') as { default: { get: jest.Mock; patch: jest.Mock; delete: jest.Mock } }).default;
const renderSettings = () => render(
  <MemoryRouter><V2AgentWakePods agentName="test-agent" instanceId="my-machine" /></MemoryRouter>,
);

describe('per-agent Wake and Pods settings', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    client.get.mockResolvedValue({ data: { installations: [{
      podId: 'pod-1', podName: 'Launch', wakeOnMessage: true, boardWake: false, heartbeatMinutes: 60,
    }] } });
    client.patch.mockResolvedValue({ data: {} });
    client.delete.mockResolvedValue({ data: {} });
  });

  it('writes settings to the selected installation with the instance identity', async () => {
    renderSettings();
    fireEvent.click(await screen.findByLabelText('Wake on board changes'));
    await waitFor(() => expect(client.patch).toHaveBeenCalledWith(
      '/api/registry/agents/test-agent/manage-settings/pods/pod-1?instanceId=my-machine',
      { wakeOnMessage: true, boardWake: true, heartbeatMinutes: 60 },
    ));
  });

  it('removes a pod installation and leaves the settings view open', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from pod' }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(
      '/api/registry/agents/test-agent/pods/pod-1?instanceId=my-machine',
    ));
    expect(await screen.findByText('No pods to manage')).toBeInTheDocument();
    confirm.mockRestore();
  });
});

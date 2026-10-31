// @ts-nocheck
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import AgentsHub from './AgentsHub';

jest.mock('axios');
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'owner', role: 'user' } }),
}));
jest.mock('./ClawdbotConfigPanel', () => () => null);
jest.mock('../admin/AgentEventsDebugPage', () => () => null);
jest.mock('./AgentCard', () => ({ agent, installed, onConfigure }) => (
  installed ? <button onClick={() => onConfigure(agent)}>Configure {agent.displayName}</button> : null
));

it('keeps a template installation’s stored instance when opening runtime controls', async () => {
  const installation = {
    name: 'template-agent', displayName: 'Renamed Template', templateId: 'template-1',
    instanceId: 'original-stored-instance', installedBy: 'owner', status: 'active',
  };
  axios.get.mockImplementation(async (url) => {
    if (url === '/api/pods') return { data: [{ _id: 'pod-1', name: 'Pod', createdBy: 'owner', members: ['owner'] }] };
    if (url.startsWith('/api/registry/agents?')) return { data: { agents: [{ name: 'openclaw' }, { name: 'commonly-summarizer' }] } };
    if (url === '/api/registry/pods/pod-1/agents') return { data: { agents: [installation] } };
    if (url.includes('/agents/template-agent?')) return { data: { agent: installation } };
    return { data: { templates: [], gateways: [], tokens: [], status: 'running' } };
  });
  render(<MemoryRouter initialEntries={['/?tab=installed']}><AgentsHub currentPodId="pod-1" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure Renamed Template' }));
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/template-agent?instanceId=original-stored-instance', expect.anything(),
  ));
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh Status', hidden: true }));
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/template-agent/runtime-status',
    expect.objectContaining({ params: { instanceId: 'original-stored-instance' } }),
  ));
});

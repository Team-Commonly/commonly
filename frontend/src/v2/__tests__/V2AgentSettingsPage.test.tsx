// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentSettingsPage from '../agents/V2AgentSettingsPage';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const renderPage = () => render(
  <MemoryRouter initialEntries={['/v2/agents/maya-claude/default']}>
    <Routes><Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentSettingsPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    return Promise.resolve({ data: { tokens: [{
      id: 'tok-1', label: 'Laptop', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, revokedAt: null,
    }] } });
  });
});

test('regeneration waits for the explicit running-key replacement confirmation', async () => {
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await screen.findByText('Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByTestId('agent-key-replace-confirmation')).toHaveTextContent('Replacing it will disconnect');
  fireEvent.click(screen.getByRole('button', { name: /keep the current key/i }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude/runtime-tokens',
    { instanceId: 'default', label: 'Agent Settings replacement', force: true },
  ));
  expect(await screen.findByTestId('agent-one-time-key')).toHaveTextContent('cm_agent_once');
});

test('a denied owner probe renders no key controls or metadata', async () => {
  axios.get.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
});

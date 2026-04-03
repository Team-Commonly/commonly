import React from 'react';
import { render, screen } from '@testing-library/react';
import AgentEnsemblePanel from './AgentEnsemblePanel';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
  },
}));

const axios = require('axios').default;

describe('AgentEnsemblePanel', () => {
  beforeEach(() => {
    localStorage.setItem('token', 't');
  });

  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  test('locks configuration while discussion is active', async () => {
    axios.get.mockResolvedValue({
      data: {
        state: {
          id: 'state-1',
          status: 'active',
          topic: 'Test topic',
          participants: [
            { agentType: 'alpha', instanceId: 'default', role: 'starter' },
            { agentType: 'beta', instanceId: 'default', role: 'responder' },
          ],
          turnState: {
            currentAgent: { agentType: 'alpha', instanceId: 'default' },
            turnNumber: 0,
            roundNumber: 0,
          },
        },
        podConfig: {
          enabled: true,
        },
      },
    });

    render(
      <AgentEnsemblePanel
        podId="pod-1"
        podAgents={[
          { name: 'alpha', instanceId: 'default', profile: { displayName: 'Alpha' } },
          { name: 'beta', instanceId: 'default', profile: { displayName: 'Beta' } },
        ]}
        isPodAdmin
      />,
    );

    expect(await screen.findByText('Status: active')).toBeInTheDocument();
    expect(screen.getByText(/Configuration is locked while a discussion is active/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Topic/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save configuration/i })).toBeDisabled();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentProfile from '../agents/V2AgentProfile';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const profileClient = { get: jest.fn() };
  return {
    __esModule: true,
    default: { create: jest.fn(() => profileClient) },
    __profileClient: profileClient,
  };
});
jest.mock('../../utils/avatarUtils', () => ({
  presetCharacterOptions: jest.fn(() => []),
}));
jest.mock('../components/V2Avatar', () => ({
  __esModule: true,
  default: () => null,
}));

const profileClient = (jest.requireMock('axios') as { __profileClient: { get: jest.Mock } }).__profileClient;

const renderProfile = () => render(
  <MemoryRouter initialEntries={['/v2/agents/claude-code/observer']}>
    <Routes>
      <Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentProfile />} />
    </Routes>
  </MemoryRouter>,
);

describe('V2AgentProfile memory-write visibility', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
    profileClient.get.mockResolvedValue({
      data: {
        agent: {
          agentName: 'claude-code',
          instanceId: 'observer',
          displayName: 'Observer',
          profilePicture: 'default',
          runtime: null,
          officialAgent: false,
          capabilities: [],
        },
        skills: [],
        pods: { count: 0, public: [] },
        memory: {
          has: true,
          entryCount: 2,
          lastAgentWrite: {
            section: 'long_term',
            updatedAt: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
          },
        },
        activity: [],
      },
    });
  });

  it('names the section of the latest agent-authored write', async () => {
    renderProfile();

    expect(await screen.findByText(/Last saved to Long-term memory \d+h ago\./)).toBeInTheDocument();
  });
});

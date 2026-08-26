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

// The profile route is unauthenticated, so it reports the KIND of the latest
// agent-authored write and never the section name. The owner/admin memory view
// keeps the exact section; that surface is covered separately.
const profilePayload = (lastAgentWrite: unknown) => ({
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
    memory: { has: true, entryCount: 2, lastAgentWrite },
    activity: [],
  },
});
const twoHoursAgo = () => new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();

describe('V2AgentProfile memory-write visibility', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
    profileClient.get.mockResolvedValue(
      profilePayload({ kind: 'durable', updatedAt: twoHoursAgo() }),
    );
  });

  it('reports the kind of the latest agent-authored write', async () => {
    renderProfile();

    expect(await screen.findByText(/Last saved to durable memory \d+h ago\./)).toBeInTheDocument();
  });

  it('reports a housekeeping write without naming the section', async () => {
    profileClient.get.mockResolvedValue(
      profilePayload({ kind: 'bookkeeping', updatedAt: twoHoursAgo() }),
    );
    renderProfile();

    expect(await screen.findByText(/Last saved to internal bookkeeping \d+h ago\./)).toBeInTheDocument();
    // No section name reaches this page for any kind.
    expect(screen.queryByText(/Runtime metadata|Deduplication state|Long-term memory/)).toBeNull();
  });
});

// @ts-nocheck
// An agent-ensemble pod reads like any room in the v2 pod view. Its V1 room
// and ensemble controls were retired with the gateway that ran ensemble turns;
// stored pods keep their `agentEnsemble` settings, and the thread ignores them.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';
import { i18nReady } from '../../i18n';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

beforeAll(async () => {
  Element.prototype.scrollIntoView = jest.fn();
  await i18nReady;
});

afterEach(() => cleanup());

const authValue = {
  currentUser: { _id: 'u1', username: 'maya' },
  user: { _id: 'u1', username: 'maya' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const at = (minute) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

const message = (id, userId, username, content, minute, isBot = false) => ({
  id,
  pod_id: 'ens-1',
  user_id: userId,
  content,
  message_type: 'text',
  created_at: at(minute),
  user: { username, isBot },
});

// The shape a stored ensemble pod has on prod: the type plus the six-field
// subdocument, which the v2 thread never reads.
const ENSEMBLE_POD = {
  _id: 'ens-1',
  name: 'Model debate',
  type: 'agent-ensemble',
  createdBy: 'u1',
  agentEnsemble: {
    enabled: true,
    topic: 'Which cache policy fits the feed?',
    participants: [
      { agentType: 'scout', instanceId: 'default', role: 'starter' },
      { agentType: 'critic', instanceId: 'default', role: 'responder' },
    ],
    stopConditions: { maxMessages: 20, maxRounds: 5, maxDurationMinutes: 60 },
    schedule: { enabled: false, frequencyMinutes: 20, timezone: 'UTC' },
    humanParticipation: 'participate',
  },
};

test('an agent-ensemble pod shows its name, its messages and the composer', () => {
  const detail = {
    pod: ENSEMBLE_POD,
    members: [
      { _id: 'u1', username: 'maya', isBot: false },
      { _id: 'scout-1', username: 'scout', isBot: true },
    ],
    messages: [
      message('m1', 'scout-1', 'scout', 'LRU keeps the hot posts warm.', 1, true),
      message('m2', 'u1', 'maya', 'What about the long tail?', 2),
    ],
    agents: [],
    sendMessage: jest.fn(),
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2Thread detail={detail} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  expect(screen.getAllByText('Model debate').length).toBeGreaterThan(0);
  expect(screen.getByText('LRU keeps the hot posts warm.')).toBeInTheDocument();
  expect(screen.getByText('What about the long tail?')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeEnabled();
  // No leftover ensemble chrome.
  expect(screen.queryByText(/ensemble/i)).toBeNull();
});

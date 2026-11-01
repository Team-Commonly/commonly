// @ts-nocheck
// TASK-702: the pod header carries an Invite for members, opening the same
// invite modal the inspector does. Hidden for a non-member and on 1:1 pods.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

const authValue = {
  currentUser: { _id: 'u1', username: 'alice' },
  user: { _id: 'u1', username: 'alice' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderThread = ({ podType = 'chat', member = true, onOpenInvite = jest.fn() } = {}) => {
  const detail = {
    pod: { _id: 'pod-1', name: 'Launch Room', type: podType },
    members: member
      ? [{ _id: 'u1', username: 'alice', isBot: false }, { _id: 'u2', username: 'bob', isBot: false }]
      : [{ _id: 'u2', username: 'bob', isBot: false }],
    messages: [],
    agents: [],
    sendMessage: jest.fn(),
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2Thread detail={detail} onOpenInvite={onOpenInvite} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return onOpenInvite;
};

describe('V2Thread header Invite', () => {
  test('a member of a team pod sees Invite, and it opens the people tab', () => {
    const onOpenInvite = renderThread();
    fireEvent.click(screen.getByTestId('pod-header-invite'));
    expect(onOpenInvite).toHaveBeenCalledWith('people');
  });

  test('a non-member does not see Invite', () => {
    renderThread({ member: false });
    expect(screen.queryByTestId('pod-header-invite')).not.toBeInTheDocument();
  });

  test.each(['agent-room', 'agent-dm'])('a %s pod does not show Invite', (podType) => {
    renderThread({ podType });
    expect(screen.queryByTestId('pod-header-invite')).not.toBeInTheDocument();
  });

  test('no invite handler, no Invite', () => {
    renderThread({ onOpenInvite: null });
    expect(screen.queryByTestId('pod-header-invite')).not.toBeInTheDocument();
  });
});

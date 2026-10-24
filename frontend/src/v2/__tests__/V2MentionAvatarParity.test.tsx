// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import V2Inspector from '../components/V2Inspector';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const auth = {
  currentUser: { _id: 'viewer-id', username: 'viewer' },
  user: { _id: 'viewer-id', username: 'viewer' }, token: 't', loading: false,
  error: null, isAuthenticated: true, register: jest.fn(), login: jest.fn(),
  logout: jest.fn(), updateProfile: jest.fn(),
};

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const message = (id, userId, username, isBot, profilePicture = 'default') => ({
  id, pod_id: 'pod-1', user_id: userId, message_type: 'text', content: `From ${username}`,
  created_at: '2026-10-23T06:00:00.000Z',
  user: { username, isBot, profile_picture: profilePicture },
});

test('the @ list and thread resolve the same avatar for a person and an agent', () => {
  const detail = {
    pod: { _id: 'pod-1', name: 'Design', type: 'chat' },
    members: [
      { _id: 'viewer-id', username: 'viewer', isBot: false },
      { _id: 'person-id', username: 'maya', isBot: false, profilePicture: 'default' },
      { _id: 'agent-id', username: 'aria', isBot: true, profilePicture: 'default' },
    ],
    // A scoped installation image must not replace the User row's avatar:
    // the transcript resolves that same User row for the agent message.
    agents: [
      { agentName: 'aria', instanceId: 'default', userId: 'stale-agent-id', displayName: 'Aria',
        profilePicture: 'default', profile: { avatarUrl: '/api/uploads/installation.png' } },
      { agentName: 'nova', instanceId: 'default', userId: 'nova-id', displayName: 'Nova',
        profilePicture: '/api/uploads/nova-account.png', profile: { avatarUrl: '/api/uploads/nova-install.png' } },
    ],
    messages: [message('person-msg', 'person-id', 'maya', false), message('agent-msg', 'agent-id', 'aria', true),
      message('nova-msg', 'nova-id', 'nova', true, '/api/uploads/nova-account.png')],
    sendMessage: jest.fn(), loading: false, error: null, sendError: null, refresh: jest.fn(),
  };
  const { container } = render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter><V2Thread detail={detail} /><V2Inspector detail={detail} /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.change(container.querySelector('.v2-composer textarea'), {
    target: { value: '@', selectionStart: 1 },
  });

  for (const [handle, messageId] of [['maya', 'person-msg'], ['aria', 'agent-msg'], ['nova', 'nova-msg']]) {
    const option = screen.getByRole('option', { name: new RegExp(`@${handle}`) });
    const optionAvatar = option.querySelector('.v2-avatar');
    const rowAvatar = container.querySelector(`#message-${messageId} .v2-avatar`);
    expect(optionAvatar.querySelector('img')).toHaveAttribute('src', rowAvatar.querySelector('img').getAttribute('src'));
    expect(optionAvatar).toHaveClass('v2-avatar--flat');
  }

  for (const [name, messageId] of [['Aria', 'agent-msg'], ['Nova', 'nova-msg']]) {
    const inspectorRow = [...container.querySelectorAll('.v2-workspace-inspector__agent')]
      .find((row) => row.textContent.includes(name));
    const inspectorAvatar = inspectorRow.querySelector('.v2-avatar');
    const rowAvatar = container.querySelector(`#message-${messageId} .v2-avatar`);
    expect(inspectorAvatar.querySelector('img')).toHaveAttribute('src', rowAvatar.querySelector('img').getAttribute('src'));
  }
});

// @ts-nocheck
// A live message appends one row. The rows already on screen get the same
// props, so they must not render again: re-rendering the whole transcript cost
// one 84-107ms frame per arrival on a phone (4x CPU, 2026-11-01).
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

const mockAvatarRenders = [];
jest.mock('../../context/SocketContext', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
jest.mock('../components/V2Avatar', () => {
  const MockAvatar = ({ name }) => { mockAvatarRenders.push(name); return <span data-testid="avatar" />; };
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});
jest.mock('../utils/avatars', () => ({ initialsFor: (name: string) => name.slice(0, 2) }));
const mockApi = {
  get: jest.fn(() => Promise.resolve({})),
  post: jest.fn(() => Promise.resolve({})),
  put: jest.fn(() => Promise.resolve({})),
  patch: jest.fn(() => Promise.resolve({})),
  del: jest.fn(() => Promise.resolve({})),
};
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const authValue = {
  currentUser: { _id: 'u1', username: 'viewer' },
  user: { _id: 'u1', username: 'viewer' },
  token: 't',
  loading: false,
  isAuthenticated: true,
  error: null,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

// Different authors an hour apart, so no row groups with the one before it.
const message = (id, author, hour) => ({
  id, pod_id: 'p1', user_id: `id-${author}`, content: `from ${author}`, message_type: 'text',
  created_at: `2026-10-19T${String(hour).padStart(2, '0')}:00:00Z`, user: { username: author },
});
const history = [message('m1', 'ada', 9), message('m2', 'brook', 10), message('m3', 'cass', 11)];

const detail = {
  pod: { _id: 'p1', name: 'Pod', type: 'chat' },
  members: [{ _id: 'u1', username: 'viewer', isBot: false }],
  messages: history,
  agents: [],
  sendMessage: jest.fn(() => Promise.resolve({})),
  loading: false,
  error: null,
  sendError: null,
  hasMore: false,
  loadingOlder: false,
  loadOlder: jest.fn(() => Promise.resolve()),
  refresh: jest.fn(),
  initialLoadComplete: true,
};

const node = (d) => (
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/v2/pods/p1']}>
      <V2Thread detail={d} />
    </MemoryRouter>
  </AuthContext.Provider>
);

test('a live arrival renders only the new row; the rows already shown stay as they are', () => {
  const view = render(node(detail));
  const seen = (names) => mockAvatarRenders.filter((name) => names.includes(name)).length;
  const before = seen(['ada', 'brook', 'cass']);
  expect(before).toBeGreaterThanOrEqual(3);

  view.rerender(node({ ...detail, messages: [...history, { ...message('m4', 'dev', 12), liveArrivedAt: Date.now() }] }));

  expect(seen(['dev'])).toBeGreaterThanOrEqual(1);
  expect(seen(['ada', 'brook', 'cass'])).toBe(before);
});

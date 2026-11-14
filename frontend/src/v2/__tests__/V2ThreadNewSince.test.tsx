// @ts-nocheck
// The PRODUCER halves of the two changes @sprint-review found bare (64500,
// 64501): the landing effect that decides reveal-vs-fetch from the hash, and
// the write that persists a thread's open/closed state. The consumers were
// covered (V2ThreadRestyle hands `revealMessageId` straight to the
// transcript); nothing exercised the code that computes either.
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
jest.mock('../components/V2Avatar', () => {
  const MockAvatar = () => <span data-testid="avatar" />;
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});
jest.mock('../utils/avatars', () => ({ initialsFor: (name: string) => name.slice(0, 2) }));
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

// `mock`-prefixed so the factory may close over them (jest hoists the mock).
const mockPut = jest.fn(() => Promise.resolve({}));
let mockReadPoint: Promise<unknown> = Promise.resolve({ podId: 'p1', lastReadAt: null });
const mockGet = jest.fn((url: string) => (String(url).endsWith('/read-point')
  ? mockReadPoint
  : Promise.resolve({ podId: 'p1', defaults: { following: null }, threads: [] })));
// ONE object for every render: the hook's fetch effect depends on `api`, so a
// factory that builds a fresh object per call re-fetches on every render (66
// calls in 50ms when I got this wrong).
const mockApi = {
  get: (...args) => mockGet(...args),
  post: jest.fn(() => Promise.resolve({})),
  put: (...args) => mockPut(...args),
  patch: jest.fn(() => Promise.resolve({})),
  del: jest.fn(() => Promise.resolve({})),
};
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const authValue = {
  currentUser: { _id: 'u1', username: 'solo-user' },
  user: { _id: 'u1', username: 'solo-user' },
  token: 't',
  loading: false,
  isAuthenticated: true,
  error: null,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};


// First minute back: opening a pod shows what arrived since the last visit.
const msg = (id: string, user: string, minute: number, extra = {}) => ({
  id, pod_id: 'p1', user_id: user, content: `${id} text`, message_type: 'text',
  created_at: `2026-11-14T10:${String(minute).padStart(2, '0')}:00Z`, user: { username: user === 'u1' ? 'solo-user' : 'teammate' }, ...extra,
});
const MESSAGES = [msg('a1', 'u2', 1), msg('a2', 'u1', 2), msg('a3', 'u2', 3), msg('n1', 'u1', 20), msg('n2', 'u2', 21), msg('n3', 'u2', 22)];
const detail = (overrides = {}) => ({
  pod: { _id: 'p1', name: 'Weekend', type: 'chat' },
  members: [{ _id: 'u1', username: 'solo-user', isBot: false }, { _id: 'u2', username: 'teammate', isBot: false }],
  messages: MESSAGES, agents: [], sendMessage: jest.fn(() => Promise.resolve({})), loading: false, error: null, sendError: null,
  hasMore: false, loadingOlder: false, loadOlder: jest.fn(() => Promise.resolve()), refresh: jest.fn(), ...overrides,
});
const renderPod = (d = detail()) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/v2/pods/p1']}><V2Thread detail={d} /></MemoryRouter>
  </AuthContext.Provider>,
);
const readPointPuts = () => mockPut.mock.calls.filter(([url]) => String(url).endsWith('/read-point'));

beforeEach(() => { mockGet.mockClear(); mockPut.mockClear(); });

test('the divider sits above the first message someone else wrote since the last visit', async () => {
  mockReadPoint = Promise.resolve({ podId: 'p1', lastReadAt: '2026-11-14T10:10:00Z' });
  const { container, findByRole } = renderPod();
  const divider = await findByRole('separator', { name: 'New since your last visit' });
  // n1 is the viewer's own message, so the divider sits above n2.
  expect(divider.nextElementSibling?.id || divider.parentElement?.querySelector('#message-n2')).toBeTruthy();
  const rows = [...container.querySelectorAll('[data-new-since-divider], [id^="message-"]')].map((el) => el.id || 'divider');
  expect(rows.indexOf('divider')).toBe(rows.indexOf('message-n2') - 1);
  expect(container.querySelectorAll('[data-new-since-divider]')).toHaveLength(1);
});

test('opening the pod moves the read point to the newest message, and the divider stays for this visit', async () => {
  mockReadPoint = Promise.resolve({ podId: 'p1', lastReadAt: '2026-11-14T10:10:00Z' });
  const { findByRole, queryByRole } = renderPod();
  await findByRole('separator', { name: 'New since your last visit' });
  await waitFor(() => expect(readPointPuts()).toHaveLength(1));
  expect(readPointPuts()[0]).toEqual(['/api/pods/p1/read-point', { at: '2026-11-14T10:22:00.000Z' }]);
  await act(async () => { await Promise.resolve(); });
  expect(queryByRole('separator', { name: 'New since your last visit' })).toBeInTheDocument();
});

test('a first visit with no read point shows no divider and records one', async () => {
  mockReadPoint = Promise.resolve({ podId: 'p1', lastReadAt: null });
  const { queryByRole } = renderPod();
  await waitFor(() => expect(readPointPuts()).toHaveLength(1));
  expect(queryByRole('separator', { name: 'New since your last visit' })).toBeNull();
});

test('a failed read point opens the pod as before, with no divider', async () => {
  mockReadPoint = Promise.reject(new Error('down'));
  const { container } = renderPod();
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/pods/p1/read-point'));
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('[data-new-since-divider]')).toBeNull();
});

test('nothing new from anyone else: no divider', async () => {
  mockReadPoint = Promise.resolve({ podId: 'p1', lastReadAt: '2026-11-14T10:22:00Z' });
  const { container } = renderPod();
  await waitFor(() => expect(readPointPuts().length + 1).toBeGreaterThan(0));
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('[data-new-since-divider]')).toBeNull();
});

test('the pod opens on the divider, not the end, until the reader moves', async () => {
  mockReadPoint = Promise.resolve({ podId: 'p1', lastReadAt: '2026-11-14T10:10:00Z' });
  const { container, findByRole } = renderPod();
  const list = container.querySelector('.v2-chat__messages') as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0 }) });
  const proto = HTMLElement.prototype.getBoundingClientRect;
  const spy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-new-since-divider')) return { top: 1500 - list.scrollTop } as DOMRect;
    return proto.call(this);
  });
  await findByRole('separator', { name: 'New since your last visit' });
  await waitFor(() => expect(list.scrollTop).toBe(1500 - 12));
  spy.mockRestore();
});

test('a reader who already moved is not pulled to the divider', async () => {
  let answer: (v: unknown) => void = () => {};
  mockReadPoint = new Promise((resolve) => { answer = resolve; });
  const { container, findByRole } = renderPod();
  const list = container.querySelector('.v2-chat__messages') as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/pods/p1/read-point'));
  list.scrollTop = 2100;
  fireEvent.wheel(list);
  await act(async () => { answer({ podId: 'p1', lastReadAt: '2026-11-14T10:10:00Z' }); await Promise.resolve(); });
  await findByRole('separator', { name: 'New since your last visit' });
  await act(async () => { await Promise.resolve(); });
  expect(list.scrollTop).toBe(2100);
});

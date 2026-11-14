// @ts-nocheck
// F518: someone who opens a pod invite signed out and signs up (or logs in)
// from it comes back joined to that pod, through the OAuth round trip, not to
// a second "Join" click. Only a click on the invite page in this browser tab
// arms the join, so a crafted link can't join a signed-in person on its own.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import V2InviteRedeem from '../components/V2InviteRedeem';

const TOKEN = 'b'.repeat(32);
const mockApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() };
let mockAuthed = false;

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockAuthed, loading: false, token: mockAuthed ? 'jwt' : null, currentUser: mockAuthed ? { _id: 'b1' } : null }),
}));
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { headers: { common: {} } }, interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const Where = () => { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p>; };
const renderAt = (path = `/v2/invite/${TOKEN}`) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/v2/invite/:token" element={<V2InviteRedeem />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  axios.get.mockResolvedValue({ data: { pod: { name: 'Launch', memberCount: 3 } } });
  mockApi.get.mockResolvedValue({ token: TOKEN, pod: { _id: 'pod-9', name: 'Launch', type: 'chat', memberCount: 3 }, alreadyMember: false });
  mockApi.post.mockResolvedValue({ ok: true, pod: { _id: 'pod-9' } });
});

test.each([
  ['Sign up to join', 'button', '/v2/register?next='],
  ['Log in', 'link', '/v2/login?next='],
])('signed out, "%s" arms the join for this invite and keeps the way back', async (name, role, dest) => {
  mockAuthed = false;
  renderAt();
  fireEvent.click(await screen.findByRole(role, { name }));
  expect(screen.getByTestId('where')).toHaveTextContent(`${dest}%2Fv2%2Finvite%2F${TOKEN}`);
  expect(sessionStorage.getItem('v2.inviteJoin.pending')).toBe(TOKEN);
});

test('back signed in with the join armed, it joins and opens the pod, once', async () => {
  mockAuthed = true;
  sessionStorage.setItem('v2.inviteJoin.pending', TOKEN);
  renderAt();
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/v2/pods/pod-9'));
  expect(mockApi.post).toHaveBeenCalledTimes(1);
  expect(mockApi.post).toHaveBeenCalledWith(`/api/invites/${TOKEN}/redeem`, {});
  expect(sessionStorage.getItem('v2.inviteJoin.pending')).toBeNull();
});

test('already a member with the join armed, it opens the pod without redeeming', async () => {
  mockAuthed = true;
  sessionStorage.setItem('v2.inviteJoin.pending', TOKEN);
  mockApi.get.mockResolvedValueOnce({ token: TOKEN, pod: { _id: 'pod-9', name: 'Launch' }, alreadyMember: true });
  renderAt();
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/v2/pods/pod-9'));
  expect(mockApi.post).not.toHaveBeenCalled();
});

test.each([
  ['nothing armed', null],
  ['another invite armed', 'c'.repeat(32)],
])('signed in with %s, the page waits for a click on Join', async (_label, armed) => {
  mockAuthed = true;
  if (armed) sessionStorage.setItem('v2.inviteJoin.pending', armed);
  renderAt();
  expect(await screen.findByRole('button', { name: 'Join Launch' })).toBeInTheDocument();
  expect(mockApi.post).not.toHaveBeenCalled();
});

test('a failed automatic join leaves the Join button and the reason', async () => {
  mockAuthed = true;
  sessionStorage.setItem('v2.inviteJoin.pending', TOKEN);
  mockApi.post.mockRejectedValueOnce({ response: { status: 410, data: { msg: 'This invite has expired.' } } });
  renderAt();
  expect(await screen.findByText('This invite has expired.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Join Launch' })).toBeInTheDocument();
  expect(sessionStorage.getItem('v2.inviteJoin.pending')).toBeNull();
});

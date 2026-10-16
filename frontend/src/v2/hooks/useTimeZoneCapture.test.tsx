// @ts-nocheck
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { AuthContext } from '../../context/AuthContext';
import { useTimeZoneCapture } from './useTimeZoneCapture';

jest.mock('../../utils/axiosConfig', () => ({ __esModule: true, default: { post: jest.fn() } }));
const axios = jest.requireMock('../../utils/axiosConfig').default;

const Probe = () => { useTimeZoneCapture(); return null; };
const renderAs = (auth) => render(
  <AuthContext.Provider value={{ isAuthenticated: false, currentUser: null, ...auth }}>
    <Probe />
  </AuthContext.Provider>,
);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeEach(() => {
  axios.post.mockReset().mockResolvedValue({ status: 204 });
  localStorage.clear();
});

test('a signed-in account sends its zone once, then not again from this browser', async () => {
  const me = { isAuthenticated: true, currentUser: { _id: 'u1' } };
  const first = renderAs(me);
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/users/me/timezone', { timeZone: zone }));
  first.unmount();
  await waitFor(() => expect(localStorage.getItem('commonly.timeZoneSent:u1')).toBe(zone));

  renderAs(me);
  await new Promise((r) => setTimeout(r, 20));
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('another account on the same browser still sends its own', async () => {
  localStorage.setItem('commonly.timeZoneSent:u1', zone);
  renderAs({ isAuthenticated: true, currentUser: { _id: 'u2' } });
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
});

test('signed out, nothing is sent, even with a user object still around', async () => {
  renderAs({ isAuthenticated: false, currentUser: { _id: 'u4' } });
  await new Promise((r) => setTimeout(r, 20));
  expect(axios.post).not.toHaveBeenCalled();
});

test('a failed send is retried next time, not marked as sent', async () => {
  axios.post.mockRejectedValueOnce(new Error('404'));
  renderAs({ isAuthenticated: true, currentUser: { _id: 'u3' } });
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(localStorage.getItem('commonly.timeZoneSent:u3')).toBeNull();
});

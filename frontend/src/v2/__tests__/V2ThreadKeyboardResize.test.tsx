// @ts-nocheck
// A phone keyboard makes the message list shorter with no scroll event. A
// reader at the end stays at the end; a reader who scrolled up is left alone.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import fs from 'fs';
import path from 'path';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
jest.mock('../components/V2Avatar', () => { const A = () => <span />; A.displayName = 'A'; return A; });
jest.mock('../utils/avatars', () => ({ initialsFor: (name) => name.slice(0, 2) }));
const mockApi = { get: jest.fn(() => Promise.resolve({})), post: jest.fn(() => Promise.resolve({})), put: jest.fn(() => Promise.resolve({})), patch: jest.fn(() => Promise.resolve({})), del: jest.fn(() => Promise.resolve({})) };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

let observed = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  global.ResizeObserver = class { constructor(cb) { this.cb = cb; this.live = false; observed.push(this); } observe() { this.live = true; } disconnect() { this.live = false; } };
});

const auth = { currentUser: { _id: 'u1', username: 'me' }, user: { _id: 'u1' }, token: 't', loading: false, isAuthenticated: true, error: null, register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn() };
const detail = {
  pod: { _id: 'p1', name: 'Weekend', type: 'chat' }, members: [{ _id: 'u1', username: 'me' }],
  messages: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, pod_id: 'p1', user_id: 'u2', content: `m${i}`, message_type: 'text', created_at: `2026-11-14T10:0${i}:00Z`, user: { username: 'mate' } })),
  agents: [], sendMessage: jest.fn(), loading: false, error: null, sendError: null, hasMore: false, loadingOlder: false, loadOlder: jest.fn(), refresh: jest.fn(),
};
const tree = (d, strict = false) => {
  const t = <AuthContext.Provider value={auth}><MemoryRouter initialEntries={['/v2/pods/p1']}><V2Thread detail={d} /></MemoryRouter></AuthContext.Provider>;
  return strict ? <React.StrictMode>{t}</React.StrictMode> : t;
};
const sized = (container) => {
  const list = container.querySelector('.v2-chat__messages');
  let h = 700;
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => h });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
  // only observers still connected hear the resize, as in a browser
  const shrink = (to) => { h = to; act(() => observed.filter((o) => o.live).forEach((o) => o.cb([]))); };
  return { list, shrink };
};
const setup = (strict = false) => {
  observed = [];
  const { container } = render(tree(detail, strict));
  return sized(container);
};

test('at the end, a shorter list (keyboard up) keeps the newest message in view', () => {
  const { list, shrink } = setup();
  list.scrollTop = 1300; fireEvent.scroll(list);
  shrink(700); // first reading sets the baseline
  shrink(380);
  expect(list.scrollTop).toBe(2000);
});

test('reading up, a shorter list leaves the reader where they are', () => {
  const { list, shrink } = setup();
  shrink(700);
  list.scrollTop = 400; fireEvent.wheel(list); fireEvent.scroll(list);
  shrink(380);
  expect(list.scrollTop).toBe(400);
});

test('the viewport lets the keyboard shrink the layout (Android Chrome)', () => {
  for (const file of ['../../../index.html', '../../../public/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    expect(html).toMatch(/name="viewport" content="[^"]*interactive-widget=resizes-content/);
  }
});

test('at the end by position, a stale follow flag does not leave the newest message below the fold', () => {
  const { list, shrink } = setup();
  shrink(700);
  list.scrollTop = 400; fireEvent.wheel(list); fireEvent.scroll(list); // the flag now says "reading up"
  list.scrollTop = 1300; // back at the end, with no scroll event yet
  shrink(380);
  expect(list.scrollTop).toBe(2000);
});

test('a list that mounts after the first render is still watched', () => {
  observed = [];
  const { container, rerender } = render(tree({ ...detail, pod: null }));
  expect(container.querySelector('.v2-chat__messages')).toBeNull();
  rerender(tree(detail));
  const { list, shrink } = sized(container);
  list.scrollTop = 1300;
  shrink(700); shrink(380);
  expect(list.scrollTop).toBe(2000);
});

test('under StrictMode the observer is attached after the double mount', () => {
  const { list, shrink } = setup(true);
  list.scrollTop = 1300;
  shrink(700); shrink(380);
  expect(list.scrollTop).toBe(2000);
});

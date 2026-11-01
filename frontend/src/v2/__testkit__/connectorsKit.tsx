// @ts-nocheck
// Shared harness for the Connectors page suites (ConnectorsPage.channels / .tools /
// .layout). It is not a test file: it lives outside `__tests__` so jest does not
// collect it. A suite still declares the `jest.mock('axios', ...)` itself (babel-jest
// only hoists the call in the file that makes it), with `axiosMock.ts` as the factory.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConnectorsPage from '../connectors/ConnectorsPage';
import { AuthContext } from '../../context/AuthContext';

export const axios = jest.requireMock('axios').default;

export const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

export const asUser = (user) => ({ ...authValue, currentUser: user, user });
export const adminAuth = (over = {}) => asUser({ ...authValue.user, role: 'admin', ...over });

export const emptyCounts = { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 };

/**
 * One GET router for every read the page makes. Anything not given answers the
 * empty shape of its route, so a suite states only what it is about.
 *
 *   connectors   /api/integrations/user/all
 *   installables /api/installables (channels and tools share it); `null` rejects
 *                the read, and leaving it out answers `[]` (no catalogue)
 *   hidden       hiddenToolConnections on the same response
 *   pods         /api/pods (an Error rejects, 'pending' never settles)
 *   grants       /api/grants
 *   seats        { [podId]: seat[] } for /api/registry/pods/:id/agents
 *   trails       { [grantId]: trail } for /api/grants/:id/calls
 *   route        (url, config) => Promise | undefined, consulted first
 */
export const mockApi = ({
  connectors = [],
  installables,
  hidden,
  pods = [],
  grants = [],
  seats = {},
  trails = {},
  route,
} = {}) => {
  axios.get.mockImplementation((url, config) => {
    const routed = route ? route(url, config) : undefined;
    if (routed !== undefined) return routed;
    if (url === '/api/integrations/user/all') return Promise.resolve({ data: connectors });
    if (url === '/api/installables') {
      if (installables === null) return Promise.reject(new Error('catalogue unavailable'));
      if (installables === undefined) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { installables, ...(hidden ? { hiddenToolConnections: hidden } : {}) } });
    }
    if (url === '/api/pods') {
      if (pods === 'pending') return new Promise(() => {});
      if (pods instanceof Error) return Promise.reject(pods);
      return Promise.resolve({ data: pods });
    }
    if (url === '/api/grants') return Promise.resolve({ data: { grants } });
    const seatRoute = /^\/api\/registry\/pods\/([^/]+)\/agents$/.exec(url);
    if (seatRoute) return Promise.resolve({ data: { agents: seats[seatRoute[1]] || [] } });
    const callsRoute = /^\/api\/grants\/([^/]+)\/calls$/.exec(url);
    if (callsRoute) {
      return Promise.resolve({ data: trails[callsRoute[1]] || { grantId: callsRoute[1], calls: [], counts: emptyCounts } });
    }
    return Promise.resolve({ data: [] });
  });
};

export const renderPage = ({ auth = authValue, entries } = {}) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={entries}>
      <ConnectorsPage />
    </MemoryRouter>
  </AuthContext.Provider>,
);

export const renderWithRoutes = (routes, { auth = authValue, entries = ['/v2/connectors'] } = {}) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={entries}>{routes}</MemoryRouter>
  </AuthContext.Provider>,
);

// ---- the tile surface ----
// A tile's accessible name is its dot's words plus its label, so a tile is found by
// the title it carries (the connector's label), never by role name.
export const tileNode = (name) => document.querySelector(`button.v2-cx-tile[title="${name}"]`);
export const findTile = async (name) => {
  await waitFor(() => expect(tileNode(name)).not.toBeNull());
  return tileNode(name);
};
export const clickTile = async (name) => {
  const node = await findTile(name);
  fireEvent.click(node);
  return node;
};
export const findDrawer = (name) => screen.findByRole('region', { name });
export const findPopover = (name) => screen.findByRole('dialog', { name });

/** Opens the drawer of a connected tile and returns it. */
export const openDrawer = async (name) => {
  await clickTile(name);
  return findDrawer(name);
};
/** Opens the popover of an unconnected tile and returns it. */
export const openPopover = async (name) => {
  await clickTile(name);
  return findPopover(name);
};

/** Opens a tool's drawer, then the grant row's selection to read its aside. */
export const openGrant = async (toolName, rowName) => {
  const drawer = await openDrawer(toolName);
  fireEvent.click(within(drawer).getByRole('button', { name: rowName }));
  const aside = await within(drawer).findByRole('complementary', { name: 'Grant details' });
  return { drawer, aside };
};

/** The "+N off" button of a group ("Channels" or "Tools"), clicked open. */
export const expandOff = async (group) => {
  const section = await screen.findByRole('region', { name: group });
  fireEvent.click(await within(section).findByRole('button', { name: /^\+\d+ off$/ }));
  return section;
};

/** Waits for the page's first read to settle (the loading line is gone). */
export const pageReady = async () => {
  await screen.findByRole('heading', { name: 'Connectors' });
  await waitFor(() => expect(screen.queryByText('Loading connectors…')).toBeNull());
};

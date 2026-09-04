// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { AuthContext } from '../../context/AuthContext';
import V2ConnectPage from '../components/V2ConnectPage';
import V2AccountMenu from '../components/V2AccountMenu';

jest.mock('../../utils/axiosConfig', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = () => <span data-testid="avatar" />;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com', role: 'member' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com', role: 'member' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderConnect = (value = auth) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter><V2ConnectPage /></MemoryRouter>
  </AuthContext.Provider>,
);

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

afterEach(() => jest.clearAllMocks());

describe('V2ConnectPage', () => {
  test('gives every member a copyable CLI/MCP start and does not tease instance keys', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    renderConnect();

    expect(screen.getByRole('heading', { name: 'Connect the CLI or MCP' })).toBeInTheDocument();
    expect(screen.getByText(/commonly login/)).toBeInTheDocument();
    expect(screen.getByText(/COMMONLY_AGENT_TOKEN=cm_agent_…/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage connected CLI devices' })).toHaveAttribute('href', '/v2/settings');
    expect(screen.queryByRole('heading', { name: 'Instance keys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open global integrations' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('npm install -g @commonlyai/cli\ncommonly login'));
  });

  test('shows the existing gateway action and global integrations only to admins', async () => {
    renderConnect({
      ...auth,
      currentUser: { ...auth.currentUser, role: 'admin' },
      user: { ...auth.user, role: 'admin' },
    });

    expect(screen.getByRole('heading', { name: 'Instance keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open global integrations' })).toHaveAttribute('href', '/v2/admin/integrations/global');
    fireEvent.click(screen.getByRole('button', { name: 'Add a gateway' }));
    fireEvent.change(screen.getByLabelText('Gateway name'), { target: { value: 'team-runtime' } });
    axios.post.mockResolvedValue({ data: { gatewayToken: 'gw_one_time_token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create gateway' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/gateways', {
      name: 'team-runtime', slug: undefined, mode: 'k8s', metadata: {},
    }));
    expect(await screen.findByText('gw_one_time_token')).toBeInTheDocument();
  });
});

test('the account menu links to Connect', async () => {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/v2/agents']}>
        <div className="v2-root"><V2AccountMenu /></div>
        <CurrentPath />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect', hidden: true }));
  expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/connect');
});

test('the account menu sends the folded Profile surface to Settings', async () => {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/v2/agents']}>
        <div className="v2-root"><V2AccountMenu /></div>
        <CurrentPath />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Settings', hidden: true }));
  expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/settings');
});

// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import { AuthContext } from '../../context/AuthContext';
import V2CliAuthorize from '../components/V2CliAuthorize';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderPage = (path = '/cli/authorize?code=ABCD-EFGH', value = auth) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter initialEntries={[path]}><V2CliAuthorize /></MemoryRouter>
  </AuthContext.Provider>,
);

const LoginProbe = () => {
  const location = useLocation();
  return <p data-testid="login-probe">{location.pathname + location.search}</p>;
};

const renderWithLogin = (path, value) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/cli/authorize" element={<V2CliAuthorize />} />
        <Route path="/v2/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

const signedOut = { ...auth, currentUser: null, user: null, token: null, isAuthenticated: false };

// The d215 auth card: the product mark's brand row, never the old lettered
// tile or the all-caps eyebrow.
const expectAuthCard = (container) => {
  expect(container.querySelector('main.v2-root.v2-cli-authorize .v2-login .v2-login__card.v2-login__card--stack')).not.toBeNull();
  expect(container.querySelector('.v2-login__brand')).not.toBeNull();
  expect(container.querySelector('.v2-cli-authorize__mark')).toBeNull();
  expect(screen.queryByText('CLI SIGN-IN')).toBeNull();
  expect(screen.queryByText('C', { exact: true })).toBeNull();
};

afterEach(() => jest.clearAllMocks());

test('claims the v2 page canvas while mounted, and gives it back on unmount', () => {
  // Outside V2App, body.v2-canvas is what switches off App.css's legacy
  // input, button and form rules (all gated on body.modern-ui:not(.v2-canvas)).
  document.body.classList.remove('v2-canvas');
  const { unmount } = renderPage();
  expect(document.body).toHaveClass('v2-canvas');
  unmount();
  expect(document.body).not.toHaveClass('v2-canvas');
});

describe('V2CliAuthorize', () => {
  test('prefills a terminal code, confirms the device facts, then completes approval', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { status: 'pending', request: { hostname: 'sam-laptop', clientName: 'commonly-cli', clientVersion: '0.1.26', createdAt: '2026-08-31T00:00:00.000Z' } } })
      .mockResolvedValueOnce({ data: { status: 'authorized' } });
    const { container } = renderPage();

    expectAuthCard(container);
    expect(screen.getByRole('heading', { level: 1, name: 'Authorize Commonly CLI' })).toHaveClass('v2-login__title');
    expect(screen.getByText('Enter the code shown in your terminal.')).toHaveClass('v2-login__subtitle');
    const input = screen.getByLabelText('Device code');
    expect(input).toHaveValue('ABCD-EFGH');
    expect(input).toHaveClass('v2-login__input', 'v2-cli-authorize__code');
    expect(input.closest('label')).toHaveClass('v2-login__field');
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('v2-login__submit');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/device/authorize', { userCode: 'ABCD-EFGH' }));

    const title = await screen.findByRole('heading', { level: 1, name: 'Authorize sam-laptop as @lily?' });
    expectAuthCard(container);
    expect(title.querySelector('.v2-cli-authorize__host')).toHaveTextContent('sam-laptop');
    const facts = container.querySelector('dl.v2-cli-authorize__facts');
    expect(facts).not.toBeNull();
    expect(Array.from(facts.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual(['Client', 'Instance', 'Requested']);
    expect(screen.getByText('commonly-cli 0.1.26').tagName).toBe('DD');
    const caution = screen.getByRole('note');
    expect(caution).toHaveClass('v2-login__notice');
    expect(caution).toHaveTextContent('Only approve a code you requested from your own terminal.');
    expect(caution.querySelector('svg')).not.toBeNull();
    const deny = screen.getByRole('button', { name: 'Deny' });
    const authorize = screen.getByRole('button', { name: 'Authorize' });
    expect(deny).toHaveClass('v2-login__submit', 'v2-login__submit--ghost');
    expect(authorize).toHaveClass('v2-login__submit');
    expect(authorize).not.toHaveClass('v2-login__submit--ghost');
    expect(deny.parentElement).toHaveClass('v2-cli-authorize__keys');
    expect(authorize.parentElement).toBe(deny.parentElement);

    fireEvent.click(authorize);
    await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/api/auth/device/authorize', {
      userCode: 'ABCD-EFGH', decision: 'authorize',
    }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Device authorized' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveClass('v2-login__notice');
    await waitFor(() => expect(status).toHaveTextContent('You can return to your terminal.'));
  });

  test('signed-out users get an explicit return path after sign-in', () => {
    const { container } = renderWithLogin('/cli/authorize?code=ABCD-EFGH', signedOut);
    expectAuthCard(container);
    expect(screen.getByRole('heading', { level: 1, name: 'Authorize Commonly CLI' })).toBeInTheDocument();
    expect(screen.getByLabelText('Device code')).toBeDisabled();
    expect(screen.getByLabelText('Device code')).toHaveValue('ABCD-EFGH');
    expect(screen.queryByRole('link', { name: 'Sign in to continue' })).toBeNull();
    const key = screen.getByRole('button', { name: 'Sign in to continue' });
    expect(key).toHaveClass('v2-login__submit');

    fireEvent.click(key);
    expect(screen.getByTestId('login-probe')).toHaveTextContent(
      '/v2/login?next=%2Fcli%2Fauthorize%3Fcode%3DABCD-EFGH',
    );
  });

  test('the session check is the card with one status line', () => {
    const { container } = renderPage('/cli/authorize?code=ABCD-EFGH', { ...signedOut, loading: true });
    expectAuthCard(container);
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  test('shows the request instance and the expired state for signed-in users', async () => {
    axios.defaults.baseURL = 'https://self-hosted.example/api';
    axios.post
      .mockResolvedValueOnce({ data: { status: 'pending', request: { hostname: 'sam-laptop', clientName: 'commonly-cli', createdAt: '2026-08-31T00:00:00.000Z' } } })
      .mockRejectedValueOnce({ response: { status: 410 } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('self-hosted.example')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Code expired' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Return to your terminal and run commonly login again.'));
    expect(status.querySelector('code')).toHaveTextContent('commonly login');
    axios.defaults.baseURL = '';
  });

  test('labels an already-consumed code instead of calling it expired', async () => {
    axios.post.mockResolvedValue({ data: { status: 'consumed' } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Code already used' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This code was already approved or completed.'));
  });

  test('a denied request says no token was issued', async () => {
    axios.post.mockResolvedValue({ data: { status: 'denied' } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Authorization denied' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No token was issued for this device.'));
  });

  test('a failed lookup is an alert row', async () => {
    axios.post.mockRejectedValue({ response: { status: 500 } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Couldn’t authorize this device' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Check the code and try again from your terminal.');
  });
});

const reachConfirm = async (hostname) => {
  axios.post.mockResolvedValueOnce({
    data: {
      status: 'pending',
      request: { hostname, clientName: 'commonly-cli', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
    },
  });
  renderPage('/cli/authorize?code=ABCD-EFGH');
  fireEvent.click(screen.getByRole('button', { name: i18n.t('cliAuthorize.continue') }));
  await screen.findByRole('button', { name: i18n.t('cliAuthorize.authorize') });
  return screen.getByRole('heading', { level: 1 });
};

describe('V2CliAuthorize in Chinese', () => {
  beforeEach(async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
  });

  afterEach(async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  it('asks for approval in Chinese', async () => {
    const title = await reachConfirm('lilys-mac.local');
    expect(title).toHaveTextContent('要以 @lily 的身份授权 lilys-mac.local 吗？');
    expect(screen.getByText('如果设备码不是你自己在终端里申请的，请不要授权。')).toBeInTheDocument();
    expect(screen.getByText('5分钟前')).toBeInTheDocument();
  });
});

// The hostname comes from whoever ran `commonly login`, with no account needed, so a device must
// never be able to change what this sentence says.
describe('V2CliAuthorize shows a requesting hostname exactly as sent', () => {
  test.each([
    ['{{username}}-laptop'],
    ['{{defaultValue}}'],
    ['{{ns}}'],
    ['&lt;b&gt;'],
    ['&amp;'],
    ['a&#47;b'],
    ['evil</host> as @admin?<host hidden>'],
    ['<host>x</host>'],
    ['<0>x</0>'],
    ['<host hidden>x'],
    ['<host style="color:red">x</host>'],
    ['<img src=x>'],
    ['lilys-mac.local'],
  ])('%s', async (hostname) => {
    const title = await reachConfirm(hostname);
    expect(title.textContent).toBe(`Authorize ${hostname} as @lily?`);
    const hosts = title.querySelectorAll('.v2-cli-authorize__host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].textContent).toBe(hostname);
    expect(title.children).toHaveLength(1);
  });
});

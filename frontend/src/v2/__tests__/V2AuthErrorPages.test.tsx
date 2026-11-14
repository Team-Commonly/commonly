// @ts-nocheck
// F526: the sign-in and forgot-password pages show their own line for a rate
// limit, never axios's "Request failed with status code 429" or server text.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { AuthContext } from '../../context/AuthContext';
import V2Login from '../components/V2Login';
import V2ForgotPassword from '../components/V2ForgotPassword';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const rateLimited = (data) => Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, data } });
const auth = (login) => ({ currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false,
  register: jest.fn(), login, logout: jest.fn(), updateProfile: jest.fn() });
const mount = (ui, login = jest.fn()) => render(
  <AuthContext.Provider value={auth(login)}><MemoryRouter initialEntries={['/v2/login']}>{ui}</MemoryRouter></AuthContext.Provider>,
);

beforeAll(async () => { await i18nReady; });
afterEach(async () => { await i18n.changeLanguage('en'); });

test('sign-in: a rate limit says when to try again, not the axios text', async () => {
  const login = jest.fn(() => Promise.reject(rateLimited({ message: 'rate limit exceeded: 20 login attempts per 15 minutes', code: 'rate_limited', scope: 'network', retryAfterSeconds: 540 })));
  const { container } = mount(<V2Login />, login);
  fireEvent.change(container.querySelector('input[type=email]'), { target: { value: 'a@example.com' } });
  fireEvent.change(container.querySelector('input[type=password]'), { target: { value: 'pw' } });
  await act(async () => { fireEvent.submit(container.querySelector('form')); });
  expect(await screen.findByText('Too many attempts from this network. Try again in 9 minutes.')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/status code|rate limit exceeded/);
});

test('forgot password under zh-CN: the line is Chinese, not the English server message', async () => {
  await i18n.changeLanguage('zh-CN');
  axios.post.mockImplementationOnce(() => Promise.reject(rateLimited({ message: 'rate limit exceeded: 5 password-reset requests per hour', code: 'rate_limited', retryAfterSeconds: 3000 })));
  const { container } = mount(<V2ForgotPassword />);
  fireEvent.change(container.querySelector('input[type=email]'), { target: { value: 'a@example.com' } });
  await act(async () => { fireEvent.submit(container.querySelector('form')); });
  expect(await screen.findByText('这个网络尝试的次数太多了，请 50 分钟后再试。')).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/rate limit exceeded/);
});

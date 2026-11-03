// @ts-nocheck
// zh-CN dates on the admin users page (PR #3350): the waitlist / invitation
// cells (formatDate) and the registered-user creation-date tooltip format in
// the app's language, not the browser's. English keeps passing no locale, so
// its output is the browser default exactly as on main.
//
// The test never asserts that zh output differs from the browser default:
// the host's own default locale could be zh-CN. It asserts the locale that
// reaches Date's formatters instead.
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2AdminUsers from '../components/V2AdminUsers';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = require('axios');

const authValue = {
  currentUser: { _id: 'admin1', username: 'admin', role: 'admin' },
  user: { _id: 'admin1', username: 'admin', role: 'admin' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

// The options formatDate passes, copied from V2AdminUsers.tsx.
const FORMAT_DATE_OPTIONS = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

const USER_CREATED_AT = '2026-09-14T08:30:00Z';
const WAITLIST_CREATED_AT = '2026-10-25T05:00:00Z';
const INVITE_CREATED_AT = '2026-10-20T12:15:00Z';

const usersPayload = {
  users: [{
    id: 'u1',
    username: 'mei',
    email: 'mei@example.com',
    role: 'user',
    verified: true,
    banned: false,
    createdAt: USER_CREATED_AT,
  }],
};

const waitlistPayload = {
  requests: [{
    id: 'w1',
    email: 'wait@example.com',
    name: 'Wai',
    organization: 'Org',
    useCase: 'testing',
    note: '',
    status: 'pending',
    createdAt: WAITLIST_CREATED_AT,
    updatedAt: WAITLIST_CREATED_AT,
    invitedAt: null,
    invitationSentAt: null,
    invitationCode: null,
    invitedBy: null,
  }],
  total: 1,
  page: 1,
  limit: 100,
  totalPages: 1,
};

const invitationsPayload = {
  invitations: [{
    id: 'i1',
    code: 'CODE-ONE',
    note: '',
    maxUses: 1,
    useCount: 0,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: INVITE_CREATED_AT,
    createdBy: null,
  }],
  total: 1,
  page: 1,
  limit: 100,
  totalPages: 1,
};

const mockApi = () => {
  axios.get.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/analytics/lifecycle')) return Promise.resolve({ data: { users: {} } });
    if (url.startsWith('/api/admin/users/waitlist')) return Promise.resolve({ data: waitlistPayload });
    if (url.startsWith('/api/admin/users/invitations')) return Promise.resolve({ data: invitationsPayload });
    if (url.startsWith('/api/admin/users')) return Promise.resolve({ data: usersPayload });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
};

const renderPage = () => render(
  <MemoryRouter>
    <AuthContext.Provider value={authValue}>
      <V2AdminUsers />
    </AuthContext.Provider>
  </MemoryRouter>,
);

// Calls made while rendering, by method: the first argument (the locale) of each.
let localeArgs: { toLocaleString: unknown[]; toLocaleDateString: unknown[] };
let stringSpy: jest.SpyInstance;
let dateStringSpy: jest.SpyInstance;

const installSpies = () => {
  localeArgs = { toLocaleString: [], toLocaleDateString: [] };
  const origString = Date.prototype.toLocaleString;
  const origDateString = Date.prototype.toLocaleDateString;
  stringSpy = jest.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function spy(this: Date, ...args) {
    localeArgs.toLocaleString.push(args[0]);
    return origString.apply(this, args);
  });
  dateStringSpy = jest.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function spy(this: Date, ...args) {
    localeArgs.toLocaleDateString.push(args[0]);
    return origDateString.apply(this, args);
  });
};

// Render, wait for all three sections, and return a snapshot of the recorded
// locales taken BEFORE the test computes its own expected strings.
const renderAndSettle = async () => {
  installSpies();
  const view = renderPage();
  await waitFor(() => expect(screen.getByText('mei')).toBeInTheDocument(), { timeout: 3000 });
  await waitFor(() => expect(screen.getByText('wait@example.com')).toBeInTheDocument(), { timeout: 3000 });
  await waitFor(() => expect(screen.getByText('CODE-ONE')).toBeInTheDocument(), { timeout: 3000 });
  const seen = {
    toLocaleString: [...localeArgs.toLocaleString],
    toLocaleDateString: [...localeArgs.toLocaleDateString],
  };
  return { view, seen };
};

const tooltipCell = () => screen.getByText('mei').closest('tr')!.querySelector('td[title]') as HTMLElement;
const waitlistRequestedCell = () => screen.getByText('wait@example.com').closest('tr')!.querySelectorAll('td')[5] as HTMLElement;
const inviteCreatedCell = () => screen.getByText('CODE-ONE').closest('tr')!.querySelectorAll('td')[4] as HTMLElement;

describe('V2AdminUsers dates follow the app language', () => {
  beforeAll(async () => { await i18nReady; });
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi();
  });
  afterEach(async () => {
    stringSpy?.mockRestore();
    dateStringSpy?.mockRestore();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('zh-CN: formatDate cells and the creation-date tooltip format in zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const { seen } = await renderAndSettle();

    expect(seen.toLocaleString.length).toBeGreaterThan(0);
    expect(seen.toLocaleString.every((locale) => locale === 'zh-CN')).toBe(true);
    expect(seen.toLocaleDateString.length).toBeGreaterThan(0);
    expect(seen.toLocaleDateString.every((locale) => locale === 'zh-CN')).toBe(true);

    expect(waitlistRequestedCell().textContent)
      .toBe(new Date(WAITLIST_CREATED_AT).toLocaleString('zh-CN', FORMAT_DATE_OPTIONS));
    expect(inviteCreatedCell().textContent)
      .toBe(new Date(INVITE_CREATED_AT).toLocaleString('zh-CN', FORMAT_DATE_OPTIONS));
    expect(tooltipCell()).toHaveAttribute('title', new Date(USER_CREATED_AT).toLocaleDateString('zh-CN'));
  });

  test('English: the same calls pass no locale (browser default, as on main)', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    const { seen } = await renderAndSettle();

    expect(seen.toLocaleString.length).toBeGreaterThan(0);
    expect(seen.toLocaleString.every((locale) => locale === undefined)).toBe(true);
    expect(seen.toLocaleDateString.length).toBeGreaterThan(0);
    expect(seen.toLocaleDateString.every((locale) => locale === undefined)).toBe(true);

    expect(waitlistRequestedCell().textContent)
      .toBe(new Date(WAITLIST_CREATED_AT).toLocaleString(undefined, FORMAT_DATE_OPTIONS));
    expect(tooltipCell()).toHaveAttribute('title', new Date(USER_CREATED_AT).toLocaleDateString());
  });
});

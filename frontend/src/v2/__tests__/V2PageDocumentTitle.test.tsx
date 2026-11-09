import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2Login from '../components/V2Login';
import V2Register from '../components/V2Register';
import { V2PrivacyPage, V2TermsPage } from '../legal/V2LegalPage';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    login: jest.fn(), register: jest.fn(), error: null, loading: false, isAuthenticated: false,
  }),
}));

// Each public page names itself in the browser tab, so a reader with several
// tabs open (or a search result) can tell sign-in from the terms. Before this,
// all four showed the landing page's "Commonly AI".
const PAGES: Array<[string, React.FC, string, string]> = [
  ['sign in', V2Login, 'Sign in · Commonly', '登录 · Commonly'],
  ['sign up', V2Register, 'Sign up · Commonly', '注册 · Commonly'],
  ['privacy', V2PrivacyPage, 'Privacy policy · Commonly', '隐私政策 · Commonly'],
  ['terms', V2TermsPage, 'Terms of service · Commonly', '服务条款 · Commonly'],
];

const renderPage = (Page: React.FC) => render(
  <MemoryRouter>
    <Page />
  </MemoryRouter>,
);

describe('public page tab titles', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    document.title = 'Commonly AI';
  });

  it.each(PAGES)('the %s page has its own English title', (_name, Page, en) => {
    renderPage(Page);
    expect(document.title).toBe(en);
  });

  it.each(PAGES)('the %s page has its own zh-CN title', async (_name, Page, _en, zh) => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    renderPage(Page);
    expect(document.title).toBe(zh);
  });

  it('follows a language switch while the page is open', async () => {
    renderPage(V2TermsPage);
    expect(document.title).toBe('Terms of service · Commonly');
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(document.title).toBe('服务条款 · Commonly');
  });

  it('gives the tab back its earlier title when the page closes', () => {
    document.title = 'Commonly AI';
    const { unmount } = renderPage(V2PrivacyPage);
    expect(document.title).toBe('Privacy policy · Commonly');
    unmount();
    expect(document.title).toBe('Commonly AI');
  });
});

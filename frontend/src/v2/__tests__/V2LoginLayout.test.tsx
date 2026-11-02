// @ts-nocheck
// The sign-in card follows the d215 artboard (signin frames): the provider
// buttons come first, then "or", then the email form. "Forgot password?" sits
// in the password label row, a failed sign-in is one alert at the top of the
// card with both fields marked, and the card ends on one plain line to sign up.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import V2Login from '../components/V2Login';
import V2OAuthButtons from '../components/V2OAuthButtons';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] } })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const renderLogin = (entry = '/v2/login', login = jest.fn().mockResolvedValue({})) => {
  render(
    <AuthContext.Provider value={{
      currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false,
      register: jest.fn(), login, logout: jest.fn(), updateProfile: jest.fn(),
    }}
    >
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/v2/login" element={<V2Login />} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return login;
};

// a comes before b in document order
const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => { jest.clearAllMocks(); localStorage.clear(); });

describe('V2Login follows the sign-in frame', () => {
  test('provider buttons come first, then "or", then the email form', async () => {
    renderLogin();
    const github = await screen.findByRole('link', { name: /continue with github/i });
    const google = screen.getByRole('link', { name: /continue with google/i });
    const or = screen.getByText('or');
    const email = screen.getByLabelText(/^email$/i);
    expect(before(github, google)).toBe(true);
    expect(before(google, or)).toBe(true);
    expect(before(or, email)).toBe(true);
  });

  test('"Forgot password?" sits in the password label row, and the input keeps its label', async () => {
    renderLogin();
    const password = await screen.findByLabelText(/^password$/i);
    const forgot = screen.getByRole('link', { name: /forgot password/i });
    expect(forgot).toHaveAttribute('href', '/v2/forgot-password');
    expect(before(forgot, password)).toBe(true);
    expect(before(screen.getByLabelText(/^email$/i), forgot)).toBe(true);
    // The link is not inside a <label>, so clicking it never focuses the field.
    expect(forgot.closest('label')).toBeNull();
  });

  test('a failed sign-in is one alert at the top, with both fields marked', async () => {
    renderLogin('/v2/login', jest.fn().mockRejectedValue({ response: { data: { error: 'Login failed' } } }));
    const github = await screen.findByRole('link', { name: /continue with github/i });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'lee@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Login failed');
    expect(before(alert, github)).toBe(true);
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('aria-invalid', 'true');
  });

  test('a provider error shows at the top without marking the fields', async () => {
    renderLogin('/v2/login?oauthError=invitation_required');
    const alert = await screen.findByRole('alert');
    expect(before(alert, await screen.findByRole('link', { name: /continue with github/i }))).toBe(true);
    expect(screen.getByLabelText(/^email$/i)).not.toHaveAttribute('aria-invalid');
  });

  test('the card ends on one line to sign up, and carries no subtitle', async () => {
    renderLogin();
    const create = await screen.findByRole('link', { name: /create an account/i });
    expect(create).toHaveAttribute('href', '/v2/register');
    expect(before(screen.getByRole('button', { name: /^sign in$/i }), create)).toBe(true);
    expect(screen.queryByText(/shared space where agents and humans/i)).toBeNull();
  });
});

describe('V2OAuthButtons separator', () => {
  test('defaults to "or" before the buttons (sign-up keeps its order)', async () => {
    render(<V2OAuthButtons />);
    const github = await screen.findByRole('link', { name: /continue with github/i });
    expect(before(screen.getByText('or'), github)).toBe(true);
  });

  test('separator="after" puts "or" after the buttons', async () => {
    render(<V2OAuthButtons separator="after" />);
    const google = await screen.findByRole('link', { name: /continue with google/i });
    expect(before(google, screen.getByText('or'))).toBe(true);
  });
});

describe('sign-in card styles', () => {
  const v2 = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const i = v2.indexOf(`\n${sel} {`);
    expect(i).toBeGreaterThan(-1);
    return v2.slice(i, v2.indexOf('}', i));
  };

  test('the page sits on the shell ground and the card is the pane surface', () => {
    expect(rule('.v2-login')).toMatch(/background: var\(--v2-page-bg\)/);
    const card = rule('.v2-login__card');
    expect(card).toMatch(/box-shadow: var\(--v2-shadow-pane\)/);
    expect(card).toMatch(/border-radius: 14px/);
  });

  test('sign in is the ink fill and the providers are keys', () => {
    const submit = rule('.v2-root button.v2-login__submit');
    expect(submit).toMatch(/linear-gradient\(180deg, var\(--v2-fill-a\), var\(--v2-fill-b\)\)/);
    expect(submit).toMatch(/color: var\(--v2-on-fill\)/);
    const oauth = rule('.v2-root :where(a, button).v2-login__oauth-btn');
    expect(oauth).toMatch(/linear-gradient\(180deg, var\(--v2-key-a\), var\(--v2-key-b\)\)/);
    expect(oauth).toMatch(/border: 1px solid var\(--v2-key-edge\)/);
  });

  test('base controls set height, not min-height, so the 44px phone floor still wins', () => {
    expect(rule('.v2-login__input')).toMatch(/\n  height: 40px;/);
    expect(rule('.v2-login__input')).not.toMatch(/min-height/);
    expect(rule('.v2-root button.v2-login__submit')).not.toMatch(/min-height/);
  });

  test('a marked field draws the ink ring', () => {
    expect(v2).toMatch(/\.v2-login__input\[aria-invalid="true"\] \{[^}]*box-shadow: inset 0 0 0 1\.5px var\(--v2-text-primary\)/);
  });

  test('on a phone the card fills the screen, with no shadow, after the rules it overrides', () => {
    // A phone rule placed before the base .v2-login rules loses to them at equal
    // specificity, so the sheet is the first 480px block after the card rules.
    const base = v2.indexOf('\n.v2-login__card--stack {');
    const start = v2.indexOf('@media (max-width: 480px)', base);
    expect(base).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(base);
    const block = v2.slice(start, v2.indexOf('\n}\n', start));
    expect(block).toMatch(/\.v2-login \{[^}]*background: var\(--v2-surface\)/);
    expect(block).toMatch(/\.v2-login__card \{[^}]*box-shadow: none;[^}]*border-radius: 0;/);
  });
});

// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import axios from 'axios';
import { AuthContext } from '../../context/AuthContext';
import V2App from '../V2App';
import V2LandingPage from '../landing/V2LandingPage';
import V2ComparePage from '../landing/V2ComparePage';
import GuidePage from '../../components/landing/GuidePage';
import GuidesIndexPage from '../../components/landing/GuidesIndexPage';
import UseCasePage from '../../components/landing/UseCasePage';
import i18n from '../../i18n';

// Mock surface includes `defaults` and `interceptors` so the transitive
// import chain (Register → axiosConfig → axios.defaults.baseURL = ...) does
// not throw when this test loads V2App.
jest.mock('axios', () => {
  const mock = {
    // The public landing fetches /api/stats/public on mount; resolve so the
    // component renders instead of throwing on `.then` of undefined.
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(),
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

const baseAuth = {
  currentUser: null,
  user: null,
  token: null,
  loading: false,
  error: null,
  isAuthenticated: false,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderAt = (path: string, auth = baseAuth) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/v2/*" element={<V2App />} />
        <Route path="/" element={<V2LandingPage />} />
        <Route path="/compare" element={<V2ComparePage />} />
        <Route path="/guides" element={<GuidesIndexPage />} />
        <Route path="/guides/:guideId/*" element={<GuidePage />} />
        <Route path="/use-cases/:useCaseId/*" element={<UseCasePage />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2 routing', () => {
  test('auth boot centers the branded typing mark instead of an inline spinner', () => {
    renderAt('/v2', { ...baseAuth, loading: true });

    expect(screen.getByRole('status', { name: 'Loading Commonly' })).toBeInTheDocument();
    expect(document.querySelectorAll('.v2-boot__mark-dot')).toHaveLength(3);
    expect(document.querySelector('.v2-spinner')).not.toBeInTheDocument();
  });

  test('login route renders v2 login form', () => {
    renderAt('/v2/login');
    expect(screen.getByRole('heading', { name: /^Sign in$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  test('index route shows the public landing when not authenticated', async () => {
    renderAt('/v2');
    // V2Home sends logged-out visitors to the canonical public front door,
    // not the login wall. The hero H1 is word-split for the entrance stagger,
    // so match on the heading's accessible name (the aria-label carries the
    // full sentence) — this also pins the screen-reader contract.
    expect(await screen.findByRole('heading', {
      level: 1,
      name: /chat with your claude code, cursor, codex/i,
    })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute(
      'href',
      'https://github.com/Team-Commonly/commonly/issues/new/choose',
    );
  });

  test('research card opens the dedicated research workspace use case', async () => {
    renderAt('/');

    expect(await screen.findByRole('link', { name: /market & research desk/i })).toHaveAttribute(
      'href',
      '/use-cases/research-desk/',
    );
  });

  test('legacy use-case routes redirect to their canonical public URL', async () => {
    renderAt('/v2/use-cases/team-chat');

    expect(await screen.findByRole('heading', {
      level: 2,
      name: 'Run pod conversations with searchable shared context',
    })).toBeInTheDocument();
  });

  test('research workspace use case explains capabilities rather than promising outcomes', async () => {
    renderAt('/use-cases/research-desk/');

    expect(await screen.findByRole('heading', {
      level: 2,
      name: 'Run research and market analysis without losing the project context',
    })).toBeInTheDocument();
    expect(screen.getByText('Common challenges')).toBeInTheDocument();
    expect(screen.getByText('What you can do')).toBeInTheDocument();
  });

  test('canonical comparison URL renders after the app takes over', async () => {
    renderAt('/compare/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Commonly vs the alternatives',
    })).toBeInTheDocument();
  });

  test('guide URL renders the same public article after the app takes over', async () => {
    renderAt('/guides/multi-agent-collaboration-platform/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'What Is a Multi-Agent Collaboration Platform?',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch a live room' })).toBeInTheDocument();
  });

  test('guides index renders after the app takes over', async () => {
    renderAt('/guides/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Guides for teams working with AI agents',
    })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Read the guide' })).toHaveLength(2);
  });

  test('deep protected route redirects to login when not authenticated', () => {
    renderAt('/v2/agents');
    expect(screen.getByRole('heading', { name: /^Sign in$/i })).toBeInTheDocument();
  });

  test('logged-out Community visitors reach the public invite preview', async () => {
    const originalPodId = process.env.REACT_APP_COMMUNITY_POD_ID;
    const originalInviteToken = process.env.REACT_APP_COMMUNITY_INVITE_TOKEN;
    (axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/pods/6a5fe677306155f677c26abf') {
        return Promise.reject({ response: { status: 401 } });
      }
      if (url === '/api/invites/7b91255f18ae3c0ae3721707a6613731/preview') {
        return Promise.resolve({ data: { pod: { name: 'Commonly HQ', memberCount: 12 } } });
      }
      return Promise.resolve({ data: {} });
    });
    process.env.REACT_APP_COMMUNITY_POD_ID = '6a5fe677306155f677c26abf';
    process.env.REACT_APP_COMMUNITY_INVITE_TOKEN = '7b91255f18ae3c0ae3721707a6613731';

    try {
      renderAt('/v2/community');

      expect(await screen.findByText(/invited to Commonly HQ/)).toBeInTheDocument();
      expect(axios.get).toHaveBeenCalledWith('/api/pods/6a5fe677306155f677c26abf');
      expect(axios.get).toHaveBeenCalledWith('/api/invites/7b91255f18ae3c0ae3721707a6613731/preview');
    } finally {
      if (originalPodId === undefined) delete process.env.REACT_APP_COMMUNITY_POD_ID;
      else process.env.REACT_APP_COMMUNITY_POD_ID = originalPodId;
      if (originalInviteToken === undefined) delete process.env.REACT_APP_COMMUNITY_INVITE_TOKEN;
      else process.env.REACT_APP_COMMUNITY_INVITE_TOKEN = originalInviteToken;
    }
  });

  test('renders the migrated auth chrome in Simplified Chinese', async () => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    const view = renderAt('/v2/login');

    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByText('Commonly 是智能体与人共同协作的空间。')).toBeInTheDocument();

    view.unmount();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });
});

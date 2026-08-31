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
    expect(document.body).toHaveClass('guide-canvas');
  });

  test('shared workspace guide retains its MCP setup commands after the app takes over', async () => {
    renderAt('/guides/connect-claude-codex-shared-workspace/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'How to Connect Claude Code and Codex to a Shared Workspace',
    })).toBeInTheDocument();
    expect(screen.getByText(/codex mcp add commonly/)).toBeInTheDocument();
  });

  test('permissions guide renders rich guide paragraphs after the app takes over', async () => {
    renderAt('/guides/ai-agent-permissions-and-tokens/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Permissions and Tokens: Scope Runtime Access Safely',
    })).toBeInTheDocument();
    expect(screen.getByText('Adding an agent to a pod is also an access decision for its runtime token.').tagName).toBe('STRONG');
    expect(screen.getByText('Authorization: Bearer cm_agent_...')).toBeInTheDocument();
  });

  test('Cursor guide retains its MCP configuration after the app takes over', async () => {
    renderAt('/guides/connect-cursor-shared-workspace/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'How to Connect Cursor to a Shared Workspace',
    })).toBeInTheDocument();
    expect(screen.getAllByText(/@commonlyai\/mcp/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cm_agent_\.\.\./).length).toBeGreaterThan(0);
  });

  test('observability guide renders its durable work-record pattern after the app takes over', async () => {
    renderAt('/guides/ai-agent-observability/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Observability: Make Work, Handoffs, and Decisions Visible',
    })).toBeInTheDocument();
    expect(screen.getByText(/Objective: The outcome this work is intended to produce/)).toBeInTheDocument();
  });

  test('events guide renders its delivery boundaries after the app takes over', async () => {
    renderAt('/guides/ai-agent-events/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Events: Mentions, Tasks, Heartbeats, and Safe Handling',
    })).toBeInTheDocument();
    expect(screen.getByText('An event arrives.')).toBeInTheDocument();
    expect(screen.getByText(/cm_agent_\.\.\./)).toBeInTheDocument();
  });

  test('multi-agent comparison guide renders its task contract after the app takes over', async () => {
    renderAt('/guides/multi-agent-vs-single-agent/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Multi-Agent vs. Single-Agent Systems: How to Choose',
    })).toBeInTheDocument();
    expect(screen.getByText(/Objective: The concrete result to produce/)).toBeInTheDocument();
  });

  test('collaboration-patterns guide renders its current-owner contract after the app takes over', async () => {
    renderAt('/guides/ai-agent-collaboration-patterns/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Collaboration Patterns: Leads, Reviewers, Claims, and Races',
    })).toBeInTheDocument();
    expect(screen.getByText(/Outcome: What must exist when the work is done/)).toBeInTheDocument();
  });

  test('agent-onboarding guide renders its Codex connection command after the app takes over', async () => {
    renderAt('/guides/onboarding-an-ai-agent-to-your-team/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'How to Onboard an AI Agent to Your Team: Roles, Access, Context, and First Work',
    })).toBeInTheDocument();
    expect(screen.getByText(/codex mcp add commonly/)).toBeInTheDocument();
    expect(screen.getByText(/COMMONLY_AGENT_TOKEN=cm_agent_…/)).toBeInTheDocument();
  });

  test('Discord integration guide renders its documented rollout after the app takes over', async () => {
    renderAt('/guides/ai-agent-discord-integration/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Discord Integration: Turn a Channel into a Reviewable Work Signal',
    })).toBeInTheDocument();
    expect(screen.getByText(/DISCORD_BOT_TOKEN=\.\.\./)).toBeInTheDocument();
    expect(screen.getByText(/@commonly-bot/)).toBeInTheDocument();
  });

  test('runtime guide renders its documented event loop after the app takes over', async () => {
    renderAt('/guides/what-is-an-ai-agent-runtime/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'What Is an AI Agent Runtime? The Process That Connects Models, Tools, and Work',
    })).toBeInTheDocument();
    expect(screen.getByText(/GET \/api\/agents\/runtime\/events/)).toBeInTheDocument();
    expect(screen.getByText(/cm_agent_…/)).toBeInTheDocument();
  });

  test('heartbeat guide renders its documented no-op convention after the app takes over', async () => {
    renderAt('/guides/ai-agent-heartbeats-and-scheduled-work/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Heartbeats and Scheduled Work: Build a Useful Cadence',
    })).toBeInTheDocument();
    expect(screen.getByText(/HEARTBEAT_OK/)).toBeInTheDocument();
    expect(screen.getByText(/crash-loops the gateway/)).toBeInTheDocument();
  });

  test('marketplace roles guide renders its documented role boundary after the app takes over', async () => {
    renderAt('/guides/ai-agent-marketplace-roles/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'AI Agent Marketplace Roles: Build a Team with Clear Boundaries',
    })).toBeInTheDocument();
    expect(screen.getByText(/Theo as a development project manager that coordinates tasks, reviews pull requests/)).toBeInTheDocument();
  });

  test('guides index renders after the app takes over', async () => {
    renderAt('/guides/');

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Guides for teams working with AI agents',
    })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Read the guide' })).toHaveLength(21);
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'How to Connect Claude Code and Codex to a Shared Workspace',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Shared Memory for AI Agents: Persisting Context Across Sessions',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Human-in-the-Loop Review for AI Agent Teams',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'AI Agent Handoffs: Transfer Work Without Losing Context',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'How to Build an AI Agent Team: Roles, Handoffs, and Review',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Agent-to-Agent Messaging: How AI Agents DM Each Other',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Self-Hosted AI Agent Platform: What to Look For',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'AI Agent Permissions and Tokens: Scope Runtime Access Safely',
    })).toBeInTheDocument();
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

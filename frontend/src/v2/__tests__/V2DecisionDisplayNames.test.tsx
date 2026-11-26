// @ts-nocheck
// F645 (prod, 11-26): a person whose display name is "Alex" read as
// "growth-t002-10160904a" on the card and the ruling, and the agent "Claude
// Code" read as "gw3-claude". The card names its asker by the pod's label,
// never the decision row's agentName, and its question chips read display names.
// The server's displayLabel for this seat is 'gw3-claude' (resolveAgentDisplayLabel
// reads "Claude Code" on claude-code as a runtime leak); the install's chosen
// name wins on screen, the same name as its author line.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  },
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('../components/V2Avatar', () => {
  const MockAvatar = () => <span data-testid="avatar" />;
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const auth = {
  currentUser: { _id: 'human-1', username: 'lily' },
  user: { _id: 'human-1', username: 'lily' },
  token: 'token', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};


const detail = {
  pod: { _id: 'pod-1', name: 'Demo', description: '', type: 'chat' },
  members: [
    { _id: 'human-1', username: 'lily', isBot: false },
    { _id: '64b000000000000000000001', username: 'growth-t002-10160904a', displayName: 'Alex', isBot: false },
    { _id: 'agent-1', username: 'claude-code-gw3-claude', isBot: true, displayLabel: 'gw3-claude' },
  ],
  agents: [{ agentName: 'claude-code', instanceId: 'gw3-claude', displayName: 'Claude Code' }],
  messages: [{
    id: '41', pod_id: 'pod-1', user_id: 'agent-1',
    user: { username: 'claude-code-gw3-claude', isBot: true },
    content: 'Plain note from the agent.',
    message_type: 'text', created_at: '2026-09-05T11:00:00.000Z',
  }, {
    id: '42', pod_id: 'pod-1', user_id: 'agent-1',
    user: { username: 'claude-code-gw3-claude', isBot: true },
    content: 'Choose one of the following approaches in prose.',
    message_type: 'text', created_at: '2026-09-05T12:00:00.000Z',
  }],
  sendMessage: jest.fn(), loading: false, error: null, sendError: null,
  hasMore: false, loadingOlder: false, loadOlder: jest.fn(), refresh: jest.fn(),
};

const renderThread = () => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
  </AuthContext.Provider>,
);

describe('F645: the decision card reads display names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') {
        return Promise.resolve({ data: { items: [{
          id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
          // The decision row's actorName is the install's agentName: the runtime.
          actorName: 'claude-code', title: 'Pick the demo path',
          detail: '@growth-t002-10160904a which path should the demo take?',
          options: [{ label: 'Short path', recommended: true }, { label: 'Long path' }],
        }] } });
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });
    mockPost.mockResolvedValue({ data: { decision: { ruling: {
      value: 'Short path', by: 'growth-t002-10160904a', byName: 'Alex', messageId: 'ruling-42', at: '2026-09-05T12:01:00.000Z',
    } } } });
  });

  test('the header names the agent by its display label, never the runtime agentName', async () => {
    renderThread();
    const card = await screen.findByTestId('decision-card');
    const header = card.querySelector('.v2-decision-card__agent');
    expect(header).toHaveTextContent('Claude Code');
    expect(card).not.toHaveTextContent('claude-code');
    expect(card).not.toHaveTextContent('gw3-claude');
  });

  test('the header and the author line on its own messages read the same name', async () => {
    const { container } = renderThread();
    await screen.findByTestId('decision-card');
    const authors = Array.from(container.querySelectorAll('.v2-msg__author, .v2-msg__author-btn'))
      .map((node) => node.textContent);
    expect(authors).toContain('Claude Code');
    expect(authors.join(' ')).not.toMatch(/gw3-claude|claude-code/);
  });

  test('a backticked handle in the question stays verbatim, unchipped', async () => {
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') {
        return Promise.resolve({ data: { items: [{
          id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42', actorName: 'claude-code',
          title: 'Pick the demo path', detail: 'Should `@gw3-claude` or @gw3-claude take it?',
          options: [{ label: 'Short path' }, { label: 'Long path' }],
        }] } });
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });
    renderThread();
    const card = await screen.findByTestId('decision-card');
    const question = card.querySelector('.v2-decision-card__question');
    expect(question.textContent).toBe('Should `@gw3-claude` or @Claude Code take it?');
    expect(question.querySelectorAll('.v2-msg__mention')).toHaveLength(1);
  });

  test('the question chips the asked person by display name, handle in the tooltip', async () => {
    renderThread();
    const card = await screen.findByTestId('decision-card');
    const chip = card.querySelector('.v2-msg__mention');
    expect(chip).toHaveTextContent('@Alex');
    expect(chip).toHaveAttribute('title', '@growth-t002-10160904a');
    expect(within(card).queryByText(/growth-t002-10160904a/)).not.toBeInTheDocument();
  });

  test('the ruling names the ruler by display name', async () => {
    renderThread();
    fireEvent.click(await screen.findByRole('button', { name: 'Rule: Short path (Recommended)' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const ruling = await screen.findByTestId('decision-ruling-row');
    expect(ruling).toHaveTextContent('Alex');
    expect(ruling).not.toHaveTextContent('growth-t002-10160904a');
  });
});

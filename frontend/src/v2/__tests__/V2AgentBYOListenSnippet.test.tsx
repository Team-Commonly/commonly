// @ts-nocheck
// The listener snippet is what a stranger pastes to make the agent answer
// @mentions. Every line of it has to execute: the CLI-install line was a shell
// comment until 2026-10-09, so a whole-snippet paste on a machine without the
// CLI skipped the install and failed on the last line with "command not found"
// (the #887 class the snippet was moved here to prevent).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../components/V2NavRail', () => () => null);
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
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

const axios = jest.requireMock('axios').default;

const authValue = {
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

const issueToken = async () => {
  axios.get.mockResolvedValue({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /install \+ generate token/i }));
  await screen.findByText(/token issued for/i);
};

describe('BYO listener snippet', () => {
  test('every line executes: the CLI install is a command, not a comment, and the run line is last', async () => {
    await issueToken();
    // Several <pre class="v2-byo__pre"> render on the issued screen (the token,
    // the MCP add command, the Cursor config, the listener); pick the listener.
    const pre = Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    expect(pre).toBeDefined();
    const lines = (pre.textContent || '').split('\n');
    expect(lines).toHaveLength(4);
    // The install line must run when the whole snippet is pasted.
    expect(lines[0].startsWith('npm i -g @commonlyai/cli@latest')).toBe(true);
    expect(lines[0].startsWith('#')).toBe(false);
    expect(lines[1]).toMatch(/^export COMMONLY_API_URL=/);
    expect(lines[2]).toBe('export COMMONLY_AGENT_TOKEN=cm_agent_test_token');
    expect(lines[3]).toMatch(/^commonly agent run \S+$/);
    // No line in the snippet is a bare comment.
    expect(lines.filter((l) => l.trimStart().startsWith('#'))).toHaveLength(0);
  });
});

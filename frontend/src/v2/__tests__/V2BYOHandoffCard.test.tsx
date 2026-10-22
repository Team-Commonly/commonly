import React from 'react';
import fs from 'fs';
import path from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow from '../components/V2MessageRow';
import type { V2Message } from '../hooks/useV2PodDetail';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

const command = [
  'npm i -g @commonlyai/cli@latest',
  'commonly login',
  'commonly agent attach opencode --pod pod-1 --name sam-opencode --env /Users/you/agents/environment.json',
  'commonly agent run sam-opencode',
].join('\n');
const message = (commands: Record<string, string>): V2Message => ({
  id: 'handoff-1',
  pod_id: 'pod-1',
  user_id: 'scout-1',
  content: 'Connect a local agent with the command below.',
  message_type: 'card',
  created_at: '2026-10-22T00:00:00.000Z',
  user: { username: 'scout', isBot: true },
  payload: {
    kind: 'byo-handoff',
    adapter: 'opencode',
    agentName: 'sam-opencode',
    podId: 'pod-1',
    os: 'mac',
    commands,
    supportedOs: ['mac'],
  },
});

describe('V2BYOHandoffCard', () => {
  const writeText = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('points its adapter guides at checked-in documents', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../components/V2BYOHandoffCard.tsx'),
      'utf8',
    );
    const repoRoot = path.resolve(__dirname, '../../../..');
    for (const doc of ['docs/cli/opencode.md', 'docs/cli/dsh.md']) {
      expect(source).toContain(`blob/main/${doc}`);
      expect(fs.existsSync(path.join(repoRoot, doc))).toBe(true);
    }
  });

  it('renders the server command and copies the exact same bytes', async () => {
    render(
      <MemoryRouter>
        <V2MessageRow message={message({ mac: command })} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('byo-handoff-card')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OpenCode setup guide' })).toHaveAttribute(
      'href',
      'https://github.com/Team-Commonly/commonly/blob/main/docs/cli/opencode.md',
    );
    expect(screen.getByTestId('byo-handoff-command').textContent).toBe(command);
    fireEvent.click(screen.getByTestId('byo-handoff-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('offers every supported OS without changing the command text', () => {
    const linux = [
      'npm i -g @commonlyai/cli@latest',
      'commonly login',
      'commonly agent attach codex --pod pod-1 --name sam-codex',
      'commonly agent run sam-codex',
    ].join('\n');
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            ...message({ mac: command, linux }),
            payload: {
              ...message({ mac: command, linux }).payload,
              adapter: 'codex',
              agentName: 'sam-codex',
              os: 'mac',
              supportedOs: ['mac', 'linux'],
            },
          }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Linux' }));
    expect(screen.getByTestId('byo-handoff-command').textContent).toBe(linux);
  });
});

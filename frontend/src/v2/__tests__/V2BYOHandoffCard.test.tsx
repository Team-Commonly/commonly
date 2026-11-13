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

  it.each(['claude', 'codex'])('sends a Windows %s setup to the Bring your own page, even from a stored card with Windows lines', (adapter) => {
    const windowsLine = 'npm i -g @commonlyai/cli@latest\ncommonly login';
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            ...message({ mac: command, windows: windowsLine }),
            payload: {
              ...message({ mac: command, windows: windowsLine }).payload,
              adapter,
              agentName: 'sam-agent',
              podId: '6a00000000000000000000aa',
              os: 'windows',
              supportedOs: ['mac', 'linux', 'windows'],
            },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('byo-handoff-command')).toBeNull();
    expect(screen.queryByTestId('byo-handoff-copy')).toBeNull();
    const link = screen.getByRole('link', { name: 'Bring your own page' });
    expect(link).toHaveAttribute('href', `/v2/agents/byo?pod=6a00000000000000000000aa&name=sam-agent&adapter=${adapter}`);
    expect(screen.getByTestId('byo-handoff-windows').textContent).toContain('PowerShell');
    expect(screen.getByTestId('byo-handoff-windows').textContent).toMatch(/^On Windows, connect (Claude Code|Codex) from the Bring your own page\./);
    expect(screen.getByTestId('byo-handoff-card').textContent).not.toContain('Run the commands below');

    fireEvent.click(screen.getByRole('button', { name: 'macOS' }));
    expect(screen.getByTestId('byo-handoff-command').textContent).toBe(command);
    expect(screen.getByTestId('byo-handoff-card').textContent).toContain('Run the commands below');
  });

  const windowsCard = (extra) => render(
    <MemoryRouter>
      <V2MessageRow
        message={{
          ...message({ mac: command }),
          payload: {
            ...message({ mac: command }).payload,
            adapter: 'codex',
            agentName: 'sam-agent',
            podId: '6a00000000000000000000aa',
            os: 'windows',
            supportedOs: ['mac', 'linux', 'windows'],
            ...extra,
          },
        }}
      />
    </MemoryRouter>,
  );
  const linkParams = () => new URLSearchParams(
    screen.getByRole('link', { name: 'Bring your own page' }).getAttribute('href').split('?')[1],
  );

  it('carries the hosted agent whose memory the local one starts with through the Windows link', () => {
    windowsCard({ memoryFrom: 'scout', memoryInstance: 'hosted-123' });
    const params = linkParams();
    expect(params.get('memoryFrom')).toBe('scout');
    expect(params.get('memoryInstance')).toBe('hosted-123');
  });

  it('reads the memory source from an older card\'s attach line when the payload has no field', () => {
    windowsCard({ commands: { mac: 'commonly agent attach codex --pod p --name sam-agent --memory-from scout --memory-instance default\ncommonly agent run sam-agent' } });
    const params = linkParams();
    expect(params.get('memoryFrom')).toBe('scout');
    expect(params.get('memoryInstance')).toBe('default');
  });

  it('adds no memory to the link when the card names none', () => {
    windowsCard({});
    expect(linkParams().has('memoryFrom')).toBe(false);
  });

  it('drops a memory source the handoff service would refuse', () => {
    windowsCard({ memoryFrom: 'scout&admin=1', memoryInstance: 'default' });
    expect(linkParams().has('memoryFrom')).toBe(false);
    expect(linkParams().has('admin')).toBe(false);
  });

  it('keeps the Windows lines for an adapter the Bring your own page does not cover', () => {
    const windowsLine = 'npm i -g @commonlyai/cli@latest opencode-ai';
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            ...message({ mac: command, windows: windowsLine }),
            payload: { ...message({ mac: command, windows: windowsLine }).payload, os: 'windows', supportedOs: ['mac', 'windows'] },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('byo-handoff-command').textContent).toBe(windowsLine);
    expect(screen.queryByTestId('byo-handoff-windows')).toBeNull();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow from '../components/V2MessageRow';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

describe('V2MessageRow', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;

  afterEach(() => {
    process.env.REACT_APP_API_URL = previousApiUrl;
  });

  it('resolves relative uploaded images against the configured API origin', () => {
    process.env.REACT_APP_API_URL = 'https://api.commonly.me';

    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '1',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: '/api/uploads/avatar.png',
            message_type: 'image',
            created_at: '2026-08-04T00:00:00.000Z',
            user: { username: 'sender' },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('img', { name: 'Uploaded attachment' })).toHaveAttribute(
      'src',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
  });

  // A message with no reactions renders NO reactions row at all — the
  // trigger lives in the hover action cluster (2026-08-23), so the 2026-08-13
  // phantom-band bug cannot recur structurally. The trigger must still be
  // reachable, just from the cluster.
  it('renders no reactions row when a message has no reactions — the trigger lives in the cluster', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '42',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: 'hello',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'sender' },
            reactions: [],
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Reactions')).toBeNull();
    // Reachability is preserved: the cluster carries the trigger.
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
  });

  it('keeps the reactions row in flow when chips exist', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '43',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: 'hello',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'sender' },
            reactions: [{ emoji: '👍', count: 2, mine: false }],
          }}
        />
      </MemoryRouter>,
    );

    const row = screen.getByLabelText('Reactions');
    expect(row.className).not.toContain('v2-msg__reactions--bare');
    expect(screen.getByText('👍')).toBeInTheDocument();
  });

  it('marks a system card with its action state', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '44',
            pod_id: 'pod-1',
            user_id: 'system-1',
            content: '🤝 Pixel and codex started a DM — [view](/v2/pods/0123456789abcdef01234567)',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'commonly-bot' },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Pixel and codex started a DM').closest('.v2-syscard')).toHaveClass('v2-syscard--action');
  });
});

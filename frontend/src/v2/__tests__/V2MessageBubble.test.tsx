import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageBubble from '../components/V2MessageBubble';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

describe('V2MessageBubble', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;

  afterEach(() => {
    process.env.REACT_APP_API_URL = previousApiUrl;
  });

  it('resolves relative uploaded images against the configured API origin', () => {
    process.env.REACT_APP_API_URL = 'https://api.commonly.me';

    render(
      <MemoryRouter>
        <V2MessageBubble
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

  // The reactions row must not reserve layout space when it holds only the
  // hover "+" trigger — the invisible band under every message pushed
  // approval cards visibly away from their trigger text (2026-08-13).
  it('collapses the reactions row (--bare) when a message has no reactions', () => {
    render(
      <MemoryRouter>
        <V2MessageBubble
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

    const row = screen.getByLabelText('Reactions');
    expect(row.className).toContain('v2-msg__reactions--bare');
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
  });

  it('keeps the reactions row in flow when chips exist', () => {
    render(
      <MemoryRouter>
        <V2MessageBubble
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
});

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

  // A message with no reactions renders NO reactions row at all — the
  // trigger lives in the hover action cluster (2026-08-23), so the 2026-08-13
  // phantom-band bug cannot recur structurally. The trigger must still be
  // reachable, just from the cluster.
  it('renders no reactions row when a message has no reactions — the trigger lives in the cluster', () => {
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

    expect(screen.queryByLabelText('Reactions')).toBeNull();
    // Reachability is preserved: the cluster carries the trigger.
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
  });

  it('keeps the reactions row in flow when chips exist', () => {
    const { container } = render(
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

    // TASK-053: the chips and the body share a content-column parent. This
    // is the structural half of "same text axis"; a visual test measures
    // their actual x positions at desktop and mobile widths.
    const column = container.querySelector('.v2-msg__content-column');
    const body = container.querySelector('.v2-msg__body');
    expect(column).not.toBeNull();
    expect(body?.parentElement).toBe(column);
    expect(row.parentElement).toBe(column);
    expect(body?.contains(row)).toBe(false);
  });

  it('keeps React with Reply and Thread in the message action row', () => {
    const { container } = render(
      <MemoryRouter>
        <V2MessageBubble
          message={{
            id: '44',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: 'hello',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'sender' },
            reactions: [{ emoji: '👍', count: 2, mine: true }],
          }}
          onReply={jest.fn()}
          onThread={jest.fn()}
        />
      </MemoryRouter>,
    );

    const actions = screen.getByRole('toolbar', { name: 'Message actions' });
    expect(actions.parentElement).toBe(container.querySelector('.v2-msg__content-column'));
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Reply to sender' }));
    expect(actions).toContainElement(screen.getByRole('button', { name: /thread from sender/i }));
    const addReaction = screen.getByRole('button', { name: 'Add reaction' });
    expect(actions).toContainElement(addReaction);
    expect(container.querySelector('.v2-msg__reaction--mine')).not.toBeNull();

    fireEvent.click(addReaction);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

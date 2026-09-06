// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ThreadMessages from '../components/V2ThreadMessages';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

const msg = (id) => ({
  id, pod_id: 'p', user_id: 'u', content: `m${id}`, created_at: '2026-09-06T09:00:00.000Z', user: { username: 'a' },
});

const renderThread = (props = {}) => {
  const messages = props.messages || [msg('1'), msg('2')];
  return render(
    <MemoryRouter>
      <V2ThreadMessages
        messages={messages}
        threadView={messages.map((message) => ({ kind: 'message', message }))}
        threadState={{ byRoot: new Map(), toggleCollapsed: jest.fn(), toggleFollowing: jest.fn() }}
        decisionByMessageId={new Map()}
        settledDecisionByMessageId={new Map()}
        agentDisplayNames={new Map()}
        agentAuthorKeys={new Set()}
        onAimAtThread={jest.fn()}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={jest.fn()}
        loading={false}
        error={null}
        messagesContainerRef={React.createRef()}
        messagesEndRef={React.createRef()}
        {...props}
      />
    </MemoryRouter>,
  );
};

describe('V2ThreadMessages history edge and jump pill (direction C)', () => {
  test('with more history the edge is a mono "load earlier" control; loading shows "loading earlier…"', () => {
    const onLoadOlder = jest.fn();
    const { rerender, container } = renderThread({ hasMore: true, onLoadOlder });
    expect(container.querySelector('.v2-thread__edge')).toHaveAttribute('data-state', 'more');
    fireEvent.click(screen.getByRole('button', { name: 'load earlier' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.v2-chat__older-btn')).toBeNull();
  });

  test('loading and beginning states are one mono line each, never a dead button', () => {
    const { container } = renderThread({ hasMore: true, loadingOlder: true });
    expect(container.querySelector('.v2-thread__edge')).toHaveAttribute('data-state', 'loading');
    expect(screen.getByRole('status')).toHaveTextContent('loading earlier…');
    expect(screen.queryByRole('button', { name: /earlier/ })).not.toBeInTheDocument();
    const { container: c2 } = renderThread({ hasMore: false });
    expect(c2.querySelector('.v2-thread__edge')).toHaveAttribute('data-state', 'beginning');
    expect(screen.getByText('beginning of the pod')).toBeInTheDocument();
  });

  test('an empty pod shows no edge line at all', () => {
    const { container } = renderThread({ messages: [], hasMore: false });
    expect(container.querySelector('.v2-thread__edge')).toHaveAttribute('data-state', 'empty');
    expect(container.querySelector('.v2-thread__edge').textContent).toBe('');
  });

  test('the jump pill appears only with arrivals while scrolled up and carries the count', () => {
    const onJump = jest.fn();
    renderThread({ jumpCount: 0, onJump });
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
    // A viewport up with no arrivals: the pill mounts without a count.
    const { unmount } = renderThread({ jumpCount: 0, showJump: true, onJump });
    expect(screen.getByRole('button', { name: /Jump to latest/ })).not.toHaveTextContent('·');
    unmount();
    renderThread({ jumpCount: 3, onJump });
    const pill = screen.getByRole('button', { name: /Jump to latest/ });
    expect(pill).toHaveTextContent('· 3');
    fireEvent.click(pill);
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});

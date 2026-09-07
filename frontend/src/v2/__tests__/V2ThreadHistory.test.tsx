// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ThreadMessages, { V2ThreadHistoryStatus } from '../components/V2ThreadMessages';

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
  const historySearch = props.historySearch || {
    targetId: null,
    status: 'idle',
    attempt: 0,
    maxAttempts: 5,
    error: null,
  };
  const { onRetryHistorySearch, historySearch: _historySearch, ...messageProps } = props;
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
        {...messageProps}
      />
      <V2ThreadHistoryStatus
        historySearch={historySearch}
        onRetryHistorySearch={onRetryHistorySearch}
        viewport
      />
    </MemoryRouter>,
  );
};

describe('V2ThreadMessages history edge and jump pill (direction C)', () => {
  test('with more history the edge is a mono "load earlier" control; loading shows "loading earlier…"', () => {
    const onLoadOlder = jest.fn();
    const { container } = renderThread({ hasMore: true, onLoadOlder });
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

  test('source lookup shows bounded progress, failure retry, and a non-deletion bound', () => {
    const onRetry = jest.fn();
    const first = renderThread({
      historySearch: { targetId: 'missing', status: 'searching', attempt: 2, maxAttempts: 5, error: null },
    });
    expect(screen.getByRole('status')).toHaveClass('v2-thread__history-status--viewport');
    expect(screen.getByRole('status')).toHaveTextContent('Searching older messages (2/5)');

    first.unmount();
    const failed = renderThread({
      historySearch: { targetId: 'missing', status: 'failed', attempt: 2, maxAttempts: 5, error: 'offline' },
      onRetryHistorySearch: onRetry,
    });
    expect(screen.getByRole('alert')).toHaveClass('v2-thread__history-status--viewport');
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic search stopped');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.unmount();

    const second = renderThread({
      historySearch: { targetId: 'missing', status: 'not-found', attempt: 5, maxAttempts: 5, error: null },
      onRetryHistorySearch: onRetry,
    });
    expect(screen.getByRole('status')).toHaveTextContent('keep browsing the conversation');
    expect(screen.getByRole('status')).not.toHaveTextContent(/deleted/i);
    second.unmount();
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

  test('groups a settled ruling by its rendered human identity, preserving the author and ruled marker', () => {
    const previous = msg('1');
    const source = msg('2', { user_id: 'u-agent', user: { username: 'Scout' } });
    const { container } = renderThread({
      messages: [previous, source],
      settledDecisionByMessageId: new Map([['2', { value: 'Ship it', by: 'Sam' }]]),
    });

    const ruling = container.querySelector('[data-testid="decision-ruling-row"]');
    expect(ruling).not.toHaveClass('v2-msg--grouped');
    expect(ruling.querySelector('.v2-msg__author')).toHaveTextContent('Sam');
    expect(ruling.querySelector('.v2-msg__ruled')).toBeInTheDocument();
  });
});

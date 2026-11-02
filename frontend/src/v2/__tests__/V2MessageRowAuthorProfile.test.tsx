// @ts-nocheck
import React from 'react';
import { TextEncoder } from 'util';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2MessageRow from '../components/V2MessageRow';

Object.assign(global, { TextEncoder });

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

const HUMAN_ID = '64b7f0c2a1b2c3d4e5f60718';

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const renderRow = (message, onAuthorClick = jest.fn()) => {
  render(
    <MemoryRouter initialEntries={['/v2/pods/chat/pod-1']}>
      <V2MessageRow
        message={{ pod_id: 'pod-1', message_type: 'text', created_at: '2026-10-30T10:00:00.000Z', ...message }}
        agentAuthorKeys={new Set(['vale'])}
        onAuthorClick={onAuthorClick}
      />
      <CurrentPath />
    </MemoryRouter>,
  );
  return onAuthorClick;
};

describe('V2MessageRow author click', () => {
  it('opens a human author\'s profile from the name and the avatar', () => {
    const onAuthorClick = renderRow({ id: 'h1', user_id: HUMAN_ID, content: 'hi', user: { username: 'juno', isBot: false } });
    const buttons = screen.getAllByRole('button', { name: "View juno's profile" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(screen.getByTestId('current-path')).toHaveTextContent(`/v2/profile/${HUMAN_ID}`);
    expect(onAuthorClick).not.toHaveBeenCalled();
  });

  it('keeps an agent author on the inspector handler', () => {
    const onAuthorClick = renderRow({ id: 'a1', user_id: '64b7f0c2a1b2c3d4e5f60799', content: 'done', user: { username: 'vale', isBot: true } });
    expect(screen.queryByRole('button', { name: /profile/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'vale' }));
    expect(onAuthorClick).toHaveBeenCalledWith('vale');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/chat/pod-1');
  });

  it('leaves a kernel line and a row with no isBot as plain text', () => {
    renderRow({ id: 'k1', user_id: HUMAN_ID, author_kind: 'kernel', content: 'claimed', user: { username: 'board', isBot: false } });
    renderRow({ id: 'u1', user_id: '64b7f0c2a1b2c3d4e5f60720', content: 'hello', user: { username: 'ida' } });
    expect(screen.queryByRole('button', { name: "View board's profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "View ida's profile" })).not.toBeInTheDocument();
  });

  it('leaves synthetic rows without a real user id as plain text', () => {
    renderRow({ id: 'r1', user_id: 'decision-ruling', content: 'Ship now', user: { username: 'You', isBot: false } });
    expect(screen.queryByRole('button', { name: /profile/ })).not.toBeInTheDocument();
  });
});

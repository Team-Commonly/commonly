import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import V2ThreadMessages from '../components/V2ThreadMessages';
import { buildThreadView } from '../utils/threadView';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

const claim = (id: number, taskId: string) => ({
  id: String(id),
  pod_id: 'pod-1',
  user_id: 'u1',
  content: '',
  message_type: 'system',
  created_at: `2026-10-31T10:0${id}:00.000Z`,
  thread_root_id: null,
  user: { username: 'scout' },
  payload: { kind: 'system-action', action: 'task-claimed', taskId, actorName: 'Scout' },
});

const claims = [claim(1, 'TASK-674'), claim(2, 'TASK-675'), claim(3, 'TASK-676'), claim(4, 'TASK-678')];

const renderClaims = (messages = claims) => {
  const threadView = buildThreadView(messages as any, new Map());
  return render(
    <MemoryRouter>
      <V2ThreadMessages
        messages={messages as any}
        threadView={threadView}
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
      />
    </MemoryRouter>,
  );
};

// The claim rows render as V2MessageRow system lines with a task id each.
const claimRowTaskIds = (container: HTMLElement) => Array.from(
  container.querySelectorAll('.v2-system-action-line__object'),
).map((node) => node.textContent);

describe('claim run summary control (TASK-692)', () => {
  afterEach(() => i18n.changeLanguage('en'));

  test('shows the count and the first and last task ids, collapsed by default', () => {
    const { container } = renderClaims();
    const toggle = screen.getByRole('button', { name: '4 claims · TASK-674 to TASK-678' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(claimRowTaskIds(container)).toEqual([]);
  });

  test('clicking expands the claim rows in order and clicking again collapses them', () => {
    const { container } = renderClaims();
    const toggle = screen.getByRole('button', { name: /4 claims/ });
    act(() => toggle.click());
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(claimRowTaskIds(container)).toEqual(['TASK-674', 'TASK-675', 'TASK-676', 'TASK-678']);
    act(() => toggle.click());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(claimRowTaskIds(container)).toEqual([]);
  });

  test('Enter and Space on the focused toggle expand and collapse it', async () => {
    const user = userEvent.setup();
    const { container } = renderClaims();
    const toggle = screen.getByRole('button', { name: /4 claims/ });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(claimRowTaskIds(container)).toHaveLength(4);
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(claimRowTaskIds(container)).toEqual([]);
  });

  test('the bar draws the D215 summary: board glyph, faces, bold count, range, time, chevron', () => {
    const { container } = renderClaims();
    const toggle = screen.getByRole('button', { name: '4 claims · TASK-674 to TASK-678' });
    // One claimer here, so one face; the faces, label and time are aria-hidden
    // because the button's accessible name already says the run in one line.
    expect(toggle.querySelectorAll('.v2-claim-run__faces .v2-avatar')).toHaveLength(1);
    expect(toggle.querySelector('.v2-claim-run__label b')).toHaveTextContent('4 claims');
    expect(toggle.querySelector('.v2-claim-run__label')).toHaveTextContent('4 claims · TASK-674 to TASK-678');
    expect(toggle.querySelector('.v2-claim-run__time')).not.toBeNull();
    expect(toggle.querySelector('.v2-claim-run__chev svg')).not.toBeNull();
    act(() => toggle.click());
    expect(container.querySelectorAll('.v2-claim-run__list .v2-system-action-line')).toHaveLength(4);
  });

  test('the expanded rows sit inside the summary group, below the toggle', () => {
    const { container } = renderClaims();
    act(() => screen.getByRole('button', { name: /4 claims/ }).click());
    const group = container.querySelector('.v2-claim-run') as HTMLElement;
    expect(within(group).getByRole('button', { name: /4 claims/ })).toBeInTheDocument();
    expect(group.querySelectorAll('.v2-system-action-line')).toHaveLength(4);
  });
});

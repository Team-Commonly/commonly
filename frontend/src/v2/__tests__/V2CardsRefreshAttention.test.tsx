import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ApprovalCard from '../components/V2ApprovalCard';
import V2DecisionCard from '../components/V2DecisionCard';
import { ATTENTION_CHANGED } from '../hooks/useV2PodAttention';
import en from '../../i18n/locales/en.json';

/**
 * Resolving a card in chat must refresh the attention counts (nav rail, pod
 * inspector). They listen for ATTENTION_CHANGED or window focus; the Activity
 * page sent it, the in-chat cards did not, so a resolved approval kept reading
 * "1 waiting on you · Scout requests approval" (Growth, 2026-10-14).
 */

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: mockGet, post: mockPost, patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'viewer-1' } }),
}));

const listen = () => {
  const seen = { count: 0 };
  const handler = () => { seen.count += 1; };
  window.addEventListener(ATTENTION_CHANGED, handler);
  return { seen, stop: () => window.removeEventListener(ATTENTION_CHANGED, handler) };
};

describe('resolving a card in chat refreshes attention', () => {
  beforeEach(() => { mockPost.mockReset(); mockGet.mockReset(); });

  test('approving an approval card announces the attention change', async () => {
    mockPost.mockResolvedValue({ ok: true });
    const { seen, stop } = listen();
    render(
      <MemoryRouter>
        <V2ApprovalCard
          message={{ id: 'm1', pod_id: 'pod-1', content: '', payload: {
            kind: 'approval-card', approvalId: 'a1', status: 'flagged', ownerUserId: 'viewer-1',
            actionType: 'create_pod', params: { name: 'Design Studio', type: 'chat' }, summary: 'Create a pod',
          } } as never}
          authorLabel="Scout"
          time="3:45 PM"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText(en.approvalCard.approve));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/approvals/a1/resolve', { decision: 'approved' }));
    await waitFor(() => expect(seen.count).toBe(1));
    stop();
  });

  test('a failed resolve does not announce a change', async () => {
    mockPost.mockRejectedValue({ response: { status: 500 } });
    const { seen, stop } = listen();
    render(
      <MemoryRouter>
        <V2ApprovalCard
          message={{ id: 'm2', pod_id: 'pod-1', content: '', payload: {
            kind: 'approval-card', approvalId: 'a2', status: 'flagged', ownerUserId: 'viewer-1',
            actionType: 'create_pod', params: { name: 'X', type: 'chat' }, summary: 'Create a pod',
          } } as never}
          authorLabel="Scout"
          time="3:45 PM"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText(en.approvalCard.approve));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.count).toBe(0);
    stop();
  });

  test('ruling on a decision card announces the attention change', async () => {
    mockPost.mockResolvedValue({ decision: { ruling: { value: 'Ship it', by: 'Sam' } } });
    const { seen, stop } = listen();
    render(<V2DecisionCard decision={{
      id: 'd1', title: 'Ship?', detail: 'Ship or hold', actorName: 'Sprint impl',
      options: [{ label: 'Ship it' }, { label: 'Hold', recommended: true }],
    } as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    await waitFor(() => expect(seen.count).toBe(1));
    stop();
  });
});

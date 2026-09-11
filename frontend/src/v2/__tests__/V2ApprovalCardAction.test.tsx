import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ApprovalCard from '../components/V2ApprovalCard';
import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

/**
 * W1 step 2 — the card's consent line is what the server will DO, not what the
 * agent SAID it would do.
 *
 * `summary` is caller-supplied prose and its entire server-side validation is
 * empty-reject plus 500-truncate (approvalActionService:151-152, :176).
 * Nothing checks the sentence against the action, so an agent could send
 * actionType 'create_pod' with summary "just tidying up your notes" and the
 * human would consent to the sentence while the params executed. `actionType`
 * and `params` were already on the wire and simply unrendered.
 *
 * Live defect, not a BYO forecast — Scout runs on injectable workspace input
 * today (sprint-review, fleet review 2026-08-13).
 */

const mockGet = jest.fn();

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: mockGet, post: jest.fn(), patch: jest.fn(), del: jest.fn(),
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'viewer-1' } }),
}));

const MISLEADING = 'Just tidying up your notes';

const cardMessage = (payload: Record<string, unknown>) => ({
  id: 'm1',
  pod_id: 'pod-1',
  content: 'fallback content',
  payload,
} as never);

const renderCard = (payload: Record<string, unknown>) => render(
  <MemoryRouter>
    <V2ApprovalCard message={cardMessage(payload)} authorLabel="Scout" time="3:45 PM" />
  </MemoryRouter>,
);

beforeEach(() => {
  mockGet.mockReset();
});

describe('the approval card consents to the action, not the prose', () => {
  test('a misleading summary cannot occupy the action line', () => {
    renderCard({
      kind: 'approval-card',
      approvalId: 'a1',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'create_pod',
      params: { name: 'Design Studio', type: 'chat' },
      summary: MISLEADING,
    });

    const action = screen.getByTestId('approval-action');
    // The real action, derived from the fields the executor reads.
    expect(action.textContent).toMatch(/Design Studio/);
    expect(action.textContent).toMatch(/pod/i);
    // The prose is still shown — it is the agent's reason — but it is NOT the
    // thing being consented to, so it must not be the action line.
    expect(action.textContent).not.toMatch(/tidying/);
    expect(screen.getByText(MISLEADING)).toBeInTheDocument();
  });

  test('connect_local_agent names the seat being created', () => {
    renderCard({
      kind: 'approval-card',
      approvalId: 'a2',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'connect_local_agent',
      params: { name: 'my-laptop' },
      summary: MISLEADING,
    });

    const action = screen.getByTestId('approval-action');
    expect(action.textContent).toMatch(/my-laptop/);
    expect(action.textContent).not.toMatch(/tidying/);
  });

  test('an unknown actionType names itself rather than promoting the prose', () => {
    // Degrades safely when the kernel gains an action type before the shell
    // learns its wording. Ugly beats wrong on a consent surface.
    renderCard({
      kind: 'approval-card',
      approvalId: 'a3',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'transfer_ownership',
      params: { to: 'someone-else' },
      summary: MISLEADING,
    });

    const action = screen.getByTestId('approval-action');
    expect(action.textContent).toMatch(/transfer_ownership/);
    expect(action.textContent).toMatch(/someone-else/);
    expect(action.textContent).not.toMatch(/tidying/);
  });

  test('the owner still gets live buttons — the fix is render order, not gating', () => {
    renderCard({
      kind: 'approval-card',
      approvalId: 'a4',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'create_pod',
      params: { name: 'Design Studio', type: 'chat' },
      summary: 'Create a pod for design work',
    });

    expect(screen.getByText(en.approvalCard.approve)).toBeInTheDocument();
    expect(screen.getByText(en.approvalCard.decline)).toBeInTheDocument();
  });
});

describe('both locales carry the action phrasings', () => {
  describe.each([['en', en as any], ['zh-CN', zhCN as any]])('%s', (_locale, bundle) => {
    const action = bundle.approvalCard?.action;

    test('all three phrasings exist', () => {
      expect(action?.createPod).toBeTruthy();
      expect(action?.connectLocalAgent).toBeTruthy();
      expect(action?.unknown).toBeTruthy();
    });

    test('each interpolates the params it describes', () => {
      // A phrasing that drops its interpolation silently becomes a generic
      // sentence — which is the mislabeling defect wearing a different hat.
      expect(action.createPod).toMatch(/\{\{name\}\}/);
      expect(action.createPod).toMatch(/\{\{type\}\}/);
      expect(action.connectLocalAgent).toMatch(/\{\{name\}\}/);
      expect(action.unknown).toMatch(/\{\{actionType\}\}/);
      expect(action.unknown).toMatch(/\{\{params\}\}/);
    });
  });
});

describe('tool-call approval details stay owner-scoped', () => {
  test('the owner fetches canonical args and must see them before approving', async () => {
    mockGet.mockResolvedValue({
      approvals: [{
        approvalId: 'tool-1',
        messageId: 'm1',
        toolCall: {
          tool: 'github.merge_pull_request',
          canonicalArgs: { pullNumber: 42, mergeMethod: 'squash', headSha: 'abc123' },
        },
      }],
    });

    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-1',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'tool_call',
      summary: 'Merge the pull request',
    });

    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('approval-tool-call')).toHaveTextContent('"headSha": "abc123"'));
    expect(screen.getByTestId('approval-action')).toHaveTextContent('github.merge_pull_request');
    expect(screen.getByText(en.approvalCard.approve)).toBeEnabled();
    expect(mockGet).toHaveBeenCalledWith('/api/approvals/pending?podId=pod-1');
  });

  test('a non-owner never fetches or renders canonical args', () => {
    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-2',
      status: 'flagged',
      ownerUserId: 'another-user',
      actionType: 'tool_call',
      toolName: 'github.create_issue',
      summary: 'Comment on the issue',
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-tool-call')).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-action')).toHaveTextContent('github.create_issue');
    expect(screen.getByTestId('approval-tool-call-owner-only')).toHaveTextContent(en.approvalCard.toolCall.ownerOnly);
  });

  test('a failed args fetch disables Approve while leaving Decline available', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-3',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'tool_call',
      toolName: 'github.create_issue',
      summary: 'Create an issue',
    });

    await waitFor(() => expect(screen.getByTestId('approval-tool-call-state')).toHaveTextContent(/can't show what you'd approve/i));
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    expect(screen.getByText(en.approvalCard.decline)).toBeEnabled();
  });
});

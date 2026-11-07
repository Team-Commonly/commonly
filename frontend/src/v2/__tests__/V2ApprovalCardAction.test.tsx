import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
const mockPost = jest.fn();

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: mockGet, post: mockPost, patch: jest.fn(), del: jest.fn(),
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
  mockPost.mockReset();
});

const CurrentPath = () => {
  const location = useLocation();
  return <span data-testid="current-path">{location.pathname}{location.search}</span>;
};

describe('connect card handoff', () => {
  const payload = {
    kind: 'approval-card', approvalId: 'a2', status: 'flagged', ownerUserId: 'viewer-1',
    actionType: 'connect_local_agent', params: { name: 'growth-claude' }, summary: 'Connect Scout',
  };
  const connectPath = '/v2/agents/byo?pod=pod-1&name=growth-claude';

  test('Approve opens the completed seat directly in BYO setup', async () => {
    mockPost.mockResolvedValue({ approval: {
      actionType: 'connect_local_agent', status: 'resolved', decision: 'approved',
      executionResult: { connectPath },
    } });
    render(<MemoryRouter initialEntries={['/v2/pods/pod-1']}>
      <V2ApprovalCard message={cardMessage(payload)} authorLabel="Scout" time="3:45 PM" />
      <CurrentPath />
    </MemoryRouter>);

    fireEvent.click(screen.getByText(en.approvalCard.approve));
    await waitFor(() => expect(screen.getByTestId('current-path')).toHaveTextContent(connectPath));
    expect(mockPost).toHaveBeenCalledWith('/api/approvals/a2/resolve', { decision: 'approved' });
  });

  test('does not leave the card when execution fails', async () => {
    mockPost.mockResolvedValue({ approval: {
      actionType: 'connect_local_agent', status: 'resolved', decision: 'approved',
      executionError: 'seat unavailable', executionResult: { connectPath },
    } });
    render(<MemoryRouter initialEntries={['/v2/pods/pod-1']}>
      <V2ApprovalCard message={cardMessage(payload)} authorLabel="Scout" time="3:45 PM" />
      <CurrentPath />
    </MemoryRouter>);

    fireEvent.click(screen.getByText(en.approvalCard.approve));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
  });
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

describe('the "Approval needed" badge', () => {
  const card = { kind: 'approval-card', approvalId: 'badge', ownerUserId: 'viewer-1', actionType: 'create_pod', params: { name: 'x', type: 'chat' } };

  test('shows while the card can still be answered', () => {
    renderCard({ ...card, status: 'flagged' });
    expect(screen.getByText(en.approvalCard.badge)).toBeInTheDocument();
    expect(document.querySelector('.v2-approval')).toHaveClass('v2-approval--open');
  });

  test.each([
    ['declined', { status: 'resolved', decision: 'declined' }, en.approvalCard.declined],
    ['expired', { status: 'expired' }, en.approvalCard.expired],
    ['a tool call that aged out', { status: 'flagged', actionType: 'tool_call', toolCall: { tool: 'github.create_issue' },
      expiresAt: new Date(Date.now() - 1000).toISOString() }, en.approvalCard.toolCall.expiredPending],
  ])('is gone once the card is %s', (_name, state, line) => {
    renderCard({ ...card, ...state });
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(en.approvalCard.badge)).not.toBeInTheDocument();
    expect(document.querySelector('.v2-approval')).not.toHaveClass('v2-approval--open');
  });

  test('stays on an aged proposal, which can still be decided', () => {
    renderCard({ ...card, status: 'flagged', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(screen.getByText(en.approvalCard.aged)).toBeInTheDocument();
    expect(screen.getByText(en.approvalCard.approve)).toBeEnabled();
    expect(screen.getByText(en.approvalCard.badge)).toBeInTheDocument();
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
  test('an aged parked call cannot be decided before the expiry sweep updates its card', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'tool-expired', status: 'flagged',
      ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'github.create_issue' },
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(screen.getByText(en.approvalCard.toolCall.expiredPending)).toBeInTheDocument();
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    expect(screen.getByText(en.approvalCard.decline)).toBeDisabled();
  });

  test('a parked call that expires while the card is on screen stops being decidable at that moment', () => {
    jest.useFakeTimers();
    // The owner's card reads the pending index while the call is live.
    mockGet.mockReturnValue(new Promise(() => {}));
    try {
      renderCard({
        kind: 'approval-card', approvalId: 'tool-expiring', status: 'flagged',
        ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'github.create_issue' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(screen.queryByText(en.approvalCard.toolCall.expiredPending)).not.toBeInTheDocument();
      expect(screen.getByText(en.approvalCard.badge)).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(60_001); });
      expect(screen.getByText(en.approvalCard.toolCall.expiredPending)).toBeInTheDocument();
      expect(screen.queryByText(en.approvalCard.badge)).not.toBeInTheDocument();
      expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
      expect(screen.getByText(en.approvalCard.decline)).toBeDisabled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a resolved tool call renders its broker ending and code instead of generic success', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'tool-failed', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'github.merge_pull_request' },
      toolCallEnding: 'refused', toolCallCode: 'merge_head_mismatch',
    });
    expect(screen.getByText(/tool call refused \(merge_head_mismatch\)/i)).toBeInTheDocument();
    expect(screen.queryByText(en.approvalCard.approved)).not.toBeInTheDocument();
  });

  test('an unknown outcome tells the owner it may have run, not that it failed', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'tool-unknown', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'github.merge_pull_request' },
      toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown',
    });
    expect(screen.getByText(en.approvalCard.toolCall.outcomeUnknown)).toBeInTheDocument();
    expect(en.approvalCard.toolCall.outcomeUnknown).toContain('This call may have run. Check before approving it again.');
    expect(screen.queryByText(/tool call failed/i)).not.toBeInTheDocument();
  });

  test('pre-ending message payloads use their old execution fields without claiming a refusal', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'legacy-ran', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', executionResult: { id: 9 },
    });
    expect(screen.getByText(en.approvalCard.toolCall.ran)).toBeInTheDocument();
    expect(screen.queryByText(/tool call refused/i)).not.toBeInTheDocument();
  });

  test('an ending-less approved card with no execution witness never claims a broker refusal', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'legacy-unwitnessed', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'linear.create_issue' },
    });
    expect(screen.getByText(en.approvalCard.approved)).toBeInTheDocument();
    expect(screen.queryByText(/tool call refused/i)).not.toBeInTheDocument();
  });

  test('a pre-ending failed tool call stays failed without showing vendor error text', () => {
    renderCard({
      kind: 'approval-card', approvalId: 'legacy-failed', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', executionError: 'private vendor error',
    });
    expect(screen.getByText(/tool call failed \(legacy_execution_failed\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/private vendor error/i)).not.toBeInTheDocument();
  });

  test('a resolved definition mismatch tells the owner the tool changed and to ask again', () => {
    // The resolver card shape for a trailed definition_digest_mismatch refusal.
    renderCard({
      kind: 'approval-card', approvalId: 'changed-pin', status: 'resolved', decision: 'approved',
      ownerUserId: 'viewer-1', actionType: 'tool_call', toolCall: { tool: 'linear.create_issue' },
      toolCallEnding: 'refused', toolCallCode: 'definition_digest_mismatch', toolCallTrailId: 'trail-changed',
    });
    expect(screen.getByText(en.approvalCard.toolCall.pinChanged)).toBeInTheDocument();
    expect(screen.queryByText(/tool call refused/i)).not.toBeInTheDocument();
  });

  test('arguments that are not an object leave the call unreadable and Approve disabled', async () => {
    mockGet.mockResolvedValue({
      approvals: [{ approvalId: 'tool-arr', messageId: 'm1', toolCall: { tool: 'github.merge_pull_request', canonicalArgs: [42, 'squash'] } }],
    });
    renderCard({ kind: 'approval-card', approvalId: 'tool-arr', status: 'flagged', ownerUserId: 'viewer-1', actionType: 'tool_call' });
    await waitFor(() => expect(screen.getByTestId('approval-tool-call-state')).toHaveTextContent(en.approvalCard.toolCall.unavailable));
    expect(screen.queryByTestId('approval-args')).not.toBeInTheDocument();
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
  });

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

  describe('approving what was shown (F215)', () => {
    const toolCard = {
      kind: 'approval-card', approvalId: 'tool-9', status: 'flagged', ownerUserId: 'viewer-1',
      actionType: 'tool_call', summary: 'Update an issue',
    };
    const pending = (toolCall: Record<string, unknown>) => mockGet.mockResolvedValue({
      approvals: [{ approvalId: 'tool-9', messageId: 'm1', toolCall }],
    });

    test('approving sends back the digest of the arguments on the card', async () => {
      pending({ tool: 'sentry.update_issue', canonicalArgs: { status: 'resolved' }, argsDigest: 'digest-1' });
      mockPost.mockResolvedValue({ approval: {} });
      renderCard(toolCard);
      await waitFor(() => expect(screen.getByText(en.approvalCard.approve)).toBeEnabled());
      fireEvent.click(screen.getByText(en.approvalCard.approve));
      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        '/api/approvals/tool-9/resolve', { decision: 'approved', argsDigest: 'digest-1' },
      ));
    });

    test('a PR write shows its server summary and can be approved on the card', async () => {
      pending({
        tool: 'github.create_pull_request', argsDigest: 'digest-2',
        summary: { repo: 'o/r', head: 'seat/1/x', base: 'main', title: 'Fix it' },
      });
      mockPost.mockResolvedValue({ approval: {} });
      renderCard(toolCard);
      await waitFor(() => expect(screen.getByTestId('approval-arg-title')).toHaveTextContent('Fix it'));
      expect(screen.getByTestId('approval-arg-head')).toHaveTextContent('seat/1/x');
      // The summary is not the envelope, so nothing is labelled as the exact arguments.
      expect(screen.queryByTestId('approval-tool-call')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText(en.approvalCard.approve));
      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        '/api/approvals/tool-9/resolve', { decision: 'approved', argsDigest: 'digest-2' },
      ));
    });

    test('a card with neither arguments nor a summary stays unapprovable', async () => {
      pending({ tool: 'sentry.update_issue', argsDigest: 'digest-3' });
      renderCard(toolCard);
      await waitFor(() => expect(screen.getByTestId('approval-tool-call-state'))
        .toHaveTextContent(en.approvalCard.toolCall.unavailable));
      expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    });

    test('a value past its box says so, and the exact arguments show what a row shows', async () => {
      pending({
        tool: 'sentry.update_issue', argsDigest: 'digest-4',
        canonicalArgs: { reason: `${'x'.repeat(5000)}‮tail` },
      });
      renderCard(toolCard);
      await waitFor(() => expect(screen.getByTestId('approval-arg-reason')).toBeInTheDocument());
      expect(screen.getByTestId('approval-arg-reason')).toHaveTextContent(
        en.approvalCard.toolCall.longValue.replace('{{length}}', '5005'),
      );
      expect(screen.getByTestId('approval-tool-call')).toHaveTextContent('\\u{202E}tail');
      expect(screen.getByTestId('approval-tool-call').textContent).not.toContain('‮');
    });

    test('a server that will not take the review says so', async () => {
      pending({ tool: 'sentry.update_issue', canonicalArgs: { status: 'resolved' }, argsDigest: 'digest-5' });
      mockPost.mockRejectedValue({ response: { status: 409, data: { error: 'approval_needs_review' } } });
      renderCard(toolCard);
      await waitFor(() => expect(screen.getByText(en.approvalCard.approve)).toBeEnabled());
      fireEvent.click(screen.getByText(en.approvalCard.approve));
      expect(await screen.findByText(en.approvalCard.errors.needsReview)).toBeInTheDocument();
    });
  });

  test('the owner reads the call as a verb and rows, with the exact arguments one click away', async () => {
    const headSha = 'abc1234def5678abc1234def5678abc1234def56';
    mockGet.mockResolvedValue({
      approvals: [{
        approvalId: 'tool-2',
        messageId: 'm1',
        toolCall: {
          tool: 'github.merge_pull_request',
          canonicalArgs: { pullNumber: 4, mergeMethod: 'squash', headSha, owner: 'Team-Commonly', repo: 'demo-day' },
        },
      }],
    });

    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-2',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'tool_call',
      summary: 'Merge the pull request',
    });

    await waitFor(() => expect(screen.getByTestId('approval-args')).toBeInTheDocument());
    const action = screen.getByTestId('approval-action');
    expect(action).toHaveTextContent('Merge pull request #4');
    expect(action).toHaveTextContent('github.merge_pull_request');

    const repoLink = within(screen.getByTestId('approval-arg-owner-repo')).getByRole('link', { name: 'Team-Commonly/demo-day' });
    expect(repoLink).toHaveAttribute('href', 'https://github.com/Team-Commonly/demo-day');
    expect(repoLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(screen.getByTestId('approval-arg-pullNumber')).getByRole('link', { name: '#4' }))
      .toHaveAttribute('href', 'https://github.com/Team-Commonly/demo-day/pull/4');
    const head = screen.getByTestId('approval-arg-headSha');
    expect(head).toHaveTextContent(en.approvalCard.toolCall.label.head);
    expect(head).toHaveTextContent('abc1234');
    expect(head.querySelector('dd')).toHaveAttribute('title', headSha);
    expect(screen.getByTestId('approval-arg-mergeMethod')).toHaveTextContent('squash');

    // The exact JSON is still on the card, behind a disclosure, never dropped.
    expect(screen.getByText(en.approvalCard.toolCall.exactArgs).closest('details')).not.toBeNull();
    expect(screen.getByTestId('approval-tool-call')).toHaveTextContent(`"headSha": "${headSha}"`);
    expect(screen.getByText(en.approvalCard.approve)).toBeEnabled();
  });

  test('a non-owner never fetches or renders canonical args', () => {
    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-2',
      status: 'flagged',
      ownerUserId: 'another-user',
      actionType: 'tool_call',
      toolCall: { tool: 'github.create_issue' },
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
      toolCall: { tool: 'github.create_issue' },
      summary: 'Create an issue',
    });

    await waitFor(() => expect(screen.getByTestId('approval-tool-call-state')).toHaveTextContent(/can't show what you'd approve/i));
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    expect(screen.getByText(en.approvalCard.decline)).toBeEnabled();
  });

  test('a PR write has no canonicalArgs: its summary is what the owner reads and approves', async () => {
    mockGet.mockResolvedValue({
      approvals: [{
        approvalId: 'tool-pr',
        toolCall: {
          tool: 'github.commit_files',
          summary: {
            repo: 'Team-Commonly/d14-walk-sandbox',
            head: 'walk/one',
            lands: 'new branch walk/one from main at abc1234',
            subject: 'add the note',
            message: { label: 'Commit message', text: 'add the note', length: 12, truncated: false },
            files: [
              { path: 'notes.md', content: 'hello', bytes: 5, truncated: false },
              { path: 'src/auth.js', content: '', bytes: 1680, truncated: true },
            ],
            contents: { shownBytes: 5, totalBytes: 1685, truncated: true },
            fileCount: 1,
          },
        },
      }],
    });
    renderCard({
      kind: 'approval-card', approvalId: 'tool-pr', status: 'flagged', ownerUserId: 'viewer-1',
      actionType: 'tool_call', toolCall: { tool: 'github.commit_files' }, summary: 'Commit',
    });

    expect(await screen.findByTestId('approval-arg-files-0')).toHaveTextContent('notes.md');
    expect(screen.getByTestId('approval-arg-files-0')).toHaveTextContent('hello');
    expect(screen.getByTestId('approval-arg-files-1')).toHaveTextContent('Not shown. This file is 1680 bytes.');
    expect(screen.getByTestId('approval-arg-message')).toHaveTextContent('add the note');
    expect(screen.getByTestId('approval-notice')).toHaveTextContent('5 of 1685 bytes');
    expect(screen.getByTestId('approval-action')).toHaveTextContent('Commit to walk/one');
    expect(screen.getByTestId('approval-arg-lands')).toHaveTextContent('new branch walk/one from main at abc1234');
    expect(screen.queryByTestId('approval-tool-call-state')).not.toBeInTheDocument();
    expect(screen.queryByText(en.approvalCard.toolCall.exactArgs)).not.toBeInTheDocument();
    expect(screen.getByText(en.approvalCard.approve)).toBeEnabled();
  });

  test.each([
    ['a summary that is not an object', 'just trust me'],
    ['a summary that is a list', ['one']],
    ['an empty summary', {}],
  ])('%s leaves the call unreadable and Approve disabled', async (_label, summary) => {
    mockGet.mockResolvedValue({
      approvals: [{ approvalId: 'tool-pr-bad', toolCall: { tool: 'github.commit_files', summary } }],
    });
    renderCard({
      kind: 'approval-card', approvalId: 'tool-pr-bad', status: 'flagged', ownerUserId: 'viewer-1',
      actionType: 'tool_call', toolCall: { tool: 'github.commit_files' }, summary: 'Commit',
    });

    await waitFor(() => expect(screen.getByTestId('approval-tool-call-state'))
      .toHaveTextContent(en.approvalCard.toolCall.unavailable));
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    expect(screen.getByText(en.approvalCard.decline)).toBeEnabled();
  });

  test('a pending row without toolCall keeps Approve disabled', async () => {
    mockGet.mockResolvedValue({ approvals: [{ approvalId: 'tool-4' }] });
    renderCard({
      kind: 'approval-card',
      approvalId: 'tool-4',
      status: 'flagged',
      ownerUserId: 'viewer-1',
      actionType: 'tool_call',
      toolCall: { tool: 'github.create_issue' },
      summary: 'Create an issue',
    });

    await waitFor(() => expect(screen.getByTestId('approval-tool-call-state')).toHaveTextContent(/can't show what you'd approve/i));
    expect(screen.getByText(en.approvalCard.approve)).toBeDisabled();
    expect(screen.getByText(en.approvalCard.decline)).toBeEnabled();
  });
});

test.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'extra'])('canonical argument %s keeps the real consent card usable', async key => {
  const canonicalArgs = JSON.parse(JSON.stringify({ title:'Pinned issue', [key]:'pinned-not-prose' }));
  mockGet.mockResolvedValue({approvals:[{approvalId:'inherited-key',messageId:'m1',toolCall:{tool:'github.create_issue',canonicalArgs}}]});
  renderCard({kind:'approval-card',approvalId:'inherited-key',status:'flagged',ownerUserId:'viewer-1',actionType:'tool_call'});
  const row = await screen.findByTestId(`approval-arg-${key}`);
  expect(within(row).getByText(key)).toBeInTheDocument();
  expect(within(row).getByText('pinned-not-prose')).toBeInTheDocument();
  expect(screen.getByTestId('approval-tool-call')).toHaveTextContent(`"${key}": "pinned-not-prose"`);
  expect(screen.getByText(en.approvalCard.approve)).toBeEnabled();
  expect(screen.getByText(en.approvalCard.decline)).toBeEnabled();
});


test.each([
  ['github.merge_pull_request', { pullNumber: 42, issueNumber: 7 }, 'Merge pull request #42'],
  ['github.comment_on_issue', { pullNumber: 7, issueNumber: 42 }, 'Comment on issue #42'],
  ['github.close_issue', { pullNumber: 7, issueNumber: 42 }, 'Close issue #42'],
  ['github.merge_pull_request', { pullNumber: 0, issueNumber: 7 }, null],
  ['github.comment_on_issue', { pullNumber: 7, issueNumber: 0 }, null],
  ['github.close_issue', { pullNumber: 7, issueNumber: 0 }, null],
])('consent for %s uses only its required number (%j)', async (tool, canonicalArgs, expected) => {
  mockGet.mockResolvedValue({ approvals: [{
    approvalId: 'number-selection', messageId: 'm1', toolCall: { tool, canonicalArgs },
  }] });
  renderCard({ kind: 'approval-card', approvalId: 'number-selection', status: 'flagged',
    ownerUserId: 'viewer-1', actionType: 'tool_call' });
  await waitFor(() => expect(screen.getByTestId('approval-args')).toBeInTheDocument());
  const action = screen.getByTestId('approval-action');
  expect(action).toHaveTextContent(tool);
  if (expected) expect(action).toHaveTextContent(expected);
  else expect(action).not.toHaveTextContent(/#7/);
  expect(screen.getByTestId('approval-arg-pullNumber')).toBeInTheDocument();
  expect(screen.getByTestId('approval-arg-issueNumber')).toBeInTheDocument();
});

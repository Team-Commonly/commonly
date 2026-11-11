import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ApprovalCard from '../components/V2ApprovalCard';
import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

/**
 * F371: approve before run. When someone else asks the owner's agent to act,
 * the card names who asked, quotes the request and lists what the agent can
 * reach in the pod. The owner approves, narrows (approves their own version)
 * or declines; everyone else sees that it waits for the owner.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();
let mockViewer = 'owner-1';

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: mockGet, post: mockPost, patch: jest.fn(), del: jest.fn(),
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: mockViewer } }),
}));

const REQUEST = 'Summarize the launch notes and post them to the board';
const base = {
  kind: 'approval-card', approvalId: 'r1', status: 'flagged', ownerUserId: 'owner-1',
  actionType: 'run_request', summary: 'Ben asked Nova to run a request',
  params: { requesterName: 'Ben', request: REQUEST, reach: ['pod:read', 'pod:post', 'memory:write', 'calendar:write'] },
};

const renderCard = (payload: Record<string, unknown>) => render(
  <MemoryRouter>
    <V2ApprovalCard
      message={{ id: 'm1', pod_id: 'pod-1', content: '[approval needed] fallback', payload } as never}
      authorLabel="Nova"
      time="3:45 PM"
    />
  </MemoryRouter>,
);

const rr = en.approvalCard.runRequest;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockViewer = 'owner-1';
});

describe('a held run request', () => {
  test('names who asked, quotes the request, and lists what the agent can reach', () => {
    renderCard(base);
    expect(screen.getByTestId('approval-action')).toHaveTextContent('Ben asked Nova to do this');
    expect(screen.getByTestId('approval-request')).toHaveTextContent(REQUEST);
    const reach = screen.getByTestId('approval-reach');
    expect(reach).toHaveTextContent('Here, Nova can');
    expect(reach).toHaveTextContent(rr.reach_pod_read);
    expect(reach).toHaveTextContent(rr.reach_pod_post);
    expect(reach).toHaveTextContent(rr.reach_memory_write);
    // A grant the card has no wording for still shows, as itself.
    expect(reach).toHaveTextContent('calendar:write');
  });

  // F449: the walk saw these two as raw keys.
  test('words the integration reach codes, so no raw key shows', () => {
    renderCard({ ...base, params: { ...base.params, reach: ['integrations:read', 'integrations:messages:read'] } });
    const reach = screen.getByTestId('approval-reach');
    expect(rr.reach_integrations_read).toBeTruthy();
    expect(rr.reach_integrations_messages_read).toBeTruthy();
    expect(reach).toHaveTextContent(rr.reach_integrations_read);
    expect(reach).toHaveTextContent(rr.reach_integrations_messages_read);
    expect(reach).not.toHaveTextContent('integrations:');
  });

  test('the owner gets Approve, Narrow and Decline', () => {
    renderCard(base);
    expect(screen.getByRole('button', { name: en.approvalCard.approve })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: rr.narrow })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.approvalCard.decline })).toBeInTheDocument();
  });

  test('Approve sends a plain approval', async () => {
    mockPost.mockResolvedValue({ approval: {} });
    renderCard(base);
    fireEvent.click(screen.getByRole('button', { name: en.approvalCard.approve }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/approvals/r1/resolve', { decision: 'approved' }));
  });

  test('Narrow opens the request for editing and approves the owner\'s version', async () => {
    mockPost.mockResolvedValue({ approval: {} });
    renderCard(base);
    fireEvent.click(screen.getByRole('button', { name: rr.narrow }));
    const box = screen.getByLabelText('Approve only this. Nova gets your version.');
    expect(box).toHaveValue(REQUEST);
    fireEvent.change(box, { target: { value: '  Summarize only. Do not post.  ' } });
    fireEvent.click(screen.getByRole('button', { name: rr.narrowApprove }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/approvals/r1/resolve', { decision: 'approved', narrowedTo: 'Summarize only. Do not post.' },
    ));
  });

  test('an emptied narrowing cannot be sent, and Cancel goes back to the three answers', () => {
    renderCard(base);
    fireEvent.click(screen.getByRole('button', { name: rr.narrow }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: rr.narrowApprove })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: rr.narrowCancel }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: rr.narrow })).toBeInTheDocument();
  });

  test('Decline sends a decline', async () => {
    mockPost.mockResolvedValue({ approval: {} });
    renderCard(base);
    fireEvent.click(screen.getByRole('button', { name: en.approvalCard.decline }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/approvals/r1/resolve', { decision: 'declined' }));
  });

  test('anyone else sees the request and that it waits for the agent\'s owner, with no buttons', () => {
    mockViewer = 'ben';
    renderCard(base);
    expect(screen.getByTestId('approval-request')).toHaveTextContent(REQUEST);
    expect(screen.getByText("Waiting for Nova's owner to decide.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('the answered card says what happened', () => {
    const { rerender } = renderCard({ ...base, status: 'resolved', decision: 'approved' });
    expect(screen.getByText('Approved. Nova has the request.')).toBeInTheDocument();
    const narrowed = { ...base, status: 'resolved', decision: 'approved', params: { ...base.params, narrowedTo: 'Summarize only' } };
    rerender(<MemoryRouter><V2ApprovalCard message={{ id: 'm1', pod_id: 'pod-1', content: '', payload: narrowed } as never} authorLabel="Nova" time={null} /></MemoryRouter>);
    expect(screen.getByText('Approved as: Summarize only')).toBeInTheDocument();
    const declined = { ...base, status: 'resolved', decision: 'declined' };
    rerender(<MemoryRouter><V2ApprovalCard message={{ id: 'm1', pod_id: 'pod-1', content: '', payload: declined } as never} authorLabel="Nova" time={null} /></MemoryRouter>);
    expect(screen.getByText("Declined. Nova won't run it.")).toBeInTheDocument();
  });

  test('zh-CN carries every run-request string', () => {
    const zh = (zhCN.approvalCard as { runRequest?: Record<string, string> }).runRequest || {};
    expect(Object.keys(zh).sort()).toEqual(Object.keys(rr).sort());
    Object.entries(rr).forEach(([key, value]) => {
      const vars = (value.match(/{{\w+}}/g) || []).sort();
      expect({ key, vars: (zh[key].match(/{{\w+}}/g) || []).sort() }).toEqual({ key, vars });
    });
  });
});

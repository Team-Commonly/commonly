// @ts-nocheck
import React from 'react';
import {
  fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2InviteModal from '../components/V2InviteModal';

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

const renderModal = (initialTab = 'people', extra = {}) => render(
  <MemoryRouter>
    <div className="v2-root">
      <V2InviteModal
        open
        podId="pod-1"
        podName="Launch room"
        initialTab={initialTab}
        onClose={jest.fn()}
        {...extra}
      />
    </div>
  </MemoryRouter>,
);

describe('V2InviteModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({ token: 'c'.repeat(32) });
    mockApi.del.mockResolvedValue({ ok: true });
  });

  test('sends the selected expiry and max-use presets when creating a link', async () => {
    renderModal();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/pods/pod-1/invites'));

    fireEvent.change(screen.getByLabelText('Invite expiry'), { target: { value: '720' } });
    fireEvent.change(screen.getByLabelText('Invite maximum uses'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate invite link' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/pods/pod-1/invites', {
        expiresInHours: 720,
        maxUses: 10,
      });
    });
    expect(await screen.findByLabelText('New invite link')).toHaveValue(
      `${window.location.origin}/v2/invite/${'c'.repeat(32)}`,
    );
  });

  test('renders existing links and removes a row after revoke', async () => {
    const token = 'a'.repeat(32);
    mockApi.get.mockResolvedValue([{
      token,
      createdBy: { _id: 'user-2', username: 'Aria' },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: null,
      maxUses: 10,
      uses: 2,
    }]);
    renderModal();

    expect(await screen.findByText('Aria')).toBeInTheDocument();
    expect(screen.getByText('2 of 10 uses')).toBeInTheDocument();
    expect(screen.getByText('Never expires')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke invite created by Aria' }));

    await waitFor(() => expect(mockApi.del).toHaveBeenCalledWith(`/api/invites/${token}`));
    await waitFor(() => expect(screen.queryByText('Aria')).not.toBeInTheDocument());
  });

  test('opens directly on the agent tab when requested by the starter panel', () => {
    renderModal('agent');

    expect(screen.getByRole('tab', { name: 'Add agent' })).toHaveAttribute('aria-selected', 'true');
    // The primary action is connect-your-own, not the v1 catalog. The starter
    // panel deep-links here, so it lands on the flow that works rather than on
    // the template list that produced the 2026-08-14 dead seat.
    expect(screen.getByRole('button', { name: 'Connect your own agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Or browse the catalog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate invite link' })).not.toBeInTheDocument();
  });

  describe('adding someone by username', () => {
    const refusal = (code) => Object.assign(new Error('refused'), { response: { status: 404, data: { code } } });

    test('is offered only to the pod creator', async () => {
      const { unmount } = renderModal();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      expect(screen.queryByLabelText('Username to add')).toBeNull();
      unmount();
      renderModal('people', { canAddMember: true });
      expect(screen.getByLabelText('Username to add')).toBeInTheDocument();
    });

    test('adds by username, strips a leading @, and tells the layout to refresh', async () => {
      const onMemberAdded = jest.fn();
      mockApi.post.mockResolvedValueOnce({ ok: true, alreadyMember: false, member: { _id: 'u2', username: 'teammate' } });
      renderModal('people', { canAddMember: true, onMemberAdded });
      fireEvent.change(screen.getByLabelText('Username to add'), { target: { value: ' @teammate ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Added @teammate.');
      expect(mockApi.post).toHaveBeenCalledWith('/api/pods/pod-1/members', { username: 'teammate' });
      expect(onMemberAdded).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('Username to add')).toHaveValue('');
    });

    test('says when they are already in the pod, without a refresh', async () => {
      const onMemberAdded = jest.fn();
      mockApi.post.mockResolvedValueOnce({ ok: true, alreadyMember: true, member: { _id: 'u2', username: 'teammate' } });
      renderModal('people', { canAddMember: true, onMemberAdded });
      fireEvent.change(screen.getByLabelText('Username to add'), { target: { value: 'teammate' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('status')).toHaveTextContent('@teammate is already in this pod.');
      expect(onMemberAdded).not.toHaveBeenCalled();
    });

    test.each([
      ['teammate_not_found', 'No one by that name shares a pod with you. Send them an invite link instead.'],
      ['agent_not_addable', "That's an agent. Agents join by being installed, from Add agent."],
      ['something_else', "Couldn't add them. Try again."],
    ])('names the %s refusal in its own words', async (code, text) => {
      mockApi.post.mockRejectedValueOnce(refusal(code));
      renderModal('people', { canAddMember: true });
      fireEvent.change(screen.getByLabelText('Username to add'), { target: { value: 'someone' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByLabelText('Username to add')).toHaveValue('someone');
    });

    test('drops a reply that lands after the dialog moved to another pod', async () => {
      let resolve;
      mockApi.post.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
      const onMemberAdded = jest.fn();
      const view = renderModal('people', { canAddMember: true, onMemberAdded });
      fireEvent.change(screen.getByLabelText('Username to add'), { target: { value: 'teammate' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      view.rerender(
        <MemoryRouter>
          <div className="v2-root">
            <V2InviteModal open podId="pod-2" podName="Other" initialTab="people" onClose={jest.fn()} canAddMember onMemberAdded={onMemberAdded} />
          </div>
        </MemoryRouter>,
      );
      resolve({ ok: true, alreadyMember: false, member: { _id: 'u2', username: 'teammate' } });
      await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/pods/pod-2/invites'));
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('');
      expect(onMemberAdded).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
    });

    test('asks for a username before calling the server', async () => {
      renderModal('people', { canAddMember: true });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter a username.');
      expect(mockApi.post).not.toHaveBeenCalledWith('/api/pods/pod-1/members', expect.anything());
    });
  });
});

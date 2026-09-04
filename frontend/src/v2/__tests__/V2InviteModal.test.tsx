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

const renderModal = (initialTab = 'people') => render(
  <MemoryRouter>
    <div className="v2-root">
      <V2InviteModal
        open
        podId="pod-1"
        podName="Launch room"
        initialTab={initialTab}
        onClose={jest.fn()}
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
    expect(screen.getByRole('button', { name: 'Connect your own agent →' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Or browse the catalog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate invite link' })).not.toBeInTheDocument();
  });
});

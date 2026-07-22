// @ts-nocheck
import React from 'react';
import {
  fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2InviteRedeem from '../components/V2InviteRedeem';

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    loading: false,
    token: 'jwt',
    currentUser: { _id: 'user-1', username: 'Sam' },
  }),
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

describe('V2InviteRedeem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockResolvedValue({
      token: 'a'.repeat(32),
      pod: {
        _id: 'private-1',
        name: 'Private room',
        type: 'agent-dm',
        memberCount: 2,
      },
      alreadyMember: false,
      expiresAt: null,
    });
  });

  test('explains that a private 1:1 conversation cannot accept invite redemption', async () => {
    mockApi.post.mockRejectedValue({
      response: {
        status: 403,
        data: {
          code: 'dm_membership_refused',
          msg: 'server detail',
        },
      },
    });
    render(
      <MemoryRouter initialEntries={[`/v2/invite/${'a'.repeat(32)}`]}>
        <Routes>
          <Route path="/v2/invite/:token" element={<V2InviteRedeem />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Join Private room' }));

    await waitFor(() => {
      expect(screen.getByText("This is a private 1:1 conversation — it can't be joined with an invite link.")).toBeInTheDocument();
    });
  });
});

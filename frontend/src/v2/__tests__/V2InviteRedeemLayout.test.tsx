// @ts-nocheck
// The d215 invite frames: the auth card holding a pod, one key per state.
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import V2InviteRedeem from '../components/V2InviteRedeem';

const mockApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() };
let mockAuthenticated = false;

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockAuthenticated, loading: false }),
}));
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const TOKEN = 'b'.repeat(32);
const renderPage = () => render(
  <MemoryRouter initialEntries={[`/v2/invite/${TOKEN}`]}>
    <Routes><Route path="/v2/invite/:token" element={<V2InviteRedeem />} /></Routes>
  </MemoryRouter>,
);

describe('V2InviteRedeem layout', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAuthenticated = false; });

  test('signed out: the pod is the title inside the auth card, with sign up and log in', async () => {
    axios.get.mockResolvedValue({ data: { pod: { name: 'Design review', memberCount: 4 } } });
    const { container } = renderPage();
    const title = await screen.findByRole('heading', { level: 1, name: 'Design review' });
    const card = container.querySelector('.v2-login__card.v2-login__card--stack');
    expect(card).toContainElement(title);
    expect(card.querySelector('.v2-login__brand')).not.toBeNull();
    expect(within(card).getByText('You’re invited to')).toHaveClass('v2-invite__eyebrow');
    expect(within(card).getByText(/4 members/)).toHaveClass('v2-invite__meta');
    expect(within(card).getByRole('button', { name: 'Sign up to join' })).toHaveClass('v2-login__submit');
    expect(within(card).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', `/v2/login?next=${encodeURIComponent(`/v2/invite/${TOKEN}`)}`);
    expect(container.querySelector('.v2-invite-card, .v2-invite-page')).toBeNull();
  });

  test('a dead link: the alert row and one plain key', async () => {
    axios.get.mockRejectedValue(new Error('gone'));
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Invite unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This invite is no longer valid.');
    const key = screen.getByRole('button', { name: 'What is Commonly?' });
    expect(key).toHaveClass('v2-login__submit', 'v2-login__submit--ghost');
  });

  test('signed in: description, member count and Join; a member gets Go to pod', async () => {
    mockAuthenticated = true;
    mockApi.get.mockResolvedValue({
      pod: { _id: 'p1', name: 'Design review', description: 'Crits on the launch screens.', memberCount: 4 },
      alreadyMember: false,
    });
    const { unmount } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Design review' })).toBeInTheDocument();
    expect(screen.getByText('Crits on the launch screens.')).toHaveClass('v2-invite__description');
    expect(screen.getByRole('button', { name: 'Join Design review' })).toHaveClass('v2-login__submit');
    unmount();

    mockApi.get.mockResolvedValue({ pod: { _id: 'p1', name: 'Design review', memberCount: 4 }, alreadyMember: true });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Go to pod' })).toBeInTheDocument();
  });
  test('signed in: a dead link and a failed join both show the alert row inside the card', async () => {
    mockAuthenticated = true;
    mockApi.get.mockRejectedValue({ response: { data: { msg: 'Invite expired' } } });
    const { container, unmount } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Invite unavailable' })).toBeInTheDocument();
    const card = container.querySelector('.v2-login__card');
    expect(within(card).getByRole('alert')).toHaveTextContent('Invite expired');
    expect(within(card).getByRole('button', { name: 'Go to your pods' })).toHaveClass('v2-login__submit--ghost');
    unmount();

    mockApi.get.mockResolvedValue({ pod: { _id: 'p1', name: 'Design review', memberCount: 4 }, alreadyMember: false });
    mockApi.post.mockRejectedValue({ response: { data: { msg: 'Pod is full' } } });
    const second = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Join Design review' }));
    const alert = await screen.findByRole('alert');
    expect(second.container.querySelector('.v2-login__card')).toContainElement(alert);
    expect(alert).toHaveTextContent('Pod is full');
    expect(screen.getByRole('button', { name: 'Join Design review' })).toBeInTheDocument();
  });
});

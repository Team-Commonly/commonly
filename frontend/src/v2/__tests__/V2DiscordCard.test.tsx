// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
import { AuthContext } from '../../context/AuthContext';
import V2DiscordCard, { resetDiscordCardForTest } from '../components/V2DiscordCard';
import { noteOwnPost, resetOwnPostForTest } from '../utils/ownPost';
import { trackUsage } from '../utils/usageEvents';
import { DISCORD_INVITE_URL } from '../utils/feedbackLinks';

jest.mock('axios', () => {
  const mock = {
    post: jest.fn(() => Promise.resolve({ data: { ok: true } })),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});
jest.mock('../utils/usageEvents', () => ({ trackUsage: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;
const person = (overrides = {}) => ({
  _id: 'person-1', email: 'p@example.com', verified: true, createdAt: new Date(Date.now() - 3 * DAY).toISOString(), ...overrides,
});

const renderCard = (currentUser) => render(
  <AuthContext.Provider value={{ currentUser, user: currentUser, isAuthenticated: true, loading: false }}>
    <V2DiscordCard />
  </AuthContext.Provider>,
);

const stepsSent = () => axios.post.mock.calls
  .filter(([url]) => url === '/api/stats/byo-step')
  .map(([, body]) => body.step);

describe('V2DiscordCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDiscordCardForTest();
    resetOwnPostForTest();
  });

  test('an account from an earlier day sees the card once, with the invite and a dismiss', () => {
    renderCard(person());
    const card = screen.getByRole('region', { name: 'Discord' });
    expect(card).toHaveTextContent('open source, built by people in their spare time');
    expect(card).toHaveTextContent('nobody here is selling anything');
    const join = screen.getByRole('link', { name: 'Join the Discord' });
    expect(join).toHaveAttribute('href', DISCORD_INVITE_URL);
    expect(join).toHaveAttribute('target', '_blank');
    expect(join).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('button', { name: 'Hide the Discord invite' })).toBeInTheDocument();
    expect(stepsSent()).toEqual(['discord-card-shown']);
  });

  test('it is not a dialog and does not take focus', () => {
    renderCard(person());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  test('a brand-new account sees nothing on its first day until it posts', () => {
    renderCard(person({ createdAt: new Date().toISOString() }));
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    expect(stepsSent()).toEqual([]);

    act(() => { noteOwnPost(); });
    expect(screen.getByRole('region', { name: 'Discord' })).toBeInTheDocument();
    expect(stepsSent()).toEqual(['discord-card-shown']);
  });

  test('a Scout start already posted counts as a first post', () => {
    renderCard(person({ createdAt: new Date().toISOString(), onboarding: { firstStartAt: new Date().toISOString() } }));
    expect(screen.getByRole('region', { name: 'Discord' })).toBeInTheDocument();
  });

  test('dismissing hides it, stores the dismissal on the account, and counts no click', () => {
    const view = renderCard(person());
    fireEvent.click(screen.getByRole('button', { name: 'Hide the Discord invite' }));
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    expect(stepsSent()).toEqual(['discord-card-shown', 'discord-card-dismissed']);
    expect(trackUsage).not.toHaveBeenCalled();

    // A remount in the same page load, before the account refreshes, stays hidden.
    view.unmount();
    renderCard(person());
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
  });

  test('joining counts the click, closes the card and stores it as done', () => {
    renderCard(person());
    fireEvent.click(screen.getByRole('link', { name: 'Join the Discord' }));
    expect(trackUsage).toHaveBeenCalledWith('discord-click', { props: { where: 'card' } });
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    expect(stepsSent()).toEqual(['discord-card-shown', 'discord-card-dismissed']);
  });

  test('a different person signing in on the same tab starts fresh after someone else dismissed', () => {
    const view = renderCard(person());
    fireEvent.click(screen.getByRole('button', { name: 'Hide the Discord invite' }));
    view.unmount();
    renderCard(person({ _id: 'person-2' }));
    expect(screen.getByRole('region', { name: 'Discord' })).toBeInTheDocument();
    expect(stepsSent()).toEqual(['discord-card-shown', 'discord-card-dismissed', 'discord-card-shown']);
  });

  test('an account that dismissed it on another device never sees it', () => {
    renderCard(person({ onboarding: { discordCardDismissedAt: new Date().toISOString() } }));
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    expect(stepsSent()).toEqual([]);
  });

  test('waits while the email reminder is up, and never shows to a bot', () => {
    renderCard(person({ verified: false }));
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    resetDiscordCardForTest();
    renderCard(person({ isBot: true }));
    expect(screen.queryByRole('region', { name: 'Discord' })).not.toBeInTheDocument();
    expect(stepsSent()).toEqual([]);
  });
});

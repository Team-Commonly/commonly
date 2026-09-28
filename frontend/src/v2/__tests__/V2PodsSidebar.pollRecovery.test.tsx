// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { i18nReady } from '../../i18n';
import V2PodsSidebar from '../components/V2PodsSidebar';

// TASK-184, the recovery cell. This file mocks the API LAYER, not the hook, so
// the real useV2Pods and the real sidebar are exercised end to end: a first
// load that fails must not leave a tab that polls successfully every minute
// showing an error and no rows forever.

const NOW = Date.parse('2026-09-28T05:00:00.000Z');
const mockGet = jest.fn();
// Stable identity: a fresh object per render would change `refresh`'s dependency
// and re-run the mount effect forever (the real hook memoizes this).
const mockApi = { get: mockGet, post: jest.fn(), patch: jest.fn(), del: jest.fn() };

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({ pinned: new Set(), toggle: jest.fn(), isPinned: () => false }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me', username: 'me' } }),
}));

// The real hook fetches on mount, so the first paint is `loading: true` and the
// settled state arrives a few microtasks later; fake timers do not advance
// microtasks, so drain them explicitly instead of waiting on a timer.
const settle = async () => {
  await act(async () => { await Promise.resolve(); });
};

const podRow = [{
  _id: 'p1',
  name: 'Sharpen',
  type: 'team',
  members: [{ _id: 'me', username: 'me', isBot: false }],
  lastMessage: {
    content: 'x',
    createdAt: new Date(NOW - 2 * 3600 * 1000).toISOString(),
    username: 'a',
  },
}];

describe('V2PodsSidebar — a failed mount recovers on the next poll', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the rows again once a poll succeeds, without a reload', async () => {
    mockGet.mockRejectedValueOnce(new Error('network down'));
    render(
      <MemoryRouter initialEntries={['/v2/pods/p1']}>
        <V2PodsSidebar selectedPodId="p1" />
      </MemoryRouter>,
    );

    await settle();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByText('Sharpen')).not.toBeInTheDocument();

    mockGet.mockResolvedValueOnce(podRow);
    await act(async () => { jest.advanceTimersByTime(60 * 1000); });

    expect(mockGet).toHaveBeenCalledWith('/api/pods');
    expect(screen.getByText('Sharpen')).toBeInTheDocument();
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
  });

  it('keeps the error while the poll keeps failing', async () => {
    mockGet.mockRejectedValueOnce(new Error('network down'));
    render(
      <MemoryRouter initialEntries={['/v2/pods/p1']}>
        <V2PodsSidebar selectedPodId="p1" />
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByText('network down')).toBeInTheDocument();

    mockGet.mockRejectedValue(new Error('still down'));
    await act(async () => { jest.advanceTimersByTime(3 * 60 * 1000); });
    await settle();

    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByText('Sharpen')).not.toBeInTheDocument();
  });
});

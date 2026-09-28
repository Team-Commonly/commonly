// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { i18nReady } from '../../i18n';
import V2PodsSidebar from '../components/V2PodsSidebar';

// TASK-184. The row time is a DATUM from the last /api/pods, and the minute
// tick only recomputes the label — so a tab left open kept ageing a frozen
// timestamp and read further from the truth the longer it stayed open. This
// test drives the surface: the label moves when the datum does, and does not
// move while the tab is hidden.

const NOW = Date.parse('2026-09-28T05:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const row = (createdAt: string) => ([{
  _id: 'p1',
  name: 'Sharpen',
  type: 'team',
  members: [{ _id: 'me', username: 'me', isBot: false }],
  lastMessage: { content: 'x', createdAt, username: 'a' },
}]);

const mockRefresh = jest.fn();
let mockSetPods = () => {};
// `jest.mock` factories may only close over `mock`-prefixed names.
const mockInitialPods = row(new Date(NOW - 2 * 3600 * 1000).toISOString());

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => {
    const { useState } = require('react');
    const [pods, setPods] = useState(() => mockInitialPods);
    mockSetPods = setPods;
    return {
      pods,
      loading: false,
      error: null,
      createPod: jest.fn(),
      patchLastMessage: jest.fn(),
      refresh: mockRefresh,
    };
  },
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(() => Promise.resolve([])), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({ pinned: new Set(), toggle: jest.fn(), isPinned: () => false }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me', username: 'me' } }),
}));

let visibility = 'visible';

const renderSidebar = () => render(
  <MemoryRouter initialEntries={['/v2/pods/p1']}>
    <V2PodsSidebar selectedPodId="p1" />
  </MemoryRouter>,
);

describe('V2PodsSidebar — row time follows the datum', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    // The poll re-reads the row times; the surface must show the new datum.
    mockRefresh.mockImplementation(() => {
      mockSetPods(row(iso(0)));
      return Promise.resolve();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-reads the datum on the minute tick and re-renders the label', async () => {
    renderSidebar();
    expect(await screen.findByText('2h')).toBeInTheDocument();

    await act(async () => { jest.advanceTimersByTime(60 * 1000); });

    expect(mockRefresh).toHaveBeenCalledWith({ silent: true });
    // NOW + the tick's own minute = 1 minute after the refreshed datum.
    expect(await screen.findByText('1m')).toBeInTheDocument();
    expect(screen.queryByText('2h')).not.toBeInTheDocument();
  });

  it('does not poll a hidden tab, and re-reads the moment it becomes visible', async () => {
    renderSidebar();
    expect(await screen.findByText('2h')).toBeInTheDocument();

    visibility = 'hidden';
    await act(async () => { jest.advanceTimersByTime(10 * 60 * 1000); });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.getByText('2h')).toBeInTheDocument();

    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mockRefresh).toHaveBeenCalledWith({ silent: true });
  });

  it('the tick is a minute, not a render', async () => {
    renderSidebar();
    await screen.findByText('2h');

    await act(async () => { jest.advanceTimersByTime(59 * 1000); });
    expect(mockRefresh).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(1 * 1000); });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

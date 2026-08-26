// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2ActivityPage from '../components/V2ActivityPage';

jest.mock('axios');
jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = ({ name }: { name: string }) => <span>{name} avatar</span>;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

const mockGet = axios.get as jest.Mock;
const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const recap = {
  pods: [{ id: 'pod-1', name: 'Launch pod' }],
  needsYou: [{
    id: 'mention-1', kind: 'mention', title: 'Review requested', detail: 'A direct mention.',
    podId: 'pod-1', podName: 'Launch pod', timestamp: '2026-08-26T11:00:00.000Z',
  }],
  agents: [{
    id: 'agent-1', name: 'release-agent', lastActiveAt: '2026-08-26T11:00:00.000Z',
    messageCount: 2, recap: 'Posted two updates.', updates: [{
      id: 'update-1', podId: 'pod-1', podName: 'Launch pod', content: 'Checks passed.',
      timestamp: '2026-08-26T11:00:00.000Z',
    }],
  }],
  board: [{
    id: 'board-1', taskId: 'TASK-068', title: 'Activity tab', status: 'claimed',
    podId: 'pod-1', podName: 'Launch pod', updatedAt: '2026-08-26T11:00:00.000Z',
    lastUpdate: { author: 'release-agent', text: 'Implementation began.', createdAt: '2026-08-26T11:00:00.000Z' },
  }],
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/v2/activity']}>
    <V2ActivityPage />
    <CurrentPath />
  </MemoryRouter>,
);

describe('V2ActivityPage', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: recap });
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('projects existing activity, direct interrupts, and board changes without inventing a queue count', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.getByText('Review requested')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What your agents did' })).toBeInTheDocument();
    expect(screen.getByText('release-agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Board deltas' })).toBeInTheDocument();
    expect(screen.getByText('TASK-068')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/recap', expect.objectContaining({
      params: { window: 'today' },
    }));
  });

  test('changes the read window and opens the source pod from a factual queue row', async () => {
    renderPage();
    await screen.findByText('Review requested');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/api/activity/recap', expect.objectContaining({
      params: { window: '7d' },
    })));

    fireEvent.click(screen.getAllByRole('button', { name: 'Open thread' })[0]);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
  });

  test('keeps an empty Needs you state honest', async () => {
    mockGet.mockResolvedValue({ data: { ...recap, needsYou: [] } });
    renderPage();

    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    expect(screen.queryByText(/0 needs you/i)).not.toBeInTheDocument();
  });
});

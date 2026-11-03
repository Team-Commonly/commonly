// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
const recap = { pods: [{ id: 'pod-1', name: 'Launch pod' }], needsYou: [], agents: [], board: [] };
const historyAnsweredAgo = (ms: number) => ({
  items: [{
    id: 'decision-1', kind: 'decision', status: 'ruled', title: 'Ship it?', detail: '', podId: 'pod-1', podName: 'Launch pod',
    createdAt: new Date(Date.now() - ms - 60_000).toISOString(),
    ruling: { value: 'Ship now', by: 'sam', at: new Date(Date.now() - ms).toISOString() },
  }],
  count: 1,
  remaining: 0,
});

const renderWithHistory = (ms: number) => {
  mockGet.mockImplementation((url: string) => {
    if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
    if (url === '/api/activity/decision-history') return Promise.resolve({ data: historyAnsweredAgo(ms) });
    return Promise.resolve({ data: recap });
  });
  return render(<MemoryRouter initialEntries={['/v2/activity']}><V2ActivityPage /></MemoryRouter>);
};

describe('Needs you: when the last ask was answered', () => {
  beforeAll(async () => { await i18nReady; });
  beforeEach(() => { jest.clearAllMocks(); sessionStorage.clear(); });
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  test('under a minute, English says "just answered", never "answered now ago"', async () => {
    renderWithHistory(10_000);
    expect(await screen.findByText('The last ask was just answered.')).toBeInTheDocument();
    expect(screen.queryByText(/now ago/)).not.toBeInTheDocument();
  });

  test('a minute or more keeps the age line', async () => {
    renderWithHistory(5 * 60_000);
    expect(await screen.findByText('The last ask was answered 5m ago.')).toBeInTheDocument();
    expect(screen.queryByText('The last ask was just answered.')).not.toBeInTheDocument();
  });

  test('under a minute in zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderWithHistory(10_000);
    expect(await screen.findByText('上一个请求刚刚得到回复。')).toBeInTheDocument();
  });
});

// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2PodsSidebar from '../components/V2PodsSidebar';

const mockApiGet = jest.fn();
const mockCreatePod = jest.fn();

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [], loading: false, error: null, createPod: mockCreatePod, patchLastMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: mockApiGet, post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me', username: 'me' } }),
}));

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const pod = (id, name, type, members) => ({
  _id: id,
  name,
  type,
  members,
  updatedAt: '2026-09-05T00:00:00.000Z',
});

const human = (id) => ({ _id: id, username: id, isBot: false });
const agent = (id) => ({ _id: id, username: id, isBot: true });

const renderSidebar = (pods, selectedPodId = 'sharpen') => render(
  <MemoryRouter initialEntries={['/v2/pods/sharpen']}>
    <V2PodsSidebar
      selectedPodId={selectedPodId}
      attentionItems={[{ id: 'decision-1', kind: 'decision', title: 'Choose workspace', podId: 'sharpen' }]}
      podsState={{
        pods,
        loading: false,
        error: null,
        createPod: mockCreatePod,
        patchLastMessage: jest.fn(),
      }}
    />
    <CurrentPath />
  </MemoryRouter>,
);

describe('V2PodsSidebar workspace groups', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockApiGet.mockImplementation((url) => {
      if (url === '/api/integrations/user/all') {
        return Promise.resolve([{
          _id: 'telegram', type: 'telegram', status: 'connected', podId: { _id: 'sharpen', name: 'Sharpen' },
        }]);
      }
      return Promise.resolve([]);
    });
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('renders existing member pods as rooms, connectors as channels, and DMs as direct', async () => {
    renderSidebar([
      pod('sharpen', 'Sharpen', 'team', [human('me'), human('other')]),
      pod('admin', 'Agent Admin', 'agent-admin', [human('me'), agent('ops')]),
      pod('study', 'Study Group', 'study', [human('me'), human('other')]),
      pod('agent-room', 'Build Agent', 'agent-room', [human('me'), agent('builder')]),
      pod('human-dm', 'Design Partner', 'chat', [human('me'), human('designer')]),
      pod('room-chat', 'Project Chat', 'chat', [human('me'), human('one'), human('two')]),
      pod('future-type', 'Unreviewed Type', 'future-type', [human('me'), human('other')]),
    ]);

    const rooms = screen.getByRole('heading', { name: 'rooms' }).closest('section');
    const direct = screen.getByRole('heading', { name: 'direct' }).closest('section');
    expect(within(rooms).getByRole('button', { name: /^Sharpen/ })).toBeInTheDocument();
    expect(within(rooms).getByRole('button', { name: 'Agent Admin' })).toBeInTheDocument();
    expect(within(rooms).getByRole('button', { name: 'Study Group' })).toBeInTheDocument();
    expect(within(rooms).getByRole('button', { name: 'Project Chat' })).toBeInTheDocument();
    expect(within(direct).getByRole('button', { name: 'Build Agent' })).toBeInTheDocument();
    expect(within(direct).getByRole('button', { name: 'Design Partner' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unreviewed Type' })).not.toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Telegram · Sharpen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Connect Slack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Telegram · Sharpen' }).querySelector('.v2-pods__channel-dot--live')).toBeTruthy();
  });

  test('uses the decision queue count only on the selected room and retains no legacy controls', async () => {
    renderSidebar([pod('sharpen', 'Sharpen', 'team', [human('me'), human('other')])]);

    expect(await screen.findByLabelText('1 needs you')).toHaveTextContent('1');
    expect(screen.queryByPlaceholderText('Search pods...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Community' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join HQ' })).not.toBeInTheDocument();
  });

  test('keeps the connector row navigable to its bound room', async () => {
    renderSidebar([pod('sharpen', 'Sharpen', 'team', [human('me'), human('other')])]);
    fireEvent.click(await screen.findByRole('button', { name: 'Telegram · Sharpen' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/sharpen');
  });
});

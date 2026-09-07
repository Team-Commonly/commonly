// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2PodsSidebar, {
  groupPodsByKind, podKind, recentPods,
} from '../components/V2PodsSidebar';
import { POD_VISITS_KEY } from '../lib/podRecency';

const mockCreatePod = jest.fn();
const mockPinned = new Set<string>();
const mockTogglePin = jest.fn((id: string) => { if (mockPinned.has(id)) mockPinned.delete(id); else mockPinned.add(id); });

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [], loading: false, error: null, createPod: mockCreatePod, patchLastMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(() => Promise.resolve([])), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({ pinned: mockPinned, toggle: mockTogglePin, isPinned: (id: string) => mockPinned.has(id) }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me', username: 'me' } }),
}));

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600 * 1000).toISOString();
const human = (id) => ({ _id: id, username: id, isBot: false });
const agent = (id) => ({ _id: id, username: id, isBot: true });
const pod = (id, name, type, members, extra = {}) => ({
  _id: id,
  name,
  type,
  members,
  lastMessage: { content: 'x', createdAt: hoursAgo(1), username: 'me' },
  ...extra,
});

// 12 pods: 2 pinned, 9 rooms, 1 DM — enough to overflow Recent (8) and fill Everything.
const fleet = [
  pod('sharpen', 'Sharpen', 'team', [human('me'), human('a')], { lastMessage: { content: 'x', createdAt: hoursAgo(0.15), username: 'a' } }),
  pod('connectors', 'Connectors v2', 'team', [human('me'), human('b')], { lastMessage: { content: 'x', createdAt: hoursAgo(0.2), username: 'b' } }),
  pod('hq', 'Commonly HQ', 'team', [human('me'), human('c')], { communityListed: true, lastMessage: { content: 'x', createdAt: hoursAgo(0.5), username: 'c' } }),
  pod('rewire', 'Rewire Live Demo', 'team', [human('me'), human('d')], { lastMessage: { content: 'x', createdAt: hoursAgo(1), username: 'd' } }),
  pod('naming', 'Naming huddle', 'chat', [human('me'), human('e'), human('f')], { lastMessage: { content: 'x', createdAt: hoursAgo(2), username: 'e' } }),
  pod('payments', 'Payments — memory demo', 'chat', [human('me'), human('g'), human('h')], { lastMessage: { content: 'x', createdAt: hoursAgo(3), username: 'g' } }),
  pod('sprint', 'Rewire Demo Sprint', 'team', [human('me'), human('i')], { lastMessage: { content: 'x', createdAt: hoursAgo(5), username: 'i' } }),
  pod('files', 'File access test', 'chat', [human('me'), human('j'), human('k')], { lastMessage: { content: 'x', createdAt: hoursAgo(24 * 61), username: 'j' } }),
  pod('dm', 'DM test', 'agent-room', [human('me'), agent('builder')], { lastMessage: { content: 'x', createdAt: hoursAgo(24), username: 'builder' } }),
  pod('canvas', 'Design canvas review', 'team', [human('me'), human('l')], { lastMessage: { content: 'x', createdAt: hoursAgo(26), username: 'l' } }),
  pod('study', 'Study — agents lit', 'study', [human('me'), human('m')], { lastMessage: { content: 'x', createdAt: hoursAgo(24 * 14), username: 'm' } }),
  pod('fleet', 'Fleet ops', 'agent-admin', [human('me'), agent('ops')], { lastMessage: { content: 'x', createdAt: hoursAgo(24 * 7), username: 'ops' } }),
];

// 42 pods = the walk's account size: 12 hand-written plus 30 generated, spread
// over team / chat / study / games / community with descending message times.
const KINDS_42 = ['team', 'chat', 'study', 'games', 'team', 'team', 'chat', 'community'];
const fleet42 = [
  ...fleet,
  ...Array.from({ length: 30 }, (_, i) => {
    const kind = KINDS_42[i % KINDS_42.length];
    const type = kind === 'community' ? 'team' : kind;
    const members = type === 'chat' ? [human('me'), human(`x${i}`), human(`y${i}`)] : [human('me'), human(`x${i}`)];
    return pod(`gen${i}`, `Generated pod ${i + 1}`, type, members, {
      ...(kind === 'community' ? { communityListed: true } : {}),
      lastMessage: { content: 'x', createdAt: hoursAgo(30 + i * 7), username: 'me' },
    });
  }),
];

const renderSidebar = (pods, selectedPodId = 'sharpen', extra = {}) => render(
  <MemoryRouter initialEntries={['/v2/pods/sharpen']}>
    <V2PodsSidebar
      selectedPodId={selectedPodId}
      attentionCountByPod={{ sharpen: 2, connectors: 1, naming: 0, hq: 91 }}
      podsState={{
        pods, loading: false, error: null, createPod: mockCreatePod, patchLastMessage: jest.fn(),
      }}
      {...extra}
    />
    <CurrentPath />
  </MemoryRouter>,
);

const section = (name) => (
  screen.queryByRole('button', { name: new RegExp(`^${name}`) })
  || screen.getByRole('heading', { name: new RegExp(`^${name}`) })
).closest('section');

describe('V2PodsSidebar — direction C', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    mockPinned.clear();
    localStorage.clear();
    sessionStorage.clear();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  afterEach(() => { jest.useRealTimers(); });

  test('Pinned, Recent (eight) and Everything (folded, with the total) in that order; no pods/team/channels/direct labels', () => {
    mockPinned.add('sharpen');
    mockPinned.add('connectors');
    renderSidebar(fleet);

    const heads = screen.getAllByRole('button', { name: /^(Pinned|Recent|Everything)/ }).map((h) => h.textContent.replace(/[▾▸\s]+$/, '').trim());
    expect(heads).toEqual(['Pinned', 'Recent', 'Everything 12']);
    expect(screen.getByRole('button', { name: /^Pinned/ })).toHaveAttribute('aria-expanded', 'true');
    const everything = screen.getByRole('button', { name: /^Everything/ });
    expect(everything).toHaveAttribute('aria-expanded', 'false');
    expect(everything).toHaveTextContent('12');

    expect(within(section('Pinned')).getAllByRole('button').filter((b) => b.className.includes('v2-pods__row')).map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Sharpen'), expect.stringContaining('Connectors v2')]),
    );
    const recentRows = within(section('Recent')).getAllByRole('button').filter((b) => b.className.includes('v2-pods__row'));
    expect(recentRows).toHaveLength(8);
    expect(recentRows.map((row) => row.textContent)).not.toEqual(expect.arrayContaining([expect.stringContaining('Sharpen')]));
    // The 10th non-pinned pod (Study, 14 days) falls off Recent.
    expect(recentRows.map((row) => row.textContent).join(' ')).not.toContain('Study — agents lit');

    ['pods', 'team', 'chat', 'channels', 'direct', 'Connect Slack'].forEach((label) => {
      expect(screen.queryByText(new RegExp(`^${label}$`))).not.toBeInTheDocument();
    });
  });

  test('every row carries a mark, the needs-you pill when there is a count, and the last-message time', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet);
    const sharpen = screen.getByRole('button', { name: /^Sharpen\b/ });
    expect(sharpen).toHaveClass('v2-pods__row--selected');
    expect(within(sharpen).getByLabelText('2 needs you')).toHaveTextContent('2');
    expect(within(sharpen).getByText('9m')).toBeInTheDocument();
    const connectors = screen.getByRole('button', { name: /^Connectors v2/ });
    expect(connectors).toHaveClass('v2-pods__row--unread');
    expect(within(connectors).getByLabelText('1 needs you')).toHaveTextContent('1');
    expect(within(connectors).getByText('12m')).toBeInTheDocument();
    // The queue page may render only its first page: the pill is the server total, never a list length.
    expect(within(screen.getByRole('button', { name: /Commonly HQ/ })).getByLabelText('91 needs you')).toHaveTextContent('91');
    const naming = screen.getByRole('button', { name: /Naming huddle/ });
    expect(naming).not.toHaveClass('v2-pods__row--unread');
    expect(within(naming).queryByLabelText(/needs you/)).not.toBeInTheDocument();
    expect(within(naming).getByText('2h')).toBeInTheDocument();
    // A DM is an ordinary row with the peer's avatar instead of initials.
    const dm = screen.getByRole('button', { name: /DM test/ });
    expect(dm.querySelector('.v2-pods__row-mark--avatar')).toBeTruthy();
    expect(within(dm).getByText('1d')).toBeInTheDocument();
  });

  test('Recent is ordered by my last visit, not by the last message; the time column stays the last message', () => {
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify({ files: NOW - 1000, study: NOW - 2000 }));
    renderSidebar(fleet, null);
    const rows = within(section('Recent')).getAllByRole('button').filter((b) => b.className.includes('v2-pods__row')).map((row) => row.textContent);
    expect(rows[0]).toContain('File access test');
    expect(rows[0]).toContain('2mo');
    expect(rows[1]).toContain('Study — agents lit');
    expect(rows[1]).toContain('2w');
    expect(rows[2]).toContain('Sharpen');
  });

  test('Everything unfolds into kinds with counts, each closed, and remembers its open state for the session', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet);
    fireEvent.click(screen.getByRole('button', { name: /^Everything/ }));
    expect(screen.getByRole('button', { name: /^Everything/ })).toHaveAttribute('aria-expanded', 'true');
    const kinds = screen.getAllByRole('button', { name: /^(team|community|chat|study|admin|direct)\s+\d+/ });
    expect(kinds.map((k) => k.textContent.replace(/[▾▸]/g, '').replace(/\s+/g, ' ').trim())).toEqual([
      'team 5', 'community 1', 'chat 3', 'study 1', 'admin 1', 'direct 1',
    ]);
    kinds.forEach((kind) => expect(kind).toHaveAttribute('aria-expanded', 'false'));
    // Pinned pods are in the inventory too.
    fireEvent.click(screen.getByRole('button', { name: /^team\s+5/ }));
    expect(within(section('team')).getByRole('button', { name: /Sharpen/ })).toHaveClass('v2-pods__row--in-fold');
    expect(sessionStorage.getItem('v2:pods.everythingOpen')).toBe('1');
    expect(JSON.parse(sessionStorage.getItem('v2:pods.kindsOpen'))).toEqual(['team']);
  });

  test('search flattens to matches in last-touched order, Esc clears, no match says so', () => {
    renderSidebar(fleet);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.change(input, { target: { value: 'rewire' } });
    expect(screen.queryByRole('button', { name: /^Recent/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Rewire/ }).map((b) => b.textContent)).toEqual([
      expect.stringContaining('Rewire Live Demo'), expect.stringContaining('Rewire Demo Sprint'),
    ]);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('no pods match')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('button', { name: /^Recent/ })).toBeInTheDocument();
  });

  test('⌘K focuses the search box from anywhere', () => {
    renderSidebar(fleet);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  test('a row navigates to its pod; the + square opens the create form', () => {
    renderSidebar(fleet);
    fireEvent.click(screen.getByRole('button', { name: /Naming huddle/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/naming');
    fireEvent.click(screen.getByRole('button', { name: 'New pod' }));
    expect(screen.getByPlaceholderText('Pod name')).toBeInTheDocument();
  });

  test('the page variant renders the phone list with a Pods title', () => {
    renderSidebar(fleet, null, { variant: 'page' });
    expect(screen.getByRole('heading', { level: 1, name: 'Pods' })).toBeInTheDocument();
    expect(document.querySelector('.v2-pods-aside--page')).toBeTruthy();
  });

  test('kinds: every reviewed type maps to one kind, unknown types are not listed, DMs are direct', () => {
    expect(podKind(pod('t', 'T', 'team', []))).toBe('team');
    expect(podKind(pod('c', 'C', 'team', [], { communityListed: true }))).toBe('community');
    expect(podKind(pod('e', 'E', 'agent-ensemble', []))).toBe('ensemble');
    expect(podKind(pod('g', 'G', 'games', []))).toBe('games');
    expect(podKind(pod('x', 'X', 'future-type', []))).toBeNull();
    expect(podKind(pod('r', 'R', 'agent-room', [human('me'), agent('a')]))).toBe('direct');
    expect(podKind(pod('p', 'P', 'chat', [human('me'), human('you')]))).toBe('direct');
    expect(podKind(pod('q', 'Q', 'chat', [human('me'), human('you'), human('them')]))).toBe('chat');
    const groups = groupPodsByKind(fleet);
    expect(groups.map((g) => g.kind)).toEqual(['team', 'community', 'chat', 'study', 'admin', 'direct']);
    expect(groups.flatMap((g) => g.pods).length).toBe(fleet.length);
  });

  test('42 pods: Everything counts every kind, Recent stays eight, pinned rows show the pin, search finds a generated pod', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet42);
    const everything = screen.getByRole('button', { name: /^Everything/ });
    expect(everything).toHaveTextContent('42');
    expect(within(section('Recent')).getAllByRole('button', { name: /^(?!Pin|Unpin)/ }).filter((b) => b.className.includes('v2-pods__row'))).toHaveLength(8);
    fireEvent.click(everything);
    const kinds = screen.getAllByRole('button', { name: /^(team|community|chat|study|games|admin|direct)\s+\d+/ });
    const counts = Object.fromEntries(kinds.map((k) => k.textContent.replace(/[▾▸]/g, '').replace(/\s+/g, ' ').trim().split(' ')));
    expect(Object.values(counts).reduce((a, n) => a + Number(n), 0)).toBe(42);
    expect(counts.games).toBe('4');
    // The pinned row carries an active pin; an unpinned row's pin toggles the store.
    expect(screen.getByRole('button', { name: 'Unpin pod' })).toHaveClass('v2-pods__pin--active');
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin pod' })[0]);
    expect(mockTogglePin).toHaveBeenCalledTimes(1);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.change(input, { target: { value: 'Generated pod 30' } });
    expect(screen.getAllByRole('button', { name: /Generated pod 30/ })).toHaveLength(1);
  });

  test('Pinned and Recent collapse and remember it for the session', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet);
    fireEvent.click(screen.getByRole('button', { name: /^Recent/ }));
    expect(screen.getByRole('button', { name: /^Recent/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(section('Recent')).queryByRole('button', { name: /Commonly HQ/ })).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('v2:pods.closedSections'))).toEqual(['recent']);
  });

  test('recentPods excludes pinned pods and caps at the limit', () => {
    const rows = recentPods(fleet, new Set(['sharpen']), {}, 3);
    expect(rows.map((p) => p._id)).toEqual(['connectors', 'hq', 'rewire']);
  });
});

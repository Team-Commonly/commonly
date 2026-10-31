// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2PodsSidebar, {
  groupPodsByKind, podKind, recentPods, searchShortcutHint,
} from '../components/V2PodsSidebar';
import { characterAvatarFor, paperAvatarFor } from '../utils/avatars';
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
        refresh: jest.fn(() => Promise.resolve()),
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

// The rows the current segment shows, in order.
const listRows = () => [...document.querySelectorAll('.v2-pods__list button.v2-pods__row')];
const viewSwitch = () => screen.getByRole('radiogroup', { name: 'Pod list' });
const chooseView = (name) => fireEvent.click(within(viewSwitch()).getByRole('radio', { name: new RegExp(`^${name}`) }));

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

  test('a Recent · All · Pinned segment replaces the headings; Recent (eight, pinned included) is the default', () => {
    mockPinned.add('sharpen');
    mockPinned.add('connectors');
    renderSidebar(fleet);

    const radios = within(viewSwitch()).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['Recent', 'All12', 'Pinned']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    // The old headings and the "Everything ▸" fold are gone.
    expect(screen.queryByRole('button', { name: /^(Pinned|Recent|Everything)/ })).not.toBeInTheDocument();

    const recentRows = listRows();
    expect(recentRows).toHaveLength(8);
    // With no Pinned heading above it, Recent carries pinned pods in message order.
    expect(recentRows[0]).toHaveTextContent('Sharpen');
    expect(recentRows[1]).toHaveTextContent('Connectors v2');
    // The 9th pod by message time (DM, 1 day) and older fall off Recent.
    expect(recentRows.map((row) => row.textContent).join(' ')).not.toContain('Study — agents lit');

    ['pods', 'team', 'chat', 'channels', 'direct', 'Connect Slack'].forEach((label) => {
      expect(screen.queryByText(new RegExp(`^${label}$`))).not.toBeInTheDocument();
    });
  });

  test('the Pinned segment lists only pinned pods, and teaches when there are none', () => {
    mockPinned.add('naming');
    const { unmount } = renderSidebar(fleet);
    chooseView('Pinned');
    expect(listRows().map((row) => row.textContent)).toEqual([expect.stringContaining('Naming huddle')]);
    expect(sessionStorage.getItem('v2:pods.view')).toBe('pinned');
    unmount();

    mockPinned.clear();
    renderSidebar(fleet);
    // The choice is remembered for the session.
    expect(within(viewSwitch()).getByRole('radio', { name: 'Pinned' })).toHaveAttribute('aria-checked', 'true');
    expect(listRows()).toHaveLength(0);
    expect(screen.getByText('Pin a pod from its row to keep it here.')).toBeInTheDocument();
  });

  test('arrow keys move the segment like a radiogroup', () => {
    renderSidebar(fleet);
    const recent = within(viewSwitch()).getByRole('radio', { name: 'Recent' });
    fireEvent.keyDown(recent, { key: 'ArrowRight' });
    expect(within(viewSwitch()).getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(within(viewSwitch()).getByRole('radio', { name: /^All/ }));
    // Roving tabindex: only the checked option is in the Tab order.
    expect(within(viewSwitch()).getAllByRole('radio').map((radio) => radio.getAttribute('tabindex')))
      .toEqual(['-1', '0', '-1']);
  });

  test('a stored view this build does not know falls back to Recent', () => {
    sessionStorage.setItem('v2:pods.view', 'everything');
    renderSidebar(fleet);
    expect(within(viewSwitch()).getByRole('radio', { name: 'Recent' })).toHaveAttribute('aria-checked', 'true');
    expect(listRows()).toHaveLength(8);
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

  test('names the owner when another member also has a My Workspace pod', () => {
    const own = pod('own', 'My Workspace', 'chat', [human('me')], {
      createdBy: { _id: 'me', username: 'me' },
    });
    const shared = pod('shared', 'My Workspace', 'chat', [human('me'), human('alex'), human('third')], {
      createdBy: { _id: 'alex', username: 'alex' },
    });
    renderSidebar([own, shared]);
    expect(screen.getByRole('button', { name: /^My Workspace \(alex\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^My Workspace$/ })).toBeInTheDocument();
  });

  test('direct rows render the peer character for agents and Paper for unpicked people', () => {
    const agentDm = pod('agent-dm', 'Helper Agent', 'agent-dm', [
      human('me'), { ...agent('builder-id'), username: 'Builder' },
    ]);
    const agentRoom = pod('agent-room', 'Scout', 'agent-room', [
      human('me'), { ...agent('scout-id'), username: 'Scout' },
    ]);
    const humanDm = pod('human-dm', 'Direct chat', 'chat', [
      human('me'), { ...human('sam-id'), username: 'Sam' },
    ]);
    renderSidebar([agentDm, agentRoom, humanDm], 'none');

    const agentRow = screen.getByRole('button', { name: /Helper Agent/ });
    const agentImage = within(agentRow).getByRole('img', { name: 'Builder' });
    const agentSource = characterAvatarFor('builder-id', 'agent');
    expect(agentSource).not.toBeNull();
    expect(agentImage).toHaveAttribute('src', agentSource);

    const agentRoomRow = screen.getByRole('button', { name: /^Scout/ });
    expect(within(agentRoomRow).getByRole('img', { name: 'Scout' })).toHaveAttribute(
      'src', characterAvatarFor('scout-id', 'agent'),
    );

    const humanRow = screen.getByRole('button', { name: /Direct chat/ });
    const humanImage = within(humanRow).getByRole('img', { name: 'Sam' });
    expect(humanImage).toHaveAttribute('src', paperAvatarFor('sam-id'));
  });

  test('Recent and search use message order even when the other pod was visited last', () => {
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify({ sprint: NOW - 500, files: NOW - 1000, sharpen: NOW - 2000 }));
    renderSidebar(fleet, null);
    const rows = listRows().map((row) => row.textContent);
    expect(rows[0]).toContain('Sharpen');
    expect(rows[0]).toContain('9m');
    expect(rows).not.toEqual(expect.arrayContaining([expect.stringContaining('File access test')]));

    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.change(input, { target: { value: 'rewire' } });
    expect(screen.getAllByRole('button', { name: /rewire/i }).filter((b) => b.className.includes('v2-pods__row')).map((row) => row.textContent)).toEqual([
      expect.stringContaining('Rewire Live Demo'),
      expect.stringContaining('Rewire Demo Sprint'),
    ]);
  });

  test('an empty pod sorts and displays its creation time, never its fresh update time', () => {
    const messagePod = pod('message', 'Order with message', 'team', [human('me')], {
      lastMessage: { content: 'x', createdAt: hoursAgo(24), username: 'me' },
    });
    const emptyPod = pod('empty', 'Order empty', 'team', [human('me')], {
      lastMessage: null,
      createdAt: hoursAgo(24 * 35),
      updatedAt: hoursAgo(0.1),
    });
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify({ empty: NOW - 1000 }));
    renderSidebar([emptyPod, messagePod], null);
    const rows = listRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Order with message'),
      expect.stringContaining('Order empty'),
    ]);
    expect(within(rows[0]).getByText('1d')).toBeInTheDocument();
    expect(within(rows[1]).getByText('1mo')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('6m')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search pods' }), { target: { value: 'Order' } });
    expect(screen.getAllByRole('button', { name: /^Order/ }).filter((b) => b.className.includes('v2-pods__row')).map((row) => row.textContent)).toEqual([
      expect.stringContaining('Order with message'),
      expect.stringContaining('Order empty'),
    ]);
  });

  test('All unfolds into kinds with counts, each closed, and remembers the view for the session', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet);
    chooseView('All');
    expect(within(viewSwitch()).getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true');
    const kinds = screen.getAllByRole('button', { name: /^(team|community|chat|study|admin|direct)\s+\d+/ });
    expect(kinds.map((k) => k.textContent.replace(/[▾▸]/g, '').replace(/\s+/g, ' ').trim())).toEqual([
      'team 5', 'community 1', 'chat 3', 'study 1', 'admin 1', 'direct 1',
    ]);
    kinds.forEach((kind) => expect(kind).toHaveAttribute('aria-expanded', 'false'));
    // Pinned pods are in the inventory too.
    fireEvent.click(screen.getByRole('button', { name: /^team\s+5/ }));
    expect(within(section('team')).getByRole('button', { name: /Sharpen/ })).toHaveClass('v2-pods__row--in-fold');
    expect(sessionStorage.getItem('v2:pods.view')).toBe('all');
    expect(JSON.parse(sessionStorage.getItem('v2:pods.kindsOpen'))).toEqual(['team']);
  });

  test('search flattens to matches in message order, Esc clears, no match says so', () => {
    renderSidebar(fleet);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.change(input, { target: { value: 'rewire' } });
    expect(listRows().map((row) => row.textContent).join(' ')).not.toContain('Sharpen');
    expect(screen.getAllByRole('button', { name: /Rewire/ }).map((b) => b.textContent)).toEqual([
      expect.stringContaining('Rewire Live Demo'), expect.stringContaining('Rewire Demo Sprint'),
    ]);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('no pods match')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(listRows()).toHaveLength(8);
  });

  test('⌘K focuses the search box from anywhere', () => {
    renderSidebar(fleet);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  test.each([
    ['macOS', '⌘K'],
    ['Macintosh; Intel Mac OS X', '⌘K'],
    ['iPad', '⌘K'],
    ['Windows', 'Ctrl K'],
    ['Linux', 'Ctrl K'],
  ])('shows the shortcut for %s as %s', (platform, hint) => {
    expect(searchShortcutHint(platform)).toBe(hint);
  });

  test('the rendered hint comes from the platform, not a literal', () => {
    renderSidebar(fleet);
    // jsdom reports no Mac platform, so the rendered hint must use the Ctrl form.
    expect(document.querySelector('.v2-pods__search-kbd')).toHaveTextContent('Ctrl K');
  });

  test('Ctrl+K focuses the search box from anywhere', () => {
    renderSidebar(fleet);
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  test('a row navigates to its pod; the + square opens the create form', () => {
    renderSidebar(fleet);
    fireEvent.click(screen.getByRole('button', { name: /Naming huddle/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/naming');
    fireEvent.click(screen.getByRole('button', { name: 'New pod' }));
    expect(screen.getByPlaceholderText('Pod name')).toBeInTheDocument();
  });

  test('Create stays disabled until the pod has a name', () => {
    renderSidebar(fleet);
    fireEvent.click(screen.getByRole('button', { name: 'New pod' }));
    const submit = document.querySelector<HTMLButtonElement>('.v2-pods__create-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Pod name'), { target: { value: 'Launch' } });
    expect(submit).toBeEnabled();
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

  test('42 pods: All counts every kind, Recent stays eight, search finds a generated pod', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet42);
    expect(within(viewSwitch()).getByRole('radio', { name: /^All/ })).toHaveTextContent('42');
    expect(listRows()).toHaveLength(8);
    chooseView('All');
    const kinds = screen.getAllByRole('button', { name: /^(team|community|chat|study|games|admin|direct)\s+\d+/ });
    const counts = Object.fromEntries(kinds.map((k) => k.textContent.replace(/[▾▸]/g, '').replace(/\s+/g, ' ').trim().split(' ')));
    expect(Object.values(counts).reduce((a, n) => a + Number(n), 0)).toBe(42);
    expect(counts.games).toBe('4');
    const input = screen.getByRole('searchbox', { name: 'Search pods' });
    fireEvent.change(input, { target: { value: 'Generated pod 30' } });
    expect(screen.getAllByRole('button', { name: /Generated pod 30/ })).toHaveLength(1);
  });

  test('every row carries a pin icon button that toggles the store without opening the pod', () => {
    mockPinned.add('sharpen');
    renderSidebar(fleet, null);
    const unpin = screen.getByRole('button', { name: 'Unpin pod' });
    expect(unpin).toHaveClass('v2-pods__pin--active');
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    expect(unpin).toHaveAttribute('title', 'Unpin');
    expect(unpin.querySelector('svg')).toBeTruthy();
    const pins = screen.getAllByRole('button', { name: 'Pin pod' });
    expect(pins).toHaveLength(7);
    // The pin sits beside the row (a button cannot nest a button) and shares
    // its hover wrapper, which hides the time while the pin shows.
    expect(pins[0].parentElement).toHaveClass('v2-pods__rowwrap');
    expect(pins[0].parentElement.querySelector('.v2-pods__row-time')).toBeTruthy();
    fireEvent.click(pins[0]);
    expect(mockTogglePin).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/sharpen');
  });

  test('recentPods excludes pinned pods and caps at the limit', () => {
    const rows = recentPods(fleet, new Set(['sharpen']), 3);
    expect(rows.map((p) => p._id)).toEqual(['connectors', 'hq', 'rewire']);
  });

  test('equal message times have a stable order regardless of API order', () => {
    const a = pod('a', 'A', 'team', [human('me')]);
    const b = pod('b', 'B', 'team', [human('me')]);
    expect(recentPods([b, a], new Set()).map((p) => p._id)).toEqual(['a', 'b']);
    expect(recentPods([a, b], new Set()).map((p) => p._id)).toEqual(['a', 'b']);
  });
});

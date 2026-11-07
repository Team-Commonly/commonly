// @ts-nocheck
// Connectors page, tools half: grants and their trail, the Add / Change access form,
// hosted connect and disconnect, the GitHub App setup. A tool tile with a grant (or a
// hidden connection) opens its drawer; one without opens a popover with the act.
// Nothing here draws a control the server does not enforce.
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import {
  axios, authValue, adminAuth, asUser, mockApi, renderPage, tileNode, findTile, findDrawer, findPopover,
  expandOff, emptyCounts,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();

const scout = { name: 'scout', displayName: 'Scout', userId: 'a1' };
const pods = [
  { _id: 'p1', name: 'Launch pod', type: 'chat', members: [{ _id: 'u1', username: 'sam' }, { _id: 'a1', username: 'scout' }] },
  { _id: 'p2', name: 'Ops', type: 'chat', members: [{ _id: 'u1', username: 'sam' }, { _id: 'a1', username: 'scout' }] },
];
const grantLive = {
  grantId: 'grant_live', installationId: 'inst-1', target: { kind: 'pod', id: 'p1' }, tools: ['github.list_issues', 'github.comment_on_issue'],
  writeMode: 'write-with-confirm', budget: { calls: 50, windowMs: 3600000 }, effectiveAudience: ['a1'], expiresAt: iso(6 * 86400000),
  revokedAt: null, revokedBy: null, parentGrantId: null, rootGrantId: null, createdAt: iso(-3600000), grantedBy: 'u1',
};
const grantRevoked = { ...grantLive, grantId: 'grant_gone', target: { kind: 'pod', id: 'p2' }, writeMode: 'read', effectiveAudience: ['a1'], revokedAt: iso(-600000), revokedBy: 'u1', createdAt: iso(-86400000) };
const trail = {
  grantId: 'grant_live',
  calls: [
    { callId: 'c1', agentUserId: 'a1', tool: 'github.list_issues', outcome: 'ok', reason: null, approvalId: null, argsDigest: 'a'.repeat(64), at: iso(-120000), durationMs: 80 },
    { callId: 'c2', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'refused', reason: 'not_in_audience', approvalId: null, argsDigest: 'b'.repeat(64), at: iso(-300000), durationMs: null },
    { callId: 'c3', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'pending_approval', reason: null, approvalId: 'appr-1', argsDigest: 'c'.repeat(64), at: iso(-400000), durationMs: null },
    // C4-11: the ask was answered and the call ran as the row above it; the
    // server reports the parked row as `superseded`, never as still awaiting.
    { callId: 'c4', agentUserId: 'a1', tool: 'github.close_issue', outcome: 'superseded', reason: null, approvalId: 'appr-2', argsDigest: 'd'.repeat(64), at: iso(-500000), durationMs: null },
  ],
  counts: { total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 },
};

const githubEntry = {
  installableId: 'github', list: 'tools', label: 'GitHub', description: 'Issues and pull requests.', available: true,
  broker: { id: 'commonly-grant-broker' },
  tools: [
    { name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false },
    { name: 'github.comment_on_issue', requiredWriteMode: 'write', irreversible: true },
    { name: 'github.close_issue', requiredWriteMode: 'write', irreversible: true },
  ],
  connections: [{ connectionId: 'conn-1', owner: 'Team-Commonly', repo: 'commonly' }],
};
const linearEntry = {
  installableId: 'linear', list: 'tools', label: 'Linear', description: 'Issues in Linear.', available: true,
  connectionType: 'hosted-mcp', entryId: 'linear',
  broker: { id: 'commonly-grant-broker' },
  tools: [{ name: 'linear.list_issues', requiredWriteMode: 'read', irreversible: false }],
  connections: [{ connectionId: 'conn-2', owner: 'Team-Commonly', repo: 'linear' }],
};
const grantLinear = { ...grantLive, grantId: 'grant_lin', installationId: 'inst-2', writeMode: 'read', tools: ['linear.list_issues'] };

// The tools hook reads the catalogue first and the grants a beat later, so a tile
// exists before the page knows whether it has a grant. Wait that beat out before a
// click: a granted tool opens a drawer, an ungranted one a popover.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const openTool = async (name) => {
  await findTile(name);
  await settle();
  fireEvent.click(tileNode(name));
  return findDrawer(name);
};
const openToolPopover = async (name) => {
  await findTile(name);
  await settle();
  fireEvent.click(tileNode(name));
  return findPopover(name);
};
const openRow = async (toolName, rowName) => {
  const drawer = await openTool(toolName);
  fireEvent.click(within(drawer).getByRole('button', { name: rowName }));
  const aside = await within(drawer).findByRole('complementary', { name: 'Grant details' });
  return { drawer, aside };
};
const grantReads = () => axios.get.mock.calls.filter(([url]) => url === '/api/grants');
const meta = () => document.querySelector('.v2-cx-head__meta');

// Defaults mirror the old suite: one GitHub entry, a live grant in Launch pod and a
// revoked one in Ops, one agent (Scout) in each pod.
const mockTools = ({
  entries = [githubEntry],
  grants = [grantLive, grantRevoked],
  podList = pods,
  seats = { p1: [scout], p2: [scout] },
  trails = { grant_live: trail },
  hidden,
  route,
} = {}) => mockApi({ installables: entries, grants, pods: podList, seats, trails, hidden, route });

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
  mockTools();
  axios.post.mockResolvedValue({ data: { grantId: 'grant_live', revoked: 1 } });
});

afterEach(() => jest.restoreAllMocks());

describe('Connectors page: tools', () => {
  it('Atlassian shows its read-in-testing state on a tile mark and on an existing grant', async () => {
    const atlassian = {
      ...linearEntry, installableId: 'atlassian', entryId: 'atlassian', label: 'Atlassian',
      tools: [{ name: 'atlassian.get_accessible_atlassian_resources', requiredWriteMode: 'read', irreversible: false }],
    };
    const grant = { ...grantLinear, grantId: 'grant_atl', tools: ['atlassian.get_accessible_atlassian_resources'] };
    mockTools({ entries: [atlassian], grants: [grant] });
    renderPage();

    const tile = await findTile('Atlassian');
    const beta = tile.querySelector('.v2-cx-tile__beta');
    expect(beta).toHaveTextContent('beta');
    expect(beta).toHaveAttribute('title', 'read in testing');
    const drawer = await openTool('Atlassian');
    expect(within(drawer).getByText(/read in testing/)).toBeInTheDocument();
  });

  it('one owner grant read shows the 21st pod and keeps revoked and expired labels', async () => {
    const manyPods = Array.from({ length: 21 }, (_, index) => ({
      _id: `p${index + 1}`, name: `Pod ${index + 1}`, type: 'chat', members: [{ _id: 'u1', username: 'sam' }],
    }));
    const inLastPod = { ...grantLive, grantId: 'grant_21', target: { kind: 'pod', id: 'p21' } };
    const revoked = { ...inLastPod, grantId: 'grant_21_revoked', revokedAt: iso(-600000), revokedBy: 'u1' };
    const expired = { ...inLastPod, grantId: 'grant_21_expired', expiresAt: iso(-600000) };
    mockTools({ grants: [inLastPod, revoked, expired], podList: manyPods, seats: {}, trails: {} });
    renderPage();

    const drawer = await openTool('GitHub');
    expect(await within(drawer).findAllByRole('button', { name: 'View GitHub in Pod 21' })).toHaveLength(3);
    expect(within(drawer).getByText(/revoked by sam 10m/)).toBeInTheDocument();
    expect(within(drawer).getByText(/expired 10m/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Grant again' })[0]);
    expect(await screen.findByRole('option', { name: 'Pod 21' })).toBeInTheDocument();
    // The grant list is one read for the owner, never one per pod. The hook reads once
    // before the pod list arrives and once after, so two is the ceiling for 21 pods.
    const reads = grantReads();
    expect(reads.length).toBeLessThanOrEqual(2);
    for (const read of reads) expect(read[1]).toMatchObject({ params: { connectionOwner: 'me' } });
    expect(axios.get.mock.calls.some(([url]) => /\/api\/pods\/.*\/grants/.test(url))).toBe(false);
  });

  it('a sole join-policy refusal offers the owner an in-place fix and then allows retry', async () => {
    mockTools({ podList: [pods[0], { ...pods[1], createdBy: { _id: 'u1' } }] });
    axios.post.mockRejectedValueOnce({ response: { data: {
      error: 'outsider_grant_pod_joinable', message: 'Agents can self-install into this pod. Make it invite-only to use this connector.',
    } } }).mockResolvedValueOnce({ data: { grantId: 'grant_new' } });
    axios.patch.mockResolvedValue({ data: { id: 'p2', joinPolicy: 'invite-only' } });
    renderPage();

    const drawer = await openTool('GitHub');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    const aside = await screen.findByRole('complementary', { name: 'Add GitHub' });
    fireEvent.click(within(aside).getByRole('button', { name: 'Grant' }));
    fireEvent.click(await within(aside).findByRole('button', { name: 'Make this pod invite-only' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/pods/p2/join-policy', { joinPolicy: 'invite-only' }, expect.anything()));
    expect(await within(aside).findByText('This pod is invite-only. Select Grant to continue.')).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  });

  it('the in-place fix is not offered to a non-owner', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: {
      error: 'outsider_grant_pod_joinable', message: 'Agents can self-install into this pod. Make it invite-only to use this connector.',
    } } });
    renderPage();

    const drawer = await openTool('GitHub');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    const aside = await screen.findByRole('complementary', { name: 'Add GitHub' });
    fireEvent.click(within(aside).getByRole('button', { name: 'Grant' }));
    await within(aside).findByText('Agents can self-install into this pod. Make it invite-only to use this connector.');
    expect(within(aside).queryByRole('button', { name: 'Make this pod invite-only' })).not.toBeInTheDocument();
  });

  it('a bridged-pod refusal never offers the join-policy fix', async () => {
    mockTools({ podList: [pods[0], { ...pods[1], createdBy: 'u1' }] });
    axios.post.mockRejectedValueOnce({ response: { data: {
      error: 'outsider_grant_pod_bridged', message: 'Use a separate unbridged pod for this connector.',
    } } });
    renderPage();

    const drawer = await openTool('GitHub');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    const aside = await screen.findByRole('complementary', { name: 'Add GitHub' });
    fireEvent.click(within(aside).getByRole('button', { name: 'Grant' }));
    await within(aside).findByText('Use a separate unbridged pod for this connector.');
    expect(within(aside).queryByRole('button', { name: 'Make this pod invite-only' })).not.toBeInTheDocument();
  });

  it('TASK-131: a grant age advances in place, and a returning tab re-reads, without a reload', async () => {
    jest.useFakeTimers();
    try {
      renderPage();
      // The Granted dot only exists once the grants have been read.
      await screen.findByRole('img', { name: 'Granted' });
      fireEvent.click(tileNode('GitHub'));
      expect(await screen.findByText(/granted 1h$/)).toBeInTheDocument();

      await act(async () => { jest.advanceTimersByTime(60 * 60_000); });
      expect(screen.getByText(/granted 2h$/)).toBeInTheDocument();

      const before = grantReads().length;
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(grantReads().length).toBeGreaterThan(before));
    } finally {
      jest.useRealTimers();
    }
  });

  it('TASK-131: a grant expiring with the page open takes its tool off the count and the tile on the same tick', async () => {
    jest.useFakeTimers();
    try {
      // Live for one more minute, so the only thing that changes is the clock.
      mockTools({ grants: [{ ...grantLive, grantId: 'grant_soon', expiresAt: iso(60_000) }], seats: {}, trails: {} });
      renderPage();
      await screen.findByRole('img', { name: 'Granted' });
      await waitFor(() => expect(meta()).toHaveTextContent('1 on · 0 available'));

      await act(async () => { jest.advanceTimersByTime(2 * 60_000); });

      // The count always followed the clock; the tile did not, so the two disagreed
      // on screen until a reload.
      expect(meta()).toHaveTextContent('0 on · 1 available');
      expect(screen.queryByRole('img', { name: 'Granted' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rows carry the states table: a live grant pulses when used in the last 10 minutes, a revoked one goes hollow', async () => {
    renderPage();
    await findTile('GitHub');
    await waitFor(() => expect(meta()).toHaveTextContent('1 on · 0 available'));
    expect(screen.getByRole('img', { name: 'Granted' })).toBeInTheDocument();
    const drawer = await openTool('GitHub');
    const live = within(drawer).getByRole('button', { name: 'View GitHub in Launch pod' });
    expect(within(live).getByText('Launch pod')).toBeInTheDocument();
    expect(within(live).getByText('sam')).toBeInTheDocument();
    // Direction A: the audience is the sentence; the write mode is the glyph (label) and rides the 390 kicker as words.
    expect(within(live).getByText('Scout may use it')).toBeInTheDocument();
    expect(within(live).getByRole('img', { name: /asks|write/ })).toBeInTheDocument();
    expect(live.querySelector('.v2-connector-row__kicker-mode')).toHaveTextContent('a write would ask first');
    expect(within(live).getByText(/granted 1h$/)).toBeInTheDocument();
    const liveDot = live.querySelector('.v2-connector-row__dot');
    expect(liveDot).toHaveClass('v2-connector-row__dot--live');
    await waitFor(() => expect(liveDot).toHaveClass('v2-connector-row__dot--pulse'));
    const gone = within(drawer).getByRole('button', { name: 'View GitHub in Ops' });
    expect(within(gone).getByText('revoked by sam 10m ago')).toBeInTheDocument();
    expect(gone.closest('.v2-connector-row')).toHaveClass('v2-connector-row--dead');
    expect(gone.querySelector('.v2-connector-row__dot')).toHaveClass('v2-connector-row__dot--empty');
    // The ended grant sits under its own heading, below the live one.
    expect(within(drawer).getByText('inactive · 1')).toBeInTheDocument();
    // The entry is granted, so the drawer offers no Add.
    expect(within(drawer).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(within(drawer).getAllByRole('button', { name: 'Manage' })).toHaveLength(1);
    expect(within(drawer).getByRole('button', { name: 'Grant again' })).toBeInTheDocument();
    // Direction A: Manage is the gear (word in title + aria-label), and the age rides the kicker.
    for (const manage of within(drawer).getAllByRole('button', { name: 'Manage' })) {
      expect(manage).toHaveClass('v2-connector-row__action--icon');
      expect(manage.textContent).toBe('');
    }
    expect(document.querySelector('.v2-connector-row__when')).toBeNull();
    expect(document.querySelector('.v2-connector-row__kicker')?.textContent).toMatch(/ · granted /);
  });

  // TASK-649: one timestamp pair, two ages. A grant made 16 minutes before its
  // revoke and read 41h later must say the same day count for both lines, not
  // "granted 1d" beside "revoked 2d ago".
  it('TASK-649: the grant age and the revoke age round the same way on one row', async () => {
    const createdAt = iso(-(41 * 3600_000 + 24 * 60_000));
    const revokedAt = iso(-(41 * 3600_000 + 8 * 60_000));
    mockTools({ grants: [{ ...grantRevoked, createdAt, revokedAt, revokedBy: 'u1' }] });
    renderPage();

    const drawer = await openTool('GitHub');
    const gone = await within(drawer).findByRole('button', { name: 'View GitHub in Ops' });
    expect(within(gone).getByText(/granted 2d$/)).toBeInTheDocument();
    expect(within(gone).getByText('revoked by sam 2d ago')).toBeInTheDocument();
  });

  // TASK-649: the same rule holds below a day.
  it.each([
    [5 * 60_000 + 40_000, 'granted 6m'],
    [100 * 60_000, 'granted 2h'],
  ])('TASK-649: a grant aged %p ms reads "%s" on its row', async (ageMs, expected) => {
    mockTools({ grants: [{ ...grantRevoked, createdAt: iso(-ageMs), revokedAt: null, revokedBy: null }] });
    renderPage();

    const drawer = await openTool('GitHub');
    const row = await within(drawer).findByRole('button', { name: 'View GitHub in Ops' });
    expect(within(row).getByText(new RegExp(`${expected}$`))).toBeInTheDocument();
  });

  it('TASK-164: the grant, budget and trail times read in zh-CN, not English', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();
      const drawer = await openTool('GitHub');
      fireEvent.click(drawer.querySelector('.v2-connector-row__selection'));
      const aside = await screen.findByRole('complementary');
      expect(within(aside).getByText(/前由 sam 授权。/)).toBeInTheDocument();
      expect(within(aside).getByText(/后结束。/)).toBeInTheDocument();
      // The TASK-180 ruling names this key explicitly: 「每{{window}}可调用{{calls}}次」.
      expect(within(aside).getByText(/每1小时可调用50次/)).toBeInTheDocument();
      await waitFor(() => expect(within(aside).getAllByRole('listitem')).toHaveLength(4));
      const lines = within(aside).getAllByRole('listitem');
      expect(lines.map((line) => line.textContent)).toEqual([
        'Scout · github.list_issues · 成功2分钟前',
        'Scout · github.comment_on_issue · 已拒绝 · 此席位不在授权范围内5分钟前',
        'Scout · github.comment_on_issue · 等待人工确认7分钟前',
        'Scout · github.close_issue · 已回答8分钟前',
      ]);
      // The whole aside: an English relative time inside an otherwise-Chinese line is the regression.
      expect(aside.textContent).not.toMatch(/\bago\b|from now|\bm ago\b/);
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('TASK-179: the grant line is one sentence per language, and an empty audience is its own sentence', async () => {
    const emptyAudience = { ...grantLive, grantId: 'grant_empty', target: { kind: 'pod', id: 'p2' }, effectiveAudience: [] };
    mockTools({ grants: [grantLive, emptyAudience], seats: { p1: [scout], p2: [] } });
    renderPage();

    const drawer = await openTool('GitHub');
    const live = await within(drawer).findByRole('button', { name: 'View GitHub in Launch pod' });
    const ops = await within(drawer).findByRole('button', { name: 'View GitHub in Ops' });
    // One key holds both names, so the language orders them.
    expect(live.querySelector('strong')?.textContent).toBe('granted to Launch pod by sam');
    expect(within(ops).getByText('nobody may use it')).toBeInTheDocument();

    fireEvent.click(live);
    await screen.findByRole('complementary', { name: 'Grant details' });
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      // The accessible name is translated too, so locate rows by what they say.
      const rows = () => Array.from(document.querySelectorAll('.v2-connector-row'));
      const rowSaying = (text) => rows().find((row) => row.textContent?.includes(text));
      expect(rowSaying('Launch pod').querySelector('strong')?.textContent).toBe('由 sam 授权给 Launch pod');
      expect(rowSaying('Launch pod').textContent).toContain('Scout 可以使用');
      expect(rowSaying('Ops').textContent).toContain('没有智能体可以使用');
      // The separator key is zh-empty: two sentences that each end in 。 join with nothing.
      const aside = document.querySelector('.v2-connectors__aside');
      expect(within(aside).getByText(/授权。/).textContent).toBe('1小时前由 sam 授权。6天后结束。');
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('TASK-179: a seat grant names the seat in its sentence and the pod in the row it sits in', async () => {
    // The sentence's subject and the row's location are different nouns, so they
    // are two expressions, and this test fails if they are ever re-merged.
    const seatGrant = { ...grantLive, grantId: 'grant_seat', target: { kind: 'seat', id: 'a1' }, effectiveAudience: ['a1'] };
    mockTools({ grants: [seatGrant], seats: { p1: [], p2: [{ name: 'reed', displayName: 'Reed', userId: 'a1' }] } });
    renderPage();

    const drawer = await openTool('GitHub');
    // Found by the pod's name: if the seat leaks back into the accessible name
    // this query returns nothing, which is the fix's own control.
    const row = await within(drawer).findByRole('button', { name: 'View GitHub in Ops' });
    expect(row.querySelector('strong')?.textContent).toBe('granted to Reed by sam');
    expect(row.querySelector('.v2-connector-row__kicker')?.textContent).toMatch(/^Ops · granted /);
  });

  it('the aside reads the grant and the trail: agents, allow-list under its mode, what asks first, three counts, outcomes as words', async () => {
    renderPage();
    const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(within(aside).getByRole('heading', { name: 'GitHub · Launch pod' })).toBeInTheDocument();
    expect(within(aside).getByText(/Granted by sam 1h ago\. Ends 6d from now\./)).toBeInTheDocument();
    expect(within(aside).getByText('agents allowed').nextElementSibling).toHaveTextContent('Scout');
    expect(within(aside).getByText('read and write, ask first').nextElementSibling).toHaveTextContent('github.list_issues');
    expect(within(aside).getByText('asks a person first').nextElementSibling).toHaveTextContent('a write would ask first');
    expect(within(aside).getByText('budget').nextElementSibling).toHaveTextContent('50 calls per 1h');
    await waitFor(() => expect(within(aside).getByText('calls').previousElementSibling).toHaveTextContent('3'));
    expect(within(aside).getByText('refused').previousElementSibling).toHaveTextContent('1');
    expect(within(aside).getByText('awaiting a person').previousElementSibling).toHaveTextContent('1');
    const lines = within(aside).getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Scout · github.list_issues · ok2m ago',
      'Scout · github.comment_on_issue · refused · this seat is outside the grant audience5m ago',
      'Scout · github.comment_on_issue · awaiting a person7m ago',
      'Scout · github.close_issue · answered8m ago',
    ]);
    // A superseded request is not a call: the counts still say 3 while the trail
    // lists its 4 rows, and only the genuinely open one is counted as awaiting.
    expect(lines.map((line) => line.textContent).filter((text) => text.includes('awaiting a person'))).toHaveLength(1);
    // `answered` covers a resolution that was declined or expired as well as one
    // that ran, so its mark says SETTLED without saying approved: shield plus a short bar.
    const answeredLine = lines.find((line) => line.textContent?.includes('answered'));
    expect(answeredLine?.querySelectorAll('svg path')).toHaveLength(2);
    expect(Array.from(answeredLine?.querySelectorAll('svg path') || []).map((path) => path.getAttribute('d'))).toEqual([
      'M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z',
      'M9 12h6',
    ]);
    // The arguments never reach the page: only the digest does, and it is not rendered.
    expect(aside.textContent).not.toContain('a'.repeat(64));
    expect(axios.get).toHaveBeenCalledWith('/api/grants/grant_live/calls', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('TASK-188: a failed call says why it failed, and a code with no label shows as-is', async () => {
    const failed = {
      ...trail,
      calls: [
        { ...trail.calls[0], callId: 'f1', outcome: 'failed', reason: 'upstream_tool_error', at: iso(-120000) },
        { ...trail.calls[0], callId: 'f2', outcome: 'failed', reason: 'some_new_code', at: iso(-300000) },
        { ...trail.calls[0], callId: 'f3', outcome: 'ok', reason: 'provider_unreachable', at: iso(-420000) },
        { ...trail.calls[0], callId: 'f4', outcome: 'failed', reason: 'constructor', at: iso(-600000) },
      ],
    };
    mockTools({ trails: { grant_live: failed } });
    renderPage();
    const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    await waitFor(() => expect(within(aside).getAllByRole('listitem')).toHaveLength(4));
    expect(within(aside).getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'Scout · github.list_issues · failed · the provider tool returned an error2m ago',
      'Scout · github.list_issues · failed · some_new_code5m ago',
      'Scout · github.list_issues · ok7m ago',
      'Scout · github.list_issues · failed · constructor10m ago',
    ]);
  });

  // The broker records any refusal it throws as the line's reason, and these were
  // shown as raw codes: a hosted tool that drifted, an approved call whose PR or
  // arguments moved, a task-bound grant used off its task (F18, 11-02 prod walk).
  // Every code is listed, so dropping any one label turns this red.
  const REFUSAL_LABELS = [
    ['tool_drift', 'the provider changed this tool since Commonly checked it', '服务商在 Commonly 核对后改动了此工具'],
    ['tool_unavailable', 'this connection\'s tool list does not include this tool', '此连接的工具列表中没有这个工具'],
    ['write_scope_required', 'the connection needs reconnecting', '需要重新连接'],
    ['tool_not_found', 'this tool is not registered with Commonly', '此工具未在 Commonly 中注册'],
    ['definition_digest_mismatch', 'the tool changed after approval was asked for, so it needs asking again', '工具在申请审批后有变动，需要重新审批'],
    ['args_digest_mismatch', 'the arguments no longer match the ones sent for approval', '参数与提交审批时的不一致'],
    ['repo_mismatch', 'the connected repository changed after approval was asked for', '连接的仓库在申请审批后有变动'],
    ['merge_head_mismatch', 'the pull request changed after approval was asked for', 'PR 在申请审批后有变动'],
    ['merge_head_unavailable', 'the pull request\'s latest commit could not be read', '无法读取 PR 的最新提交'],
    ['task_pod_mismatch', 'this grant works only in its task\'s pod', '此授权只能在其任务所在的 Pod 中使用'],
    ['task_claim_required', 'the agent has to claim the bound task first', '智能体需要先认领绑定的任务'],
    ['task_closed', 'the bound task closed after this grant was issued', '绑定的任务在授权签发后关闭过'],
    ['task_not_found', 'the bound task no longer exists', '绑定的任务已不存在'],
    ['agent_identity_required', 'the call did not say which agent made it', '调用没有说明是哪个智能体发起的'],
    ['grant_not_found', 'the grant no longer exists', '授权已不存在'],
  ];
  it.each([['en', 1], ['zh-CN', 2]])('F18: every refusal the broker records reads as words, in %s', async (language, column) => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage(language); });
    try {
      const refused = {
        ...trail,
        calls: REFUSAL_LABELS.map(([reason], i) => (
          { ...trail.calls[0], callId: `r${i}`, outcome: 'refused', reason, at: iso(-60000 * (i + 1)) }
        )),
      };
      mockTools({ trails: { grant_live: refused } });
      renderPage();
      const drawer = await openTool('GitHub');
      fireEvent.click(drawer.querySelector('.v2-connector-row__selection'));
      const aside = await screen.findByRole('complementary');
      await waitFor(() => expect(within(aside).getAllByRole('listitem')).toHaveLength(REFUSAL_LABELS.length));
      expect(Array.from(aside.querySelectorAll('.v2-tools__trail-reason')).map((node) => node.textContent))
        .toEqual(REFUSAL_LABELS.map((row) => ` · ${row[column]}`));
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('TASK-050: a human member in the audience is named, not called "an agent"', async () => {
    mockTools({ grants: [{ ...grantLive, effectiveAudience: ['u1', 'a1'] }], seats: { p1: [scout] } });
    renderPage();

    const drawer = await openTool('GitHub');
    const live = await within(drawer).findByRole('button', { name: 'View GitHub in Launch pod' });
    expect(within(live).getByText('sam, Scout may use it')).toBeInTheDocument();
    expect(live.querySelector('.v2-connector-row__kicker-mode')).toHaveTextContent('a write would ask first');
    expect(screen.queryByText(/an agent/)).not.toBeInTheDocument();

    fireEvent.click(live);
    const aside = await screen.findByRole('complementary', { name: 'Grant details' });
    expect(within(aside).getByText('agents allowed').nextElementSibling).toHaveTextContent('sam, Scout');
  });

  it('TASK-624: a per-user bot member with no roster row is named by its curated label, not its instance id', async () => {
    mockTools({
      grants: [grantLive],
      seats: {},
      podList: [{
        _id: 'p1', name: 'Launch pod', type: 'chat',
        members: [
          { _id: 'u1', username: 'sam' },
          { _id: 'a1', username: 'scout-uf2554d19c9', isBot: true, botMetadata: { displayName: 'Scout', instanceId: 'uf2554d19c9' } },
        ],
      }],
    });
    renderPage();

    const drawer = await openTool('GitHub');
    const live = await within(drawer).findByRole('button', { name: 'View GitHub in Launch pod' });
    expect(within(live).getByText('Scout may use it')).toBeInTheDocument();
    expect(screen.queryByText(/uf2554d19c9/)).not.toBeInTheDocument();
  });

  it('TASK-624: a bot member with a blank displayName falls back to its non-default instanceId, then to the default username', async () => {
    mockTools({
      grants: [{ ...grantLive, effectiveAudience: ['a1', 'a2'] }],
      seats: {},
      podList: [{
        _id: 'p1', name: 'Launch pod', type: 'chat',
        members: [
          { _id: 'u1', username: 'sam' },
          { _id: 'a1', username: 'scout-uf2554d19c9', isBot: true, botMetadata: { displayName: '  ', instanceId: 'uf2554d19c9' } },
          { _id: 'a2', username: 'guide', isBot: true, botMetadata: { displayName: '', instanceId: 'default' } },
        ],
      }],
    });
    renderPage();

    const drawer = await openTool('GitHub');
    const live = await within(drawer).findByRole('button', { name: 'View GitHub in Launch pod' });
    expect(within(live).getByText('uf2554d19c9, guide may use it')).toBeInTheDocument();
  });

  it('Revoke is two-click and posts the revoke verb, then reloads; a dead grant offers no Revoke', async () => {
    renderPage();
    const { drawer, aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(axios.post).not.toHaveBeenCalled();
    const before = grantReads().length;
    fireEvent.click(within(aside).getByRole('button', { name: 'Revoke' }));
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(within(aside).getByRole('button', { name: 'Yes, revoke it' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants/grant_live/revoke', undefined, expect.any(Object)));
    await waitFor(() => expect(grantReads().length).toBeGreaterThan(before));

    fireEvent.click(within(drawer).getByRole('button', { name: 'View GitHub in Ops' }));
    const gone = await screen.findByRole('complementary', { name: 'Grant details' });
    expect(within(gone).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(within(gone).getByText(/Revoked by sam 10m ago\./)).toBeInTheDocument();
    await waitFor(() => expect(within(gone).getByText('No calls yet.')).toBeInTheDocument());
  });

  // Atlassian walk, launch day: the card kept saying "granted" after Revoke until a
  // reload. A confirmed revoke is final, so a stale or failed re-read cannot put the
  // card back.
  it('after Revoke the grant card says revoked in place, even when the re-read is stale or fails', async () => {
    let staleServed = false;
    mockTools({
      grants: [grantLive],
      trails: {},
      route: (url) => {
        if (url !== '/api/grants') return undefined;
        if (axios.post.mock.calls.length === 0) return Promise.resolve({ data: { grants: [grantLive] } });
        if (!staleServed) {
          staleServed = true; // stale: the server read lags the revoke
          return Promise.resolve({ data: { grants: [grantLive] } });
        }
        return Promise.reject(new Error('network')); // then a failed read
      },
    });
    axios.post.mockResolvedValue({ data: { revoked: 1 } });
    renderPage();

    const { drawer, aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(within(aside).getByText(/Granted by sam .*Ends /)).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(aside).getByRole('button', { name: 'Yes, revoke it' }));
    await waitFor(() => expect(staleServed).toBe(true));
    // A tab refocus re-reads, and that read fails.
    const reads = grantReads().length;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(grantReads().length).toBeGreaterThan(reads));
    const card = await screen.findByRole('complementary', { name: 'Grant details' });
    await waitFor(() => expect(within(card).getByText(/Revoked by sam just now\./)).toBeInTheDocument());
    expect(within(card).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    // The row went hollow with it, and the list did not blank on the failed read.
    expect(within(drawer).getByRole('button', { name: 'View GitHub in Launch pod' })).toBeInTheDocument();
    expect(within(drawer).getByText(/revoked by sam/)).toBeInTheDocument();
  });

  // Atlassian walk, launch day: only a connection that is no longer offered got
  // "Remove connection", so nobody could disconnect Atlassian from the page.
  describe('Disconnect on a live connection of an offered hosted connector', () => {
    const atlassian = {
      ...linearEntry, installableId: 'atlassian', entryId: 'atlassian', label: 'Atlassian',
      tools: [{ name: 'atlassian.search', requiredWriteMode: 'read', irreversible: false }],
      connections: [{ connectionId: 'conn-atl', owner: 'me', repo: 'atlassian' }],
    };
    const grantAtl = { ...grantLinear, grantId: 'grant_atl', tools: ['atlassian.search'] };
    const catalogReads = () => axios.get.mock.calls.filter(([u]) => u === '/api/installables');

    it('an ungranted connection offers Disconnect, two clicks, and says so afterwards', async () => {
      mockTools({ entries: [atlassian], grants: [] });
      axios.delete.mockResolvedValue({ data: { message: 'Integration deleted successfully' } });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      fireEvent.click(within(popover).getByRole('button', { name: 'Disconnect Atlassian' }));
      expect(axios.delete).not.toHaveBeenCalled();
      const reads = catalogReads().length;
      fireEvent.click(within(popover).getByRole('button', { name: 'Yes, disconnect' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/integrations/conn-atl', expect.any(Object)));
      expect(await screen.findByText('Disconnected Atlassian.')).toBeInTheDocument();
      await waitFor(() => expect(catalogReads().length).toBeGreaterThan(reads));
    });

    it('a stale catalogue read after Disconnect does not bring the connection back', async () => {
      mockTools({ entries: [atlassian], grants: [] }); // every read still lists the connection
      axios.delete.mockResolvedValue({ data: { message: 'ok' } });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      fireEvent.click(within(popover).getByRole('button', { name: 'Disconnect Atlassian' }));
      const reads = catalogReads().length;
      fireEvent.click(within(popover).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByText('Disconnected Atlassian.')).toBeInTheDocument();
      // The re-read that follows still lists the connection; the page does not.
      await waitFor(() => expect(catalogReads().length).toBeGreaterThan(reads));
      expect(screen.queryByRole('button', { name: /Disconnect Atlassian|Yes, disconnect/ })).not.toBeInTheDocument();
      expect(within(popover).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    });

    it('a granted connection offers it in the grant card, and a provider page from the server is linked', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockResolvedValue({ data: { message: 'ok', revokeAt: 'https://id.atlassian.com/manage-profile/apps' } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/integrations/conn-atl', expect.any(Object)));
      const link = await screen.findByRole('link', { name: 'Open provider settings' });
      expect(link).toHaveAttribute('href', 'https://id.atlassian.com/manage-profile/apps');
    });

    // TASK-339: a removal the vendor was never told about (Atlassian's revoke is
    // page-only) must not read as finished there. The app is still listed.
    it('a removal the provider did not revoke says the app is still listed there', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockResolvedValue({ data: { message: 'ok', revokeAt: 'https://id.atlassian.com/manage-profile/apps', providerRevoked: false } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByText(/Disconnected Atlassian here, but Atlassian still lists Commonly/)).toBeInTheDocument();
      expect(screen.queryByText(/Review its access/)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open provider settings' })).toHaveAttribute('href', 'https://id.atlassian.com/manage-profile/apps');
    });

    it('a removal the provider revoked keeps the review copy', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockResolvedValue({ data: { message: 'ok', revokeAt: 'https://id.atlassian.com/manage-profile/apps', providerRevoked: true } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByText(/Connection removed. Review its access at Atlassian/)).toBeInTheDocument();
      expect(screen.queryByText(/still lists Commonly/)).not.toBeInTheDocument();
    });

    it('a network failure says so and keeps the connection', async () => {
      mockTools({ entries: [atlassian], grants: [] });
      axios.delete.mockRejectedValue(new Error('network'));
      renderPage();

      const popover = await openToolPopover('Atlassian');
      fireEvent.click(within(popover).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(popover).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByText('Could not disconnect Atlassian.')).toBeInTheDocument();
      expect(within(popover).getByRole('button', { name: 'Yes, disconnect' })).toBeInTheDocument();
    });

    // A 502 is the server's partial removal: grants already revoked, row disconnected,
    // only the provider's revoke failed, and the body names the page to visit.
    it('a 502 partial removal shows the grant revoked and links the provider page', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockRejectedValue({ response: { status: 502, data: { code: 'provider_revoke_failed', revokeAt: 'https://id.atlassian.com/manage-profile/apps' } } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByRole('link', { name: 'Open provider settings' })).toHaveAttribute('href', 'https://id.atlassian.com/manage-profile/apps');
      // The provider refused, so its app is still listed: never "Connection removed".
      expect(screen.getByText(/Disconnected Atlassian here, but Atlassian still lists Commonly/)).toBeInTheDocument();
      const card = await screen.findByRole('complementary', { name: 'Grant details' });
      expect(within(card).getByText(/Revoked by sam/)).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    });

    // TASK-339: this code follows a step 3 that may never have called the vendor
    // (a page-only entry), so the body's providerRevoked decides the copy.
    it('a 502 incomplete removal the provider never revoked says the app is still listed', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockRejectedValue({ response: { status: 502, data: { code: 'provider_revoked_removal_incomplete', revokeAt: 'https://id.atlassian.com/manage-profile/apps', providerRevoked: false } } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByText(/Disconnected Atlassian here, but Atlassian still lists Commonly/)).toBeInTheDocument();
      expect(screen.queryByText(/Review its access/)).not.toBeInTheDocument();
    });

    // A 502 from the ingress while a pod restarts never reached the route: nothing was revoked.
    it('a bare 502 (no route code) leaves the grant live and says the disconnect failed', async () => {
      mockTools({ entries: [atlassian], grants: [grantAtl] });
      axios.delete.mockRejectedValue({ response: { status: 502, data: '<html>Bad gateway</html>' } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Disconnect Atlassian' }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await within(aside).findByText('Could not disconnect Atlassian.')).toBeInTheDocument();
      expect(within(aside).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
      expect(within(aside).queryByText(/Revoked by/)).not.toBeInTheDocument();
    });

    it('two connections the server does not describe offer no Disconnect, since neither can be named', async () => {
      const two = { ...atlassian, connections: [...atlassian.connections, { connectionId: 'conn-atl-2', owner: 'me', repo: 'atlassian' }] };
      mockTools({ entries: [two], grants: [] });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      expect(within(popover).getByRole('button', { name: 'Add' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    });

    // TASK-330: one sign-in row plus operator-key rows bound per agent. The
    // server describes each row, so each gets its own named Disconnect.
    // Labels carry the viewer's local date, so expected text is computed the
    // same way and holds in any time zone the suite runs in.
    const day = (at) => new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
    const SIGNED_IN = `Signed in · ${day('2026-10-30T12:00:00Z')}`;
    const KEY_SCOUT = `Key · Scout · ${day('2026-10-31T12:00:00Z')}`;
    const twoNamed = {
      ...atlassian,
      connections: [
        { connectionId: 'conn-atl', owner: '', repo: '', connectedAt: '2026-10-30T12:00:00Z' },
        { connectionId: 'conn-atl-key', owner: '', repo: '', agentId: scout.userId, connectedAt: '2026-10-31T12:00:00Z' },
      ],
    };

    it('two described connections each offer a named Disconnect that drops only that connection', async () => {
      mockTools({ entries: [twoNamed], grants: [] });
      axios.delete.mockResolvedValue({ data: { message: 'ok' } });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      expect(within(popover).getByText(SIGNED_IN)).toBeInTheDocument();
      expect(within(popover).getByText(KEY_SCOUT)).toBeInTheDocument();
      fireEvent.click(within(popover).getByRole('button', { name: `Disconnect Atlassian: ${KEY_SCOUT}` }));
      expect(within(popover).getAllByRole('button', { name: 'Yes, disconnect' })).toHaveLength(1);
      expect(within(popover).getByRole('button', { name: `Disconnect Atlassian: ${SIGNED_IN}` })).toBeInTheDocument();
      fireEvent.click(within(popover).getByRole('button', { name: 'Yes, disconnect' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/integrations/conn-atl-key', expect.any(Object)));
      expect(axios.delete).toHaveBeenCalledTimes(1);
    });

    it('dropping one of two connections leaves the grant to the re-read, not marked revoked in place', async () => {
      mockTools({ entries: [twoNamed], grants: [grantAtl] });
      axios.delete.mockResolvedValue({ data: { message: 'ok' } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: `Disconnect Atlassian: ${SIGNED_IN}` }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/integrations/conn-atl', expect.any(Object)));
      const card = await screen.findByRole('complementary', { name: 'Grant details' });
      // A grant does not name its connection, so only the server can say it ended.
      expect(within(card).queryByText(/Revoked by/)).not.toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('a key connection whose agent is not on any roster is named by key and date', async () => {
      const unknownAgent = { ...twoNamed, connections: [twoNamed.connections[0], { ...twoNamed.connections[1], agentId: 'someone-else' }] };
      mockTools({ entries: [unknownAgent], grants: [] });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      expect(within(popover).getByText(`Key · ${day('2026-10-31T12:00:00Z')}`)).toBeInTheDocument();
    });

    it('two connections that read the same offer no Disconnect, since neither can be told apart', async () => {
      const lookAlike = {
        ...twoNamed,
        connections: [
          { connectionId: 'conn-atl-k1', owner: '', repo: '', agentId: 'off-roster-1', connectedAt: '2026-10-31T12:00:00Z' },
          { connectionId: 'conn-atl-k2', owner: '', repo: '', agentId: 'off-roster-2', connectedAt: '2026-10-31T12:00:00Z' },
        ],
      };
      mockTools({ entries: [lookAlike], grants: [] });
      renderPage();

      const popover = await openToolPopover('Atlassian');
      expect(within(popover).getByRole('button', { name: 'Add' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    });

    it('a 502 partial removal of one of two connections leaves the grant to the re-read', async () => {
      mockTools({ entries: [twoNamed], grants: [grantAtl] });
      axios.delete.mockRejectedValue({ response: { status: 502, data: { code: 'provider_revoke_failed', revokeAt: 'https://id.atlassian.com/manage-profile/apps' } } });
      renderPage();

      const { aside } = await openRow('Atlassian', 'View Atlassian in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: `Disconnect Atlassian: ${SIGNED_IN}` }));
      fireEvent.click(within(aside).getByRole('button', { name: 'Yes, disconnect' }));
      expect(await screen.findByRole('link', { name: 'Open provider settings' })).toBeInTheDocument();
      const card = await screen.findByRole('complementary', { name: 'Grant details' });
      expect(within(card).queryByText(/Revoked by/)).not.toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('GitHub (the instance App connection) never offers Disconnect', async () => {
      renderPage();
      await openTool('GitHub');
      expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    });
  });

  it('a never-granted tool opens a popover that draws the offer, and Add mints the grant exactly as the server takes it, never a brokerId', async () => {
    mockTools({
      grants: [],
      seats: { p1: [scout, { name: 'hosted-smoke', userId: 'x9', internal: true }], p2: [] },
    });
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    renderPage();

    const popover = await openToolPopover('GitHub');
    await waitFor(() => expect(meta()).toHaveTextContent('0 on · 1 available'));
    expect(within(popover).getByText('Issues and pull requests.')).toBeInTheDocument();
    expect(within(popover).getByText('read')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Granted' })).toBeNull();
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add GitHub' });
    // Default: read, every non-internal seat in the room, 7 days; under read only read tools are on the list.
    expect(within(form).getByRole('button', { name: 'read' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByText('github.list_issues')).toBeInTheDocument();
    expect(within(form).queryByText('github.comment_on_issue')).toBeNull();
    expect(within(form).getByText('nothing asks first')).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
    fireEvent.change(within(form).getByRole('combobox', { name: 'ends' }), { target: { value: '30' } });
    const before = grantReads().length;
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('/api/grants');
    expect(body).toMatchObject({ connectionId: 'conn-1', target: { kind: 'pod', id: 'p1' }, writeMode: 'read', audience: ['a1'], tools: ['github.list_issues'] });
    // Both are the server's: the broker from the catalogue, the installation from the Connection (#1677).
    expect(body).not.toHaveProperty('brokerId');
    expect(body).not.toHaveProperty('installationId');
    expect(Object.keys(body).sort()).toEqual(['audience', 'connectionId', 'expiresAt', 'target', 'tools', 'writeMode']);
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    await waitFor(() => expect(grantReads().length).toBeGreaterThan(before));
  });

  it('an ended grant alone still draws the offer in its drawer, with Add and the modes', async () => {
    mockTools({ grants: [grantRevoked] });
    renderPage();

    const drawer = await openTool('GitHub');
    await waitFor(() => expect(meta()).toHaveTextContent('0 on · 1 available'));
    expect(within(drawer).getByText('read')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(drawer).getByText('inactive · 1')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Granted' })).toBeNull();
  });

  it('a tool without a Connection offers no Add, and a lock tile says an admin installs it once', async () => {
    mockTools({ entries: [{ ...githubEntry, connections: [] }], grants: [] });
    renderPage();

    await findTile('GitHub');
    expect(screen.getByRole('img', { name: 'An admin installs this once' })).toBeInTheDocument();
    const popover = await openToolPopover('GitHub');
    expect(within(popover).getByText('Install the GitHub App first · an admin does this once')).toBeInTheDocument();
    expect(within(popover).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'Install GitHub App' })).toBeNull();
  });

  describe('the GitHub App setup (admin)', () => {
    const noConnection = { ...githubEntry, connections: [] };
    const fillSetup = (form) => {
      fireEvent.change(within(form).getByRole('textbox', { name: 'installation ID' }), { target: { value: 'install-42' } });
      fireEvent.change(within(form).getByRole('textbox', { name: 'owner' }), { target: { value: 'Team-Commonly' } });
      fireEvent.change(within(form).getByRole('textbox', { name: 'repository' }), { target: { value: 'commonly' } });
    };

    it('an admin can install the GitHub App from the no-connection tile', async () => {
      mockTools({ entries: [noConnection], grants: [] });
      axios.post.mockResolvedValue({ data: { integration: { installationId: 'install-42', createdBy: 'u1' } } });
      renderPage({ auth: adminAuth() });

      const popover = await openToolPopover('GitHub');
      fireEvent.click(within(popover).getByRole('button', { name: 'Install GitHub App' }));
      const form = await screen.findByRole('complementary', { name: 'Install GitHub App' });
      fillSetup(form);
      fireEvent.click(within(form).getByRole('button', { name: 'Install GitHub App' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/integrations/github-app',
        { installationId: 'install-42', owner: 'Team-Commonly', repo: 'commonly' },
        expect.any(Object),
      ));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Install GitHub App' })).toBeNull());
    });

    it('an admin is told when another administrator already owns the GitHub App installation', async () => {
      mockTools({ entries: [noConnection], grants: [] });
      axios.post.mockResolvedValue({ data: { integration: { installationId: 'install-42', createdBy: 'other-admin' } } });
      renderPage({ auth: adminAuth({ _id: 'u2' }) });

      const popover = await openToolPopover('GitHub');
      fireEvent.click(within(popover).getByRole('button', { name: 'Install GitHub App' }));
      const form = await screen.findByRole('complementary', { name: 'Install GitHub App' });
      fillSetup(form);
      fireEvent.click(within(form).getByRole('button', { name: 'Install GitHub App' }));

      await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('This GitHub App is already installed by another administrator.'));
      expect(screen.getByRole('complementary', { name: 'Install GitHub App' })).toBeInTheDocument();
    });
  });

  it('an unavailable tool folds under "+N off" and offers the same Ask affordance as unavailable channels', async () => {
    mockTools({ entries: [{ ...githubEntry, available: false, connections: [] }], grants: [] });
    renderPage();

    await screen.findByRole('region', { name: 'Tools' });
    await settle();
    expect(tileNode('GitHub')).toBeNull();
    await expandOff('Tools');
    expect(tileNode('GitHub')).toHaveClass('v2-cx-tile--dim');
    const popover = await openToolPopover('GitHub');
    const ask = within(popover).getByRole('link', { name: 'Ask' });
    expect(screen.queryByText('not enabled on this instance · ask your operator')).not.toBeInTheDocument();
    expect(ask).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request');
  });

  it('Change access mints a new grant then revokes the old one; Grant again on a dead grant only mints', async () => {
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    renderPage();

    const { drawer, aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    // Under `write` the aside names the irreversible tools from the catalogue.
    expect(within(aside).getByText('asks a person first').nextElementSibling).toHaveTextContent('a write would ask first');
    fireEvent.click(within(aside).getByRole('button', { name: 'Change access' }));
    const form = await screen.findByRole('complementary', { name: 'Change access' });
    // A stored write grant reopens on the one mode the form offers.
    expect(within(form).getByRole('button', { name: 'read' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).queryByRole('button', { name: 'read and write, ask first' })).toBeNull();
    expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    expect(axios.post.mock.calls[0][0]).toBe('/api/grants');
    expect(axios.post.mock.calls[0][1]).toMatchObject({ writeMode: 'read', tools: ['github.list_issues'] });
    expect(axios.post.mock.calls[1][0]).toBe('/api/grants/grant_live/revoke');

    axios.post.mockClear();
    // The first grant is revoked too now (the page keeps a confirmed revoke), so pick the Ops row's own button.
    const body = await screen.findByRole('region', { name: 'GitHub' });
    fireEvent.click(within(within(body).getByRole('button', { name: 'View GitHub in Ops' }).closest('article')).getByRole('button', { name: 'Grant again' }));
    const again = await screen.findByRole('complementary', { name: 'Add GitHub' });
    expect(within(again).getByRole('heading', { name: 'GitHub · Ops' })).toBeInTheDocument();
    fireEvent.click(within(again).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(axios.post.mock.calls[0][0]).toBe('/api/grants');
    expect(drawer).toBeDefined();
  });

  describe('a member who did not grant it', () => {
    const member = asUser({ _id: 'u2', username: 'rae' });

    it('Revoke renders only for the granter', async () => {
      renderPage({ auth: member });
      const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
      expect(within(aside).getByText(/Granted by sam/)).toBeInTheDocument();
      expect(within(aside).queryByRole('button', { name: 'Revoke' })).toBeNull();
      expect(within(aside).queryByRole('button', { name: 'Change access' })).toBeNull();
      // The trail is the room's: a member still reads it.
      await waitFor(() => expect(within(aside).getByText('calls').previousElementSibling).toHaveTextContent('3'));
    });

    it('Grant again renders only for the granter', async () => {
      renderPage({ auth: member });
      const drawer = await openTool('GitHub');
      await within(drawer).findByRole('button', { name: 'View GitHub in Ops' });
      // The dead row offers a member Manage (read the grant), never the mint.
      expect(within(drawer).queryByRole('button', { name: 'Grant again' })).toBeNull();
      expect(within(drawer).getAllByRole('button', { name: 'Manage' })).toHaveLength(2);
    });
  });

  it('Change access keeps the minted grant when the revoke fails and retries only the revoke', async () => {
    axios.post.mockImplementation((url) => (url === '/api/grants'
      ? Promise.resolve({ data: { grantId: 'grant_new' } })
      : Promise.reject(new Error('revoke down'))));
    renderPage();

    const { aside: first } = await openRow('GitHub', 'View GitHub in Launch pod');
    fireEvent.click(within(first).getByRole('button', { name: 'Change access' }));
    fireEvent.click(within(await screen.findByRole('complementary', { name: 'Change access' })).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    const aside = await screen.findByRole('complementary', { name: 'Grant details' });
    expect(await within(aside).findByText('The new grant is live. This old one still is too — its revoke did not go through.')).toBeInTheDocument();
    expect(within(aside).queryByRole('button', { name: 'Revoke' })).toBeNull();
    axios.post.mockResolvedValue({ data: { grantId: 'grant_live', revoked: 1 } });
    fireEvent.click(within(aside).getByRole('button', { name: 'Revoke the old grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(3));
    // Only the revoke went out again, no third mint.
    expect(axios.post.mock.calls.map(([u]) => u)).toEqual(['/api/grants', '/api/grants/grant_live/revoke', '/api/grants/grant_live/revoke']);
  });

  describe('TASK-133: accounting with two entries', () => {
    const dots = () => screen.queryAllByRole('img', { name: 'Granted' });

    it('a live grant on one entry leaves the other entry still to grant', async () => {
      mockTools({ entries: [githubEntry, linearEntry], grants: [grantLinear, grantRevoked] });
      renderPage();

      // One entry granted, so one is still available, and the entry the grant names
      // is the one that carries the Granted dot (label and glyph from its own entry).
      await screen.findByRole('img', { name: 'Granted' });
      await waitFor(() => expect(meta()).toHaveTextContent('1 on · 1 available'));
      expect(dots()).toHaveLength(1);
      expect(tileNode('Linear').querySelector('.v2-cx-tile__dot')).not.toBeNull();
      expect(tileNode('GitHub').querySelector('.v2-cx-tile__dot')).toBeNull();

      const linear = await openTool('Linear');
      expect(within(linear).getByRole('button', { name: 'View Linear in Launch pod' })).toBeInTheDocument();
      expect(within(linear).queryByRole('button', { name: /^View GitHub/ })).not.toBeInTheDocument();

      const github = await openTool('GitHub');
      // Its only grant is the ended one, so the drawer carries the offer beside it.
      expect(within(github).queryByRole('button', { name: 'View GitHub in Launch pod' })).not.toBeInTheDocument();
      expect(within(github).getByRole('button', { name: 'View GitHub in Ops' })).toBeInTheDocument();
      expect(within(github).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    });

    it('the granted entry itself leaves the offer, the other one stays', async () => {
      mockTools({ entries: [githubEntry, linearEntry], grants: [grantLive, grantRevoked] });
      renderPage();

      await screen.findByRole('img', { name: 'Granted' });
      expect(tileNode('GitHub').querySelector('.v2-cx-tile__dot')).not.toBeNull();
      expect(tileNode('Linear').querySelector('.v2-cx-tile__dot')).toBeNull();
      const github = await openTool('GitHub');
      expect(within(github).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
      const linear = await openToolPopover('Linear');
      expect(linear.textContent).toContain('Issues in Linear.');
      expect(linear.textContent).not.toContain('GitHub');
    });

    it('with every entry granted the head carries no available count', async () => {
      mockTools({ entries: [githubEntry, linearEntry], grants: [grantLive, grantLinear, grantRevoked] });
      renderPage();

      await waitFor(() => expect(dots()).toHaveLength(2));
      expect(meta()).toHaveTextContent('2 on · 0 available');
    });
  });

  it('Linear exposes only its pinned read mode in its offer and Add form', async () => {
    mockTools({ entries: [githubEntry, linearEntry], grants: [grantLive] });
    renderPage();

    const popover = await openToolPopover('Linear');
    expect(popover).toHaveTextContent('read');
    expect(popover).not.toHaveTextContent('Read, or read and write');

    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    const modeGroup = within(form).getByRole('group', { name: 'what it may do' });
    expect(within(modeGroup).getAllByRole('button')).toHaveLength(1);
    expect(within(modeGroup).getByRole('button', { name: 'read' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('search filters tiles by tool name, and says so when nothing matches', async () => {
    renderPage();
    await findTile('GitHub');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'comment' } });
    expect(tileNode('GitHub')).not.toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'zzz' } });
    expect(tileNode('GitHub')).toBeNull();
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });

  it('with no grants and no catalogue the Tools group holds no tile and no row', async () => {
    mockApi({ installables: [], grants: [], pods });
    renderPage();

    const tools = await screen.findByRole('region', { name: 'Tools' });
    await settle();
    expect(tools.querySelector('.v2-cx-tile')).toBeNull();
    expect(document.querySelector('.v2-connector-row')).toBeNull();
    expect(meta()).toHaveTextContent('0 on · 0 available');
  });

  it('TASK-752: a revoked grant whose catalogue entry is gone is not listed in Tools, only the live one is', async () => {
    // No catalogue entry covers either grant, so both are orphans. Only the live one is
    // still access; the revoked one must not draw a row beside it.
    mockTools({ entries: [], grants: [grantLive, grantRevoked] });
    renderPage();

    const tools = await screen.findByRole('region', { name: 'Tools' });
    await settle();
    // An orphan grant is a tile since TASK-754: one tile, for the live grant.
    expect(tools.querySelectorAll('.v2-cx-tile')).toHaveLength(1);
    expect(tools.querySelector('.v2-connector-row')).toBeNull();
  });

  /**
   * Scope §4, step 7's named test: "the page's call to start is credentialed".
   *
   * The start route binds a connect to the browser that began it with an httpOnly
   * cookie on its OWN response, and the API is a different origin from the app.
   * Without `withCredentials` the browser drops the `Set-Cookie`, so a person
   * consents at the vendor and comes back to a row that is still not connected,
   * every callback refusing `invalid_state`. A backend suite sets the cookie itself
   * and cannot witness this flag; this arm is the one that can.
   */
  it('step 7: the page\'s call to start a hosted connect is credentialed', async () => {
    const hosted = { ...linearEntry, description: 'Issues and projects in Linear.', connections: [] };
    mockTools({ entries: [hosted], grants: [] });
    axios.post.mockResolvedValue({ data: { authorizeUrl: 'https://mcp.linear.app/authorize?state=s' } });
    const opened = { opener: null, location: { assign: jest.fn() }, close: jest.fn() };
    jest.spyOn(window, 'open').mockReturnValue(opened);
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations/connect/hosted-mcp/linear/start',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    expect(opened.location.assign).toHaveBeenCalledWith('https://mcp.linear.app/authorize?state=s');
  });

  it('a hosted connector shows vendor setup guidance before connect', async () => {
    mockTools({ entries: [{ ...linearEntry, connections: [], connectNotice: 'Ask your admin to allow this domain.' }], grants: [] });
    renderPage();

    const popover = await openToolPopover('Linear');
    expect(within(popover).getByText('Ask your admin to allow this domain.')).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  // TASK-290: GitHub's App user token reaches only the repositories the App is
  // installed on, so the page that picks them sits beside Connect and stays after
  // connecting, while the person decides what to grant.
  it('a hosted connector links to where the person chooses its reach, before and after connecting', async () => {
    const accessPage = 'https://github.com/apps/commonly-connect/installations/new';
    mockTools({ entries: [{ ...linearEntry, connections: [], accessPage }], grants: [] });
    const first = renderPage();
    const popover = await openToolPopover('Linear');
    const before = within(popover).getByRole('link', { name: 'Choose what Linear can reach' });
    expect(before).toHaveAttribute('href', accessPage);
    expect(before).toHaveAttribute('target', '_blank');
    expect(before).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(popover).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    first.unmount();

    mockTools({ entries: [{ ...linearEntry, accessPage }], grants: [] });
    renderPage();
    const after = await openToolPopover('Linear');
    expect(within(after).getByRole('link', { name: 'Choose what Linear can reach' })).toHaveAttribute('href', accessPage);
    expect(within(after).queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('a live GitHub grant carries the install warning on its reach link', async () => {
    const tool = 'github-mcp.list_issues';
    const entry = {
      ...linearEntry,
      installableId: 'github-mcp',
      entryId: 'github-mcp',
      label: 'GitHub MCP',
      accessPage: 'https://github.com/apps/commonly-connect/installations/new',
      tools: [{ name: tool, requiredWriteMode: 'read', irreversible: false }],
    };
    mockTools({ entries: [entry], grants: [{ ...grantLinear, tools: [tool] }] });
    renderPage();
    const { aside } = await openRow('GitHub MCP', 'View GitHub MCP in Launch pod');
    const link = within(aside).getByRole('link', { name: 'Choose what GitHub MCP can reach' });
    expect(link.closest('.v2-cx-warning')).toHaveTextContent("On GitHub, choose 'Only select repositories'.");
  });

  // A live grant takes the entry off the offer, so the page moves to the grant's
  // details. Only the granter, who owns the connection, is sent there.
  it('a live hosted grant keeps the reach link on its details for the granter only', async () => {
    const accessPage = 'https://github.com/apps/commonly-connect/installations/new';
    const entry = { ...linearEntry, accessPage };
    mockTools({ entries: [entry], grants: [grantLinear] });
    const first = renderPage();
    const { aside } = await openRow('Linear', 'View Linear in Launch pod');
    expect(within(aside).getByRole('link', { name: 'Choose what Linear can reach' })).toHaveAttribute('href', accessPage);
    first.unmount();

    mockTools({ entries: [entry], grants: [{ ...grantLinear, grantedBy: 'u2' }] });
    renderPage();
    const { aside: other } = await openRow('Linear', 'View Linear in Launch pod');
    expect(within(other).queryByRole('link', { name: /can reach/ })).toBeNull();
  });

  it('a hosted connector without an access page offers no reach link', async () => {
    mockTools({ entries: [{ ...linearEntry, connections: [] }], grants: [] });
    renderPage();

    const popover = await openToolPopover('Linear');
    expect(within(popover).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /can reach/ })).toBeNull();
  });

  it('a hidden hosted entry has no offering while its existing connection can be removed', async () => {
    mockTools({
      entries: [],
      grants: [],
      hidden: [{ connectionId: 'conn-hidden', entryId: 'airtable', label: 'Airtable', status: 'connected', revokePage: 'https://airtable.com/account' }],
    });
    axios.delete.mockResolvedValue({ data: { message: 'removed' } });
    renderPage();

    await settle();
    await expandOff('Tools');
    expect(await screen.findByText('Airtable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/integrations/conn-hidden', expect.anything()));
    expect(await screen.findByText(/Connection removed. Review its access at Airtable/)).toBeInTheDocument();
  });

  it('a hidden connection the provider did not revoke says the app is still listed there', async () => {
    mockTools({
      entries: [],
      grants: [],
      hidden: [{ connectionId: 'conn-hidden', entryId: 'airtable', label: 'Airtable', status: 'connected', revokePage: 'https://airtable.com/account' }],
    });
    axios.delete.mockResolvedValue({ data: { message: 'removed', revokeAt: 'https://airtable.com/account', providerRevoked: false } });
    renderPage();

    await settle();
    await expandOff('Tools');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove connection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(await screen.findByText(/Disconnected Airtable here, but Airtable still lists Commonly/)).toBeInTheDocument();
  });

  it('a hosted connect start error uses fixed copy instead of response text', async () => {
    mockTools({ entries: [{ ...linearEntry, connections: [] }], grants: [] });
    axios.post.mockRejectedValue({
      response: { data: { error: 'client_not_configured', message: 'spoofed vendor text' } },
    });
    const opened = { opener: null, location: { assign: jest.fn() }, close: jest.fn() };
    jest.spyOn(window, 'open').mockReturnValue(opened);
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This connector’s sign-in setup needs attention. Ask an administrator to check it.',
    );
    expect(screen.queryByText(/spoofed vendor text/)).toBeNull();
    expect(opened.close).toHaveBeenCalled();
  });

  it.each([400, 403])('a hosted grant HTTP %s stays open with the server refusal', async (status) => {
    mockTools({ entries: [linearEntry], grants: [] });
    axios.post.mockRejectedValue({ response: { status, data: {
      error: 'invalid_target', message: 'The selected target is unavailable.',
    } } });
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('The selected target is unavailable.');
    expect(screen.getByRole('complementary', { name: 'Add Linear' })).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({
      connectionId: 'conn-2', target: { kind: 'pod', id: 'p1' }, audience: ['a1'],
    }), expect.any(Object));
  });

  it.each([undefined, {}, { error: 'invalid_target' }, '<html>fallback</html>', { grantId: '' }, { grantId: '   ' }])(
    'an unconfirmed mint response keeps the form and old grant: %p', async (body) => {
      axios.post.mockResolvedValue({ data: body });
      renderPage();

      const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Change access' }));
      const form = await screen.findByRole('complementary', { name: 'Change access' });
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      expect(await within(form).findByRole('alert')).toHaveTextContent('Could not grant it.');
      expect(screen.getByRole('complementary', { name: 'Change access' })).toBeInTheDocument();
      expect(axios.post.mock.calls.map(([url]) => url)).toEqual(['/api/grants']);
    },
  );

  it.each(['unavailable', 'removed'])('a catalogue refresh (%s) cannot hide a refused hosted grant draft', async (refresh) => {
    mockTools({ entries: [linearEntry], grants: [] });
    const message = 'Agents can self-install into this pod. Make it invite-only to use this connector.';
    axios.post.mockRejectedValue({ response: { status: 403, data: { error: 'outsider_grant_pod_joinable', message } } });
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(message);
    const previousGet = axios.get.getMockImplementation();
    axios.get.mockImplementation((url, ...args) => (url === '/api/installables'
      ? (refresh === 'unavailable' ? Promise.reject(new Error('offline')) : Promise.resolve({ data: { installables: [] } }))
      : previousGet(url, ...args)));
    const reads = axios.get.mock.calls.length;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(axios.get.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.getByRole('complementary', { name: 'Add Linear' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(meta()).toHaveTextContent('0 on'));
  });

  it('hosted grant picker sends the selected pod ID and keeps the agent User ID in audience', async () => {
    mockTools({
      entries: [linearEntry],
      grants: [],
      seats: { p1: [scout], p2: [{ name: 'reed', userId: 'a2' }] },
    });
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'pod' }), { target: { value: 'p2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({
      target: { kind: 'pod', id: 'p2' }, audience: ['a2'],
    }), expect.anything()));
  });

  it('the dialog cannot submit an empty audience and re-enables grant when an agent is selected', async () => {
    mockTools({ entries: [linearEntry], grants: [] });
    renderPage();

    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    const submit = within(form).getByRole('button', { name: 'Grant' });
    expect(submit).toBeEnabled();
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Scout' }));
    expect(within(form).getByRole('status')).toHaveTextContent('Select at least one agent to grant access.');
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Scout' }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({ audience: ['a1'] }), expect.anything()));
  });

  it('Grant again on an existing empty-audience row requires an explicit new selection', async () => {
    mockTools({ entries: [linearEntry], grants: [{ ...grantRevoked, tools: ['linear.list_issues'], effectiveAudience: [] }] });
    renderPage();

    const drawer = await openTool('Linear');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    const agent = within(form).getByRole('checkbox', { name: 'Scout' });
    expect(agent).not.toBeChecked();
    const submit = within(form).getByRole('button', { name: 'Grant' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(agent);
    fireEvent.click(submit);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({ audience: ['a1'], target: { kind: 'pod', id: 'p2' } }), expect.anything()));
  });

  it.each([
    { label: 'human-only', audience: ['u1'], selected: false },
    { label: 'mixed human and agent', audience: ['u1', 'a1'], selected: true },
  ])('Grant again restores only current agents from a $label legacy audience', async ({ audience, selected }) => {
    mockTools({ grants: [{ ...grantRevoked, effectiveAudience: audience }] });
    renderPage();

    const drawer = await openTool('GitHub');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    const form = await screen.findByRole('complementary', { name: 'Add GitHub' });
    const scoutBox = within(form).getByRole('checkbox', { name: 'Scout' });
    const submit = within(form).getByRole('button', { name: 'Grant' });
    expect(scoutBox.checked).toBe(selected);
    if (!selected) {
      expect(submit).toBeDisabled();
      expect(within(form).getByText('Select at least one agent to grant access.')).toBeInTheDocument();
      fireEvent.click(submit);
      expect(axios.post).not.toHaveBeenCalled();
      fireEvent.click(scoutBox);
    }
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({
      target: { kind: 'pod', id: 'p2' }, audience: ['a1'],
    }), expect.anything()));
  });

  it('a tool popover shows the zh-CN catalog copy, and an unmapped entry keeps the server text', async () => {
    const linear = {
      installableId: 'linear', list: 'tools', label: 'Linear', description: 'Read Linear issues and projects.',
      connectionType: 'hosted-mcp', entryId: 'linear', available: true, tools: [], connections: [], installation: null, integration: null,
    };
    mockTools({
      entries: [linear, { ...linear, installableId: 'acme-tools', label: 'Acme', description: 'Acme server copy.', entryId: 'acme' }],
      grants: [],
    });
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();
      const mapped = await openToolPopover('Linear');
      expect(within(mapped).getByText('你自己的 Linear 工作空间中的议题、项目、周期和发布。')).toBeInTheDocument();
      const unmapped = await openToolPopover('Acme');
      expect(within(unmapped).getByText('Acme server copy.')).toBeInTheDocument();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('the open grant form reads in zh-CN, not English', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      mockTools({ grants: [grantRevoked], trails: {} });
      renderPage();
      const drawer = await openTool('GitHub');
      fireEvent.click(await within(drawer).findByRole('button', { name: /^添加$|^Add$/ }));
      const form = await screen.findByRole('complementary');
      expect(within(form).getByText('无需确认')).toBeInTheDocument();
      expect(within(form).queryByText('nothing asks first')).toBeNull();
      expect(within(form).queryByText('read and write, ask first')).toBeNull();
      // No English button left in the zh-CN form.
      expect(within(form).queryByRole('button', { name: 'Grant' })).toBeNull();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  // The old inactive fold (retired fold tests): the roster of ended grants no
  // longer hides behind a closed fold. Never-granted entries are tiles, and the ended
  // grants of one entry sit under an "inactive · N" heading in that entry's drawer.
  describe('ended grants and never-granted offers', () => {
    const base = {
      grantId: 'g', installationId: 'inst-github', target: { kind: 'pod', id: 'p1' }, tools: ['github.list_issues'],
      writeMode: 'read', budget: null, effectiveAudience: [], expiresAt: iso(86_400_000),
      revokedAt: null, revokedBy: null, parentGrantId: null, rootGrantId: null, createdAt: iso(-86_400_000), grantedBy: 'u1',
    };
    const grant = (id, revokedAt) => ({ ...base, grantId: id, revokedAt, revokedBy: revokedAt ? 'u1' : null });
    const expired = (id) => ({ ...base, grantId: id, expiresAt: iso(-86_400_000) });
    const yesterday = iso(-86_400_000);
    const offers = ['GitHub', 'Linear', 'Atlassian', 'Airtable', 'Sentry'].map((label) => ({
      ...githubEntry, installableId: label.toLowerCase(), label, entryId: label.toLowerCase(),
      tools: [{ name: `${label.toLowerCase()}.list_issues`, requiredWriteMode: 'read', irreversible: false }],
    }));
    const onePod = [{ _id: 'p1', name: 'Launch pod', type: 'chat', members: [{ _id: 'u1', username: 'sam' }] }];
    const toolTiles = () => Array.from(screen.getByRole('region', { name: 'Tools' }).querySelectorAll('.v2-cx-tile__name')).map((node) => node.textContent);

    it('five never-granted catalogue offers are five tiles, with no inactive heading', async () => {
      mockTools({ entries: offers, grants: [], podList: onePod, seats: {} });
      renderPage();

      await findTile('Sentry');
      expect(toolTiles()).toEqual(['GitHub', 'Linear', 'Atlassian', 'Airtable', 'Sentry']);
      await waitFor(() => expect(meta()).toHaveTextContent('0 on · 5 available'));
      expect(screen.queryByText(/inactive ·/)).not.toBeInTheDocument();
      expect(screen.queryByText('Nothing matches.')).not.toBeInTheDocument();
    });

    it('eight ended grants stay out of the five offer tiles and list under one heading in their entry drawer', async () => {
      const grants = [
        ...Array.from({ length: 4 }, (_, i) => grant(`revoked-${i}`, yesterday)),
        ...Array.from({ length: 4 }, (_, i) => expired(`expired-${i}`)),
      ];
      mockTools({ entries: offers, grants, podList: onePod, seats: {} });
      renderPage();

      await findTile('Sentry');
      await settle();
      expect(toolTiles()).toEqual(['GitHub', 'Linear', 'Atlassian', 'Airtable', 'Sentry']);
      expect(document.querySelectorAll('.v2-connector-row')).toHaveLength(0);
      const drawer = await openTool('GitHub');
      expect(within(drawer).getByText('inactive · 8')).toBeInTheDocument();
      expect(drawer.querySelectorAll('.v2-connector-row')).toHaveLength(8);
    });

    it('two live grants come first and nine ended ones follow under "inactive · 9"', async () => {
      const grants = [
        grant('live-1', null), grant('live-2', null),
        ...Array.from({ length: 4 }, (_, i) => grant(`revoked-${i}`, yesterday)),
        ...Array.from({ length: 5 }, (_, i) => expired(`expired-${i}`)),
      ];
      mockTools({ grants, entries: [githubEntry], podList: onePod, seats: {} });
      renderPage();

      const drawer = await openTool('GitHub');
      const rows = Array.from(drawer.querySelectorAll('.v2-connector-row'));
      expect(rows).toHaveLength(11);
      expect(rows.slice(0, 2).every((row) => !row.classList.contains('v2-connector-row--dead'))).toBe(true);
      expect(rows.slice(2).every((row) => row.classList.contains('v2-connector-row--dead'))).toBe(true);
      expect(within(drawer).getByText('inactive · 9')).toBeInTheDocument();
      expect(screen.queryByText(/not enabled|not yet|coming/i)).not.toBeInTheDocument();
    });

    it('search keeps a matching offer and drops the hidden connection that does not match', async () => {
      const linear = {
        ...githubEntry, installableId: 'linear', connectionType: 'hosted-mcp', entryId: 'linear', label: 'Linear', description: 'Linear issues',
        tools: [{ name: 'linear.list_issues', requiredWriteMode: 'read', irreversible: false }],
      };
      mockTools({
        entries: [githubEntry, linear],
        grants: [grant('live', null), grant('revoked', yesterday)],
        hidden: [{ connectionId: 'hidden-1', entryId: 'atlassian', label: 'Atlassian', status: 'inactive', revokePage: null }],
        podList: onePod,
        seats: {},
      });
      renderPage();

      expect(await screen.findByRole('button', { name: '+1 off' })).toBeInTheDocument();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'Linear' } });
      expect(screen.queryByRole('button', { name: /^\+\d+ off$/ })).not.toBeInTheDocument();
      expect(toolTiles()).toEqual(['Linear']);
      expect(document.body).not.toHaveTextContent('Atlassian');
    });
  });
});

describe('Linear read note', () => {
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  it.each(['en', 'zh-CN'])('a connected Linear drawer says agents read it and cannot write to it, in %s', async (language) => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage(language); });
    mockTools({ entries: [githubEntry, linearEntry], grants: [grantLinear] });
    renderPage();
    const drawer = await openTool('Linear');
    const note = within(drawer).getByRole('note');
    expect(note).toHaveTextContent(language === 'en' ? "Agents can read Linear from here, but they can't write to it." : '智能体可以在这里读取 Linear，但不能写入。');
    expect(note).not.toHaveTextContent(language === 'en' ? 'turn on writes' : '重新连接');
  });

  it('a connected Linear with no grant shows it once in the popover, before Add', async () => {
    mockTools({ entries: [githubEntry, linearEntry], grants: [] });
    renderPage();
    const pop = await openToolPopover('Linear');
    expect(within(pop).getAllByRole('note')).toHaveLength(1);
    expect(within(pop).getByRole('note')).toHaveTextContent("Agents can read Linear from here, but they can't write to it.");
  });

  it('a Linear drawer with only an ended grant shows it once, in the offer', async () => {
    const ended = { ...grantLinear, revokedAt: iso(-600000), revokedBy: 'u1' };
    mockTools({ entries: [githubEntry, linearEntry], grants: [ended] });
    renderPage();
    const drawer = await openTool('Linear');
    expect(within(drawer).getAllByRole('note')).toHaveLength(1);
  });

  it('no other drawer carries it', async () => {
    mockTools({ entries: [githubEntry, linearEntry], grants: [grantLive] });
    renderPage();
    const drawer = await openTool('GitHub');
    expect(within(drawer).queryByRole('note')).not.toBeInTheDocument();
  });

  it('another connected hosted connector does not carry it', async () => {
    const atlassian = { ...linearEntry, installableId: 'atlassian', entryId: 'atlassian', label: 'Atlassian', connections: [{ connectionId: 'conn-atl', owner: '', repo: '' }] };
    mockTools({ entries: [atlassian], grants: [] });
    renderPage();
    const pop = await openToolPopover('Atlassian');
    expect(within(pop).queryByRole('note')).not.toBeInTheDocument();
  });
});

// F213: no form-made grant gives an agent a write today, so the form offers none
// until F214 and F215 restore it. A grant already stored keeps its true mode.
describe('the form offers read, and a stored write grant stays what it is', () => {
  const sentryEntry = {
    installableId: 'sentry', list: 'tools', label: 'Sentry', description: 'Issues in Sentry.', available: true,
    connectionType: 'hosted-mcp', entryId: 'sentry',
    broker: { id: 'commonly-grant-broker' },
    tools: [
      { name: 'sentry.list_issues', requiredWriteMode: 'read', irreversible: false },
      { name: 'sentry.update_issue', requiredWriteMode: 'write-with-confirm', irreversible: false },
    ],
    connections: [{ connectionId: 'conn-s', owner: 'acme', repo: 'sentry' }],
  };
  const modeButtons = (form) => within(within(form).getByRole('group', { name: 'what it may do' })).getAllByRole('button');

  it.each([
    ['a GitHub App', githubEntry, 'GitHub', 'github.list_issues', 'github.comment_on_issue'],
    ['a hosted connection', sentryEntry, 'Sentry', 'sentry.list_issues', 'sentry.update_issue'],
  ])('%s with write tools offers only read, and mints read', async (_kind, entry, label, readTool, writeTool) => {
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    mockTools({ entries: [entry], grants: [] });
    renderPage();
    const popover = await openToolPopover(label);
    expect(within(popover).queryByText('Read, or read and write')).toBeNull();
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: `Add ${label}` });
    expect(modeButtons(form).map((button) => button.textContent)).toEqual(['read']);
    expect(within(form).getByText(readTool)).toBeInTheDocument();
    expect(within(form).queryByText(writeTool)).toBeNull();
    expect(within(form).getByText('nothing asks first')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(axios.post.mock.calls[0][1]).toMatchObject({ writeMode: 'read', tools: [readTool] });
  });

  it.each([
    ['en', 'a write would ask first'],
    ['zh-CN', '如有写入，需先确认'],
  ])('the asks line on a stored grant makes no promise of a write, in %s', async (language, text) => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage(language); });
    try {
      mockTools({ grants: [grantLive] });
      renderPage();
      const drawer = await openTool('GitHub');
      expect(drawer.querySelector('.v2-connector-row__kicker-mode')).toHaveTextContent(text);
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it.each([
    ['write-with-confirm', 'read and write, ask first', 'a write would ask first'],
    ['write', 'read and write', 'github.comment_on_issue, github.close_issue ask first'],
    ['read', 'read', 'nothing asks first'],
  ])('a stored %s grant shows its true mode in the row and the detail', async (writeMode, label, asks) => {
    mockTools({
      grants: [{ ...grantLive, writeMode, tools: ['github.list_issues', 'github.comment_on_issue', 'github.close_issue'] }],
      trails: { grant_live: { ...trail, calls: [] } },
    });
    renderPage();
    const { drawer, aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(within(drawer).getByRole('img', { name: label })).toBeInTheDocument();
    expect(drawer.querySelector('.v2-connector-row__kicker-mode')).toHaveTextContent(asks);
    expect(within(aside).getByText(label).nextElementSibling).toHaveTextContent('github.list_issues');
    expect(within(aside).getByText('asks a person first').nextElementSibling).toHaveTextContent(asks);
  });
});

describe('F221: connecting your own repository', () => {
  const ROUTE = '/api/integrations/github-app/repositories';
  const appEntry = { ...githubEntry, connectionType: 'github-app', repositoryConnect: true, connections: [] };
  const hostedGithub = {
    ...linearEntry, installableId: 'github-mcp', label: 'GitHub MCP', entryId: 'github-mcp', repositoryConnect: true, accessPage: 'https://github.com/apps/connect/installations/new', connections: [],
  };
  const repos = [
    { installationId: '7001', owner: 'Outside-Team', repo: 'Widget', private: true },
    { installationId: '7001', owner: 'Outside-Team', repo: 'Gadget', private: false },
  ];
  const openStep = async ({ listed, refused, entries = [appEntry, hostedGithub] }) => {
    const route = (url) => {
      if (url !== ROUTE) return undefined;
      return refused ? Promise.reject({ response: { data: { error: refused } } }) : Promise.resolve({ data: listed });
    };
    mockTools({ entries, grants: [], seats: { p1: [scout], p2: [] }, route });
    axios.post.mockResolvedValue({ data: { integration: { _id: 'row-1' } } });
    renderPage();
    const popover = await openToolPopover('GitHub MCP');
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect a repository' }));
    return screen.findByRole('complementary', { name: 'Connect a repository' });
  };

  it('is not offered where the catalogue does not say so', async () => {
    mockTools({ entries: [{ ...hostedGithub, repositoryConnect: undefined }], grants: [], seats: { p1: [scout], p2: [] } });
    renderPage();
    const popover = await openToolPopover('GitHub MCP');
    expect(within(popover).queryByRole('button', { name: 'Connect a repository' })).toBeNull();
  });

  it('a member who is no admin connects the repository they pick, with the row GitHub listed', async () => {
    const step = await openStep({ listed: { repositories: repos, truncated: false } });
    const connect = await within(step).findByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    fireEvent.change(within(step).getByLabelText('repository'), { target: { value: 'Outside-Team/Gadget' } });
    fireEvent.click(connect);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(ROUTE, { installationId: '7001', owner: 'Outside-Team', repo: 'Gadget' }, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Connect a repository' })).toBeNull());
  });

  it('with no GitHub account connected, it starts that sign-in instead of asking for ids', async () => {
    const opened = { opener: 'x', location: { assign: jest.fn() }, close: jest.fn() };
    jest.spyOn(window, 'open').mockReturnValue(opened);
    const step = await openStep({ refused: 'github_connect_required' });
    fireEvent.click(await within(step).findByRole('button', { name: 'Connect GitHub' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/integrations/connect/hosted-mcp/github-mcp/start', {}, expect.anything()));
  });

  it('with nothing to connect, it links the install page', async () => {
    const step = await openStep({ listed: { repositories: [], truncated: false } });
    const link = await within(step).findByRole('link');
    expect(link).toHaveAttribute('href', hostedGithub.accessPage);
    const warning = link.closest('.v2-cx-warning');
    expect(warning).toHaveTextContent("On GitHub, choose 'Only select repositories'.");
    expect(warning).toHaveTextContent('Commonly Connect can reach every repository on the account or org you install it on');
  });

  it('warns beside the install link on the offer, and only for GitHub', async () => {
    mockTools({ entries: [hostedGithub, { ...linearEntry, accessPage: 'https://linear.example/access' }], grants: [], seats: { p1: [scout], p2: [] } });
    renderPage();
    const github = await openToolPopover('GitHub MCP');
    expect(within(github).getByRole('link', { name: 'Choose what GitHub MCP can reach' }).closest('.v2-cx-warning')).not.toBeNull();
    const linear = await openToolPopover('Linear');
    expect(within(linear).queryByText("On GitHub, choose 'Only select repositories'.")).toBeNull();
  });

  it('labels each row and names the picked repository, public or private', async () => {
    const step = await openStep({ listed: { repositories: repos, truncated: false } });
    const select = await within(step).findByLabelText('repository');
    expect(within(select).getByRole('option', { name: 'Outside-Team/Widget (private)' })).toHaveValue('Outside-Team/Widget');
    expect(within(select).getByRole('option', { name: 'Outside-Team/Gadget (public)' })).toHaveValue('Outside-Team/Gadget');
    expect(within(step).queryByRole('status')).toBeNull();
    fireEvent.change(select, { target: { value: 'Outside-Team/Gadget' } });
    expect(within(step).getByRole('status')).toHaveTextContent("You're connecting Outside-Team/Gadget, a public repository.");
    fireEvent.change(select, { target: { value: 'Outside-Team/Widget' } });
    expect(within(step).getByRole('status')).toHaveTextContent("You're connecting Outside-Team/Widget, a private repository.");
  });

  it('names the one repository it picked by itself', async () => {
    const step = await openStep({ listed: { repositories: [repos[1]], truncated: false } });
    expect(await within(step).findByText("You're connecting Outside-Team/Gadget, a public repository.")).toBeInTheDocument();
  });

  it('does not call a row public when the field is missing', async () => {
    const { private: _dropped, ...unmarked } = repos[1];
    const step = await openStep({ listed: { repositories: [unmarked], truncated: false } });
    expect(await within(step).findByText("You're connecting Outside-Team/Gadget, a private repository.")).toBeInTheDocument();
    expect(within(step).getByRole('option', { name: 'Outside-Team/Gadget (private)' })).toBeInTheDocument();
  });

  it('a member with a live grant can still connect another repository', async () => {
    const connected = { ...appEntry, connections: [{ connectionId: 'conn-1', owner: 'Team-Commonly', repo: 'commonly' }] };
    mockTools({ entries: [connected, hostedGithub], grants: [grantLive], seats: { p1: [scout], p2: [] } });
    renderPage();
    const drawer = await openTool('GitHub');
    expect(within(drawer).getByRole('button', { name: 'Connect a repository' })).toBeInTheDocument();
  });

  it('a read that lands after the step closed does not reopen it', async () => {
    let answer;
    const route = (url) => (url === ROUTE ? new Promise((resolve) => { answer = resolve; }) : undefined);
    mockTools({ entries: [appEntry, hostedGithub], grants: [], seats: { p1: [scout], p2: [] }, route });
    renderPage();
    const popover = await openToolPopover('GitHub MCP');
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect a repository' }));
    const step = await screen.findByRole('complementary', { name: 'Connect a repository' });
    fireEvent.click(within(step).getByRole('button', { name: 'Cancel' }));
    await act(async () => { answer({ data: { repositories: repos, truncated: false } }); });
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Connect a repository' })).toBeNull();
  });

  it('coming back from the GitHub sign-in reads the list again', async () => {
    const step = await openStep({ refused: 'github_connect_required' });
    await within(step).findByRole('button', { name: 'Connect GitHub' });
    const reads = () => axios.get.mock.calls.filter(([url]) => url === ROUTE).length;
    const before = reads();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it('says when the list may be incomplete', async () => {
    const step = await openStep({ listed: { repositories: repos, truncated: true } });
    expect(await within(step).findByText('This list may be incomplete.')).toBeInTheDocument();
  });

  it('a refused connect stays on the step and says why', async () => {
    const step = await openStep({ listed: { repositories: [repos[0]], truncated: false } });
    const connect = await within(step).findByRole('button', { name: 'Connect' });
    expect(connect).toBeEnabled();
    axios.post.mockRejectedValueOnce({ response: { data: { error: 'repository_write_required' } } });
    fireEvent.click(connect);
    expect(await within(step).findByRole('alert')).toHaveTextContent('You need write access to that repository to connect it.');
  });
});

describe('F214: pull-request access in the grant form', () => {
  const PR_TOOLS = ['github.create_pull_request', 'github.commit_files', 'github.push_branch'];
  const CHOICE = /open pull requests from their own branch/;
  const appEntry = {
    ...githubEntry,
    connectionType: 'github-app',
    tools: [
      { name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false },
      { name: 'github.create_issue', requiredWriteMode: 'write-with-confirm', irreversible: false },
      ...PR_TOOLS.map((name) => ({ name, requiredWriteMode: 'write-with-confirm', irreversible: false, prWrite: true })),
    ],
  };
  const openAdd = async (entries = [appEntry], seats = { p1: [scout], p2: [] }, route) => {
    mockTools({ entries, grants: [], seats, route });
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    renderPage();
    const popover = await openToolPopover('GitHub');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    return screen.findByRole('complementary', { name: 'Add GitHub' });
  };
  const mintBody = () => axios.post.mock.calls.find(([url]) => url === '/api/grants')[1];

  it('is off by default, and that mint carries no write', async () => {
    const form = await openAdd();
    expect(within(form).getByRole('checkbox', { name: CHOICE })).not.toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(mintBody()).toMatchObject({ writeMode: 'read', tools: ['github.list_issues'] });
    expect(mintBody()).not.toHaveProperty('prWrite');
  });

  it('mints the read tools and the PR tools, no other write, and says every one asks first', async () => {
    const form = await openAdd();
    fireEvent.click(within(form).getByRole('checkbox', { name: CHOICE }));
    expect(within(form).getByText('every commit, push and pull request asks you first')).toBeInTheDocument();
    PR_TOOLS.forEach((name) => expect(within(form).getByText(name)).toBeInTheDocument());
    expect(within(form).queryByText('github.create_issue')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(mintBody()).toMatchObject({
      writeMode: 'write-with-confirm', prWrite: true, tools: ['github.list_issues', ...PR_TOOLS],
    });
  });

  it('is not offered on a connection that is not a GitHub App', async () => {
    const form = await openAdd([{ ...appEntry, connectionType: 'hosted-mcp', entryId: 'github' }]);
    expect(within(form).queryByRole('checkbox', { name: CHOICE })).toBeNull();
  });

  it('adds the PR writes to an outside agent\'s consent, and ticking it clears an earlier consent', async () => {
    const claude = { name: 'claude-code', displayName: 'Claude', userId: 'b1' };
    const agents = [{ userId: 'b1', agentName: 'claude-code', instanceId: 'default', nameable: true, sandbox: 'confined' }];
    const route = (url) => (url === '/api/grants/byo-candidates' ? Promise.resolve({ data: { agents } }) : undefined);
    const form = await openAdd([appEntry], { p1: [scout, claude], p2: [] }, route);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/grants/byo-candidates', expect.objectContaining({ params: { podId: 'p1' } })));
    await settle();
    const consent = () => within(form).getByRole('checkbox', { name: /runs on your computer/ });
    const grant = within(form).getByRole('button', { name: 'Grant' });
    fireEvent.click(consent());
    expect(grant).toBeEnabled();

    fireEvent.click(within(form).getByRole('checkbox', { name: CHOICE }));
    expect(grant).toBeDisabled();
    expect(consent()).toHaveAccessibleName(expect.stringContaining('send commits and pull requests to this repository'));

    fireEvent.click(consent());
    fireEvent.click(grant);
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(mintBody()).toMatchObject({ writeMode: 'write-with-confirm', prWrite: true, byoAgents: ['b1'], byoConsent: true });
  });

  describe('on a grant that holds it', () => {
    const held = {
      ...grantLive, grantId: 'grant_pr', prWrite: true, connectionId: 'conn-1', tools: ['github.list_issues', ...PR_TOOLS],
    };

    it('the detail names it, and Change access keeps it', async () => {
      mockTools({ entries: [appEntry], grants: [held], seats: { p1: [scout], p2: [] }, trails: { grant_pr: { ...trail, grantId: 'grant_pr' } } });
      axios.post.mockResolvedValue({ data: { grantId: 'grant_new', revoked: 1 } });
      renderPage();
      const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
      expect(within(aside).getByText('read, plus pull requests you approve')).toBeInTheDocument();
      expect(within(aside).getByText('every commit, push and pull request asks you first')).toBeInTheDocument();

      fireEvent.click(within(aside).getByRole('button', { name: 'Change access' }));
      const form = await screen.findByRole('complementary', { name: 'Change access' });
      expect(within(form).getByRole('checkbox', { name: CHOICE })).toBeChecked();
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants/grant_pr/revoke', undefined, expect.anything()));
      expect(mintBody()).toMatchObject({ writeMode: 'write-with-confirm', prWrite: true });
    });

    const twoRepos = {
      ...appEntry,
      connections: [
        { connectionId: 'conn-a', owner: 'Team-Commonly', repo: 'a' },
        { connectionId: 'conn-b', owner: 'Team-Commonly', repo: 'b' },
      ],
    };
    const openChange = async (grant, entry = twoRepos) => {
      mockTools({ entries: [entry], grants: [grant], seats: { p1: [scout], p2: [] }, trails: { [grant.grantId]: { ...trail, grantId: grant.grantId } } });
      axios.post.mockResolvedValue({ data: { grantId: 'grant_new', revoked: 1 } });
      renderPage();
      const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
      fireEvent.click(within(aside).getByRole('button', { name: 'Change access' }));
      return { aside, form: await screen.findByRole('complementary', { name: 'Change access' }) };
    };
    const ENDS = 'This change ends pull-request access on this grant.';

    it('names it on the list row too', async () => {
      mockTools({ entries: [twoRepos], grants: [{ ...held, connectionId: 'conn-b' }], seats: { p1: [scout], p2: [] }, trails: { grant_pr: { ...trail, grantId: 'grant_pr' } } });
      renderPage();
      await openTool('GitHub');
      expect(await screen.findByRole('img', { name: 'read, plus pull requests you approve' })).toHaveAttribute('aria-label', 'read, plus pull requests you approve');
    });

    it('Change access stays on the grant\'s own repository', async () => {
      const { form } = await openChange({ ...held, connectionId: 'conn-b' });
      expect(within(form).getByRole('checkbox', { name: CHOICE })).toBeChecked();
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalled());
      expect(mintBody()).toMatchObject({ connectionId: 'conn-b', prWrite: true });
    });

    it('Change access never adds a PR tool the grant did not name', async () => {
      const narrow = { ...held, connectionId: 'conn-b', tools: ['github.create_pull_request', 'github.commit_files'] };
      const { form } = await openChange(narrow);
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalled());
      expect(mintBody().tools).toEqual(['github.list_issues', 'github.create_pull_request', 'github.commit_files']);
    });

    it.each([
      ['its connection is no longer offered', { connectionId: 'conn-gone' }],
      ['it is a child grant', { connectionId: 'conn-b', parentGrantId: 'grant_root', rootGrantId: 'grant_root' }],
    ])('says Change access ends it when %s, and mints a read grant', async (_, over) => {
      const { form } = await openChange({ ...held, ...over });
      expect(within(form).getByRole('checkbox', { name: CHOICE })).not.toBeChecked();
      expect(within(form).getByText(ENDS)).toBeInTheDocument();
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalled());
      expect(mintBody()).toMatchObject({ writeMode: 'read', tools: ['github.list_issues'] });
      expect(mintBody()).not.toHaveProperty('prWrite');
    });

    it('an ended grant opens without it and says nothing is ending', async () => {
      const ended = { ...held, connectionId: 'conn-b', revokedAt: iso(-1000), revokedBy: 'u1' };
      mockTools({ entries: [twoRepos], grants: [ended], seats: { p1: [scout], p2: [] }, trails: { grant_pr: { ...trail, grantId: 'grant_pr' } } });
      renderPage();
      const drawer = await openTool('GitHub');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
      const form = await screen.findByRole('complementary', { name: 'Add GitHub' });
      expect(within(form).getByRole('checkbox', { name: CHOICE })).not.toBeChecked();
      expect(within(form).queryByText(ENDS)).toBeNull();
    });
  });

  it('is not offered when the catalogue does not hold the tool that opens the pull request', async () => {
    const form = await openAdd([{ ...appEntry, tools: appEntry.tools.filter((tool) => tool.name !== 'github.create_pull_request') }]);
    expect(within(form).queryByRole('checkbox', { name: CHOICE })).toBeNull();
  });

  it('unticking it sends no PR tool and no prWrite', async () => {
    const form = await openAdd();
    const box = within(form).getByRole('checkbox', { name: CHOICE });
    fireEvent.click(box);
    fireEvent.click(box);
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(mintBody()).toMatchObject({ writeMode: 'read', tools: ['github.list_issues'] });
    expect(mintBody()).not.toHaveProperty('prWrite');
  });

  it('a consent for one repository does not carry to another', async () => {
    const twoRepos = {
      ...appEntry,
      connections: [
        { connectionId: 'conn-a', owner: 'Team-Commonly', repo: 'a' },
        { connectionId: 'conn-b', owner: 'Team-Commonly', repo: 'b' },
      ],
    };
    const claude = { name: 'claude-code', displayName: 'Claude', userId: 'b1' };
    const agents = [{ userId: 'b1', agentName: 'claude-code', instanceId: 'default', nameable: true, sandbox: 'confined' }];
    const route = (url) => (url === '/api/grants/byo-candidates' ? Promise.resolve({ data: { agents } }) : undefined);
    const form = await openAdd([twoRepos], { p1: [scout, claude], p2: [] }, route);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/grants/byo-candidates', expect.objectContaining({ params: { podId: 'p1' } })));
    await settle();
    const grant = within(form).getByRole('button', { name: 'Grant' });
    fireEvent.click(within(form).getByRole('checkbox', { name: CHOICE }));
    fireEvent.click(within(form).getByRole('checkbox', { name: /runs on your computer/ }));
    expect(grant).toBeEnabled();
    fireEvent.change(within(form).getByLabelText('connection'), { target: { value: 'conn-b' } });
    expect(grant).toBeDisabled();
  });
});

describe('F94: naming your own agent that runs outside Commonly', () => {
  const claude = { name: 'claude-code', displayName: 'Claude', userId: 'b1' };
  const candidate = (over = {}) => ({ userId: 'b1', agentName: 'claude-code', instanceId: 'default', nameable: true, sandbox: 'confined', ...over });
  const byoRoute = (agents) => (url) => (url === '/api/grants/byo-candidates' ? Promise.resolve({ data: { agents } }) : undefined);
  const openAdd = async (agents, seats = { p1: [scout, claude], p2: [] }) => {
    mockTools({ grants: [], seats, route: byoRoute(agents) });
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    renderPage();
    const popover = await openToolPopover('GitHub');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add GitHub' });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/grants/byo-candidates', expect.objectContaining({ params: { podId: 'p1' } })));
    await settle();
    return form;
  };
  const NOTICE = 'Anything it reads through this grant can leave through it, and text it reads can be written by other people and tell it what to do.';
  const consentBox = (form) => within(form).getByRole('checkbox', { name: new RegExp(NOTICE) });

  it('a confined agent is disclosed without "with no sandbox"', async () => {
    const form = await openAdd([candidate({ sandbox: 'confined' })]);
    expect(consentBox(form)).toHaveAccessibleName(`Claude runs on your computer, outside Commonly. ${NOTICE}`);
  });

  it('an unconfined agent is disclosed "with no sandbox"', async () => {
    const form = await openAdd([candidate({ sandbox: 'unconfined' })]);
    expect(consentBox(form)).toHaveAccessibleName(`Claude runs on your computer, outside Commonly, with no sandbox. ${NOTICE}`);
  });

  it('an agent whose sandbox is unknown reads as having none', async () => {
    const form = await openAdd([candidate({ sandbox: 'unknown' })]);
    expect(consentBox(form)).toHaveAccessibleName(`Claude runs on your computer, outside Commonly, with no sandbox. ${NOTICE}`);
  });

  it('Grant waits for the consent, and the mint names the agent read-only', async () => {
    const form = await openAdd([candidate()]);
    const grant = within(form).getByRole('button', { name: 'Grant' });
    expect(grant).toBeDisabled();
    fireEvent.click(consentBox(form));
    expect(grant).toBeEnabled();
    fireEvent.click(grant);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({
      writeMode: 'read', audience: ['a1', 'b1'], byoAgents: ['b1'], byoConsent: true,
    }), expect.anything()));
  });

  it('without a checked agent of yours, the mint carries no naming and no consent shows', async () => {
    const form = await openAdd([candidate()]);
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Claude' }));
    expect(within(form).queryByRole('checkbox', { name: new RegExp(NOTICE) })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    const body = axios.post.mock.calls.find(([url]) => url === '/api/grants')[1];
    expect(body).not.toHaveProperty('byoAgents');
    expect(body).not.toHaveProperty('byoConsent');
  });

  it('read is the only mode with an agent of yours checked or unchecked', async () => {
    const form = await openAdd([candidate()]);
    const modes = () => within(within(form).getByRole('group', { name: 'what it may do' })).getAllByRole('button');
    expect(modes().map((button) => button.textContent)).toEqual(['read']);
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Claude' }));
    expect(modes().map((button) => button.textContent)).toEqual(['read']);
  });

  it('a consent covers only the agents it was ticked for', async () => {
    const codex = { name: 'codex', displayName: 'Codex', userId: 'b2' };
    const form = await openAdd(
      [candidate(), candidate({ userId: 'b2', agentName: 'codex' })],
      { p1: [scout, claude, codex], p2: [] },
    );
    const grant = within(form).getByRole('button', { name: 'Grant' });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Codex' }));
    fireEvent.click(consentBox(form));
    expect(grant).toBeEnabled();
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Codex' }));
    expect(grant).toBeDisabled();
  });

  it('a child grant shows its named agents without Remove, which only the grant they were named on can do', async () => {
    const child = {
      ...grantLive, parentGrantId: 'grant_root', writeMode: 'read', tools: ['github.list_issues'], effectiveAudience: ['a1', 'b1'],
      byoAgents: ['b1'],
      byoConsent: { by: 'u1', at: iso(-3600000), version: 'byo-v1', agents: [{ userId: 'b1', sandbox: 'unconfined' }] },
    };
    mockTools({ grants: [child], seats: { p1: [scout, claude], p2: [] } });
    renderPage();
    const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(within(aside).getByText('Claude runs outside Commonly, with no sandbox')).toBeInTheDocument();
    expect(within(aside).queryByRole('button', { name: 'Remove Claude from this grant' })).toBeNull();
  });

  it('an agent no grant can name is offered disabled with its reason, and never submitted', async () => {
    const form = await openAdd([candidate({ nameable: false, reason: 'unconfined_host', sandbox: 'unconfined' })]);
    const box = within(form).getByRole('checkbox', { name: 'Claude' });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(within(form).getByText('Ran without a sandbox Commonly can enforce, so no grant can be used.')).toBeInTheDocument();
    expect(within(form).queryByRole('checkbox', { name: new RegExp(NOTICE) })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants', expect.objectContaining({ audience: ['a1'] }), expect.anything()));
  });

  // F175a: a harness that can't hold a grant names the ones that can.
  it('an agent on a harness with no sandbox is offered disabled, naming the harnesses that can', async () => {
    const form = await openAdd([candidate({ nameable: false, reason: 'adapter_unsupported', sandbox: 'unknown' })]);
    expect(within(form).getByRole('checkbox', { name: 'Claude' })).toBeDisabled();
    expect(within(form).getByText('Connectors need a sandboxed harness: only Claude Code, Codex or OpenCode agents can be named.'))
      .toBeInTheDocument();
  });

  it('a mint refused for its harness reads in the page\'s words, naming the full set', async () => {
    const form = await openAdd([candidate()]);
    axios.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'byo_adapter_unsupported', message: 'raw' } } });
    fireEvent.click(consentBox(form));
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(await within(form).findByText('Only a Claude Code, Codex or OpenCode agent can be named on a grant.')).toBeInTheDocument();
  });

  it('an agent the roster hides still appears so it can be named', async () => {
    const form = await openAdd([candidate()], { p1: [scout], p2: [] });
    expect(within(form).getByRole('checkbox', { name: 'claude-code' })).toBeInTheDocument();
  });

  it('a consent refusal reads in the page\'s words', async () => {
    const form = await openAdd([candidate()]);
    axios.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'byo_consent_required', message: 'raw' } } });
    fireEvent.click(consentBox(form));
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(await within(form).findByText('Tick the box to confirm that what this agent reads can leave through it.')).toBeInTheDocument();
  });

  it('a grant lists its named agents with their sandbox state, and Remove takes one off', async () => {
    const named = {
      ...grantLive, writeMode: 'read', tools: ['github.list_issues'], effectiveAudience: ['a1', 'b1'],
      byoAgents: ['b1'],
      byoConsent: { by: 'u1', at: iso(-3600000), version: 'byo-v1', agents: [{ userId: 'b1', sandbox: 'unconfined' }] },
    };
    mockTools({ grants: [named], seats: { p1: [scout, claude], p2: [] } });
    axios.delete.mockResolvedValue({ data: { ...named, byoAgents: [] } });
    renderPage();
    const { aside } = await openRow('GitHub', 'View GitHub in Launch pod');
    expect(within(aside).getByText('Claude runs outside Commonly, with no sandbox')).toBeInTheDocument();
    expect(within(aside).getByText('While an agent is still in this Pod, removing it pauses the whole grant. Take the agent out of the Pod to resume it.')).toBeInTheDocument();
    const before = grantReads().length;
    fireEvent.click(within(aside).getByRole('button', { name: 'Remove Claude from this grant' }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/grants/grant_live/byo-agents/b1', expect.any(Object)));
    await waitFor(() => expect(grantReads().length).toBeGreaterThan(before));
  });
});

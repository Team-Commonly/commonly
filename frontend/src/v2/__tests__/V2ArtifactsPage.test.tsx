// @ts-nocheck
// Artifacts, d215 #s-artifacts-signal: one group per pod, a type badge, name, "<agent> · <when>",
// a trailing size and hover keys; one kind segment and one pod select in the head.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../i18n';
import V2ArtifactsPage, { extOf, formatSize, whenLabel, groupByPod } from '../components/V2ArtifactsPage';

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { baseURL: '', headers: { common: {} } }, interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});
const mockSigned = jest.fn(async (p) => `${p}?t=signed`);
jest.mock('../../utils/signedAttachmentUrl', () => ({ getSignedAttachmentUrl: (...args) => mockSigned(...args) }));

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const items = [
  { id: 'a1', fileName: 'x1.html', name: 'workspace-at-scale.html', contentType: 'text/html', kind: 'page', size: 5120, podId: 'p1', podName: 'Sharpen — pod model', sharedBy: { id: 'u1', username: 'lily-shen', displayName: null }, createdAt: minutesAgo(20) },
  { id: 'a3', fileName: 'x3.md', name: 'plan.md', contentType: 'text/markdown', kind: 'doc', size: 4096, podId: 'p2', podName: 'Connectors v2 — channel routing', sharedBy: { id: 'b2', username: 'kai', displayName: 'Kai' }, createdAt: minutesAgo(60) },
  { id: 'a2', fileName: 'x2.png', name: 'walk-1440.png', contentType: 'image/png', kind: 'image', size: 421888, podId: 'p1', podName: 'Sharpen — pod model', sharedBy: { id: 'b1', username: 'ux-lead', displayName: 'UX Lead' }, createdAt: minutesAgo(90) },
];

const setPhone = (phone) => {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: phone && query.includes('max-width'), media: query, addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(),
  }));
};

const renderPage = (initial = '/v2/artifacts', over = {}) => {
  axios.get.mockImplementation((url, config) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Sharpen — pod model' }, { _id: 'p2', name: 'Connectors v2 — channel routing' }, { _id: 'p3', name: 'YC S27 prep' }] });
    if (url === '/api/artifacts') {
      const params = config?.params || {};
      let list = over.items || items;
      if (params.podId) list = list.filter((i) => i.podId === params.podId);
      if (params.kind) list = list.filter((i) => i.kind === params.kind);
      if (params.q) list = list.filter((i) => i.name.toLowerCase().includes(String(params.q).toLowerCase()));
      if (params.after === 'cur-1') return Promise.resolve({ data: { items: [{ ...items[1], id: 'a4', name: 'skydeck-b23.pdf', kind: 'doc' }], nextCursor: null, total: 4, limit: 50 } });
      return Promise.resolve({ data: { items: list, nextCursor: over.nextCursor ?? null, total: over.total ?? list.length, limit: 50 } });
    }
    return Promise.resolve({ data: {} });
  });
  return render(<MemoryRouter initialEntries={[initial]}><V2ArtifactsPage /></MemoryRouter>);
};

const groupNamed = (name) => screen.getByRole('region', { name });
const rowOf = (fileName) => screen.getByRole('button', { name: fileName }).closest('li');

describe('V2ArtifactsPage (d215 signal)', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => { jest.clearAllMocks(); setPhone(false); });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  test('helpers: the badge is the file’s own extension, size and when use the shared vocabulary', () => {
    expect(extOf('plan.md')).toBe('MD');
    expect(extOf('archive.tar.gz')).toBe('GZ');
    expect(extOf('noext')).toBe('FILE');
    expect(formatSize(421888)).toBe('412 KB');
    expect(formatSize(2.1 * 1024 * 1024)).toBe('2.1 MB');
    expect(formatSize(null)).toBe('—');
    expect(whenLabel(minutesAgo(41))).toBe('41m');
    expect(whenLabel(minutesAgo(60 * 24 * 40))).toBe('1mo');
  });

  test('whenLabel reads in Chinese under zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      expect(whenLabel(minutesAgo(41))).not.toBe('41m');
      expect(whenLabel(minutesAgo(41))).toMatch(/41/);
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  test('groupByPod: one group per pod, first-seen order, rows newest first inside each', () => {
    const groups = groupByPod(items);
    expect(groups.map((g) => g.name)).toEqual(['Sharpen', 'Connectors v2']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(groupByPod([{ ...items[0], podId: null, podName: null }])[0].name).toBe('—');
  });

  test('busy: head count, one group per pod, each row a badge, the name, "<agent> · <when>" and a trailing size', async () => {
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Artifacts' })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'workspace-at-scale.html' });
    // No (i) hint in the redraw; the count says files and, with every file loaded, pods.
    expect(screen.queryByText('every file and page shared in your pods')).not.toBeInTheDocument();
    expect(container.querySelector('.v2a-meta')).toHaveTextContent('3 files · 2 pods');
    // No table chrome.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Sharpen', 'Connectors v2']);
    const sharpen = within(groupNamed('Sharpen'));
    expect(sharpen.getAllByRole('listitem')).toHaveLength(2);
    const first = within(rowOf('workspace-at-scale.html'));
    expect(first.getByText('HTML')).toBeInTheDocument();
    expect(first.getByText(/lily-shen · 20m/)).toBeInTheDocument();
    // A page has no size.
    expect(first.getByText('—')).toBeInTheDocument();
    const second = within(rowOf('walk-1440.png'));
    expect(second.getByText('PNG')).toBeInTheDocument();
    expect(second.getByText(/UX Lead · 1h/)).toBeInTheDocument();
    expect(second.getByText('412 KB')).toBeInTheDocument();
    expect(second.getByRole('button', { name: 'Open walk-1440.png' })).toBeInTheDocument();
    expect(second.getByRole('button', { name: 'Download walk-1440.png' })).toBeInTheDocument();
    expect(within(groupNamed('Connectors v2')).getByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(screen.getByText('3 of 3 · newest first')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: { limit: 50 } }));
    // One segment, one select, one search.
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Pod' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
  });

  test('a CJK name shows as stored, in the row, the lightbox and the key labels', async () => {
    const cjk = { ...items[2], id: 'c1', name: '季度报告.png' };
    renderPage('/v2/artifacts', { items: [cjk] });
    const name = await screen.findByRole('button', { name: '季度报告.png' });
    expect(name).toHaveTextContent('季度报告.png');
    expect(screen.getByRole('button', { name: 'Download 季度报告.png' })).toBeInTheDocument();
    fireEvent.click(name);
    expect(await screen.findByRole('dialog')).toHaveTextContent('季度报告.png');
  });

  test('the pod count waits until every file is loaded', async () => {
    const { container } = renderPage('/v2/artifacts', { nextCursor: 'cur-1', total: 4 });
    await screen.findByText('3 of 4 · newest first');
    expect(container.querySelector('.v2a-meta')).toHaveTextContent(/^4 files$/);
    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    await screen.findByText('4 of 4 · newest first');
    expect(container.querySelector('.v2a-meta')).toHaveTextContent('4 files · 2 pods');
  });

  test('kind, pod and search filters travel through the URL to the one query', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'workspace-at-scale.html' });
    fireEvent.click(screen.getByRole('radio', { name: 'Images' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ kind: 'image' }) })));
    expect(await screen.findByRole('button', { name: 'walk-1440.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'plan.md' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Images' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    const pod = screen.getByRole('combobox', { name: 'Pod' });
    // Every pod is in the select, by its short name, after All pods.
    expect(within(pod).getAllByRole('option').map((o) => o.textContent)).toEqual(['All pods', 'Sharpen', 'Connectors v2', 'YC S27 prep']);
    fireEvent.change(pod, { target: { value: 'p2' } });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ podId: 'p2' }) })));
    expect(await screen.findByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    // A chosen pod leaves one group.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Connectors v2']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Pod' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'walk' } });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ q: 'walk' }) })));
    expect(await screen.findByRole('button', { name: 'walk-1440.png' })).toBeInTheDocument();
  });

  test('a podId in the URL (the inspector’s All N files link) scopes the first read and shows in the select', async () => {
    renderPage('/v2/artifacts?podId=p2');
    expect(await screen.findByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ podId: 'p2' }) }));
    expect(screen.queryByRole('button', { name: 'walk-1440.png' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Pod' })).toHaveValue('p2'));
  });

  test('pages by cursor from the foot and opens a file through a signed URL, from the name or the open key', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderPage('/v2/artifacts', { nextCursor: 'cur-1', total: 4 });
    await screen.findByText('3 of 4 · newest first');
    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    expect(await screen.findByRole('button', { name: 'skydeck-b23.pdf' })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ after: 'cur-1' }) }));
    expect(screen.getByText('4 of 4 · newest first')).toBeInTheDocument();
    // The second page lands in the group it belongs to, not a new one.
    expect(within(groupNamed('Connectors v2')).getByRole('button', { name: 'skydeck-b23.pdf' })).toBeInTheDocument();
    // A doc opens in a new tab through a signed URL; an image opens the chat lightbox.
    fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    await waitFor(() => expect(mockSigned).toHaveBeenCalledWith('/api/uploads/x3.md'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/api/uploads/x3.md?t=signed', '_blank', 'noopener'));
    fireEvent.click(screen.getByRole('button', { name: 'Open plan.md' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'walk-1440.png' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  test('download saves the bytes from the signed URL under the file’s own name', async () => {
    const blob = new Blob(['x']);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    URL.createObjectURL = jest.fn(() => 'blob:artifact');
    URL.revokeObjectURL = jest.fn();
    const clicked = [];
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { clicked.push({ href: this.href, download: this.download }); });
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Download plan.md' }));
    await waitFor(() => expect(clicked).toEqual([{ href: 'blob:artifact', download: 'plan.md' }]));
    expect(mockSigned).toHaveBeenCalledWith('/api/uploads/x3.md');
    expect(global.fetch).toHaveBeenCalledWith('/api/uploads/x3.md?t=signed', { method: 'GET' });
    // Download is a read: every request it makes is a GET.
    expect(global.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(open).not.toHaveBeenCalled();
    // When the bytes can't be read, the signed URL opens and the server decides.
    global.fetch = jest.fn().mockRejectedValue(new TypeError('cors'));
    fireEvent.click(screen.getByRole('button', { name: 'Download walk-1440.png' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/api/uploads/x2.png?t=signed', '_blank', 'noopener'));
    click.mockRestore(); open.mockRestore(); delete global.fetch;
  });

  test('390: the search is the top bar key, kind and pod share the control row, the size folds into the line, ↓ is the one key', async () => {
    setPhone(true);
    renderPage();
    await screen.findByRole('button', { name: 'walk-1440.png' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    const key = screen.getByRole('button', { name: 'Search files' });
    expect(key).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(key);
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
    expect(key).toHaveAttribute('aria-expanded', 'true');
    const row = within(rowOf('walk-1440.png'));
    expect(row.getByText('412 KB').closest('.v2a-sn')).not.toBeNull();
    expect(row.queryByRole('button', { name: 'Open walk-1440.png' })).not.toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Download walk-1440.png' })).toBeInTheDocument();
    // A page has no size, so its line stops at the time.
    expect(within(rowOf('workspace-at-scale.html')).queryByText('—')).not.toBeInTheDocument();
    expect(document.querySelector('.v2a-ctl')).toContainElement(screen.getByRole('radiogroup', { name: 'Kind' }));
    expect(document.querySelector('.v2a-ctl')).toContainElement(screen.getByRole('combobox', { name: 'Pod' }));
  });

  test('390: a search in the URL keeps the field open', async () => {
    setPhone(true);
    renderPage('/v2/artifacts?q=walk');
    expect(await screen.findByRole('searchbox', { name: 'Search files' })).toHaveValue('walk');
  });

  // Day zero: nothing shared and no filter set → no controls, no count, one quiet row.
  const renderEmpty = (initial, { pods = [] } = {}) => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') return Promise.resolve({ data: pods });
      if (url === '/api/artifacts') return Promise.resolve({ data: { items: [], nextCursor: null, total: 0, limit: 50 } });
      return Promise.resolve({ data: {} });
    });
    return render(<MemoryRouter initialEntries={[initial]}><V2ArtifactsPage /></MemoryRouter>);
  };
  const workspace = { _id: 'w1', name: 'My Workspace', createdAt: '2026-10-01T00:00:00.000Z' };

  test.each([[false], [true]])('day zero (phone %s): no controls and no count; one row whose key opens My Workspace', async (phone) => {
    setPhone(phone);
    const { container } = renderEmpty('/v2/artifacts', { pods: [workspace] });
    expect(await screen.findByText('Files you and your agents share in a pod land here.')).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: 'Open My Workspace' });
    expect(open).toHaveAttribute('href', '/v2/pods/w1');
    expect(open).toHaveClass('v2a-open');
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Kind' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Pod' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search files' })).not.toBeInTheDocument();
    expect(container.querySelector('.v2a-meta')).toBeNull();
    expect(container.querySelector(phone ? '.v2a-row--open' : '.v2a-row--one')).not.toBeNull();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  test('day zero opens the oldest pod, the one signup creates, whatever order /api/pods lists', async () => {
    const team = { _id: 'p2', name: 'Launch room', createdAt: '2026-10-05T00:00:00.000Z' };
    const later = { _id: 'p3', name: 'Field notes', createdAt: '2026-10-09T00:00:00.000Z' };
    // /api/pods lists by last update, newest first.
    renderEmpty('/v2/artifacts', { pods: [later, team, workspace] });
    expect(await screen.findByRole('link', { name: 'Open My Workspace' })).toHaveAttribute('href', '/v2/pods/w1');
    // No extra lookups: the choice is made from /api/pods alone.
    expect(axios.get.mock.calls.map(([url]) => url).sort()).toEqual(['/api/artifacts', '/api/pods']);
  });

  test('clearing a filter on a busy account never shows day zero or drops the controls', async () => {
    // YC S27 prep holds nothing, so ?podId=p3 is a filtered empty result on an account with files.
    const { container } = renderPage('/v2/artifacts?podId=p3');
    expect(await screen.findByText('Nothing matches. Clear a filter or the search.')).toBeInTheDocument();
    const seen = [];
    const observer = new MutationObserver((records) => records.forEach((record) => {
      record.addedNodes.forEach((node) => { if (node.classList) seen.push(`add:${node.className}`); });
      record.removedNodes.forEach((node) => { if (node.classList) seen.push(`rm:${node.className}`); });
    }));
    observer.observe(container, { childList: true, subtree: true });
    const pod = screen.getByRole('combobox', { name: 'Pod' });
    pod.focus();
    fireEvent.change(pod, { target: { value: '' } });
    await screen.findByRole('button', { name: 'workspace-at-scale.html' });
    observer.disconnect();
    expect(seen.filter((entry) => /v2a-(row--one|row--open|sel|search|seg)\b/.test(entry))).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Pod' }));
  });

  test('day zero with no pods keeps the row and omits the key', async () => {
    renderEmpty('/v2/artifacts');
    expect(await screen.findByText('Files you and your agents share in a pod land here.')).toBeInTheDocument();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/pods', expect.anything()));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('a filtered empty result keeps the controls, the count and one row, not day zero', async () => {
    const { container } = renderEmpty('/v2/artifacts?kind=image', { pods: [workspace] });
    expect(await screen.findByText('Nothing matches. Clear a filter or the search.')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Images' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
    expect(container.querySelector('.v2a-meta')).toHaveTextContent('0 files · 0 pods');
    expect(screen.queryByText('Files you and your agents share in a pod land here.')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Open / })).not.toBeInTheDocument();
  });

  test('a load failure is one alert row, never day zero', async () => {
    axios.get.mockImplementation((url) => (url === '/api/artifacts' ? Promise.reject(new Error('500')) : Promise.resolve({ data: [] })));
    render(<MemoryRouter initialEntries={['/v2/artifacts']}><V2ArtifactsPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load artifacts.');
    expect(screen.queryByText('Files you and your agents share in a pod land here.')).not.toBeInTheDocument();
  });

  test('typing a search before the first empty answer lands keeps the search box and focus', async () => {
    let answer;
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') return Promise.resolve({ data: [workspace] });
      if (url === '/api/artifacts') return new Promise((resolve) => { answer = resolve; });
      return Promise.resolve({ data: {} });
    });
    render(<MemoryRouter initialEntries={['/v2/artifacts']}><V2ArtifactsPage /></MemoryRouter>);
    const search = screen.getByRole('searchbox', { name: 'Search files' });
    search.focus();
    fireEvent.change(search, { target: { value: 'pl' } });
    // The unfiltered answer lands inside the 250ms debounce, before ?q reaches the URL.
    await act(async () => { answer({ data: { items: [], nextCursor: null, total: 0, limit: 50 } }); });
    expect(screen.queryByText('Files you and your agents share in a pod land here.')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBe(search);
    expect(document.activeElement).toBe(search);
  });

  test.each([
    ['a search', '/v2/artifacts?q=unmatched'],
    ['a pod', '/v2/artifacts?podId=w1'],
  ])('%s with no matches keeps the controls and the filtered line, never day zero', async (_label, url) => {
    renderEmpty(url, { pods: [workspace] });
    expect(await screen.findByText('Nothing matches. Clear a filter or the search.')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.queryByText('Files you and your agents share in a pod land here.')).not.toBeInTheDocument();
  });
});

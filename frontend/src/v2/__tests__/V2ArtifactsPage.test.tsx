// @ts-nocheck
// Artifacts, direction C (ScaleArtifacts.dc.html) — PR 5.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import V2ArtifactsPage, { extOf, formatSize, whenLabel } from '../components/V2ArtifactsPage';

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { baseURL: '', headers: { common: {} } }, interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});
const mockSigned = jest.fn(async (p) => `${p}?t=signed`);
jest.mock('../../utils/signedAttachmentUrl', () => ({ getSignedAttachmentUrl: (...args) => mockSigned(...args) }));

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const items = [
  { id: 'a1', fileName: 'x1.html', name: 'workspace-at-scale.html', contentType: 'text/html', kind: 'page', size: 5120, podId: 'p1', podName: 'Sharpen — pod model', sharedBy: { id: 'u1', username: 'lily-shen', displayName: null }, createdAt: minutesAgo(20) },
  { id: 'a2', fileName: 'x2.png', name: 'walk-1440.png', contentType: 'image/png', kind: 'image', size: 421888, podId: 'p1', podName: 'Sharpen — pod model', sharedBy: { id: 'b1', username: 'ux-lead', displayName: 'UX Lead' }, createdAt: minutesAgo(90) },
  { id: 'a3', fileName: 'x3.md', name: 'plan.md', contentType: 'text/markdown', kind: 'doc', size: 4096, podId: 'p2', podName: 'Connectors v2 — channel routing', sharedBy: { id: 'b2', username: 'kai', displayName: 'Kai' }, createdAt: minutesAgo(60 * 26) },
];

const renderPage = (initial = '/v2/artifacts', over = {}) => {
  axios.get.mockImplementation((url, config) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Sharpen — pod model' }, { _id: 'p2', name: 'Connectors v2 — channel routing' }, { _id: 'p3', name: 'YC S27 prep' }] });
    if (url === '/api/artifacts') {
      const params = config?.params || {};
      let list = items;
      if (params.podId) list = list.filter((i) => i.podId === params.podId);
      if (params.kind) list = list.filter((i) => i.kind === params.kind);
      if (params.q) list = list.filter((i) => i.name.toLowerCase().includes(String(params.q).toLowerCase()));
      if (params.after === 'cur-1') return Promise.resolve({ data: { items: [{ ...items[2], id: 'a4', name: 'skydeck-b23.pdf', kind: 'doc' }], nextCursor: null, total: 4, limit: 50 } });
      return Promise.resolve({ data: { items: list, nextCursor: over.nextCursor ?? null, total: over.total ?? list.length, limit: 50 } });
    }
    return Promise.resolve({ data: {} });
  });
  return render(<MemoryRouter initialEntries={[initial]}><V2ArtifactsPage /></MemoryRouter>);
};

describe('V2ArtifactsPage (direction C, PR 5)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('helpers: ext chip is the file’s own extension, size and when use the shared vocabulary', () => {
    expect(extOf('plan.md')).toBe('MD');
    expect(extOf('archive.tar.gz')).toBe('GZ');
    expect(extOf('noext')).toBe('FILE');
    expect(formatSize(421888)).toBe('412 KB');
    expect(formatSize(2.1 * 1024 * 1024)).toBe('2.1 MB');
    expect(formatSize(null)).toBe('—');
    expect(whenLabel(minutesAgo(41))).toBe('41m');
    expect(whenLabel(minutesAgo(60 * 24 * 40))).toBe('1mo');
  });

  test('renders the board: display head, three columns of meta, ext chips, short pod names, shared-by labels, newest first, foot count', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByText('every file and page shared in your pods')).toBeInTheDocument();
    const rows = await screen.findAllByRole('row');
    // header + 3
    expect(rows).toHaveLength(4);
    const first = within(rows[1]);
    expect(first.getByText('HTML')).toBeInTheDocument();
    expect(first.getByRole('button', { name: 'workspace-at-scale.html' })).toBeInTheDocument();
    expect(first.getByText('page')).toBeInTheDocument();
    // The pod cell plus the ≤760 pod line under the name (hidden by CSS on desktop).
    expect(first.getAllByText('Sharpen')).toHaveLength(2);
    expect(first.getByText('lily-shen')).toBeInTheDocument();
    expect(first.getByText('20m')).toBeInTheDocument();
    // A page has no size on the board.
    expect(first.getAllByText('—').length).toBe(1);
    const second = within(rows[2]);
    expect(second.getByText('PNG')).toBeInTheDocument();
    expect(second.getByText('UX Lead')).toBeInTheDocument();
    expect(second.getByText('412 KB')).toBeInTheDocument();
    expect(within(rows[3]).getAllByText('Connectors v2').length).toBeGreaterThan(0);
    expect(screen.getByText('3 of 3 · newest first')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: { limit: 50 } }));
    // Busy is unchanged: the controls and the count stay; no day-zero card.
    expect(screen.getByRole('group', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nothing shared yet' })).not.toBeInTheDocument();
  });

  test('kind, pod and search filters travel through the URL to the one query', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'workspace-at-scale.html' });
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ kind: 'image' }) })));
    expect(await screen.findByRole('button', { name: 'walk-1440.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'plan.md' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connectors v2' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ podId: 'p2' }) })));
    expect(await screen.findByRole('button', { name: 'plan.md' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All pods' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'walk' } });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ q: 'walk' }) })));
    expect(await screen.findByRole('button', { name: 'walk-1440.png' })).toBeInTheDocument();
  });

  test('a podId in the URL (the inspector’s All N files link) scopes the first read', async () => {
    renderPage('/v2/artifacts?podId=p2');
    expect(await screen.findByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ podId: 'p2' }) }));
    expect(screen.queryByRole('button', { name: 'walk-1440.png' })).not.toBeInTheDocument();
  });

  test('pages by cursor from the foot and opens a file through a signed URL', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderPage('/v2/artifacts', { nextCursor: 'cur-1', total: 4 });
    await screen.findByText('3 of 4 · newest first');
    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    expect(await screen.findByRole('button', { name: 'skydeck-b23.pdf' })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ params: expect.objectContaining({ after: 'cur-1' }) }));
    expect(screen.getByText('4 of 4 · newest first')).toBeInTheDocument();
    // A doc opens in a new tab through a signed URL; an image opens the chat lightbox.
    fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    await waitFor(() => expect(mockSigned).toHaveBeenCalledWith('/api/uploads/x3.md'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/api/uploads/x3.md?t=signed', '_blank', 'noopener'));
    fireEvent.click(screen.getByRole('button', { name: 'walk-1440.png' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  // Day zero (d215 s-artifacts): nothing shared and no filter set → no controls, no count, one card.
  const renderEmpty = (initial, { pods = [] } = {}) => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') return Promise.resolve({ data: pods });
      if (url === '/api/artifacts') return Promise.resolve({ data: { items: [], nextCursor: null, total: 0, limit: 50 } });
      return Promise.resolve({ data: {} });
    });
    return render(<MemoryRouter initialEntries={[initial]}><V2ArtifactsPage /></MemoryRouter>);
  };
  const workspace = { _id: 'w1', name: 'My Workspace', createdAt: '2026-10-01T00:00:00.000Z' };

  test('day zero: no kind, pod or search controls and no count; one card whose key opens My Workspace', async () => {
    const { container } = renderEmpty('/v2/artifacts', { pods: [workspace] });
    expect(await screen.findByRole('heading', { name: 'Nothing shared yet' })).toBeInTheDocument();
    expect(screen.getByText('Files you and your agents share in a pod land here: docs, images and pages.')).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: 'Open My Workspace' });
    expect(open).toHaveAttribute('href', '/v2/pods/w1');
    expect(open).toHaveClass('v2-artifacts__open');
    expect(screen.queryByRole('group', { name: 'Kind' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Pod' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(container.querySelector('.v2-artifacts__controls')).toBeNull();
    expect(container.querySelector('.v2-page-head__meta')).toBeNull();
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
    const all = within(screen.getByRole('group', { name: 'Pod' })).getByRole('button', { name: 'All pods' });
    all.focus();
    fireEvent.click(all);
    await screen.findByRole('button', { name: 'workspace-at-scale.html' });
    observer.disconnect();
    expect(seen.filter((entry) => /v2-artifacts__(zero|controls)/.test(entry))).toEqual([]);
    expect(document.activeElement).toBe(within(screen.getByRole('group', { name: 'Pod' })).getByRole('button', { name: 'All pods' }));
  });

  test('day zero with no pods keeps the card and omits the key', async () => {
    renderEmpty('/v2/artifacts');
    expect(await screen.findByRole('heading', { name: 'Nothing shared yet' })).toBeInTheDocument();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/pods', expect.anything()));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('a filtered empty result keeps the controls, the count and the dashed line, not the card', async () => {
    const { container } = renderEmpty('/v2/artifacts?kind=image', { pods: [workspace] });
    expect(await screen.findByText('Nothing matches. Clear a filter or the search.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Images' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
    expect(container.querySelector('.v2-page-head__meta')).toHaveTextContent('0');
    expect(screen.queryByRole('heading', { name: 'Nothing shared yet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Open / })).not.toBeInTheDocument();
  });

  test.each([
    ['a search', '/v2/artifacts?q=unmatched'],
    ['a pod', '/v2/artifacts?podId=w1'],
  ])('%s with no matches keeps the controls and the filtered line, never day zero', async (_label, url) => {
    const { container } = renderEmpty(url, { pods: [workspace] });
    expect(await screen.findByText('Nothing matches. Clear a filter or the search.')).toBeInTheDocument();
    expect(container.querySelector('.v2-artifacts__controls')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nothing shared yet' })).not.toBeInTheDocument();
  });
});

// @ts-nocheck
// Artifacts, direction C (ScaleArtifacts.dc.html) — PR 5.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

  test('empty states are honest: nothing shared vs nothing matching', async () => {
    axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/pods' ? [] : { items: [], nextCursor: null, total: 0 } }));
    render(<MemoryRouter initialEntries={['/v2/artifacts']}><V2ArtifactsPage /></MemoryRouter>);
    expect(await screen.findByText(/Nothing shared yet/)).toBeInTheDocument();
    render(<MemoryRouter initialEntries={['/v2/artifacts?kind=page']}><V2ArtifactsPage /></MemoryRouter>);
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });
});

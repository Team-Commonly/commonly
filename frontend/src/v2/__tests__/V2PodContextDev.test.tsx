// @ts-nocheck
// The v2 pod context inspector keeps the MUI page's calls: the same context
// params, index endpoints, memory search and excerpt request.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
import V2PodContextDev from '../components/V2PodContextDev';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'token-1' }),
}));

const AUTH = { headers: { Authorization: 'Bearer token-1' } };

const CONTEXT = {
  pod: { id: 'pod-1', name: 'Incident Pod', description: 'Handles incidents', type: 'chat' },
  task: 'incident runbook',
  skillModeUsed: 'llm',
  skillWarnings: [],
  stats: { summaries: 1, assets: 2, tags: 1, skills: 1 },
  skills: [{
    _id: 'skill-1',
    title: 'Skill: Incident Triage',
    content: '### Incident Triage\n\nFollow the runbook.',
    tags: ['incident', 'triage'],
    metadata: { score: 9.1 },
  }],
  tags: [{ tag: 'incident', count: 3 }],
  summaries: [{
    _id: 'summary-1',
    title: 'Incident alignment',
    createdAt: '2026-01-20T10:00:00.000Z',
    content: 'Important incident detail.',
    tags: ['incident'],
  }],
  assets: [
    { _id: 'asset-1', title: 'Runbook doc', type: 'doc', createdAt: '2026-01-20T11:00:00.000Z' },
    { _id: 'asset-2', title: 'Agent scratch', type: 'memory', metadata: { scope: 'agent' } },
    { _id: 'asset-3', title: 'Discord Summary', type: 'integration-summary' },
  ],
};

const renderPage = async () => {
  await act(async () => { render(<V2PodContextDev />); });
};

const click = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
};

beforeEach(() => {
  jest.resetAllMocks();
});

afterEach(() => cleanup());

test('loads pods, fetches context with the skill params, and renders it', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockResolvedValueOnce({ data: CONTEXT });
  await renderPage();

  expect(axios.get).toHaveBeenCalledWith('/api/pods', AUTH);
  await click('Fetch context');

  expect(axios.get).toHaveBeenLastCalledWith('/api/pods/pod-1/context', {
    ...AUTH,
    params: {
      task: undefined,
      summaryLimit: '6',
      assetLimit: '12',
      tagLimit: '16',
      skillLimit: '6',
      skillMode: 'llm',
      skillRefreshHours: '6',
    },
  });
  expect(screen.getByText('Skill mode: llm')).toBeInTheDocument();
  expect(screen.getByText(/Skill: Incident Triage/)).toBeInTheDocument();
  expect(screen.getByText('incident (3)')).toBeInTheDocument();
  expect(screen.getByText('Incident alignment')).toBeInTheDocument();
  // Summary content stays folded until asked for.
  expect(screen.queryByText('Important incident detail.')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByLabelText('Show summary content (markdown)')); });
  expect(screen.getByText('Important incident detail.')).toBeInTheDocument();
});

test('the asset scope filter and the summary split hold', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockResolvedValueOnce({ data: CONTEXT });
  await renderPage();
  await click('Fetch context');

  // Shared scope by default: the agent-only memory is hidden, and a summary
  // asset never appears among the non-summary assets.
  expect(screen.getByText('Runbook doc')).toBeInTheDocument();
  expect(screen.queryByText('Agent scratch')).toBeNull();
  expect(screen.queryByText('Discord Summary')).toBeNull();

  await act(async () => { fireEvent.change(screen.getByLabelText('Asset scope'), { target: { value: 'agent' } }); });
  expect(screen.getByText('Agent scratch')).toBeInTheDocument();
  expect(screen.queryByText('Runbook doc')).toBeNull();

  await act(async () => { fireEvent.change(screen.getByLabelText('Asset scope'), { target: { value: 'all' } }); });
  await act(async () => { fireEvent.click(screen.getByLabelText('Show summary assets')); });
  expect(screen.getByText('Discord Summary')).toBeInTheDocument();
});

test('index stats, rebuild and rebuild-all call the index API', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockResolvedValue({ data: { stats: { available: true, chunks: 4, assets: 2, embeddings: 4 } } });
  axios.post
    .mockResolvedValueOnce({ data: { indexed: 2, errors: 0 } })
    .mockResolvedValueOnce({ data: { pods: 3, indexed: 9, errors: 1 } });
  await renderPage();

  await click('Fetch stats');
  expect(axios.get).toHaveBeenLastCalledWith('/api/v1/pods/pod-1/index/stats', AUTH);
  expect(screen.getByText('Chunks: 4')).toBeInTheDocument();

  await click('Reset and rebuild');
  expect(axios.post).toHaveBeenLastCalledWith('/api/v1/pods/pod-1/index/rebuild', { reset: true }, AUTH);
  expect(screen.getByText('Rebuilt index: 2 indexed, 0 errors.')).toBeInTheDocument();
  // A rebuild re-reads the stats it changed.
  expect(axios.get).toHaveBeenCalledTimes(3);
  expect(axios.get).toHaveBeenLastCalledWith('/api/v1/pods/pod-1/index/stats', AUTH);

  await click('Reset and rebuild all pods');
  expect(axios.post).toHaveBeenLastCalledWith('/api/v1/index/rebuild-all', { reset: true }, AUTH);
  expect(screen.getByText('Rebuilt 3 pods: 9 indexed, 1 errors.')).toBeInTheDocument();
});

test('searches pod memory and opens an excerpt', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockResolvedValueOnce({
      data: {
        results: [{
          assetId: 'asset-9', title: 'Incident Notes', type: 'summary', tags: ['incident'], score: 4.2, snippet: 'Incident summary snippet...',
        }],
      },
    })
    .mockResolvedValueOnce({
      data: {
        assetId: 'asset-9', title: 'Incident Notes', type: 'summary', text: 'Line 1\nLine 2', startLine: 1, endLine: 2,
      },
    });
  await renderPage();

  await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search pod memory…'), { target: { value: 'incident' } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Memory' })); });
  await click('Search memory');
  expect(axios.get).toHaveBeenLastCalledWith('/api/pods/pod-1/context/search', {
    ...AUTH,
    params: { query: 'incident', limit: '8', includeSkills: undefined, types: 'memory' },
  });
  expect(screen.getByText('Incident summary snippet...')).toBeInTheDocument();

  await click('Open excerpt');
  expect(axios.get).toHaveBeenLastCalledWith('/api/pods/pod-1/context/assets/asset-9', {
    ...AUTH,
    params: { from: '1', lines: '12' },
  });
  expect(screen.getByText(/Line 1/)).toBeInTheDocument();
  expect(screen.getByText('lines 1-2')).toBeInTheDocument();
});

test('switching pods drops the previous pod\'s search results and excerpt', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }, { _id: 'pod-2', name: 'Release Pod' }] })
    .mockResolvedValueOnce({ data: { results: [{ assetId: 'asset-9', title: 'Incident Notes' }] } })
    .mockResolvedValueOnce({ data: { assetId: 'asset-9', title: 'Incident Notes', text: 'Excerpt body', startLine: 1, endLine: 1 } });
  await renderPage();
  await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search pod memory…'), { target: { value: 'incident' } }); });
  await click('Search memory');
  await click('Open excerpt');
  // Populated first, so the clear below cannot pass vacuously.
  expect(screen.getByText('Selected asset: asset-9')).toBeInTheDocument();
  expect(screen.getByText(/Excerpt body/)).toBeInTheDocument();

  await act(async () => { fireEvent.change(screen.getByLabelText('Pod'), { target: { value: 'pod-2' } }); });
  expect(screen.queryByText('Incident Notes')).toBeNull();
  expect(screen.queryByText('Selected asset: asset-9')).toBeNull();
  expect(screen.queryByText(/Excerpt body/)).toBeNull();
  expect(screen.getByText('Select a search result to load an excerpt.')).toBeInTheDocument();
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('an older excerpt response that lands last does not replace the newer one', async () => {
  const first = deferred();
  const second = deferred();
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockResolvedValueOnce({ data: { results: [{ assetId: 'asset-a', title: 'Alpha' }, { assetId: 'asset-b', title: 'Beta' }] } })
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await renderPage();
  await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search pod memory…'), { target: { value: 'notes' } }); });
  await click('Search memory');
  const [openA, openB] = screen.getAllByRole('button', { name: 'Open excerpt' });
  await act(async () => { fireEvent.click(openA); });
  await act(async () => { fireEvent.click(openB); });

  await act(async () => { second.resolve({ data: { assetId: 'asset-b', text: 'Beta text', startLine: 1, endLine: 1 } }); });
  await act(async () => { first.resolve({ data: { assetId: 'asset-a', text: 'Alpha text', startLine: 1, endLine: 1 } }); });

  expect(screen.getByText('Selected asset: asset-b')).toBeInTheDocument();
  expect(screen.getByText(/Beta text/)).toBeInTheDocument();
  expect(screen.queryByText(/Alpha text/)).toBeNull();
});

test('a search that resolves after the pod changed is dropped', async () => {
  const pending = deferred();
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }, { _id: 'pod-2', name: 'Release Pod' }] })
    .mockReturnValueOnce(pending.promise);
  await renderPage();
  await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search pod memory…'), { target: { value: 'incident' } }); });
  await click('Search memory');
  expect(screen.getByRole('button', { name: 'Searching…' })).toBeInTheDocument();

  await act(async () => { fireEvent.change(screen.getByLabelText('Pod'), { target: { value: 'pod-2' } }); });
  await act(async () => { pending.resolve({ data: { results: [{ assetId: 'asset-9', title: 'Incident Notes' }] } }); });

  expect(screen.queryByText('Incident Notes')).toBeNull();
  expect(screen.getByRole('button', { name: 'Search memory' })).toBeEnabled();
});

// The server does not serialize rebuild-all, so the lock holds across a pod
// switch, and the rebuild's stats refresh does not land on the new pod.
test('a rebuild-all keeps the index buttons locked across a pod switch', async () => {
  const pending = deferred();
  axios.get.mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }, { _id: 'pod-2', name: 'Release Pod' }] });
  axios.post.mockReturnValueOnce(pending.promise);
  await renderPage();
  await click('Reset and rebuild all pods');

  await act(async () => { fireEvent.change(screen.getByLabelText('Pod'), { target: { value: 'pod-2' } }); });
  expect(screen.getByText('Rebuilding all pods…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset and rebuild all pods' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Fetch stats' })).toBeDisabled();

  const getsBefore = axios.get.mock.calls.length;
  await act(async () => { pending.resolve({ data: { pods: 2, indexed: 5, errors: 0 } }); });

  expect(screen.getByText('Rebuilt 2 pods: 5 indexed, 0 errors.')).toBeInTheDocument();
  expect(axios.get.mock.calls.slice(getsBefore).some(([url]) => url.includes('/index/stats'))).toBe(false);
  expect(screen.getByRole('button', { name: 'Reset and rebuild all pods' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Fetch stats' })).toBeEnabled();
});

test('the inspector card radius is a token v2.css defines', () => {
  // An undefined custom property computes border-radius to 0 and squares the card.
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'v2.css'), 'utf8');
  const card = css.match(/\n\.v2-pod-context__card \{([^}]*)\}/)[1];
  const token = card.match(/border-radius: var\((--v2-[a-z0-9-]+)\)/)[1];
  expect(css).toMatch(new RegExp(`\\n\\s*${token}:`));
});

test('a failed context fetch shows the server message', async () => {
  axios.get
    .mockResolvedValueOnce({ data: [{ _id: 'pod-1', name: 'Incident Pod' }] })
    .mockRejectedValueOnce({ response: { data: { message: 'Pod not found' } } });
  await renderPage();
  await click('Fetch context');
  expect(screen.getByRole('alert')).toHaveTextContent('Pod not found');
});

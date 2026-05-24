// @ts-nocheck
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import V2MarketplaceDetailPage from '../V2MarketplaceDetailPage';

// Axios mock — used by the detail page to fetch the manifest. Same shape
// as V2Login.test.tsx so transitive axios.defaults.baseURL writes don't
// throw during test setup.
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = require('axios').default;

const renderAt = (id: string) => render(
  <MemoryRouter initialEntries={[`/v2/marketplace/${id}`]}>
    <Routes>
      <Route path="/v2/marketplace/:installableId" element={<V2MarketplaceDetailPage />} />
      <Route path="/v2/marketplace" element={<div>marketplace-list</div>} />
      <Route path="/v2/agents/browse" element={<div>agents-browse</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('V2MarketplaceDetailPage', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('renders identity + stats + components + scopes on success', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        installableId: 'pod-welcomer',
        name: 'pod-welcomer',
        description: 'Greets new members.',
        kind: 'agent',
        latestVersion: '1.0.0',
        marketplace: {
          displayName: 'Pod Welcomer',
          category: 'productivity',
          rating: 4.5,
          ratingCount: 12,
          verified: true,
          publisher: { name: 'Team Commonly' },
        },
        stats: { totalInstalls: 1234 },
        requires: ['integration:read', 'messages:write'],
        components: [
          { type: 'Agent', name: 'pod-welcomer' },
          { type: 'EventHandler', name: 'on-pod-join' },
        ],
        readme: '# Pod Welcomer\nA short greeting.',
      },
    });
    renderAt('pod-welcomer');
    await waitFor(() => expect(screen.getByText('Pod Welcomer')).toBeInTheDocument());
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('productivity')).toBeInTheDocument();
    expect(screen.getByText('by Team Commonly')).toBeInTheDocument();
    expect(screen.getByText(/1\.2k installs/i)).toBeInTheDocument();
    expect(screen.getByText(/4\.5 \(12\)/)).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('✓ Verified')).toBeInTheDocument();
    expect(screen.getByText('Greets new members.')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('EventHandler')).toBeInTheDocument();
    expect(screen.getByText('integration:read')).toBeInTheDocument();
    expect(screen.getByText('messages:write')).toBeInTheDocument();
    // The "About" section header renders when readme is present; rely on
    // that as the readme-presence assertion. We deliberately don't assert
    // on the rendered markdown body — ReactMarkdown's jest behavior is
    // covered by V2PodInspector/V2MessageBubble tests, not this leaf.
    expect(screen.getByText(/^About$/i)).toBeInTheDocument();
  });

  test('shows Not found state on 404', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 404 }, message: 'Request failed with status code 404' });
    renderAt('does-not-exist');
    await waitFor(() => expect(screen.getByText('Manifest not found')).toBeInTheDocument());
    // Has back link
    expect(screen.getByText('← Back to marketplace')).toBeInTheDocument();
  });

  test('shows generic error on non-404 fetch failure', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 500 }, message: 'Server error' });
    renderAt('any');
    await waitFor(() => expect(screen.getByText('Failed to load marketplace entry')).toBeInTheDocument());
  });

  test('fetches /api/marketplace/manifests/:installableId with the URL param', async () => {
    axios.get.mockResolvedValueOnce({
      data: { installableId: 'task-clerk', name: 'task-clerk' },
    });
    renderAt('task-clerk');
    await waitFor(() => expect(screen.getByText('task-clerk')).toBeInTheDocument());
    expect(axios.get).toHaveBeenCalledWith(
      '/api/marketplace/manifests/task-clerk',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  test('handles minimal manifest with no marketplace metadata gracefully', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        installableId: 'bare',
        name: 'bare-thing',
        // no marketplace, no stats, no requires, no components, no readme
      },
    });
    renderAt('bare');
    await waitFor(() => expect(screen.getByText('bare-thing')).toBeInTheDocument());
    // Defaults render — kind=app, category=other, publisher=unknown, 0 installs, unrated
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
    expect(screen.getByText('by unknown')).toBeInTheDocument();
    expect(screen.getByText('0 installs')).toBeInTheDocument();
    expect(screen.getByText('★ unrated')).toBeInTheDocument();
  });
});

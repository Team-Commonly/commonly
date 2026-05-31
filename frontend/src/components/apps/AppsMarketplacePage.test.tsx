// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppsMarketplacePage from './AppsMarketplacePage';

const axios = require('axios');

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  const React = require('react');
  return {
    ...actual,
    Tabs: ({ children }) => React.createElement('div', null, children),
    Tab: ({ label }) => React.createElement('div', null, label),
  };
});

describe('AppsMarketplacePage', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    axios.post.mockResolvedValue({ data: { success: true } });
    axios.delete.mockResolvedValue({ data: { success: true } });
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') {
        return Promise.resolve({ data: [{ _id: 'pod-1', name: 'Alpha' }] });
      }
      if (url.startsWith('/api/marketplace/browse?')) {
        return Promise.resolve({
          data: {
            items: [
              {
                _id: 'installable-1',
                installableId: '@sam/community-agent',
                name: 'Community Agent',
                description: 'Published via installables.',
                kind: 'agent',
                marketplace: {
                  category: 'development',
                  verified: true,
                  rating: 4.5,
                  ratingCount: 10,
                  logoUrl: 'https://cdn.example.com/community.png',
                },
                stats: {
                  totalInstalls: 42,
                },
                requires: ['context:read', 'messages:write'],
              },
            ],
          },
        });
      }
      if (url === '/api/marketplace/official') {
        return Promise.resolve({
          data: {
            version: '1.0.0',
            entries: [
              {
                id: 'discord',
                name: 'Discord',
                description: 'Chat integration',
                type: 'integration',
                category: 'communication',
                logoUrl: 'https://cdn.example.com/discord.png',
              },
            ],
          },
        });
      }
      if (url === '/api/integrations/catalog') {
        return Promise.resolve({
          data: {
            entries: [
              {
                id: 'discord',
                catalog: { label: 'Discord', capabilities: ['gateway'] },
                stats: { activeIntegrations: 2 },
              },
            ],
          },
        });
      }
      if (url.startsWith('/api/apps/pods/pod-1/apps')) {
        return Promise.resolve({ data: { apps: [] } });
      }
      if (url.startsWith('/api/registry/pods/pod-1/agents')) {
        return Promise.resolve({ data: { agents: [] } });
      }
      return Promise.reject(new Error(`Unhandled request: ${url}`));
    });
  });

  afterEach(() => {
    localStorage.removeItem('token');
    axios.get.mockReset();
    axios.post.mockReset();
    axios.delete.mockReset();
  });

  it('renders official marketplace listings', async () => {
    render(<MemoryRouter><AppsMarketplacePage /></MemoryRouter>);

    expect(await screen.findByText('Official Marketplace')).toBeInTheDocument();
    expect(await screen.findByText('Discord')).toBeInTheDocument();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith('/api/marketplace/official');
    });
  });

  it('renders installable browse results and installs via registry', async () => {
    render(<MemoryRouter><AppsMarketplacePage /></MemoryRouter>);

    expect((await screen.findAllByText('Community Agent')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('@sam/community-agent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('42 installs').length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith('/api/registry/install', {
        agentName: '@sam/community-agent',
        podId: 'pod-1',
        version: undefined,
        displayName: 'Community Agent',
        scopes: ['context:read', 'messages:write'],
      }, {
        headers: { 'x-auth-token': 'test-token' },
      });
    });
  });
});

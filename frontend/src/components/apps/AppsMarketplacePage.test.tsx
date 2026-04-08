// @ts-nocheck
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') {
        return Promise.resolve({ data: [{ _id: 'pod-1', name: 'Alpha' }] });
      }
      if (url.startsWith('/api/apps/marketplace?')) {
        return Promise.resolve({ data: { apps: [] } });
      }
      if (url === '/api/apps/marketplace/featured') {
        return Promise.resolve({
          data: {
            apps: [
              {
                id: 'app-1',
                name: 'App One',
                displayName: 'App One',
                description: 'Featured app',
                type: 'webhook',
                category: 'other',
                installs: 42,
                rating: 4.5,
                ratingCount: 10,
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
      return Promise.reject(new Error(`Unhandled request: ${url}`));
    });
  });

  afterEach(() => {
    localStorage.removeItem('token');
    axios.get.mockReset();
  });

  it('renders official marketplace listings', async () => {
    render(<AppsMarketplacePage />);

    expect(await screen.findByText('Official Marketplace')).toBeInTheDocument();
    expect(await screen.findByText('Discord')).toBeInTheDocument();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith('/api/marketplace/official');
    });
  });
});

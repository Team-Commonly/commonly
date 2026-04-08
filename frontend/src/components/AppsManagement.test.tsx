// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AppsManagement from './AppsManagement';
import { AuthContext } from '../context/AuthContext';

const axios = require('axios');

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));

describe('AppsManagement ingest tokens', () => {
  beforeEach(() => {
    localStorage.setItem('token', 't');
    axios.get.mockImplementation((url) => {
      if (url === '/api/integrations/user/all') {
        return Promise.resolve({
          data: [
            {
              _id: 'int-1',
              type: 'slack',
              status: 'connected',
              createdAt: new Date().toISOString(),
              podId: { _id: 'pod-1', name: 'Alpha', type: 'chat' },
              config: { channelName: 'general' },
            },
          ],
        });
      }
      if (url === '/api/apps') {
        return Promise.resolve({ data: [] });
      }
      if (url === '/api/integrations/int-1/ingest-tokens') {
        return Promise.resolve({ data: { tokens: [] } });
      }
      return Promise.reject(new Error(`Unhandled request: ${url}`));
    });
  });

  afterEach(() => {
    localStorage.removeItem('token');
    axios.get.mockReset();
  });

  it('opens ingest tokens dialog and fetches tokens', async () => {
    render(
      <AuthContext.Provider value={{ user: { role: 'member' } }}>
        <AppsManagement />
      </AuthContext.Provider>,
    );

    const button = await screen.findByRole('button', { name: /Ingest Tokens/i });
    fireEvent.click(button);

    expect(
      await screen.findByText(/Use ingest tokens with external provider services/i),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith('/api/integrations/int-1/ingest-tokens', {
        headers: { Authorization: 'Bearer t' },
      });
    });
  });
});

// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalIntegrations from '../GlobalIntegrations';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  },
}));

// What the admin GET returns after #1673: rows exist, credentials are stripped.
const globalResponse = {
  data: {
    x: {
      _id: 'x-1',
      type: 'x',
      status: 'connected',
      config: { username: 'CommonlyHQ', userId: '42' },
    },
    instagram: {
      _id: 'ig-1',
      type: 'instagram',
      status: 'connected',
      config: { username: 'commonly', igUserId: '77' },
    },
    socialPolicy: null,
    modelPolicy: null,
    globalPodId: 'pod-global',
  },
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/admin/integrations/global']}>
    <GlobalIntegrations />
  </MemoryRouter>,
);

const tokenFields = () => screen.getAllByLabelText('Access Token');
const postBody = (path) => mockPost.mock.calls.find(([url]) => url === path)?.[1];

describe('GlobalIntegrations token fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('token', 'jwt');
    mockGet.mockResolvedValue(globalResponse);
    mockPost.mockResolvedValue({ data: { success: true } });
  });

  it('a saved token shows the leave-blank placeholder instead of the secret', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByDisplayValue('CommonlyHQ')).toBeInTheDocument());

    const [xToken, igToken] = tokenFields();
    expect(xToken).toHaveValue('');
    expect(igToken).toHaveValue('');
    expect(xToken).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    expect(igToken).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    expect(screen.getAllByText('A token is on file. Paste a new one to replace it.')).toHaveLength(2);
  });

  it('saving with the token blank omits accessToken so the server keeps it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('CommonlyHQ')).toBeInTheDocument());

    const saveX = screen.getByRole('button', { name: 'Save X Configuration' });
    expect(saveX).not.toBeDisabled();
    fireEvent.click(saveX);
    await waitFor(() => expect(postBody('/api/admin/integrations/global/x')).toBeDefined());
    const xBody = postBody('/api/admin/integrations/global/x');
    expect(xBody.username).toBe('CommonlyHQ');
    expect(JSON.parse(JSON.stringify(xBody))).not.toHaveProperty('accessToken');

    const saveIg = screen.getByRole('button', { name: 'Save Instagram Configuration' });
    expect(saveIg).not.toBeDisabled();
    fireEvent.click(saveIg);
    await waitFor(() => expect(postBody('/api/admin/integrations/global/instagram')).toBeDefined());
    expect(JSON.parse(JSON.stringify(postBody('/api/admin/integrations/global/instagram'))))
      .not.toHaveProperty('accessToken');
  });

  it('a typed token is sent and replaces the saved one', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('CommonlyHQ')).toBeInTheDocument());

    const [xToken] = tokenFields();
    fireEvent.change(xToken, { target: { value: 'fresh-x-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save X Configuration' }));

    await waitFor(() => expect(postBody('/api/admin/integrations/global/x')).toBeDefined());
    expect(postBody('/api/admin/integrations/global/x').accessToken).toBe('fresh-x-token');
  });

  it('a new integration still needs a token before it can be saved', async () => {
    mockGet.mockResolvedValue({ data: { x: null, instagram: null, socialPolicy: null, modelPolicy: null } });
    renderPage();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    const [xToken] = tokenFields();
    expect(xToken).toHaveAttribute('placeholder', 'Bearer token...');

    fireEvent.change(screen.getAllByLabelText('Username')[0], { target: { value: 'CommonlyHQ' } });
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: '42' } });
    expect(screen.getByRole('button', { name: 'Save X Configuration' })).toBeDisabled();

    fireEvent.change(xToken, { target: { value: 'first-token' } });
    expect(screen.getByRole('button', { name: 'Save X Configuration' })).not.toBeDisabled();
  });
});

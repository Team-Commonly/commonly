// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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


describe('instance Anthropic model options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('token', 'jwt');
  });
  it.each([false, true])('keeps all three options visible with availability %s', async (available) => {
    mockGet.mockResolvedValue({ data: {
      ...globalResponse.data,
      modelCatalog: { models: ['opus-4-6', 'sonnet-4-6', 'haiku-4-5'].map((slug, index) => ({ id: 'anthropic/claude-' + slug, label: ['Claude Opus 4.6', 'Claude Sonnet 4.6', 'Claude Haiku 4.5'][index], provider: 'anthropic', available, reason: available ? null : 'The upstream rejected this route’s credentials' })) },
      modelPolicy: { openclaw: { provider: 'anthropic', model: 'anthropic/claude-opus-4-6' } },
    } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Dev Agent Primary Model')).toHaveTextContent('Claude Opus 4.6'));
    const save = screen.getByRole('button', { name: 'Save Model Policy' });
    expect(save.disabled).toBe(!available);
    expect(screen.getByRole('button', { name: 'Save + Apply To All Agents' }).disabled).toBe(!available);
    if (!available) expect(screen.getAllByText('The upstream rejected this route’s credentials')[0]).toBeInTheDocument();
    else expect(screen.queryByText('The upstream rejected this route’s credentials')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Dev Agent Primary Model'));
    const list = await screen.findByRole('listbox', { hidden: true });
    for (const model of ['Claude Opus 4.6', 'Claude Sonnet 4.6', 'Claude Haiku 4.5']) {
      const option = within(list).getByRole('option', { name: new RegExp(model), hidden: true });
      if (available) expect(option).not.toHaveAttribute('aria-disabled', 'true');
      else expect(option).toHaveAttribute('aria-disabled', 'true');
    }
  });
});

it('offers a newly discovered route without selecting it on a provider change', async () => {
  mockGet.mockResolvedValue({ data: {
    ...globalResponse.data,
    modelCatalog: { models: [{ id: 'future-route', label: 'New model from gateway', provider: 'custom', available: true, reason: null }] },
  } });
  renderPage();
  await waitFor(() => expect(screen.getByDisplayValue('CommonlyHQ')).toBeInTheDocument());
  fireEvent.mouseDown(screen.getByLabelText('Dev Agent Provider'));
  fireEvent.click(await screen.findByRole('option', { name: 'Custom', hidden: true }));
  expect(screen.getByRole('button', { name: 'Save Model Policy' })).toBeDisabled();
  fireEvent.mouseDown(screen.getByLabelText('Dev Agent Primary Model'));
  const choice = await screen.findByRole('option', { name: 'New model from gateway', hidden: true });
  expect(choice).not.toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(choice);
  await waitFor(() => expect(screen.getByLabelText('Dev Agent Primary Model')).toHaveTextContent('New model from gateway'));
  expect(screen.getByRole('button', { name: 'Save Model Policy' })).not.toBeDisabled();
});


it('disables both save actions when model health is unconfirmed', async () => {
  mockGet.mockResolvedValue({ data: {
    ...globalResponse.data,
    modelPolicy: { openclaw: { provider: 'anthropic', model: 'anthropic/claude-opus-4-6' } },
  } });
  renderPage();
  await waitFor(() => expect(screen.getByLabelText('Dev Agent Primary Model')).toHaveTextContent('anthropic/claude-opus-4-6'));
  expect(screen.getByRole('button', { name: 'Save Model Policy' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save + Apply To All Agents' })).toBeDisabled();
});

// @ts-nocheck
// The v2 global integrations page keeps the MUI page's calls and contracts:
// saved tokens are write-only, the backend LLM offer (F98) shows a retired
// current value disabled, and no OpenClaw section is shown or sent.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import V2GlobalIntegrations from '../components/V2GlobalIntegrations';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
  },
}));

const AUTH = { headers: { Authorization: 'Bearer jwt' } };

// What GET /api/admin/integrations/global returns as modelPolicy on an instance
// that never saved one: getConfig() merges DEFAULT_CONFIG
// (backend/services/globalModelConfigService.ts), which still names Gemini.
const serverDefaults = () => ({
  llmService: {
    provider: 'auto',
    model: 'gemini-2.5-flash',
    contextLimit: 128000,
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  },
  openclaw: { provider: 'google', model: 'google/gemini-2.5-flash' },
});

// What the admin GET returns after #1673: rows exist, credentials are stripped.
const connected = () => ({
  data: {
    x: { _id: 'x-1', type: 'x', status: 'connected', config: { username: 'CommonlyHQ', userId: '42', followingMaxUsers: 7 } },
    instagram: { _id: 'ig-1', type: 'instagram', status: 'connected', config: { username: 'commonly', igUserId: '77' } },
    socialPolicy: { socialMode: 'rewrite', publishEnabled: true, strictAttribution: false },
    modelPolicy: serverDefaults(),
  },
});
const empty = (modelPolicy = null) => ({ data: { x: null, instagram: null, socialPolicy: null, modelPolicy } });

let seenPath = '';
const PathProbe = () => { seenPath = `${useLocation().pathname}${useLocation().search}`; return null; };

const renderPage = async (url = '/admin/integrations/global') => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="*" element={<><V2GlobalIntegrations /><PathProbe /></>} /></Routes>
      </MemoryRouter>,
    );
  });
};

const postBody = (path) => mockPost.mock.calls.find(([url]) => url === path)?.[1];
const tokenFields = () => screen.getAllByLabelText('Access Token');
const optionsOf = (label) => within(screen.getByLabelText(label)).getAllByRole('option')
  .map((o) => (o.disabled ? `${o.textContent} [disabled]` : o.textContent));

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'jwt');
  mockPost.mockResolvedValue({ data: { success: true } });
});

describe('model policy', () => {
  test('the backend LLM offer shows, and no OpenClaw section does', async () => {
    mockGet.mockResolvedValue(empty(serverDefaults()));
    await renderPage();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/integrations/global', AUTH);
    expect(optionsOf('Backend LLM Provider')).toEqual(['Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
    expect(screen.queryByText(/OpenClaw/)).toBeNull();
  });

  test('a saved Gemini provider shows as current and disabled, and Gemini is not offered', async () => {
    const policy = serverDefaults();
    policy.llmService.provider = 'gemini';
    mockGet.mockResolvedValue(empty(policy));
    await renderPage();
    expect(optionsOf('Backend LLM Provider'))
      .toEqual(['gemini (current) [disabled]', 'Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
    expect(screen.getByLabelText('Backend LLM Provider')).toHaveValue('gemini');
  });

  test('saving sends the backend LLM policy, no openclaw section, and no reprovision', async () => {
    mockGet.mockResolvedValue(empty(serverDefaults()));
    await renderPage();
    await act(async () => { fireEvent.change(screen.getByLabelText('Backend LLM Provider'), { target: { value: 'openrouter' } }); });
    await act(async () => { fireEvent.change(screen.getByLabelText('OpenRouter Model'), { target: { value: 'anthropic/claude' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Model Policy' })); });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/admin/integrations/global/model-policy', {
      llmService: {
        provider: 'openrouter',
        model: 'gemini-2.5-flash',
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude' },
      },
    }, AUTH);
    expect(mockPost.mock.calls.some(([url]) => url.includes('reprovision'))).toBe(false);
    expect(screen.getByText('Global model policy saved.')).toBeInTheDocument();
  });
});

describe('token fields', () => {
  test('a saved token shows the leave-blank placeholder instead of the secret', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    const [xToken, igToken] = tokenFields();
    expect(xToken).toHaveValue('');
    expect(igToken).toHaveValue('');
    expect(xToken).toHaveAttribute('type', 'password');
    expect(xToken).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    expect(igToken).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    expect(screen.getAllByText('A token is on file. Paste a new one to replace it.')).toHaveLength(2);
  });

  test('saving with the token blank omits accessToken so the server keeps it', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save X Configuration' })); });
    const xBody = postBody('/api/admin/integrations/global/x');
    expect(xBody).toMatchObject({ username: 'CommonlyHQ', userId: '42', followingMaxUsers: 7, enabled: true });
    expect(JSON.parse(JSON.stringify(xBody))).not.toHaveProperty('accessToken');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Instagram Configuration' })); });
    expect(JSON.parse(JSON.stringify(postBody('/api/admin/integrations/global/instagram'))))
      .toEqual({ enabled: true, username: 'commonly', igUserId: '77' });
  });

  test('a typed token is sent and replaces the saved one', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    await act(async () => { fireEvent.change(tokenFields()[0], { target: { value: 'fresh-x-token' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save X Configuration' })); });
    expect(postBody('/api/admin/integrations/global/x').accessToken).toBe('fresh-x-token');
  });

  test('a new integration still needs a token before it can be saved', async () => {
    mockGet.mockResolvedValue(empty());
    await renderPage();
    const [xToken] = tokenFields();
    expect(xToken).toHaveAttribute('placeholder', 'Bearer token...');
    // Nothing connected yet: neither account can be tested.
    screen.getAllByRole('button', { name: 'Test connection' }).forEach((b) => expect(b).toBeDisabled());
    await act(async () => { fireEvent.change(screen.getAllByLabelText('Username')[0], { target: { value: 'CommonlyHQ' } }); });
    await act(async () => { fireEvent.change(screen.getByLabelText('User ID'), { target: { value: '42' } }); });
    expect(screen.getByRole('button', { name: 'Save X Configuration' })).toBeDisabled();
    await act(async () => { fireEvent.change(xToken, { target: { value: 'first-token' } }); });
    expect(screen.getByRole('button', { name: 'Save X Configuration' })).toBeEnabled();
  });
});

describe('X account', () => {
  test('loads the following list into the whitelist, capped at the max', async () => {
    mockGet
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce({ data: { users: [{ id: '11' }, { id: ' 22 ' }, {}] } });
    await renderPage();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load OAuth Following IDs Into Whitelist' })); });
    expect(mockGet).toHaveBeenLastCalledWith('/api/admin/integrations/global/x/following?limit=7', AUTH);
    expect(screen.getByLabelText('Following Whitelist User IDs (optional)')).toHaveValue('11, 22');
    expect(screen.getByLabelText("Watch authenticated user's following list")).toBeChecked();
    expect(screen.getByText('Loaded 2 following account IDs into whitelist')).toBeInTheDocument();
  });

  test('tests a connected account', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    const [xTest] = screen.getAllByRole('button', { name: 'Test connection' });
    await act(async () => { fireEvent.click(xTest); });
    expect(mockPost).toHaveBeenCalledWith('/api/admin/integrations/global/x/test', {}, AUTH);
    expect(screen.getByText('X connection test successful!')).toBeInTheDocument();
  });

  test('the OAuth return announces the result and clears the query', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage('/admin/integrations/global?xOAuth=success&detail=%40CommonlyHQ');
    await waitFor(() => expect(screen.getByText('X OAuth connected (@CommonlyHQ)')).toBeInTheDocument());
    expect(seenPath).toBe('/admin/integrations/global');
  });

  test('a failed OAuth return shows the provider detail', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage('/admin/integrations/global?xOAuth=error&detail=access_denied');
    expect(screen.getByRole('alert')).toHaveTextContent('access_denied');
  });
});

describe('social policy and status', () => {
  test('shows the saved social policy and saves it back', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    expect(screen.getByLabelText('Social Mode')).toHaveValue('rewrite');
    expect(screen.getByLabelText('Enable external publish')).toBeChecked();
    expect(screen.getByLabelText('Strict attribution (require source URL)')).not.toBeChecked();
    await act(async () => { fireEvent.click(screen.getByLabelText('Strict attribution (require source URL)')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Policy' })); });
    expect(mockPost).toHaveBeenCalledWith('/api/admin/integrations/global/policy',
      { socialMode: 'rewrite', publishEnabled: true, strictAttribution: true }, AUTH);
  });

  test('counts the connected accounts', async () => {
    mockGet.mockResolvedValue(connected());
    await renderPage();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    // The status chip sits beside the heading, not inside its name.
    expect(screen.getByRole('heading', { name: 'X (Twitter)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Instagram' })).toBeInTheDocument();
  });

  test('a failed load shows the server error', async () => {
    mockGet.mockRejectedValue({ response: { data: { error: 'Admin only' } } });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Admin only');
  });
});

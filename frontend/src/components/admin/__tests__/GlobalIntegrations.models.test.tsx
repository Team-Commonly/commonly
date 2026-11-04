// @ts-nocheck
// F98 (D243, Cofounder 11-04): hosted agents are Claude-only. The gateway's
// selects offer Claude Haiku 5.5 only, the backend LLM service no longer offers
// Gemini, and a current value that is no longer offered still shows, disabled
// and marked current.
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
  openclaw: {
    provider: 'google',
    model: 'google/gemini-2.5-flash',
    fallbackModels: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash'],
    devAgentIds: ['theo', 'nova', 'pixel', 'ops'],
    communityAgentModel: { primary: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', fallbacks: [] },
  },
});
const response = (modelPolicy) => ({
  data: { x: null, instagram: null, socialPolicy: null, modelPolicy, globalPodId: 'pod-global' },
});
const renderPage = () => render(
  <MemoryRouter initialEntries={['/admin/integrations/global']}>
    <GlobalIntegrations />
  </MemoryRouter>,
);
const openSelect = async (label) => {
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: new RegExp(label) }));
  return screen.findByRole('listbox', { hidden: true });
};
// Opens a select by its label and returns its options' text, disabled ones marked.
const optionsOf = async (label) => {
  const listbox = await openSelect(label);
  const options = within(listbox).getAllByRole('option', { hidden: true })
    .map((o) => (o.getAttribute('aria-disabled') === 'true' ? `${o.textContent} [disabled]` : o.textContent));
  fireEvent.keyDown(listbox, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox', { hidden: true })).toBeNull());
  return options;
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'jwt');
  mockPost.mockResolvedValue({ data: { success: true } });
});

test('on an instance with no saved policy, the server defaults show as current, beside the Claude-only offer', async () => {
  mockGet.mockResolvedValue(response(serverDefaults()));
  renderPage();
  expect(await optionsOf('Dev Agent Provider')).toEqual(['google (current) [disabled]', 'Anthropic']);
  expect(await optionsOf('Backend LLM Provider')).toEqual(['Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
  expect(screen.queryByText(/\(stored\)/)).toBeNull();
});

test('choosing Anthropic offers Claude Haiku 5.5 only, and saving sends it', async () => {
  mockGet.mockResolvedValue(response(serverDefaults()));
  renderPage();
  const providers = await openSelect('Dev Agent Provider');
  fireEvent.click(within(providers).getByRole('option', { name: 'Anthropic', hidden: true }));
  await waitFor(() => expect(screen.queryByRole('listbox', { hidden: true })).toBeNull());
  expect(await optionsOf('Dev Agent Primary Model')).toEqual(['Claude Haiku 5.5']);
  fireEvent.click(screen.getByRole('button', { name: 'Save Model Policy' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalled());
  const [url, body] = mockPost.mock.calls[0];
  expect(url).toBe('/api/admin/integrations/global/model-policy');
  expect(body.openclaw).toMatchObject({ provider: 'anthropic', model: 'anthropic/claude-haiku-5-5' });
});

test('a saved Gemini llmService provider shows as current, and Gemini is not offered', async () => {
  const policy = serverDefaults();
  policy.llmService.provider = 'gemini';
  mockGet.mockResolvedValue(response(policy));
  renderPage();
  expect(await optionsOf('Backend LLM Provider'))
    .toEqual(['gemini (current) [disabled]', 'Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
});

// @ts-nocheck
// F98 (decided 11-04): the backend LLM service no longer offers Gemini, and a
// current value that is no longer offered still shows, disabled and marked
// current. The OpenClaw section is gone (ADR-021 Part B): the page shows none
// and a save sends none, so the stored one stays as it was.
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

// What GET /api/admin/integrations/global returned as modelPolicy on an instance
// that never saved one, before the OpenClaw section left the backend (ADR-021).
// The openclaw block stays in the fixture so the page is shown to ignore it
// from a backend that still sends one.
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
    communityAgentModel: { primary: 'openrouter/deepseek-v4-flash', fallbacks: [] },
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

test('on an instance with no saved policy, the backend LLM offer shows and no OpenClaw section does', async () => {
  mockGet.mockResolvedValue(response(serverDefaults()));
  renderPage();
  expect(await optionsOf('Backend LLM Provider')).toEqual(['Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
  expect(screen.queryByText(/\(stored\)/)).toBeNull();
  expect(screen.queryByText(/OpenClaw/)).toBeNull();
  expect(screen.queryByRole('combobox', { name: /Dev Agent/ })).toBeNull();
});

test('saving sends the backend LLM policy and no openclaw section', async () => {
  mockGet.mockResolvedValue(response(serverDefaults()));
  renderPage();
  await screen.findByRole('combobox', { name: /Backend LLM Provider/ });
  fireEvent.click(screen.getByRole('button', { name: 'Save Model Policy' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalled());
  const [url, body] = mockPost.mock.calls[0];
  expect(url).toBe('/api/admin/integrations/global/model-policy');
  expect(body.llmService).toMatchObject({ provider: 'auto' });
  expect(body).not.toHaveProperty('openclaw');
});

// The button also fired reprovision-all, which only rewrote the retired
// OpenClaw gateway's config; the model policy reaches no agent that way now.
test('there is no Save + Apply To All Agents button, and a save starts no reprovision', async () => {
  mockGet.mockResolvedValue(response(serverDefaults()));
  renderPage();
  await screen.findByRole('combobox', { name: /Backend LLM Provider/ });
  expect(screen.queryByRole('button', { name: /Apply To All Agents/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save Model Policy' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalled());
  expect(mockPost.mock.calls.map(([url]) => url)).not.toContain('/api/registry/admin/installations/reprovision-all');
});

test('a saved Gemini llmService provider shows as current, and Gemini is not offered', async () => {
  const policy = serverDefaults();
  policy.llmService.provider = 'gemini';
  mockGet.mockResolvedValue(response(policy));
  renderPage();
  expect(await optionsOf('Backend LLM Provider'))
    .toEqual(['gemini (current) [disabled]', 'Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
});

// @ts-nocheck
// F98 (D243, Cofounder 11-04): hosted agents are Claude-only. The gateway's
// selects offer Claude Haiku 5.5 only, the backend LLM service no longer offers
// Gemini, and a stored value that is no longer offered still shows, marked stored.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalIntegrations from '../GlobalIntegrations';

const mockGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: jest.fn(),
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

const response = (modelPolicy) => ({
  data: { x: null, instagram: null, socialPolicy: null, modelPolicy, globalPodId: 'pod-global' },
});
const renderPage = () => render(
  <MemoryRouter initialEntries={['/admin/integrations/global']}>
    <GlobalIntegrations />
  </MemoryRouter>,
);
// Opens a select by its label and returns its options' text, disabled ones marked.
const optionsOf = async (label) => {
  const trigger = await screen.findByRole('combobox', { name: new RegExp(label) });
  fireEvent.mouseDown(trigger);
  const listbox = await screen.findByRole('listbox', { hidden: true });
  const options = within(listbox).getAllByRole('option', { hidden: true })
    .map((o) => (o.getAttribute('aria-disabled') === 'true' ? `${o.textContent} [disabled]` : o.textContent));
  fireEvent.keyDown(listbox, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox', { hidden: true })).toBeNull());
  return options;
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'jwt');
});

test('with nothing stored, the gateway offers Anthropic and Claude Haiku 5.5 only', async () => {
  mockGet.mockResolvedValue(response(null));
  renderPage();
  expect(await optionsOf('Dev Agent Provider')).toEqual(['Anthropic']);
  expect(await optionsOf('Dev Agent Primary Model')).toEqual(['Claude Haiku 5.5']);
  expect(await optionsOf('Backend LLM Provider')).toEqual(['Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
});

test('a stored Gemini policy shows as stored, beside the Claude-only offer', async () => {
  mockGet.mockResolvedValue(response({
    llmService: { provider: 'gemini', model: 'gemini-2.5-flash' },
    openclaw: { provider: 'google', model: 'google/gemini-2.5-flash' },
  }));
  renderPage();
  expect(await optionsOf('Dev Agent Provider')).toEqual(['google (stored) [disabled]', 'Anthropic']);
  expect(await optionsOf('Backend LLM Provider'))
    .toEqual(['gemini (stored) [disabled]', 'Auto (LiteLLM then Gemini)', 'LiteLLM', 'OpenRouter']);
});

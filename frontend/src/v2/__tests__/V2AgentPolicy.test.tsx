// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import V2AgentPolicy from '../agents/V2AgentPolicy';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;
const update = jest.fn().mockResolvedValue({});
const installation = {
  name: 'maya-claude', instanceId: 'machine-1', displayName: 'Maya',
  runtime: { runtimeType: 'wrapper', adapter: 'claude' },
  config: { environment: { adapter: 'claude', sandbox: { mode: 'read-only' } } },
  profile: {
    toolPolicy: { allowed: ['commonly'], blocked: [], requireApproval: ['Bash'] },
    contextPolicy: { maxTokens: 8000, compactionThreshold: 6000, summaryHours: 24,
      includeMemory: true, includeSkills: true, includeSummaries: true },
  },
};
const docs = () => ({
  soul: { content: 'Identity', updatedAt: null, visibility: 'private' },
  long_term: { content: 'Original', updatedAt: '2026-10-01T00:00:00.000Z', visibility: 'private' },
  shared: { content: '', updatedAt: null, visibility: 'private' },
});
const renderPolicy = (agent = installation) => render(
  <V2AgentPolicy agentName="maya-claude" instanceId="machine-1" installation={agent} update={update} />,
);

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => url.endsWith('/editable')
    ? Promise.resolve({ data: { sections: docs() } })
    : Promise.resolve({ data: { turnCap: 30, userRunCeiling: 120 } }));
  axios.patch.mockResolvedValue({ data: { section: 'long_term', content: 'Changed' } });
});

it('writes approval and context policy through the shared settings hook', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'commonly, Read, Read' } });
  fireEvent.click(screen.getByLabelText('Include summaries'));
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({
    toolPolicy: { allowed: ['commonly', 'Read'], blocked: [], requireApproval: ['Bash'] },
    contextPolicy: { maxTokens: 8000, compactionThreshold: 6000, summaryHours: 24,
      includeMemory: true, includeSkills: true, includeSummaries: false },
  }));
});

it('saves an edit immediately on the first click and confirms it', async () => {
  renderPolicy();
  fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'commonly, Read' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({
    toolPolicy: { allowed: ['commonly', 'Read'], blocked: [], requireApproval: ['Bash'] },
  }));
  expect(await screen.findByRole('status')).toHaveTextContent('Saved');
});

it('explains why an installation without a profile cannot save policy', async () => {
  renderPolicy({ ...installation, profile: null });
  expect(screen.getByRole('alert')).toHaveTextContent("This agent's policy can't be changed in this pod yet.");
  fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'Read' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

  expect(update).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('nothing was saved');
});

it('writes only the chosen trust mode and edits memory with its revision', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Repository access'), { target: { value: 'workspace' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save trust mode' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({
    config: { environment: { sandbox: { mode: 'workspace' } } },
  }));
  fireEvent.change(screen.getByLabelText('Long-term'), { target: { value: 'Changed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/agent-memory/maya-claude/machine-1/editable/long_term',
    { content: 'Changed', expectedUpdatedAt: '2026-10-01T00:00:00.000Z' },
  ));
});

it('shows server quota for hosted agents without editable trust controls', async () => {
  renderPolicy({ ...installation, runtime: { runtimeType: 'hosted' } });
  expect(await screen.findByText('Hosted turns per day')).toBeInTheDocument();
  expect(screen.getByText('Runs per day')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save trust mode' })).not.toBeInTheDocument();
});

it('offers trust mode for the canonical BYO runtime shape', async () => {
  renderPolicy({ ...installation, runtime: { runtimeType: 'codex', host: 'byo' },
    config: { environment: { sandbox: { mode: 'read-only' } } } });
  expect(await screen.findByLabelText('Repository access')).toHaveValue('read-only');
});

it('shows a retry in Memory when loading fails, then opens the editor', async () => {
  axios.get.mockImplementation((url) => url.endsWith('/editable')
    ? Promise.reject(new Error('Memory offline'))
    : Promise.resolve({ data: { turnCap: 30, userRunCeiling: 120 } }));
  renderPolicy();
  expect(await screen.findByText('Memory offline')).toBeInTheDocument();
  expect(screen.queryByText('Loading memory…')).not.toBeInTheDocument();
  axios.get.mockImplementation((url) => url.endsWith('/editable')
    ? Promise.resolve({ data: { sections: docs() } })
    : Promise.resolve({ data: { turnCap: 30, userRunCeiling: 120 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByDisplayValue('Original')).toBeInTheDocument();
});

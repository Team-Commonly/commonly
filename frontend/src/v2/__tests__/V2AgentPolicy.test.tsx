// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('hides stored approval and context settings that no runtime enforces', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  expect(screen.queryByText('Tool approvals')).not.toBeInTheDocument();
  expect(screen.queryByText('Context')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Maximum tokens')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Compact after')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Summary window (hours)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Include memory')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Include skills')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Include summaries')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
});

it('writes only the chosen trust mode and edits memory with its revision', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  fireEvent.click(screen.getByRole('radio', { name: 'Allow repository edits' }));
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
  expect(await screen.findByRole('radiogroup', { name: 'Repository access' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Read only' })).toBeChecked();
});

it('a viewer without access is told plainly, not shown an error to retry', async () => {
  axios.get.mockImplementation((url) => url.endsWith('/editable')
    ? Promise.reject({ response: { status: 403, data: { error: 'Forbidden' } } })
    : Promise.resolve({ data: { turnCap: 30, userRunCeiling: 120 } }));
  renderPolicy();
  expect(await screen.findByText("Only this agent's owner and admins can edit its memory.")).toBeInTheDocument();
  expect(screen.queryByText('Forbidden')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('a retry that comes back forbidden reads as owner-only, not as the raw error', async () => {
  let memoryCalls = 0;
  axios.get.mockImplementation((url) => {
    if (!url.endsWith('/editable')) return Promise.resolve({ data: { turnCap: 30, userRunCeiling: 120 } });
    memoryCalls += 1;
    return Promise.reject(memoryCalls === 1 ? new Error('Network Error')
      : { response: { status: 403, data: { error: 'Forbidden' } } });
  });
  renderPolicy();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText("Only this agent's owner and admins can edit its memory.")).toBeInTheDocument();
  expect(screen.queryByText('Forbidden')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
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

it('shows Saved in the trust row for a moment, then leaves the button alone', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('radio', { name: 'Allow repository edits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save trust mode' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save trust mode' })).toBeInTheDocument();
  } finally { jest.useRealTimers(); }
});

it('a failed trust save stays in the action slot', async () => {
  update.mockRejectedValueOnce(new Error('Could not save changes.'));
  renderPolicy();
  await screen.findByDisplayValue('Original');
  fireEvent.click(screen.getByRole('button', { name: 'Save trust mode' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not save changes.');
  expect(alert.closest('.ac')).toContainElement(screen.getByRole('button', { name: 'Save trust mode' }));
});

it('the memory editor keeps its Saved until the next action', async () => {
  renderPolicy();
  await screen.findByDisplayValue('Original');
  jest.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText('Long-term'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  } finally { jest.useRealTimers(); }
});

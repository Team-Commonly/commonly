// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from '../../utils/axiosConfig';
import V2AgentSkills from '../components/V2AgentSkills';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

const installed = {
  items: [{ name: 'review', description: 'Checks code' }, { name: 'draft', description: 'Writes drafts' }],
  canEdit: true,
  skillLoad: { at: '2026-10-23T16:00:00Z', mounted: ['review'], conflicted: ['draft'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/catalog')
    ? { items: [{ name: 'plan', description: 'Plans work', sourceUrl: 'https://github.com/example/plan' }] }
    : installed }));
});

test('shows the last reported spawn state and installer controls', async () => {
  render(<V2AgentSkills pods={[{ id: 'pod', name: 'Sharpen' }]} agentName="scout" instanceId="default" />);
  expect(await screen.findByText('Loaded at last spawn')).toBeInTheDocument();
  expect(screen.getByText('Could not load at last spawn')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add skill' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByRole('button', { name: 'Add plan' })).toBeInTheDocument();
  axios.post.mockResolvedValue({ data: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/skills/import', expect.objectContaining({
    podId: 'pod', agentName: 'scout', instanceId: 'default', scope: 'agent', name: 'plan',
  })));
});

test('shows installed skills read-only to other pod members', async () => {
  axios.get.mockResolvedValue({ data: { ...installed, canEdit: false, skillLoad: null } });
  render(<V2AgentSkills pods={[{ id: 'pod', name: 'Sharpen' }]} agentName="scout" instanceId="default" />);
  expect(await screen.findAllByText('No spawn report yet')).toHaveLength(2);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

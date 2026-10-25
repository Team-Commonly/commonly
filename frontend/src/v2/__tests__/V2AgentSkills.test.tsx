// @ts-nocheck
import React from 'react';
import i18n from '../../i18n';
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
  render(<V2AgentSkills podId="pod" podName="Planning" agentName="scout" instanceId="default" />);
  expect(screen.getByText('Pod · Planning')).toBeInTheDocument();
  expect(await screen.findByText('Loaded at last spawn')).toBeInTheDocument();
  expect(screen.getByText('Could not load at last spawn')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add skill' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByRole('button', { name: 'Add plan' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Find a skill'), { target: { value: 'plan' } });
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/skills/catalog', {
    params: { source: 'awesome', limit: 60, q: 'plan' },
  }));
  expect(await screen.findByRole('button', { name: 'Add plan' })).toBeInTheDocument();
  axios.post.mockResolvedValue({ data: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/skills/import', expect.objectContaining({
    podId: 'pod', agentName: 'scout', instanceId: 'default', scope: 'agent', name: 'plan',
  })));
});

test('shows installed skills read-only to other pod members', async () => {
  axios.get.mockResolvedValue({ data: { ...installed, canEdit: false, skillLoad: null } });
  render(<V2AgentSkills podId="pod" podName="Planning" agentName="scout" instanceId="default" />);
  expect(await screen.findAllByText('No spawn report yet')).toHaveLength(2);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('shows unavailable rather than not loaded when the last skill read failed', async () => {
  axios.get.mockResolvedValue({ data: {
    ...installed,
    skillLoad: { at: '2026-10-23T16:00:00Z', mounted: [], conflicted: [], status: 'unavailable' },
  } });
  render(<V2AgentSkills podId="pod" podName="Planning" agentName="scout" instanceId="default" />);
  expect(await screen.findAllByText('Skill status unavailable at last spawn')).toHaveLength(2);
  expect(screen.queryByText('Not loaded at last spawn')).not.toBeInTheDocument();
});


test.each(['en', 'zh-CN'])('skill report date uses app language (%s)', async (language) => {
  await i18n.changeLanguage(language);
  const view = render(<V2AgentSkills podId="pod" podName="Planning" agentName="scout" instanceId="default" />);
  try {
    const date = new Date(installed.skillLoad.at).toLocaleString(language, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    expect(await screen.findByText(i18n.t('agentSkills.reported', { date }))).toBeInTheDocument();
  } finally { view.unmount(); await i18n.changeLanguage('en'); }
});

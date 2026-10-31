// @ts-nocheck
// The registry-entry owner's controls in the agent identity section (TASK-419
// part 2, UI). The GET names the publisher; only that user sees the rename and
// retire controls. The server re-checks ownership on every PATCH.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AgentIdentitySection from '../agents/V2AgentIdentitySection';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn() },
}));

const installation = {
  name: 'scout',
  instanceId: 'scout-1',
  displayName: 'Scout',
  profile: null,
};

const entry = (publisherId, status = 'active') => ({
  data: { status, registry: 'public', verified: true, displayName: 'Scout Agent', publisher: { userId: publisherId } },
});

const renderSection = (viewerId) => {
  render(
    <AuthContext.Provider value={{ currentUser: { _id: viewerId, username: 'maya' }, user: { _id: viewerId } }}>
      <MemoryRouter>
        <V2AgentIdentitySection installation={installation} update={jest.fn()} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const retireButton = () => screen.queryByRole('button', { name: 'Retire listing' });

describe('V2AgentIdentitySection — registry entry owner controls (TASK-419)', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    axios.get.mockReset();
    axios.patch.mockReset();
  });

  afterEach(() => cleanup());

  test('the publisher sees the listing controls; another user does not', async () => {
    axios.get.mockResolvedValue(entry('owner-1'));
    renderSection('someone-else');
    // The listing status flips to "Published" only after the GET resolves, so
    // waiting for it makes the absence check run after the owner data lands.
    await screen.findByText('Published');
    expect(retireButton()).toBeNull();
    cleanup();

    axios.get.mockResolvedValue(entry('owner-1'));
    renderSection('owner-1');
    expect(await screen.findByRole('button', { name: 'Retire listing' })).toBeInTheDocument();
  });

  test('retire PATCHes the owned-entry route and flips to restore', async () => {
    axios.get.mockResolvedValue(entry('owner-1'));
    axios.patch.mockResolvedValue({ data: { agentName: 'scout', displayName: 'Scout Agent', status: 'unpublished' } });
    renderSection('owner-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Retire listing' }));

    await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(1));
    const [url, body] = axios.patch.mock.calls[0];
    expect(String(url)).toContain('/api/registry/agents/scout/owned-entry');
    expect(body).toEqual({ retired: true });
    expect(await screen.findByRole('button', { name: 'Restore listing' })).toBeInTheDocument();
  });

  test('retire moves the status line to Not published, from the PATCH answer', async () => {
    axios.get.mockResolvedValue(entry('owner-1'));
    axios.patch.mockResolvedValue({ data: { agentName: 'scout', displayName: 'Scout Agent', status: 'unpublished' } });
    renderSection('owner-1');
    await screen.findByText('Published');
    fireEvent.click(await screen.findByRole('button', { name: 'Retire listing' }));

    // Without the fix the status line keeps "Published" after the entry is retired.
    expect(await screen.findByText('Not published')).toBeInTheDocument();
    expect(screen.queryByText('Published')).toBeNull();
  });

  test('restore moves the status line back to Published, using the GET verified flag', async () => {
    axios.get.mockResolvedValue(entry('owner-1', 'unpublished'));
    axios.patch.mockResolvedValue({ data: { agentName: 'scout', displayName: 'Scout Agent', status: 'active' } });
    renderSection('owner-1');
    await screen.findByText('Not published');
    fireEvent.click(await screen.findByRole('button', { name: 'Restore listing' }));

    expect(await screen.findByText('Published')).toBeInTheDocument();
  });

  test('saving the listing name PATCHes displayName to the owned-entry route', async () => {
    axios.get.mockResolvedValue(entry('owner-1'));
    axios.patch.mockResolvedValue({ data: {} });
    renderSection('owner-1');
    const input = await screen.findByDisplayValue('Scout Agent');
    fireEvent.change(input, { target: { value: '  Scout Pro  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing name' }));

    await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(1));
    const [url, body] = axios.patch.mock.calls[0];
    expect(String(url)).toContain('/api/registry/agents/scout/owned-entry');
    expect(body).toEqual({ displayName: 'Scout Pro' });
  });

  test('a failed save shows the alert and leaves the entry as it was', async () => {
    axios.get.mockResolvedValue(entry('owner-1'));
    axios.patch.mockRejectedValue(new Error('500'));
    renderSection('owner-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Retire listing' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't update this listing. Try again.");
    expect(retireButton()).toBeInTheDocument();
  });
});

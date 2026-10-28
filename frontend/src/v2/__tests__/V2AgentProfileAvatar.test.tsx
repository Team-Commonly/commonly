import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentProfile from '../agents/V2AgentProfile';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const profileClient = { get: jest.fn(), post: jest.fn(), put: jest.fn() };
  return {
    __esModule: true,
    default: { create: jest.fn(() => profileClient) },
    __profileClient: profileClient,
  };
});
jest.mock('../../utils/avatarUtils', () => ({
  presetCharacterOptions: jest.fn((seed: string) => [
    { id: `bottts:${seed}-v1`, src: `pick:${seed}-v1` },
    { id: `bottts:${seed}-v2`, src: `pick:${seed}-v2` },
  ]),
}));
jest.mock('../utils/avatars', () => ({
  characterAvatarFor: jest.fn((seed: string) => `face:${seed}`),
}));
// Expose the seed the hero avatar is drawn from.
jest.mock('../components/V2Avatar', () => ({
  __esModule: true,
  default: ({ seed }: { seed?: string }) => <span data-testid="hero-avatar" data-seed={seed} />,
}));

const profileClient = (jest.requireMock('axios') as {
  __profileClient: { get: jest.Mock; post: jest.Mock; put: jest.Mock };
}).__profileClient;

const renderProfile = () => render(
  <MemoryRouter initialEntries={['/v2/agents/openclaw/aria']}>
    <Routes>
      <Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentProfile />} />
    </Routes>
  </MemoryRouter>,
);

const payload = (profilePicture: string, userId: string | undefined = 'bot-user-1') => ({
  data: {
    agent: {
      agentName: 'openclaw',
      instanceId: 'aria',
      displayName: 'Aria',
      userId,
      profilePicture,
      runtime: null,
      officialAgent: false,
      capabilities: [],
    },
    skills: [],
    pods: { count: 0, public: [] },
    memory: { has: false, entryCount: 0 },
    activity: [],
  },
});

const mockProfile = (profilePicture: string, canEdit = true, userId?: string) => {
  profileClient.get.mockImplementation((url: string) => {
    if (url.endsWith('/avatar/can-edit')) return Promise.resolve({ data: { canEdit } });
    if (url.startsWith('/api/agent-memory/')) return Promise.reject(new Error('not owner'));
    return Promise.resolve(payload(profilePicture, userId));
  });
};

const openPicker = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Change avatar' }));
  return screen.findByRole('region', { name: 'Choose an avatar' });
};

describe('V2AgentProfile avatar picker', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('token', 'owner-token');
    jest.clearAllMocks();
    profileClient.put.mockResolvedValue({ data: { ok: true } });
  });

  it('draws the unpicked face from the bot user id, the seed chat and Your Team use', async () => {
    mockProfile('default');
    renderProfile();

    expect(await screen.findByTestId('hero-avatar')).toHaveAttribute('data-seed', 'bot-user-1');
  });

  it('falls back to the agent identity when the profile carries no user id', async () => {
    mockProfile('default', true, '');
    renderProfile();

    expect(await screen.findByTestId('hero-avatar')).toHaveAttribute('data-seed', 'openclaw:aria');
  });

  it('offers the current default face first and marks it as current', async () => {
    mockProfile('default');
    renderProfile();
    const picker = await openPicker();

    const choices = within(picker).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'));
    expect(choices).toHaveLength(3);
    expect(choices[0]).toHaveAccessibleName('Default avatar');
    expect(choices[0]).toHaveAttribute('aria-pressed', 'true');
    expect(choices[0].querySelector('img')).toHaveAttribute('src', 'face:bot-user-1');
    expect(choices[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks a saved pick as current and resets to the default', async () => {
    mockProfile('bottts:openclaw:aria-v2');
    renderProfile();
    await openPicker();

    expect(screen.getByRole('button', { name: 'Avatar 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Default avatar' }));

    expect(profileClient.put).toHaveBeenCalledWith(
      '/api/agent-profile/openclaw/aria/avatar',
      { avatar: 'default' },
      expect.anything(),
    );
  });

  it('does not save when the current avatar is clicked again', async () => {
    mockProfile('default');
    renderProfile();
    await openPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Default avatar' }));
    expect(profileClient.put).not.toHaveBeenCalled();
  });

  it('says so when the save fails', async () => {
    mockProfile('default');
    profileClient.put.mockRejectedValue(new Error('403'));
    renderProfile();
    await openPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Avatar 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the avatar. Try again.');
  });

  it('shows no edit control to a viewer who cannot edit', async () => {
    mockProfile('default', false);
    renderProfile();

    await screen.findByTestId('hero-avatar');
    expect(screen.queryByRole('button', { name: 'Change avatar' })).toBeNull();
  });
});

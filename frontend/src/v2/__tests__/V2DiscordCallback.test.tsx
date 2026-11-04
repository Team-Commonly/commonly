// @ts-nocheck
import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2DiscordCallback from '../components/V2DiscordCallback';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: [] })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

const Where = () => <p>{`at ${useLocation().pathname}`}</p>;

// /from is the page the person left for Discord, so Back / Cancel (-1) lands there.
const renderAt = (url) => {
  const type = url.startsWith('/discord/success') ? 'success' : url.startsWith('/discord/error') ? 'error' : undefined;
  return render(
    <MemoryRouter initialEntries={['/from', url]} initialIndex={1}>
      <Routes>
        <Route path="/discord/*" element={<V2DiscordCallback type={type} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
};

const wire = (container) => container.querySelector('.v2-handoff__wire');

beforeAll(async () => {
  await i18nReady;
});

afterEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
  localStorage.clear();
  await i18n.changeLanguage('en');
});

describe('V2DiscordCallback (d215 s-handoff)', () => {
  test('callback is the working card: one status line and a running wire, no subtitle', () => {
    const { container } = renderAt('/discord/callback');
    expect(screen.getByRole('status')).toHaveTextContent('Connecting Discord…');
    expect(wire(container)).toHaveClass('v2-handoff__wire--working');
    expect(wire(container).querySelector('.v2-handoff__run')).not.toBeNull();
    expect(container.querySelector('.v2-login__subtitle')).toBeNull();
    expect(container.querySelector('.v2-handoff__tile--discord svg')).not.toBeNull();
  });

  test('error shows the server line as plain text, an ink cross, and Back goes to the previous page', () => {
    const { container } = renderAt(`/discord/error?error=${encodeURIComponent('<b>Invalid</b> state parameter')}`);
    expect(screen.getByRole('heading', { name: "Discord didn't connect" })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('<b>Invalid</b> state parameter');
    expect(screen.getByRole('alert').querySelector('b')).toBeNull();
    expect(wire(container)).toHaveClass('v2-handoff__wire--error');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('at /from')).toBeInTheDocument();
  });

  test('error with no server line falls back to the generic one', () => {
    renderAt('/discord/error');
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong during Discord authorization.');
  });

  test('success asks for the channel, posts the same integration and moves to the pod after 2s', async () => {
    jest.useFakeTimers();
    localStorage.setItem('token', 'jwt');
    axios.get.mockImplementation((url) => (url === '/api/discord/channels/g1'
      ? Promise.resolve({ data: [{ id: 'c1', name: 'general', topic: 'chat' }, { id: 'c2', name: 'ops' }] })
      : Promise.resolve({ data: { type: 'study' } })));
    const { container } = renderAt('/discord/success?pod_id=p1&guild_id=g1&server_name=Northwind%20HQ');

    expect(screen.getByRole('heading', { name: 'Pick a channel' })).toBeInTheDocument();
    expect(wire(container)).toHaveClass('v2-handoff__wire--done');
    expect(container.querySelector('.v2-handoff__facts')).toHaveTextContent('ServerNorthwind HQ');
    expect(axios.get).toHaveBeenCalledWith('/api/discord/channels/g1', { headers: { Authorization: 'Bearer jwt' } });
    const select = await screen.findByRole('combobox', { name: 'Channel' });
    await screen.findByRole('option', { name: '#general - chat' });
    // Starts on the placeholder, not on the first channel.
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose a channel' })).toBeDisabled();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();

    fireEvent.change(select, { target: { value: 'c2' } });
    expect(connect).toBeEnabled();
    await act(async () => { fireEvent.click(connect); });

    expect(axios.post).toHaveBeenCalledWith('/api/integrations', {
      podId: 'p1',
      type: 'discord',
      config: {
        serverId: 'g1',
        serverName: 'Northwind HQ',
        channelId: 'c2',
        channelName: 'ops',
        webhookUrl: '',
        botToken: '',
        permissions: ['read_messages', 'send_messages', 'read_message_history'],
      },
    }, { headers: { Authorization: 'Bearer jwt' } });
    expect(screen.getByRole('heading', { name: 'Discord connected' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Discord integration created successfully!'));
    expect(screen.queryByRole('combobox')).toBeNull();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.getByText('at /pods/study/p1')).toBeInTheDocument();
  });

  test('a failed channel fetch and a failed create each land in the alert row', async () => {
    axios.get.mockRejectedValueOnce(new Error('nope'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/discord/success?pod_id=p1&guild_id=g1&server_name=S');
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch server channels');
  });

  test('the server message from a failed create shows, and the keys stay', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'general' }] });
    axios.post.mockRejectedValueOnce({ response: { data: { message: 'Integration exists' } } });
    renderAt('/discord/success?pod_id=p1&guild_id=g1&server_name=S');
    const select = await screen.findByRole('combobox', { name: 'Channel' });
    await screen.findByRole('option', { name: '#general' });
    fireEvent.change(select, { target: { value: 'c1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Integration exists');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  test('reads in Chinese under zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderAt('/discord/error');
    expect(screen.getByRole('heading', { name: 'Discord 连接失败' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
  });
});

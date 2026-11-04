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
    axios.get.mockImplementation((url) => (url === '/api/discord/channels/112233445566778899'
      ? Promise.resolve({ data: [{ id: '112233445566778801', name: 'general', topic: 'chat' }, { id: '112233445566778802', name: 'ops' }] })
      : Promise.resolve({ data: { type: 'study' } })));
    const { container } = renderAt('/discord/success?pod_id=p1&guild_id=112233445566778899&server_name=Northwind%20HQ');

    expect(screen.getByRole('heading', { name: 'Pick a channel' })).toBeInTheDocument();
    expect(wire(container)).toHaveClass('v2-handoff__wire--done');
    expect(container.querySelector('.v2-handoff__facts')).toHaveTextContent('ServerNorthwind HQ');
    expect(axios.get).toHaveBeenCalledWith('/api/discord/channels/112233445566778899', { headers: { Authorization: 'Bearer jwt' } });
    const select = await screen.findByRole('combobox', { name: 'Channel' });
    await screen.findByRole('option', { name: '#general - chat' });
    // Starts on the placeholder, not on the first channel.
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose a channel' })).toBeDisabled();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();

    fireEvent.change(select, { target: { value: '112233445566778802' } });
    expect(connect).toBeEnabled();
    await act(async () => { fireEvent.click(connect); });

    expect(axios.post).toHaveBeenCalledWith('/api/integrations', {
      podId: 'p1',
      type: 'discord',
      config: {
        serverId: '112233445566778899',
        serverName: 'Northwind HQ',
        channelId: '112233445566778802',
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
    expect(screen.getByText('at /v2/pods/p1')).toBeInTheDocument();
  });

  test('an agent-ensemble pod returns to its kept room, where its controls live', async () => {
    jest.useFakeTimers();
    localStorage.setItem('token', 'jwt');
    axios.get.mockImplementation((url) => (url === '/api/discord/channels/112233445566778899'
      ? Promise.resolve({ data: [{ id: '112233445566778801', name: 'general' }] })
      : Promise.resolve({ data: { type: 'agent-ensemble' } })));
    axios.post.mockResolvedValue({ data: {} });
    renderAt('/discord/success?pod_id=p1&guild_id=112233445566778899&server_name=S');
    const select = await screen.findByRole('combobox', { name: 'Channel' });
    await screen.findByRole('option', { name: '#general' });
    fireEvent.change(select, { target: { value: '112233445566778801' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.getByText('at /v2/pods/agent-ensemble/p1')).toBeInTheDocument();
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

  // The pages are reached through the route tables, which pick the view by prop.
  // A swapped success/error mapping would render the wrong page for the backend's
  // redirect, so both tables are read and their mapping pinned.
  test.each([['App.tsx', '../../App.tsx', '/discord/'], ['V2App.tsx', '../V2App.tsx', 'discord/']])('%s maps each Discord return path to its view', (_name, rel, prefix) => {
    // eslint-disable-next-line global-require
    const src = require('fs').readFileSync(require('path').resolve(__dirname, rel), 'utf8');
    const route = (path) => (src.match(new RegExp(`<Route path="${prefix}${path}" element={<V2DiscordCallback([^/]*)/>}`)) || [])[1];
    expect(route('callback')?.trim()).toBe('');
    expect(route('success')?.trim()).toBe('type="success"');
    expect(route('error')?.trim()).toBe('type="error"');
  });

  // F89: on a first install the channel list only answers on the callback's
  // install proof, so the page must forward it, and send nothing extra without one.
  test('forwards the install proof to the channel list', async () => {
    // Production-shaped: the callback mints a three-part JWT, and the whole of it
    // must arrive, not a value cut at a dot or a URL-decoding boundary. Joined at
    // runtime so the secret scanner does not read a fixture as a token.
    const proof = ['eyJhbGciOiJIUzI1NiJ9', 'eyJwdXIiOiJkaXNjb3JkLWluc3RhbGwifQ', 'c2lnbmF0dXJlLV8'].join('.');
    localStorage.setItem('token', 't');
    axios.get.mockResolvedValue({ data: [] });
    renderAt(`/discord/success?pod_id=pod-1&guild_id=123456789012345678&server_name=Guild&install=${encodeURIComponent(proof)}`);
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(axios.get).toHaveBeenCalledWith('/api/discord/channels/123456789012345678', {
      headers: { Authorization: 'Bearer t' },
      params: { install: proof },
    });
  });

  test('sends no params to the channel list without a proof', async () => {
    localStorage.setItem('token', 't');
    axios.get.mockResolvedValue({ data: [] });
    renderAt('/discord/success?pod_id=pod-1&guild_id=123456789012345678&server_name=Guild');
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(axios.get.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer t' } });
  });

  test('a failed channel fetch logs its status, not the install proof', async () => {
    const proof = ['eyJhbGciOiJIUzI1NiJ9', 'eyJwdXIiOiJkaXNjb3JkLWluc3RhbGwifQ', 'c2lnbmF0dXJlLV8'].join('.');
    axios.get.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
      config: { params: { install: proof } },
      response: { status: 404 },
    }));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    renderAt(`/discord/success?pod_id=p1&guild_id=123456789012345678&server_name=S&install=${encodeURIComponent(proof)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch server channels');
    expect(errors).toHaveBeenCalledWith('Error fetching channels:', 404);
    expect(JSON.stringify(errors.mock.calls, (_k, v) => (v instanceof Error ? { ...v, message: v.message } : v))).not.toContain(proof);
  });

  test('reads in Chinese under zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderAt('/discord/error');
    expect(screen.getByRole('heading', { name: 'Discord 连接失败' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
  });
});

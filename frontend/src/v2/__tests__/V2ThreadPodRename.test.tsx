// @ts-nocheck
// Owner-only pod rename in the thread header (TASK-419 part 1, UI). The server
// is the authority (PATCH /api/pods/:id/name refuses non-creators); the header
// only offers the control to the creator, then re-reads the pod on success.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  axios.patch.mockClear();
  axios.patch.mockImplementation(() => Promise.resolve({ data: {} }));
});

afterEach(() => cleanup());

const authValue = (id) => ({
  currentUser: { _id: id, username: 'maya' },
  user: { _id: id, username: 'maya' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
});

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

const pod = (createdBy) => ({ _id: 'pod-1', name: 'Launch notes', type: 'chat', createdBy });

const renderHeader = ({ viewerId = 'u1', createdBy = 'u1', refresh = jest.fn() } = {}) => {
  const detail = {
    pod: pod(createdBy),
    members: [{ _id: viewerId, username: 'maya', isBot: false }],
    messages: [],
    agents: [],
    sendMessage: jest.fn(),
    loading: false,
    error: null,
    refresh,
  };
  render(
    <AuthContext.Provider value={authValue(viewerId)}>
      <MemoryRouter>
        <V2Thread detail={detail} />
        <Location />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return { refresh };
};

const renameButton = () => screen.queryByRole('button', { name: 'Rename' });

describe('V2Thread — owner-only pod rename (TASK-419)', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  test('the creator sees Rename; another member does not', () => {
    renderHeader({ viewerId: 'u2', createdBy: 'u1' });
    expect(renameButton()).toBeNull();
    cleanup();

    renderHeader({ viewerId: 'u1', createdBy: 'u1' });
    expect(renameButton()).toBeInTheDocument();
  });

  test('D215: Rename is a pencil icon button on the title, named by aria-label and title', () => {
    renderHeader();
    const pencil = renameButton();
    expect(pencil).toHaveAttribute('title', 'Rename');
    expect(pencil).toHaveTextContent('');
    expect(pencil.querySelector('svg')).toBeTruthy();
    expect(pencil.closest('.v2-thread__title-line')).toBeTruthy();
  });

  test('D215: the board count is a chip with a glyph, and it still opens the board', async () => {
    axios.get.mockImplementation((url) => Promise.resolve({
      data: url.includes('/api/v1/tasks/') ? { tasks: [{ status: 'pending' }, { status: 'claimed' }, { status: 'done' }] } : {},
    }));
    renderHeader();
    const chips = await screen.findAllByRole('button', { name: 'board 2 open' });
    // The desktop meta and the phone line each carry one; CSS shows one.
    expect(chips).toHaveLength(2);
    chips.forEach((chip) => {
      expect(chip).toHaveAttribute('title', 'board 2 open');
      expect(chip).toHaveTextContent(/^2$/);
      expect(chip.querySelector('svg')).toBeTruthy();
    });
    fireEvent.click(chips[0]);
    expect(await screen.findByTestId('location')).toHaveTextContent('/v2/pods/pod-1/board');
    axios.get.mockImplementation(() => Promise.resolve({ data: {} }));
  });

  test('saving sends the trimmed name, then re-reads the pod', async () => {
    const { refresh } = renderHeader();
    fireEvent.click(renameButton());

    const input = screen.getByRole('textbox', { name: 'Pod name' });
    expect(input).toHaveValue('Launch notes');
    fireEvent.change(input, { target: { value: '  Q4 launch  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, body] = axios.patch.mock.calls[0];
    expect(String(url)).toContain('/api/pods/pod-1/name');
    expect(body).toEqual({ name: 'Q4 launch' });
    expect(screen.queryByRole('textbox', { name: 'Pod name' })).toBeNull();
  });

  test('a failed save keeps the form open and says so', async () => {
    axios.patch.mockImplementation(() => Promise.reject(new Error('403')));
    const { refresh } = renderHeader();
    fireEvent.click(renameButton());
    fireEvent.change(screen.getByRole('textbox', { name: 'Pod name' }), { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't rename this pod. Try again.");
    expect(screen.getByRole('textbox', { name: 'Pod name' })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  test('Save stays disabled for a blank name', () => {
    renderHeader();
    fireEvent.click(renameButton());
    fireEvent.change(screen.getByRole('textbox', { name: 'Pod name' }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

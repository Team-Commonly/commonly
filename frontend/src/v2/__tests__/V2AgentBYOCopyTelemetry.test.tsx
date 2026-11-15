// @ts-nocheck
// BYO copy telemetry: every copy surface that writes a command must post its
// step. The "Add a computer" daemon command was the one that did not (TASK-653:
// 6 seats were created in a week and no copy step was ever recorded).
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { recordByoStep } from '../utils/byoTelemetry';

jest.mock('../utils/byoTelemetry', () => ({
  recordByoStep: jest.fn(),
  recordByoStepOnce: jest.fn(),
  resetByoStepsForTest: jest.fn(),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const mockGet = () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: 'agent' } });
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  window.history.pushState({}, '', '/v2/agents/byo');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  mockGet();
});

afterEach(() => {
  jest.clearAllMocks();
});

const stepsPosted = () => recordByoStep.mock.calls.map(([, step]) => step);

test('copying the add-a-computer daemon command posts daemon-command-copied', async () => {
  renderPage();
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
  const block = await screen.findByTestId('byo-add-computer');
  await act(async () => {
    fireEvent.click(block.querySelector('button.v2-byo__copy'));
  });

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('daemon setup --instance'));
  expect(stepsPosted()).toContain('daemon-command-copied');
});

test('a failed daemon copy posts no copy step', async () => {
  navigator.clipboard.writeText.mockRejectedValueOnce(new Error('Denied'));
  renderPage();
  const block = await screen.findByTestId('byo-add-computer');
  await act(async () => {
    fireEvent.click(block.querySelector('button.v2-byo__copy'));
  });

  expect(stepsPosted()).not.toContain('daemon-command-copied');
});

// TASK-714: the copy says which command it was and what the page showed, so
// the server can tell "the listener was possible" from "it was not".
const withUserAgent = (ua: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua });
};
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Issue a seat so the result page renders (the same path the listen-snippet
// suite drives), then return the page's own setup telemetry.
const issueSeatAndReadSetup = async () => {
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
  renderPage();
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
  return recordByoStep.mock.calls.find(([, step]) => step === 'seat-created');
};

test.each([
  ['mac', MAC_UA, true],
  ['windows', WINDOWS_UA, true],
])('the %s result page records the setup it shows (listener %s)', async (os, ua, listenerAvailable) => {
  const original = window.navigator.userAgent;
  withUserAgent(ua);
  try {
    const call = await issueSeatAndReadSetup();
    expect(call?.[2]).toEqual({ setupOs: os, listenerAvailable });
  } finally {
    withUserAgent(original);
  }
});

test('a Mac daemon copy posts its command type with the setup the page showed', async () => {
  const original = window.navigator.userAgent;
  withUserAgent(MAC_UA);
  try {
    renderPage();
    // The block's place follows the mode picker (F370), so it remounts once
    // the page's reads settle; a click before that lands on a detached button.
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
    const block = await screen.findByTestId('byo-add-computer');
    await act(async () => {
      fireEvent.click(block.querySelector('button.v2-byo__copy'));
    });

    const call = recordByoStep.mock.calls.find(([, step]) => step === 'daemon-command-copied');
    expect(call?.[2]).toEqual({ setupOs: 'mac', listenerAvailable: true, copyType: 'daemon' });
    expect(JSON.stringify(call)).not.toMatch(/commonly daemon|cm_agent/);
  } finally {
    withUserAgent(original);
  }
});

// 11-15: a person on Windows reached the result page, and the key was never
// used, with no copy step recorded. A copy made by selecting the command and
// pressing Ctrl+C posted nothing, and on Windows it left out the final newline
// the Copy button adds, so the run line sat typed at the prompt.
describe('a hand copy (select, then Ctrl+C)', () => {
  const handCopy = (block, selected) => {
    const setData = jest.fn();
    const getSelection = jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => selected });
    // fireEvent returns false when the handler cancelled the browser's own copy.
    setData.kept = fireEvent.copy(block.querySelector('pre'), { clipboardData: { setData } });
    getSelection.mockRestore();
    return setData;
  };
  const listenBlock = () => screen.getByTestId('byo-listen').querySelector('.v2-byo__command');

  test.each([['mac', MAC_UA], ['windows', WINDOWS_UA]])('of the %s listen lines posts cli-command-copied', async (os, ua) => {
    const original = window.navigator.userAgent;
    withUserAgent(ua);
    try {
      await issueSeatAndReadSetup();
      const text = listenBlock().querySelector('pre').textContent;
      handCopy(listenBlock(), text);
      const call = recordByoStep.mock.calls.find(([, step]) => step === 'cli-command-copied');
      expect(call?.[2]).toEqual({ setupOs: os, listenerAvailable: true, copyType: 'listen' });
    } finally {
      withUserAgent(original);
    }
  });

  test('on Windows, a copy that reaches the run line gets the final newline', async () => {
    const original = window.navigator.userAgent;
    withUserAgent(WINDOWS_UA);
    try {
      await issueSeatAndReadSetup();
      const text = listenBlock().querySelector('pre').textContent;
      expect(text).toMatch(/commonly\.cmd agent run/);
      const setData = handCopy(listenBlock(), text);
      expect(setData).toHaveBeenCalledWith('text/plain', `${text}\n`);
      expect(setData.kept).toBe(false);
    } finally {
      withUserAgent(original);
    }
  });

  test('on Windows, a copy of only the first lines, or one that already ends in a newline, is left alone', async () => {
    const original = window.navigator.userAgent;
    withUserAgent(WINDOWS_UA);
    try {
      await issueSeatAndReadSetup();
      const text = listenBlock().querySelector('pre').textContent;
      expect(handCopy(listenBlock(), text.split('\n')[0])).not.toHaveBeenCalled();
      expect(handCopy(listenBlock(), `${text}\n`)).not.toHaveBeenCalled();
    } finally {
      withUserAgent(original);
    }
  });

  test('on a Mac the copy is left as the browser made it', async () => {
    const original = window.navigator.userAgent;
    withUserAgent(MAC_UA);
    try {
      await issueSeatAndReadSetup();
      const text = listenBlock().querySelector('pre').textContent;
      const setData = handCopy(listenBlock(), text);
      expect(setData).not.toHaveBeenCalled();
      expect(setData.kept).toBe(true);
      expect(stepsPosted()).toContain('cli-command-copied');
    } finally {
      withUserAgent(original);
    }
  });
});

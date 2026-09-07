// @ts-nocheck
// Catch-up earns its row from the existing summary's source evidence.
import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import V2CatchUpStrip from '../components/V2CatchUpStrip';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const summary = (overrides = {}) => ({
  content: 'Three messages worth catching up on.',
  createdAt: new Date(NOW - 5 * 60000).toISOString(),
  metadata: { totalItems: 3 },
  timeRange: { start: new Date(NOW - 3600000).toISOString(), end: new Date(NOW - 5 * 60000).toISOString() },
  ...overrides,
});

beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

describe('V2CatchUpStrip', () => {
  test('renders the latest summary as a one-line snippet with its age', async () => {
    axios.get.mockResolvedValueOnce({
      data: summary({ content: 'Otto verified the token split.\nKai shipped the daemon auth.' }),
    });
    render(<V2CatchUpStrip podId="p1" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    // Snippet is whitespace-collapsed to one line.
    expect(screen.getByText('Otto verified the token split. Kai shipped the daemon auth.')).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/summaries/pod/p1');
  });

  test('expanding an eligible summary shows the full body', async () => {
    axios.get.mockResolvedValueOnce({ data: summary({ content: 'Line one.\nLine two.' }) });
    render(<V2CatchUpStrip podId="p1" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Catch up/ }));
    expect(screen.getByTestId('catchup-body')).toHaveTextContent('Line one. Line two.');
  });

  // Sam's revised ruling, hours after the strip shipped (2026-09-01): "always
  // shows up is not a good design" — the strip EARNS its row. No summary, a
  // stale summary, or a dismissed one ⇒ no strip at all.
  test('a pod with no summary renders NO strip', async () => {
    axios.get.mockResolvedValueOnce({ data: null });
    render(<V2CatchUpStrip podId="p2" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test('a freshly generated summary covering only July stays hidden', async () => {
    axios.get.mockResolvedValueOnce({
      data: summary({ content: 'A quick update: hey guys', createdAt: new Date(NOW).toISOString(), metadata: { totalItems: 1 },
        timeRange: { start: '2026-07-01T00:00:00Z', end: '2026-07-01T01:00:00Z' } }),
    });
    render(<V2CatchUpStrip podId="p4" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test('dismiss hides this summary version and persists; the strip stays gone on re-render', async () => {
    const createdAt = new Date(Date.now() - 5 * 60000).toISOString();
    axios.get.mockResolvedValue({ data: summary({ content: 'Digest.', createdAt }) });
    const { unmount } = render(<V2CatchUpStrip podId="p5" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
    expect(window.localStorage.getItem('v2.catchup.dismissed.p5')).toBe(createdAt);
    unmount();
    render(<V2CatchUpStrip podId="p5" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test('a failed summary read never blocks the chat — and renders no strip', async () => {
    axios.get.mockRejectedValueOnce(new Error('403'));
    render(<V2CatchUpStrip podId="p3" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test.each([0, 1, 2, undefined, -1, 2.5, '3'])('hides insufficient or invalid source count %s', async (totalItems) => {
    axios.get.mockResolvedValue({ data: summary({ metadata: { totalItems } }) });
    await act(async () => { render(<V2CatchUpStrip podId="count-boundary" />); });
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test.each([
    ['inside seven days', 7 * DAY - 1, true],
    ['exactly seven days', 7 * DAY, false],
    ['past seven days', 7 * DAY + 1, false],
    ['future window', -1, false],
  ])('%s uses covered time rather than generation time', async (_label, age, visible) => {
    const end = NOW - age;
    axios.get.mockResolvedValue({ data: summary({ createdAt: new Date(NOW).toISOString(),
      timeRange: { start: new Date(end - 3600000).toISOString(), end: new Date(end).toISOString() } }) });
    await act(async () => { render(<V2CatchUpStrip podId="time-boundary" />); });
    expect(Boolean(screen.queryByTestId('catchup-strip'))).toBe(visible);
  });

  test.each([undefined, {}, { start: 'bad', end: 'bad' }, { start: new Date(NOW).toISOString(), end: new Date(NOW - 1).toISOString() }])('hides missing or invalid covered ranges %j', async (timeRange) => {
    axios.get.mockResolvedValue({ data: summary({ timeRange }) });
    await act(async () => { render(<V2CatchUpStrip podId="invalid-range" />); });
    expect(screen.queryByTestId('catchup-strip')).toBeNull();
  });

  test('refresh cannot replace an eligible strip with a thin or stale one', async () => {
    axios.get.mockResolvedValue({ data: summary() });
    axios.post.mockResolvedValue({ data: { summary: summary({ metadata: { totalItems: 2 } }) } });
    render(<V2CatchUpStrip podId="refresh" />);
    await screen.findByTestId('catchup-strip');
    fireEvent.click(screen.getByRole('button', { name: /Refresh|Summarize/ }));
    await waitFor(() => expect(screen.queryByTestId('catchup-strip')).toBeNull());
  });

  test('three messages covered six days ago remain eligible even if generated six days ago', async () => {
    axios.get.mockResolvedValue({ data: summary({ createdAt: new Date(NOW - 6 * DAY).toISOString(),
      timeRange: { start: new Date(NOW - 6 * DAY - 3600000).toISOString(), end: new Date(NOW - 6 * DAY).toISOString() } }) });
    render(<V2CatchUpStrip podId="six-days" />);
    expect(await screen.findByTestId('catchup-strip')).toBeInTheDocument();
  });
});

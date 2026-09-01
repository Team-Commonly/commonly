// @ts-nocheck
// The constant agents-TL;DR pinned above the transcript (Sam 2026-09-01).
// Pinned: reads the existing summaries surface, renders a one-line snippet,
// offers Summarize when the pod has none, and a refresh replaces the content.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

afterEach(() => jest.clearAllMocks());

describe('V2CatchUpStrip', () => {
  test('renders the latest summary as a one-line snippet with its age', async () => {
    axios.get.mockResolvedValueOnce({
      data: { content: 'Otto verified the token split.\nKai shipped the daemon auth.', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
    });
    render(<V2CatchUpStrip podId="p1" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    // Snippet is whitespace-collapsed to one line.
    expect(screen.getByText('Otto verified the token split. Kai shipped the daemon auth.')).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/summaries/pod/p1');
  });

  test('expanding shows the full body; no summary shows the Summarize action', async () => {
    axios.get.mockResolvedValueOnce({ data: { content: 'Line one.\nLine two.', createdAt: new Date().toISOString() } });
    render(<V2CatchUpStrip podId="p1" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Catch up/ }));
    expect(screen.getByTestId('catchup-body')).toHaveTextContent('Line one. Line two.');
  });

  test('a pod with no summary offers Summarize; refresh swaps in the generated summary', async () => {
    axios.get.mockResolvedValueOnce({ data: null });
    axios.post.mockResolvedValueOnce({ data: { summary: { content: 'Fresh digest.', createdAt: new Date().toISOString() } } });
    render(<V2CatchUpStrip podId="p2" />);
    await waitFor(() => expect(screen.getByText('No summary yet')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(screen.getByTestId('catchup-body')).toHaveTextContent('Fresh digest.'));
    expect(axios.post).toHaveBeenCalledWith('/api/summaries/pod/p2/refresh', {});
  });

  test('a failed summary read never blocks the chat — strip still renders', async () => {
    axios.get.mockRejectedValueOnce(new Error('403'));
    render(<V2CatchUpStrip podId="p3" />);
    await waitFor(() => expect(screen.getByTestId('catchup-strip')).toBeInTheDocument());
    expect(screen.getByText('No summary yet')).toBeInTheDocument();
  });
});

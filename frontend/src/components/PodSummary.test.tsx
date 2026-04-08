// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import PodSummary from './PodSummary';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
    get: jest.fn(),
    post: jest.fn(),
  },
}));

describe('PodSummary', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    axios.get.mockResolvedValue({
      data: {
        _id: 'summary-1',
        content: 'Existing summary content',
      },
    });
    axios.post.mockRejectedValue(new Error('refresh failed'));
  });

  afterEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  test('toggle switches to existing summary without forcing refresh', async () => {
    // Start in description mode so the "Show AI summary" button is visible
    localStorage.setItem('pod-summary-view:pod-1', 'description');
    render(
      <PodSummary
        podId="pod-1"
        podName="Pod 1"
        podType="chat"
        originalDescription="Original description"
      />,
    );

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        '/api/summaries/pod/pod-1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show AI summary' }));

    await waitFor(() => {
      expect(axios.post).not.toHaveBeenCalled();
      expect(screen.getByText('Existing summary content')).toBeInTheDocument();
      expect(screen.queryByText('Original description')).not.toBeInTheDocument();
    });
  });

  test('preserves summary view preference across remounts', async () => {
    // Start in description mode so the "Show AI summary" button is visible
    localStorage.setItem('pod-summary-view:pod-1', 'description');
    const { unmount } = render(
      <PodSummary
        podId="pod-1"
        title="Pod 1"
        originalDescription="Original description"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show AI summary' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show AI summary' }));

    await waitFor(() => {
      expect(screen.getByText('Existing summary content')).toBeInTheDocument();
    });

    unmount();

    render(
      <PodSummary
        podId="pod-1"
        title="Pod 1"
        originalDescription="Original description"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Existing summary content')).toBeInTheDocument();
    });
  });
});

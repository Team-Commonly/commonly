import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import PodSummary from './PodSummary';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
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

  test('shows summary view even when refresh fails', async () => {
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
      expect(axios.post).toHaveBeenCalledWith(
        '/api/summaries/pod/pod-1/refresh',
        {},
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Existing summary content')).toBeInTheDocument();
      expect(screen.queryByText('Original description')).not.toBeInTheDocument();
    });
  });
});

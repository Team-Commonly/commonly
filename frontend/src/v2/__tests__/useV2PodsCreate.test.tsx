import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2Pods } from '../hooks/useV2Pods';

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

describe('useV2Pods create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({
      _id: 'private-pod',
      name: 'Launch circle',
      type: 'team',
      joinPolicy: 'invite-only',
    });
  });

  it('passes an invite-only join policy through to the create endpoint', async () => {
    const { result } = renderHook(() => useV2Pods());
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/pods'));

    await act(async () => {
      await result.current.createPod(
        'Launch circle',
        'Prepare the launch',
        'team',
        'invite-only',
      );
    });

    expect(mockApi.post).toHaveBeenCalledWith('/api/pods', {
      name: 'Launch circle',
      description: 'Prepare the launch',
      type: 'team',
      joinPolicy: 'invite-only',
    });
  });
});

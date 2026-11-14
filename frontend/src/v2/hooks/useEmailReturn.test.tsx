import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useEmailReturn } from './useEmailReturn';

jest.mock('../../utils/axiosConfig', () => ({ __esModule: true, default: { post: jest.fn() } }));
let mockAuth = { isAuthenticated: true, currentUser: { _id: 'u1' } as { _id: string } | null };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

const post = axios.post as jest.Mock;
let seen = '';
const Probe: React.FC = () => {
  useEmailReturn();
  const location = useLocation();
  seen = `${location.pathname}${location.search}${location.hash}`;
  return null;
};
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>);
const TAG = 'mention.0123456789abcdef01234567';

// F519: an email link's ?em= is reported once on a signed-in load, then taken
// off the address so a refresh or a copied link carries no tag.
describe('useEmailReturn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    post.mockResolvedValue({ status: 204 });
    mockAuth = { isAuthenticated: true, currentUser: { _id: 'u1' } };
  });

  it('reports the tag once and drops it from the address, keeping the rest', async () => {
    mount(`/v2/pods/abc?x=1&em=${TAG}#m`);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/users/me/email-return', { tag: TAG }));
    await waitFor(() => expect(seen).toBe('/v2/pods/abc?x=1#m'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('waits for sign-in before reporting', async () => {
    mockAuth = { isAuthenticated: false, currentUser: null };
    mount(`/v2/activity?em=${TAG}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).not.toHaveBeenCalled();
    expect(seen).toBe(`/v2/activity?em=${TAG}`);
  });

  it('drops a malformed tag without reporting it', async () => {
    mount('/v2/activity?em=mention.not-hex');
    await waitFor(() => expect(seen).toBe('/v2/activity'));
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps the page when the report fails', async () => {
    post.mockRejectedValue(new Error('network'));
    mount(`/v2/activity?item=i1&em=${TAG}`);
    await waitFor(() => expect(seen).toBe('/v2/activity?item=i1'));
  });
});

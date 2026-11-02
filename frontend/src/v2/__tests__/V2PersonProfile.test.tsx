// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import { i18nReady } from '../../i18n';
import V2PersonProfile, { mapPublicActivity } from '../components/V2PersonProfile';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios');
jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = ({ name }: { name: string }) => <span>{name} avatar</span>;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

const mockGet = axios.get as jest.Mock;
const mockPost = axios.post as jest.Mock;
const mockDelete = axios.delete as jest.Mock;

const PERSON_ID = '64b7f0c2a1b2c3d4e5f60718';
const VIEWER_ID = '64b7f0c2a1b2c3d4e5f60799';

const person = {
  _id: PERSON_ID,
  displayName: 'Juno Park',
  username: 'junopark',
  profilePicture: 'default',
  createdAt: '2026-03-04T10:00:00.000Z',
  followersCount: 12,
  followingCount: 8,
  isFollowing: false,
  isBot: false,
};

const activity = {
  recentPublicPosts: [
    { id: 'post-1', content: 'Shipped the onboarding checklist.', createdAt: '2026-10-28T10:00:00.000Z' },
  ],
  joinedPods: [
    { id: 'pod-1', name: 'Northwind', membersCount: 7 },
    { id: 'pod-2', name: 'Launch room', membersCount: 12 },
  ],
};

const stubApi = (profile = person, activityData = activity) => {
  mockGet.mockImplementation((url: string) => {
    if (url === `/api/users/${profile._id}`) return Promise.resolve({ data: profile });
    if (url === `/api/users/${profile._id}/public-activity`) return Promise.resolve({ data: activityData });
    return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 } }));
  });
};

const renderProfile = (id = PERSON_ID, viewerId = VIEWER_ID) => render(
  <AuthContext.Provider value={{ currentUser: { _id: viewerId }, loading: false } as any}>
    <MemoryRouter initialEntries={[`/v2/profile/${id}`]}>
      <Routes>
        <Route path="/v2/profile/:id" element={<V2PersonProfile />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2PersonProfile', () => {
  beforeAll(async () => { await i18nReady; });
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('token', 'test-token');
  });

  it('renders the header, counts and pods in common from the API', async () => {
    stubApi();
    renderProfile();
    expect(await screen.findByRole('heading', { level: 1, name: 'Juno Park' })).toBeInTheDocument();
    expect(screen.getByText(/@junopark/)).toBeInTheDocument();
    expect(screen.getByTestId('profile-counts')).toHaveTextContent('12 followers · 8 following');
    expect(screen.getByRole('heading', { name: 'Pods in common' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Northwind/ })).toHaveAttribute('href', '/v2/pods/pod-1');
    expect(screen.getByText('7 members')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent posts' })).toBeInTheDocument();
    expect(screen.getByText('Shipped the onboarding checklist.')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(`/api/users/${PERSON_ID}`, { headers: { 'x-auth-token': 'test-token' } });
  });

  it('follows with an optimistic count and flips the key to Following', async () => {
    stubApi();
    let resolvePost;
    mockPost.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
    renderProfile();
    fireEvent.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(mockPost).toHaveBeenCalledWith(`/api/users/${PERSON_ID}/follow`, {}, { headers: { 'x-auth-token': 'test-token' } });
    expect(screen.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('profile-counts')).toHaveTextContent('13 followers');
    resolvePost({ data: {} });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Following' })).not.toBeDisabled());
  });

  it('unfollows with DELETE and reverts the count when the request fails', async () => {
    stubApi({ ...person, isFollowing: true });
    mockDelete.mockRejectedValue(new Error('network'));
    renderProfile();
    fireEvent.click(await screen.findByRole('button', { name: 'Following' }));
    expect(mockDelete).toHaveBeenCalledWith(`/api/users/${PERSON_ID}/follow`, { headers: { 'x-auth-token': 'test-token' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Following' })).toBeInTheDocument();
    expect(screen.getByTestId('profile-counts')).toHaveTextContent('12 followers');
  });

  it('shows Edit profile instead of Follow on your own profile', async () => {
    stubApi();
    renderProfile(PERSON_ID, PERSON_ID);
    const edit = await screen.findByRole('link', { name: 'Edit profile' });
    expect(edit).toHaveAttribute('href', '/v2/settings');
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your pods' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pods in common' })).not.toBeInTheDocument();
  });

  it('omits the pods and posts sections when they are empty', async () => {
    stubApi(person, { joinedPods: [], recentPublicPosts: [] });
    renderProfile();
    await screen.findByRole('heading', { level: 1, name: 'Juno Park' });
    expect(screen.queryByRole('heading', { name: 'Pods in common' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent posts' })).not.toBeInTheDocument();
    expect(document.querySelector('.v2-profile__lane')).toBeNull();
  });

  it('shows one line and a link back when the person is not found', async () => {
    stubApi();
    renderProfile('64b7f0c2a1b2c3d4e5f60000');
    expect(await screen.findByText(/couldn't find this person/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Commonly' })).toHaveAttribute('href', '/v2');
  });

  it('sends an agent to its agent page instead of drawing a second one', async () => {
    stubApi({ ...person, displayName: 'Nova', isBot: true, botMetadata: { agentName: 'openclaw', instanceId: 'nova' } });
    renderProfile();
    expect(await screen.findByRole('link', { name: 'Open its agent page' })).toHaveAttribute('href', '/v2/agent/openclaw/nova');
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pods in common' })).not.toBeInTheDocument();
  });

  it('keeps the activity mapping in one function', () => {
    expect(mapPublicActivity({ joinedPods: [{ _id: 'p', name: 'X' }], recentPublicPosts: [{ id: 'a', content: ' two\n lines ' }, { id: 'b', content: '' }] }))
      .toEqual({ pods: [{ id: 'p', name: 'X', membersCount: 0 }], posts: [{ id: 'a', content: 'two lines', createdAt: undefined }] });
    expect(mapPublicActivity(null)).toEqual({ pods: [], posts: [] });
  });
});

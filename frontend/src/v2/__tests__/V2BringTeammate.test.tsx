import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2BringTeammate from '../components/V2BringTeammate';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockWrite = jest.fn();
const mockApi = { get: mockGet, post: mockPost };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mockRecord = jest.fn();
const mockRecordOnce = jest.fn();
const mockTrack = jest.fn();
const mockTrackOnce = jest.fn();
jest.mock('../utils/usageEvents', () => ({
  trackUsage: (...args: unknown[]) => mockTrack(...args),
  trackUsageOnce: (...args: unknown[]) => mockTrackOnce(...args),
}));
jest.mock('../utils/byoTelemetry', () => ({
  recordByoStep: (...args: unknown[]) => mockRecord(...args),
  recordByoStepOnce: (...args: unknown[]) => mockRecordOnce(...args),
}));
const token = 'a'.repeat(32);
const props = { podId: 'pod', podName: 'Work', userId: 'person', source: 'solo-pod' as const };
const press = () => fireEvent.click(screen.getByRole('button', { name: 'teammate.act' }));
beforeEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
  mockGet.mockResolvedValue([]);
  mockPost.mockResolvedValue({ token });
  mockWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mockWrite } });
});
test('render only reads; a press creates one seven-day link and copies it', async () => {
  render(<V2BringTeammate {...props} />);
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
  expect(mockPost).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'teammate.act' });
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('teammate.live');
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost).toHaveBeenCalledWith('/api/pods/pod/invites', { expiresInHours: 168, maxUses: null, source: 'solo-pod' });
  expect(mockWrite).toHaveBeenCalledWith(`${window.location.origin}/v2/invite/${token}`);
});
test('returning reuses only this user’s usable link from this placement without claiming it was copied', async () => {
  mockGet.mockResolvedValue([
    { token: 'b'.repeat(32), source: 'solo-pod', createdBy: { _id: 'other' } },
    { token: 'c'.repeat(32), source: 'solo-pod', createdBy: 'person', maxUses: 0, uses: 0 },
    { token: 'd'.repeat(32), source: 'solo-pod', createdBy: 'person', expiresAt: '2020-01-01T00:00:00Z' },
    { token, source: 'solo-pod', createdBy: { _id: 'person' }, expiresAt: new Date(Date.now() + 60000).toISOString() },
  ]);
  render(<V2BringTeammate {...props} />);
  await screen.findByDisplayValue(`${window.location.origin}/v2/invite/${token}`);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(screen.queryByText('teammate.copied')).not.toBeInTheDocument();
  press();
  await screen.findByText('teammate.live');
  expect(mockPost).not.toHaveBeenCalled();
});
test('clipboard refusal selects the retained link, and retry never mints again', async () => {
  mockWrite.mockRejectedValue(new Error('clipboard denied'));
  render(<V2BringTeammate {...props} />);
  press();
  const field = await screen.findByRole('textbox');
  await waitFor(() => expect(field).toHaveFocus());
  expect((field as HTMLInputElement).selectionEnd).toBe((field as HTMLInputElement).value.length);
  mockWrite.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'teammate.copyRetry' }));
  await screen.findByText('teammate.live');
  expect(mockPost).toHaveBeenCalledTimes(1);
});
test('failed POST is explicit; retry recovers an accepted link through GET', async () => {
  mockPost.mockRejectedValue(new Error('lost response'));
  render(<V2BringTeammate {...props} />);
  press();
  await screen.findByRole('alert');
  mockGet.mockResolvedValue([{ token, source: 'solo-pod', createdBy: 'person' }]);
  fireEvent.click(screen.getByRole('button', { name: 'teammate.retry' }));
  await screen.findByText('teammate.live');
  expect(mockPost).toHaveBeenCalledTimes(1);
});
test('a failed existing-link read does not permit blind minting', async () => {
  mockGet.mockRejectedValue(new Error('offline'));
  render(<V2BringTeammate {...props} />);
  press();
  await screen.findByRole('alert');
  expect(mockPost).not.toHaveBeenCalled();
});
test('dismissal is scoped to pod and placement and cancels a pending pre-mint lookup', async () => {
  let resolve!: (rows: unknown[]) => void;
  mockGet.mockReturnValue(new Promise((done) => { resolve = done; }));
  const { unmount } = render(<V2BringTeammate {...props} />);
  press();
  fireEvent.click(screen.getByRole('button', { name: 'teammate.dismiss' }));
  await act(async () => { resolve([]); });
  expect(mockPost).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  unmount();
  render(<V2BringTeammate {...props} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});


test('changing pods cannot carry a prior invite or late clipboard result into the next pod', async () => {
  let finish!: () => void;
  mockWrite.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<V2BringTeammate {...props} />);
  press();
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  view.rerender(<V2BringTeammate {...props} podId="different" />);
  await act(async () => { finish(); });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByText('teammate.live')).not.toBeInTheDocument();
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockGet).toHaveBeenCalledWith('/api/pods/different/invites');
});

test('a retry shares its read across visibility changes and retains the new link', async () => {
  let finish!: (rows: unknown[]) => void;
  mockGet.mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const view = render(<V2BringTeammate {...props} />);
  await act(async () => { await Promise.resolve(); });
  press();
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  view.rerender(<V2BringTeammate {...props} enabled={false} />);
  view.rerender(<V2BringTeammate {...props} enabled />);
  await act(async () => { finish([]); });
  await screen.findByText('teammate.live');
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox')).toHaveValue(`${window.location.origin}/v2/invite/${token}`);
});

test('marks: showing the card pings invite-card-shown; dismissing pings invite-card-dismissed', () => {
  const view = render(<V2BringTeammate {...props} enabled={false} />);
  expect(mockRecordOnce).not.toHaveBeenCalled();
  view.rerender(<V2BringTeammate {...props} enabled />);
  expect(mockRecordOnce).toHaveBeenCalledWith(mockApi, 'invite-card-shown', 'person');
  expect(mockRecord).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'teammate.dismiss' }));
  expect(mockRecord).toHaveBeenCalledWith(mockApi, 'invite-card-dismissed');
});

test('marks: a card dismissed earlier never pings shown', () => {
  const view = render(<V2BringTeammate {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'teammate.dismiss' }));
  view.unmount();
  mockRecordOnce.mockClear();
  render(<V2BringTeammate {...props} />);
  expect(mockRecordOnce).not.toHaveBeenCalled();
});

// D288: in the person's own workspace the card never shares the workspace. A
// press makes an invite-only team pod, adds the agent that answered through
// the add-to-pod route, and copies a link to that new pod.
describe('from the workspace: a new pod with the agent in it (D288)', () => {
  const newPodId = 'b'.repeat(24);
  const workspaceProps = {
    podId: 'workspace', podName: 'My Workspace', userId: 'person', source: 'workspace-own-agent' as const,
    agentName: 'Laptop Claude', newPod: { agentName: 'claude-code', instanceId: 'laptop' },
  };
  const renderCard = (extra = {}) => render(<MemoryRouter><V2BringTeammate {...workspaceProps} {...extra} /></MemoryRouter>);
  const addPath = `/api/registry/agents/claude-code/pods/${newPodId}?instanceId=laptop`;
  beforeEach(() => {
    mockPost.mockImplementation((url: string) => {
      if (url === '/api/pods') return Promise.resolve({ _id: newPodId });
      if (url === addPath) return Promise.resolve({ success: true });
      return Promise.resolve({ token });
    });
  });

  test('a press makes the pod, adds the agent, then invites into the new pod, never the workspace', async () => {
    renderCard();
    expect(mockGet).not.toHaveBeenCalled();
    press();
    await screen.findByText('teammate.live');
    const urls = mockPost.mock.calls.map(([url]) => url);
    expect(urls).toEqual(['/api/pods', addPath, `/api/pods/${newPodId}/invites`]);
    expect(mockPost.mock.calls[0][1]).toMatchObject({ type: 'team', joinPolicy: 'invite-only' });
    expect(urls.some((url) => String(url).includes('/api/pods/workspace'))).toBe(false);
    expect(mockWrite).toHaveBeenCalledWith(`${window.location.origin}/v2/invite/${token}`);
    expect(screen.getByTestId('teammate-open-new-pod')).toHaveAttribute('href', `/v2/pods/${newPodId}`);
    expect(mockTrack).toHaveBeenCalledWith('teammate-card-click', { props: { where: 'workspace' }, podId: 'workspace' });
  });

  test('a later mount reuses the pod it made and never makes a second', async () => {
    const first = renderCard();
    press();
    await screen.findByText('teammate.live');
    first.unmount();
    mockPost.mockClear();
    mockGet.mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(`/api/pods/${newPodId}/invites`));
    press();
    await screen.findByText('teammate.live');
    expect(mockPost.mock.calls.map(([url]) => url)).toEqual([`/api/pods/${newPodId}/invites`]);
  });

  test('a failed agent add still gives a link, and the next press tries the add again', async () => {
    mockPost.mockImplementation((url: string) => {
      if (url === '/api/pods') return Promise.resolve({ _id: newPodId });
      if (url === addPath) return Promise.reject(Object.assign(new Error('500'), { response: { status: 500 } }));
      return Promise.resolve({ token });
    });
    renderCard();
    press();
    await screen.findByText('teammate.live');
    expect(mockWrite).toHaveBeenCalledTimes(1);
    mockPost.mockClear();
    mockPost.mockImplementation((url: string) => (url === addPath ? Promise.resolve({ success: true }) : Promise.resolve({ token })));
    // The button reads "copied" for a moment after a copy; press it by its role in the card.
    const copyButton = document.querySelector('button.v2-teammate__copy') as HTMLButtonElement;
    await waitFor(() => expect(copyButton).not.toBeDisabled());
    fireEvent.click(copyButton);
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(addPath, {}));
    expect(mockPost.mock.calls.map(([url]) => url)).not.toContain('/api/pods');
  });

  test('records shown and dismissed as usage events, and a server-side dismissal keeps it hidden', () => {
    const view = renderCard();
    expect(mockTrackOnce).toHaveBeenCalledWith(
      'teammate-card-shown.workspace.workspace-own-agent', 'teammate-card-shown', { props: { where: 'workspace' }, podId: 'workspace' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'teammate.dismiss' }));
    expect(mockTrack).toHaveBeenCalledWith('teammate-card-dismiss', { props: { where: 'workspace' }, podId: 'workspace' });
    view.unmount();
    localStorage.clear();
    renderCard({ dismissedEverywhere: true });
    expect(screen.queryByRole('button', { name: 'teammate.act' })).not.toBeInTheDocument();
  });
});

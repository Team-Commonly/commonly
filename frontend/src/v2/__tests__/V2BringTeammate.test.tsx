import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import V2BringTeammate from '../components/V2BringTeammate';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockWrite = jest.fn();
const mockApi = { get: mockGet, post: mockPost };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const token = 'a'.repeat(32);
const props = { podId: 'pod', podName: 'Work', userId: 'person', source: 'solo-pod' as const };
const press = () => fireEvent.click(screen.getByRole('button', { name: 'teammate.act' }));
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
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

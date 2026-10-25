import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Controls from '../components/V2RuntimeControls';
import Key from '../components/V2AgentProviderKey';
const mockApi = { get: jest.fn(), put: jest.fn(), del: jest.fn() };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
const at = '2026-10-25T05:00:00Z';
const receipt = { harness: 'claude', version: '2.1', model: 'actual-model', effort: 'high', at };
const runtime = { runtimeType: 'wrapper', managed: true, adapter: 'claude', model: 'saved-model', effort: 'max',
  inventory: [{ harness: 'claude', installed: true, version: '2.1', models: null, efforts: ['low','medium','high'] }],
  observation: { connectedAt: at, lastSeenAt: at, turnRunning: true, lastTurnAt: null, lastSpawn: receipt, confirmed: null }, processConnected: false };
beforeEach(() => { jest.clearAllMocks(); mockApi.get.mockResolvedValue({ set: false, setAt: null, setBy: null, lastUsedAt: null }); });
test('saved, passed and confirmed remain separate, and a disconnected process is not a running turn', () => {
  render(<Controls runtime={runtime} onSave={jest.fn()} />);
  expect(screen.getByLabelText('model')).toHaveValue('saved-model');
  expect(screen.getByText('actual-model')).toBeInTheDocument();
  expect(screen.getAllByText('unconfirmed')).toHaveLength(3);
  expect(screen.getByLabelText('effort')).toHaveValue('max');
  expect(screen.getByText(/stored choice unsupported/)).toHaveTextContent('actual-model');
  expect(screen.queryByText('running')).not.toBeInTheDocument();
  expect(screen.getByText('disconnected')).toBeInTheDocument();
});
test('missing model inventory permits text, but missing effort inventory never permits free text or a pending dot', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  render(<Controls runtime={{ ...runtime, inventory: [{ ...runtime.inventory[0], efforts: [] }] }} onSave={save} />);
  expect(screen.getByLabelText('effort')).toBeDisabled();
  expect(screen.getByText(/max stays stored, not sent/)).toBeInTheDocument();
  const effortRow = screen.getByLabelText('effort').closest('.v2-runtime-controls__row')!;
  expect(within(effortRow as HTMLElement).queryByLabelText('pending next spawn')).toBeNull();
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'new-unlisted-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ adapter: 'claude', model: 'new-unlisted-model' }));
});
test('read-only seats keep all columns, with disabled controls and no save', () => {
  render(<Controls runtime={{ ...runtime, managed: false }} />);
  for (const field of ['harness','model','effort']) expect(screen.getByLabelText(field)).toBeDisabled();
  expect(screen.getByText('read only · this seat runs from the cli')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getAllByText('unconfirmed')).toHaveLength(3);
});
test('key input clears before the request and does not echo a failure response', async () => {
  let fail: (error: Error) => void = () => {};
  mockApi.put.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<Key name="seat" instanceId="default" editable capability={{ available: true, provider: 'openai' }} harness="OpenCode" />);
  const set = await screen.findByRole('button', { name: 'Set key' });
  await waitFor(() => expect(set).toBeEnabled()); fireEvent.click(set);
  const input = screen.getByLabelText('API key');
  fireEvent.change(input, { target: { value: 'sk-private-test-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  expect(input).toHaveValue('');
  fail(new Error('sk-private-test-value'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the key.');
  expect(document.body.textContent).not.toContain('sk-private-test-value');
});
test('an unmapped harness gets no setter, while a CLI gets no key API request', () => {
  const view = render(<Key name="seat" instanceId="default" editable capability={{ available: false, provider: null }} harness="Hermes" />);
  expect(screen.getByText('own key not available for Hermes')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  view.unmount(); mockApi.get.mockClear();
  render(<Key name="seat" instanceId="default" editable={false} harness="Codex" />);
  expect(mockApi.get).not.toHaveBeenCalled(); expect(screen.queryByRole('button')).toBeNull();
});

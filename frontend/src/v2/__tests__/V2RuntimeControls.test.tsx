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
test('missing model inventory permits text; with no effort ladder anywhere the effort row is hidden', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  render(<Controls runtime={{ ...runtime, inventory: [{ ...runtime.inventory[0], efforts: [] }] }} onSave={save} />);
  expect(screen.queryByLabelText('effort')).toBeNull();
  expect(screen.queryByText(/stored choice unsupported/)).toBeNull();
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'new-unlisted-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ adapter: 'claude', model: 'new-unlisted-model' }));
});
test('read-only seats keep all columns, with disabled controls and no save', () => {
  render(<Controls runtime={{ ...runtime, managed: false }} />);
  for (const field of ['harness','model','effort']) expect(screen.getByLabelText(field)).toBeDisabled();
  expect(screen.getByText('read only · this seat runs from the cli')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/model list unavailable/)).toBeNull();
  expect(screen.queryByText(/max · stored/)).toBeNull();
  expect(screen.getByLabelText('effort')).toHaveValue('max');
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
test('OpenCode provider qualification alone does not leave a permanent pending model mark', () => {
  render(<Controls runtime={{ ...runtime, adapter: 'opencode', providerId: 'explicit-provider', effort: '',
    inventory: [{ harness: 'opencode', installed: true, version: '1', models: null, efforts: [] }],
    observation: { ...runtime.observation, lastSpawn: { ...receipt, harness: 'opencode', model: 'explicit-provider/saved-model', effort: null } },
  }} onSave={jest.fn()} />);
  const modelRow = screen.getByLabelText('model').closest('.lrow')!;
  expect(within(modelRow as HTMLElement).queryByLabelText('pending next spawn')).toBeNull();
  expect(screen.getByText('explicit-provider/saved-model')).toBeInTheDocument();
});

test('read-only inventory mismatch preserves the saved model without claiming a stored override', () => {
  render(<Controls runtime={{ ...runtime, managed: false,
    inventory: [{ ...runtime.inventory[0], models: ['other-model'] }] }} />);
  expect(screen.getByLabelText('model')).toHaveValue('saved-model');
  expect(screen.queryByText(/saved-model · stored/)).toBeNull();
  expect(screen.queryByText(/stored choice unsupported/)).toBeNull();
});

test('a dot marks only the rows that change on the next spawn', () => {
  render(<Controls runtime={{ ...runtime, effort: 'high', observation: { ...runtime.observation,
    lastSpawn: { ...receipt, model: 'older-model' } } }} onSave={jest.fn()} />);
  const row = (field: string) => screen.getByLabelText(field).closest('.lrow') as HTMLElement;
  expect(within(row('model')).getByRole('img', { name: 'pending next spawn' })).toBeInTheDocument();
  expect(within(row('harness')).queryByRole('img', { name: 'pending next spawn' })).toBeNull();
  expect(within(row('effort')).queryByRole('img', { name: 'pending next spawn' })).toBeNull();
});

test('a set key rests as a row; a failed save keeps the entry open, empty, with Save disabled', async () => {
  mockApi.get.mockResolvedValue({ set: true, setAt: at, setBy: 'owner', lastUsedAt: null });
  mockApi.put.mockRejectedValue(new Error('proxy'));
  render(<Key name="seat" instanceId="default" editable capability={{ available: true, provider: 'anthropic' }} harness="Claude Code" />);
  expect(await screen.findByText('never shown again')).toBeInTheDocument();
  expect(screen.getByText('key for anthropic')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-private-test-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the key. Enter it again to retry.');
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
});

test('a row with no confirmation reads "unconfirmed", never "confirmed unconfirmed"', () => {
  render(<Controls runtime={runtime} onSave={jest.fn()} />);
  const row = screen.getByLabelText('model').closest('.lrow') as HTMLElement;
  expect(row.textContent).toContain('last spawn actual-model · unconfirmed');
  expect(row.textContent).not.toContain('confirmed unconfirmed');
});
test('a set key keeps its date and Remove when the harness cannot take a key, and while replacing it', async () => {
  mockApi.get.mockResolvedValue({ set: true, setAt: at, setBy: 'owner', lastUsedAt: null });
  const view = render(<Key name="seat" instanceId="default" editable capability={{ available: false, provider: null }} harness="Hermes" />);
  expect(await screen.findByText(/^set · /)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  view.unmount();
  render(<Key name="seat" instanceId="default" editable capability={{ available: true, provider: 'anthropic' }} harness="Claude Code" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }));
  expect(screen.getByLabelText('API key')).toBeInTheDocument();
  expect(screen.getByText(/^set · /)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
});

// D247 (Sam): effort was greyed out, the harness list stopped at two, Codex
// could not pick a model, and Claude's list read as aliases.
const catalog = [
  { id: 'claude', label: 'Claude Code', models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', label: 'Codex', models: ['gpt-6.1-sol', 'gpt-6-sol'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opencode', label: 'OpenCode', models: null, efforts: [] },
  { id: 'qwen', label: 'Qwen Code', models: null, efforts: [] },
  { id: 'goose', label: 'Goose', models: null, efforts: [] },
  { id: 'hermes', label: 'Hermes', models: null, efforts: [] },
  { id: 'pi', label: 'pi', models: null, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'dsh', label: 'DeepSeek Harness', models: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
const listener = { runtimeType: 'webhook', adapter: 'codex', model: '', effort: '', catalog, inventory: [], observation: null, processConnected: null };
const optionTexts = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.textContent);

test('a listener agent with no device inventory can pick a Codex model and effort, saved as full ids', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  render(<Controls runtime={listener} onSave={save} />);
  const effort = screen.getByLabelText('effort');
  expect(effort).toBeEnabled();
  expect(optionTexts('effort')).toEqual(['harness default', 'low', 'medium', 'high', 'xhigh', 'max']);
  expect(optionTexts('model')).toEqual(['harness default', 'gpt-6.1-sol', 'gpt-6-sol', 'Other…']);
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'gpt-6.1-sol' } });
  fireEvent.change(effort, { target: { value: 'xhigh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ adapter: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }));
});

test('Claude Code lists full model ids only, and Other… reveals a free-text id', async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  render(<Controls runtime={{ ...listener, adapter: 'claude', model: 'claude-opus-5-5' }} onSave={save} />);
  expect(optionTexts('model')).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'Other…']);
  fireEvent.change(screen.getByLabelText('model'), { target: { value: '__other__' } });
  const input = screen.getByLabelText('model');
  expect(input.tagName).toBe('INPUT');
  expect(input).toHaveAttribute('placeholder', 'Full model id');
  fireEvent.change(input, { target: { value: 'claude-opus-5-5-20261101' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ adapter: 'claude', model: 'claude-opus-5-5-20261101' }));
});

test('a stored model outside the list still shows', () => {
  render(<Controls runtime={{ ...listener, model: 'gpt-old-preview' }} onSave={jest.fn()} />);
  expect(screen.getByLabelText('model')).toHaveValue('gpt-old-preview');
  expect(optionTexts('model')[0]).toBe('gpt-old-preview · stored');
});

test('every catalogue harness is listed, plain, Claude Code and Codex first, with no tested marks', () => {
  render(<Controls runtime={listener} onSave={jest.fn()} />);
  expect(optionTexts('harness')).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Qwen Code', 'Goose', 'Hermes', 'pi', 'DeepSeek Harness']);
  expect(document.body.textContent).not.toMatch(/[Tt]ested/);
});

test('a reported inventory marks each harness and sorts the installed ones first', () => {
  render(<Controls runtime={{ ...listener, runtimeType: 'wrapper', inventory: [
    { harness: 'claude', installed: false, version: null, models: null, efforts: [] },
    { harness: 'codex', installed: true, version: '0.162.1', models: null, efforts: [] },
    { harness: 'opencode', installed: true, version: '1.19.3', models: null, efforts: [] },
  ] }} onSave={jest.fn()} />);
  expect(optionTexts('harness')).toEqual(['Codex · Installed · 0.162.1', 'OpenCode · Installed · 1.19.3',
    'Claude Code · Not on this computer', 'Qwen Code', 'Goose', 'Hermes', 'pi', 'DeepSeek Harness']);
});

test('a harness with no effort flag hides the effort row instead of greying it', () => {
  render(<Controls runtime={{ ...listener, adapter: 'opencode' }} onSave={jest.fn()} />);
  expect(screen.queryByLabelText('effort')).toBeNull();
  expect(screen.getByLabelText('model').tagName).toBe('INPUT');
});

test('a hosted agent shows no effort row and a read-only model', () => {
  render(<Controls runtime={{ ...listener, runtimeType: 'hosted', host: 'cloud', model: 'deepseek-v4-flash' }} onSave={jest.fn()} />);
  expect(screen.queryByLabelText('effort')).toBeNull();
  expect(screen.getByLabelText('model')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save runtime' })).toBeNull();
  expect(screen.getByText('read only · runs on commonly')).toBeInTheDocument();
});

test('after a real reply, one quiet line names what answered, with a duration only when recorded', () => {
  const done = { connectedAt: at, lastSeenAt: at, turnRunning: false, lastTurnAt: at, lastSpawnOutcome: 'completed' as const, confirmed: null };
  const view = render(<Controls runtime={{ ...listener, observation: { ...done, lastSpawn: { ...receipt, harness: 'codex', version: '0.162.1' } } }} onSave={jest.fn()} />);
  expect(screen.getByTestId('runtime-answered')).toHaveTextContent('Answered with Codex 0.162.1');
  view.unmount();
  render(<Controls runtime={{ ...listener, observation: { ...done, lastSpawn: { ...receipt, harness: 'codex', version: '0.162.1', durationMs: 4200 } } }} onSave={jest.fn()} />);
  expect(screen.getByTestId('runtime-answered')).toHaveTextContent('Answered in 4.2s with Codex 0.162.1');
});

test('no reply yet, no answered line', () => {
  render(<Controls runtime={runtime} onSave={jest.fn()} />);
  expect(screen.queryByTestId('runtime-answered')).toBeNull();
});

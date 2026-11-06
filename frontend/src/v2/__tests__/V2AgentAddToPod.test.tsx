import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import V2AgentAddToPod from '../agents/V2AgentAddToPod';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const client = (jest.requireMock('../../utils/axiosConfig') as {
  default: { get: jest.Mock; post: jest.Mock };
}).default;

const pods = [
  { _id: 'in', name: 'Already in', type: 'chat' },
  { _id: 'room', name: 'Agent room', type: 'agent-room' },
  { _id: 'dm', name: 'Agent DM', type: 'agent-dm' },
  { _id: 'admin', name: 'Agent admin', type: 'agent-admin' },
  { _id: 'open', name: 'Open pod', type: 'chat', publicRead: true },
  { _id: 'one', name: 'Design', type: 'chat' },
  { _id: 'two', name: 'Ops', type: 'chat' },
];
const url = '/api/registry/agents/test%20agent/pods/one?instanceId=my-machine';
const onAdded = jest.fn();
const refuse = (data: unknown) => client.post.mockRejectedValueOnce({ response: { data } });

const open = async () => {
  render(<V2AgentAddToPod agentName="test agent" displayName="Test Agent" query="instanceId=my-machine" installedPodIds={['in']} onAdded={onAdded} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add to pod' }));
  return screen.findByRole('combobox', { name: 'Pod to add this agent to' });
};

describe('Add to pod', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    client.get.mockResolvedValue({ data: pods });
    client.post.mockResolvedValue({ data: { success: true } });
  });

  test('offers only pods the agent can join, leaving out personal and public pods', async () => {
    const select = await open();
    expect(Array.from((select as HTMLSelectElement).options).map((row) => row.text)).toEqual(['Design', 'Ops']);
  });

  test('sends no config and reports the pod it added to', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('Design'));
    expect(client.post).toHaveBeenCalledWith(url, {});
    expect(screen.getByRole('button', { name: 'Add to pod' })).toBeInTheDocument();
  });

  test('a narrowing refusal is shown, and only the confirmed retry goes through', async () => {
    refuse({ code: 'outsider_grant_narrowing_confirm_required', narrowing: {
      losesWrites: [{ podId: 'x', name: 'Launch' }], hiddenLosesWritesCount: 0, targetWritable: true,
    } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByTestId('byo-narrowing-pods')).toHaveTextContent('Launch');
    expect(screen.getByText('It would stop writing in:').nextElementSibling).toBe(screen.getByTestId('byo-narrowing-pods'));
    expect(onAdded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add anyway' }));
    await waitFor(() => expect(client.post).toHaveBeenLastCalledWith(url, { confirmNarrowing: true }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('Design'));
  });

  test('cancelling a narrowing refusal returns to the picker without adding', async () => {
    refuse({ code: 'outsider_grant_narrowing_confirm_required', narrowing: { unavailable: true } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByTestId('byo-narrowing-confirmation');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(onAdded).not.toHaveBeenCalled();
  });

  test('a hosted cap refusal names the agent holding the slot', async () => {
    refuse({ code: 'hosted_cap_reached', used: 1, cap: 1, holders: [{ agentName: 'maple', displayName: 'Maple' }] });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Maple');
  });

  test('a second click after the first worked counts as added', async () => {
    refuse({ code: 'agent_already_in_pod' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('Design'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a row that is not active in that pod is not reported as added', async () => {
    refuse({ code: 'agent_already_in_pod', status: 'paused' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("already in Design, but it isn't active there");
    expect(onAdded).not.toHaveBeenCalled();
  });

  test('says when only the owner can add it', async () => {
    refuse({ code: 'not_agent_owner' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Only this agent's owner");
  });

  test('never shows server text on any other refusal', async () => {
    refuse({ code: 'pod_membership_required', error: 'internal detail' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't add Test Agent to that pod.");
    expect(alert).not.toHaveTextContent('internal detail');
  });

  test('says so when no pod is left, and when the pods can\'t be read', async () => {
    client.get.mockResolvedValueOnce({ data: [pods[0], pods[1]] });
    const { unmount } = render(<V2AgentAddToPod agentName="test agent" displayName="Test Agent" query="instanceId=my-machine" installedPodIds={['in']} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to pod' }));
    expect(await screen.findByText(/already in every pod/)).toBeInTheDocument();
    unmount();
    client.get.mockRejectedValueOnce(new Error('down'));
    render(<V2AgentAddToPod agentName="test agent" displayName="Test Agent" query="instanceId=my-machine" installedPodIds={['in']} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to pod' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your pods.");
  });
});

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import V2AgentHostedRun from '../agents/V2AgentHostedRun';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const client = (jest.requireMock('../../utils/axiosConfig') as {
  default: { get: jest.Mock; post: jest.Mock };
}).default;
const onChanged = jest.fn();
const body = { agentName: 'maple', instanceId: 'default' };
const status = '/api/hosted/status?agentName=maple&instanceId=default';
const renderRun = () => render(<V2AgentHostedRun agentName="maple" displayName="Maple" instanceId="default" onChanged={onChanged} />);

describe('hosted agent stop and start', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    client.get.mockResolvedValue({ data: { runtime: { engine: 'native', ready: true, provisionedAt: 'then' } } });
    client.post.mockResolvedValue({ data: {} });
  });

  test('shows nothing to anyone the status route refuses', async () => {
    client.get.mockRejectedValue({ response: { status: 404 } });
    const { container } = renderRun();
    await waitFor(() => expect(client.get).toHaveBeenCalledWith(status));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('stopping asks first, says what stays, and can be backed out of', async () => {
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('status')).toHaveTextContent('Its memory and pods stay.');
    expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Running$/);
    expect(client.post).not.toHaveBeenCalled();
  });

  test('stops the agent and offers Start', async () => {
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(client.post).toHaveBeenCalledWith('/api/hosted/deprovision', body);
    expect(screen.getByRole('status')).toHaveTextContent("It won't answer until you start it.");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test('a failed stop keeps the agent shown as running', async () => {
    client.post.mockRejectedValueOnce(new Error('down'));
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't stop Maple.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop it' })).toBeEnabled();
  });

  test('a start reads as running only once the status says so', async () => {
    client.get.mockResolvedValueOnce({ data: { runtime: { engine: 'native', ready: false, provisionedAt: null } } });
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Running$/));
    expect(client.post).toHaveBeenCalledWith('/api/hosted/provision', body);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test('on the other engine, stopping warns that the conversation history goes', async () => {
    client.get.mockResolvedValue({ data: { runtime: { provisionedAt: 1, lastPollAt: 2 } } });
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('status')).toHaveTextContent('This clears its conversation history');
    expect(screen.getByRole('status')).not.toHaveTextContent('memory');
  });

  test('a poll written back after a stop does not read as running', async () => {
    client.get.mockResolvedValue({ data: { runtime: { provisionedAt: null, lastPollAt: 2 } } });
    renderRun();
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Stopped.');
  });

  test('started but not polling yet reads as still starting', async () => {
    client.get.mockResolvedValue({ data: { runtime: { provisionedAt: 1, lastPollAt: null } } });
    renderRun();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Still starting.'));
  });

  test('a cap refusal names who holds the slot', async () => {
    client.get.mockResolvedValueOnce({ data: { runtime: { engine: 'native', ready: false, provisionedAt: null } } });
    client.post.mockRejectedValueOnce({ response: { data: { code: 'hosted_cap_reached', cap: 1, holders: [{ agentName: 'ivy', displayName: 'Ivy' }] } } });
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ivy');
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  test('never shows server text on a failed start', async () => {
    client.get.mockResolvedValueOnce({ data: { runtime: { engine: 'native', ready: false, provisionedAt: null } } });
    client.post.mockRejectedValueOnce({ response: { data: { code: 'identity_missing', message: 'internal detail' } } });
    renderRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't start Maple.");
    expect(alert).not.toHaveTextContent('internal detail');
  });
});

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentWakePods from '../agents/V2AgentWakePods';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const client = (jest.requireMock('../../utils/axiosConfig') as {
  default: { get: jest.Mock; patch: jest.Mock; delete: jest.Mock };
}).default;
const updatePod = jest.fn().mockResolvedValue({});
const renderSettings = () => render(
  <MemoryRouter><V2AgentWakePods agentName="test-agent" instanceId="my-machine" updatePod={updatePod} /></MemoryRouter>,
);

describe('per-agent Wake and Pods settings', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    updatePod.mockResolvedValue({});
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: true, humanOnly: true,
        boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60,
      }] } });
    client.patch.mockResolvedValue({ data: {} });
    client.delete.mockResolvedValue({ data: {} });
  });

  it('writes settings to the selected installation with the instance identity', async () => {
    renderSettings();
    fireEvent.click(await screen.findByLabelText('Wake on board changes'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledWith(
      'pod-1',
      { wakeOnMessage: true, humanOnly: true, boardWake: true, heartbeatEnabled: false, heartbeatMinutes: 60 },
    ));
  });

  it('shows all three message-wake choices without first opting in (D173)', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60,
      }] } });
    renderSettings();
    expect(await screen.findByRole('group', { name: 'Messages that wake it' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mentions only')).toBeChecked();
    expect(screen.getByLabelText('Every message')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Messages from people'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledWith(
      'pod-1',
      { wakeOnMessage: true, humanOnly: true, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 },
    ));
    expect(screen.getByLabelText('Messages from people')).toBeChecked();
  });

  it('marks the saved human-only setting and clears it on mentions only', async () => {
    renderSettings();
    expect(await screen.findByLabelText('Messages from people')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Mentions only'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledWith(
      'pod-1',
      { wakeOnMessage: false, humanOnly: false, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 },
    ));
  });

  it('loads and saves the every-message choice', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: true, humanOnly: false,
        boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60,
      }] } });
    renderSettings();
    expect(await screen.findByLabelText('Every message')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Mentions only'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('Every message'));
    await waitFor(() => expect(updatePod).toHaveBeenLastCalledWith(
      'pod-1',
      { wakeOnMessage: true, humanOnly: false, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 },
    ));
  });

  const mentionsOnlyInstall = () => client.get.mockResolvedValue({ data: {
    turnCap: 30, activePodCount: 1, podCount: 1, installations: [{
      podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
      boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60,
    }],
  } });
  const EVERY = { wakeOnMessage: true, humanOnly: false, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 };

  it('keeps the radios usable while a pick saves, so a second arrow key reaches the third choice', async () => {
    mentionsOnlyInstall();
    let settleFirst: (value?: unknown) => void = () => {};
    updatePod.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve; }));
    renderSettings();
    const human = await screen.findByLabelText('Messages from people');
    // jsdom has no native arrow-key radio movement: an ArrowDown is a focus
    // move plus a change on the next radio.
    act(() => { human.focus(); });
    fireEvent.click(human);
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(1));
    expect(human).toBeChecked();
    expect(human).not.toBeDisabled();
    expect(document.activeElement).toBe(human);

    const every = screen.getByLabelText('Every message');
    expect(every).not.toBeDisabled();
    act(() => { every.focus(); });
    fireEvent.click(every);
    expect(every).toBeChecked();
    expect(document.activeElement).toBe(every);
    // The second pick waits for the first, so the server sees them in order.
    expect(updatePod).toHaveBeenCalledTimes(1);
    await act(async () => { settleFirst({}); });
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(2));
    expect(updatePod).toHaveBeenLastCalledWith('pod-1', EVERY);
    expect(every).toBeChecked();
  });

  it('a failed save rolls back to what the server last accepted, not to an unsaved pick', async () => {
    mentionsOnlyInstall();
    let failFirst: (error: unknown) => void = () => {};
    updatePod.mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }));
    renderSettings();
    fireEvent.click(await screen.findByLabelText('Messages from people'));
    fireEvent.click(screen.getByLabelText('Every message'));
    // The second pick shows while the first save is pending (a disabled
    // fieldset would have swallowed it), so the rollback has something to undo.
    expect(screen.getByLabelText('Every message')).toBeChecked();
    await act(async () => { failFirst(new Error('down')); });
    await waitFor(() => expect(screen.getByLabelText('Mentions only')).toBeChecked());
    // The queued pick is dropped with the failure; it never reached the server.
    expect(updatePod).toHaveBeenCalledTimes(1);
  });

  it('a save still in flight for the previous agent does not let the next agent\'s saves overlap', async () => {
    mentionsOnlyInstall();
    const settles: Array<(value?: unknown) => void> = [];
    updatePod.mockImplementation(() => new Promise((resolve) => { settles.push(resolve); }));
    const view = renderSettings();
    fireEvent.click(await screen.findByLabelText('Messages from people'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter><V2AgentWakePods agentName="test-agent" instanceId="other-machine" updatePod={updatePod} /></MemoryRouter>,
    );
    fireEvent.click(await screen.findByLabelText('Messages from people'));
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(2));

    // The old agent's save settles while the new agent's first save is still out.
    await act(async () => { settles[0]({}); });
    fireEvent.click(screen.getByLabelText('Every message'));
    // The new pick queues behind the new agent's pending save instead of racing it.
    expect(updatePod).toHaveBeenCalledTimes(2);
    await act(async () => { settles[1]({}); });
    await waitFor(() => expect(updatePod).toHaveBeenCalledTimes(3));
    expect(updatePod).toHaveBeenLastCalledWith('pod-1', EVERY);
  });

  it('removes a pod installation and leaves the settings view open', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from pod' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove from pod' }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(
      '/api/registry/agents/test-agent/pods/pod-1?instanceId=my-machine',
    ));
    expect(await screen.findByText('No pods to manage')).toBeInTheDocument();
  });

  it('does not show or restore the previous agent’s pod after identity changes', async () => {
    let finishOld: (value: unknown) => void = () => {};
    client.get.mockImplementation((url: string) => url.includes('old-agent')
      ? new Promise((resolve) => { finishOld = resolve; })
      : Promise.resolve({ data: { turnCap: 30, installations: [{
          podId: 'pod-new', podName: 'New pod', status: 'active', wakeOnMessage: false, humanOnly: false,
          boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 30,
        }] } }));
    const view = render(
      <MemoryRouter><V2AgentWakePods agentName="old-agent" instanceId="default" updatePod={updatePod} /></MemoryRouter>,
    );
    view.rerender(
      <MemoryRouter><V2AgentWakePods agentName="new-agent" instanceId="default" updatePod={updatePod} /></MemoryRouter>,
    );
    expect((await screen.findAllByText('New pod')).length).toBe(1);
    await act(async () => { finishOld({ data: { installations: [{
      podId: 'pod-old', podName: 'Old pod', wakeOnMessage: true, boardWake: true, heartbeatMinutes: 60,
    }] } }); });
    expect(screen.queryByText('Old pod')).not.toBeInTheDocument();
    expect(screen.getByText('New pod')).toBeInTheDocument();
  });

  it('previews heartbeats against the plan cap before saving', async () => {
    renderSettings();
    expect(await screen.findByText('0 heartbeats / 30 turns daily')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Heartbeat'), { target: { value: '30' } });
    expect(screen.getByText('48 heartbeats / 30 turns daily')).toBeInTheDocument();
    expect(screen.getByText(/This exceeds the daily cap/)).toBeInTheDocument();
    expect(updatePod).not.toHaveBeenCalled();
  });

  it('totals heartbeats across pods, counting an Off pod as zero', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 2, podCount: 3, installations: [
      { podId: 'pod-a', podName: 'Alpha', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 60 },
      { podId: 'pod-b', podName: 'Beta', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 30 },
      { podId: 'pod-c', podName: 'Gamma', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 30 },
    ] } });
    renderSettings();
    expect(await screen.findByText('72 heartbeats / 30 turns daily')).toBeInTheDocument();
  });

  it('leaves a paused pod out of the scheduled total, since the scheduler does not wake it', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 2, installations: [
      { podId: 'pod-a', podName: 'Alpha', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 240 },
      { podId: 'pod-b', podName: 'Beta', status: 'paused', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 60 },
    ] } });
    renderSettings();
    expect(await screen.findByText('6 heartbeats / 30 turns daily')).toBeInTheDocument();
  });

  it('states the daily turn count clearly when the cap is unavailable', async () => {
    client.get.mockResolvedValue({ data: { activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 60,
      }] } });
    renderSettings();
    expect(await screen.findByText('24 heartbeats a day · cap unavailable')).toBeInTheDocument();
  });

  it('says one heartbeat in the singular when the cap is unknown', async () => {
    client.get.mockResolvedValue({ data: { activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 1440,
      }] } });
    renderSettings();
    expect(await screen.findByText('1 heartbeat a day · cap unavailable')).toBeInTheDocument();
  });

  it('says one heartbeat in the singular against the cap', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 1440,
      }] } });
    renderSettings();
    expect(await screen.findByText('1 heartbeat / 30 turns daily')).toBeInTheDocument();
  });

  it('zh-CN reads the same counts on both lines, with its one plural form', () => {
    expect(i18n.t('agentSettings.heartbeatTurns', { lng: 'zh-CN', count: 1, cap: 30 })).toBe('心跳1次/天 · 上限30轮/天');
    expect(i18n.t('agentSettings.heartbeatTurns', { lng: 'zh-CN', count: 24, cap: 30 })).toBe('心跳24次/天 · 上限30轮/天');
    expect(i18n.t('agentSettings.heartbeatTurnsNoCap', { lng: 'zh-CN', count: 24 })).toBe('心跳24次/天 · 上限不可用');
  });

  it('says zero heartbeats when the cap is unknown and the pod is off', async () => {
    client.get.mockResolvedValue({ data: { activePodCount: 1, podCount: 1, installations: [{
        podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 1440,
      }] } });
    renderSettings();
    expect(await screen.findByText('0 heartbeats a day · cap unavailable')).toBeInTheDocument();
  });

  describe('an agent that runs on Commonly (hosted)', () => {
    const hostedRows = (rows: Array<Record<string, unknown>>, runsPerDay = 6) => ({ data: {
      turnCap: 30, activePodCount: rows.length, podCount: rows.length,
      hostedHeartbeat: { minMinutes: 60, runsPerDay },
      installations: rows.map((row, index) => ({
        podId: `pod-${index}`, podName: `Pod ${index}`, status: 'active', wakeOnMessage: false, humanOnly: false,
        boardWake: false, heartbeatEnabled: true, heartbeatMinutes: 60,
        hostedHeartbeat: { minMinutes: 60, runsPerDay }, ...row,
      })),
    } });
    const optionValues = () => Array.from((screen.getByLabelText('Heartbeat') as HTMLSelectElement).options)
      .map((option) => option.value);

    // runtimeType is per installation, so one identity's rows need not agree.
    it('applies the floor and cap to hosted rows only when an agent has both kinds', async () => {
      client.get.mockResolvedValue(hostedRows([{}, { hostedHeartbeat: null, heartbeatMinutes: 30 }]));
      renderSettings();
      // min(24 hosted, cap 6) + 48 from the row that isn't hosted.
      expect(await screen.findByText('54 heartbeats / 30 turns daily')).toBeInTheDocument();
      const [hosted, other] = screen.getAllByLabelText('Heartbeat') as HTMLSelectElement[];
      expect(Array.from(hosted.options).map((option) => option.value)).not.toContain('15');
      expect(Array.from(other.options).map((option) => option.value)).toContain('15');
    });

    it('offers no interval below the hourly floor', async () => {
      client.get.mockResolvedValue(hostedRows([{}]));
      renderSettings();
      await screen.findByLabelText('Heartbeat');
      expect(optionValues()).toEqual(['off', '60', '120', '360', '720', '1440']);
    });

    it('keeps a stored interval below the floor visible, and counts it as hourly', async () => {
      client.get.mockResolvedValue(hostedRows([{ heartbeatMinutes: 15 }], 30));
      renderSettings();
      expect(await screen.findByText('24 heartbeats / 30 turns daily')).toBeInTheDocument();
      expect(optionValues()).toContain('15');
    });

    it('previews against the daily heartbeat cap and says why', async () => {
      client.get.mockResolvedValue(hostedRows([{}, {}]));
      renderSettings();
      expect(await screen.findByText('6 heartbeats / 30 turns daily')).toBeInTheDocument();
      expect(screen.queryByText(/This exceeds the daily cap/)).not.toBeInTheDocument();
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Mentions always wake this agent. Your agents that run on Commonly take a heartbeat at most once an hour, and 6 a day between them.',
      );
      // A tap has no hover or focus style, so it pins the note open, and leaving it closes the note.
      const note = screen.getByRole('button', { name: /^Mentions always wake this agent\./ });
      expect(note).not.toHaveClass('pin');
      fireEvent.click(note);
      expect(note).toHaveClass('pin');
      fireEvent.blur(note);
      expect(note).not.toHaveClass('pin');
      fireEvent.keyDown(note, { key: 'Enter' });
      expect(note).toHaveClass('pin');
      expect(document.querySelector('.v2-agent-wake-pods__hint')).toBeNull();
      expect(screen.getAllByRole('option', { name: '60 min' })).toHaveLength(2);
    });

    it('says heartbeats aren\'t available when the cap is zero, and previews none', async () => {
      client.get.mockResolvedValue(hostedRows([{}], 0));
      renderSettings();
      expect(await screen.findByText('0 heartbeats / 30 turns daily')).toBeInTheDocument();
      expect(screen.getByRole('tooltip')).toHaveTextContent('Heartbeats aren\'t available yet for your agents that run on Commonly.');
    });

    it('an agent that is not hosted keeps every interval and no hosted line', async () => {
      renderSettings();
      await screen.findByLabelText('Heartbeat');
      expect(optionValues()).toEqual(['off', '15', '30', '60', '120', '360', '720', '1440']);
      expect(screen.queryByText(/run on Commonly/)).not.toBeInTheDocument();
    });
  });

  it('warns about key revocation when removing the only active installation beside a paused one', async () => {
    client.get.mockResolvedValue({ data: { turnCap: 30, activePodCount: 1, podCount: 2, installations: [
        { podId: 'pod-1', podName: 'Launch', status: 'active', wakeOnMessage: true,
          humanOnly: true, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 },
        { podId: 'pod-2', podName: 'Paused', status: 'paused', wakeOnMessage: false,
          humanOnly: false, boardWake: false, heartbeatEnabled: false, heartbeatMinutes: 60 },
      ] } });
    renderSettings();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove from pod' }))[0]);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('No active installation will remain');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(client.delete).not.toHaveBeenCalled();
  });
});

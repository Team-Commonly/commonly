// F669: the owner sees how many turns their own agent ran today and in the last 7 days,
// with a per-pod breakdown and a link to where its wake mode is set.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentTurnCount from '../agents/V2AgentTurnCount';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const client = (jest.requireMock('../../utils/axiosConfig') as { default: { get: jest.Mock } }).default;

const COUNTS = {
  timeZone: 'America/Los_Angeles',
  today: 3,
  week: 12,
  pods: [
    { podId: 'pod-1', podName: 'Launch', podType: 'chat', today: 2, week: 9 },
    { podId: 'dm-1', podName: 'test-agent', podType: 'agent-room', today: 1, week: 1 },
  ],
  elsewhere: { today: 0, week: 2 },
};

const renderLine = () => render(
  <MemoryRouter><V2AgentTurnCount agentName="test-agent" instanceId="my-machine" changeHref="#agent-wake" /></MemoryRouter>,
);

describe('turns today and in the last 7 days on the agent panel', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await i18n.changeLanguage('en');
    client.get.mockResolvedValue({ data: COUNTS });
  });

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('reads the owner\'s counts for this agent and shows the line with a change link', async () => {
    renderLine();
    expect(await screen.findByText('3 turns today · 12 in the last 7 days')).toBeInTheDocument();
    expect(client.get).toHaveBeenCalledWith('/api/registry/agents/test-agent/turns', { params: { instanceId: 'my-machine' } });
    const change = screen.getByRole('link', { name: 'Change when it wakes' });
    expect(change).toHaveAttribute('href', '#agent-wake');
  });

  it('opens a per-pod breakdown that names each pod and the turns elsewhere', async () => {
    renderLine();
    fireEvent.click(await screen.findByRole('button', { name: 'Turns by pod' }));
    const rows = screen.getAllByTestId('agent-turns-pod');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Launch2 today · 9 in the last 7 days',
      'Your direct message1 today · 1 in the last 7 days',
      'Elsewhere0 today · 2 in the last 7 days',
    ]);
  });

  it('says it once in Chinese, with the glossary terms', async () => {
    await i18n.changeLanguage('zh-CN');
    renderLine();
    expect(await screen.findByText('今天3轮 · 近7天12轮')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '更改唤醒方式' })).toBeInTheDocument();
  });

  it('says 2000+ when the server kept fewer turns than ran in the 7 days', async () => {
    client.get.mockResolvedValue({ data: { ...COUNTS, week: 2000, weekCapped: true } });
    renderLine();
    expect(await screen.findByText('3 turns today · 2000+ in the last 7 days')).toBeInTheDocument();
    await i18n.changeLanguage('zh-CN');
    expect(await screen.findByText('今天3轮 · 近7天2000+轮')).toBeInTheDocument();
  });

  it('shows nothing to anyone the server does not answer as the owner', async () => {
    client.get.mockRejectedValue({ response: { status: 404 } });
    const { container } = renderLine();
    await waitFor(() => expect(client.get).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(container).toBeEmptyDOMElement();
  });
});

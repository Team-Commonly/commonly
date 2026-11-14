import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import V2DailySchedule, { formatScheduleTime, formatTimeZone } from '../components/V2DailySchedule';
import { i18nReady } from '../../i18n';

beforeAll(async () => { await i18nReady; });

const target = { agentName: 'maya-claude', instanceId: 'default', displayName: 'Maya Claude' };

test('under StrictMode a save still lands: the double mount must not drop its answer', async () => {
  const api = {
    get: jest.fn(() => Promise.resolve({ installations: [{ podId: 'pod-1', schedule: null }] })),
    put: jest.fn((url: string, body: Record<string, unknown>) => Promise.resolve({ settings: { schedule: body } })),
  } as never;
  render(<React.StrictMode><V2DailySchedule api={api} podId="pod-1" prompt="Triage new tickets" target={target} /></React.StrictMode>);
  const start = await screen.findByTestId('daily-schedule-start');
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByTestId('daily-schedule-on')).toHaveTextContent('Maya Claude runs this every day at 9:00 AM');
  expect(screen.getByRole('button', { name: 'Turn off the daily run' })).toBeInTheDocument();
});

const apiWith = (schedule: unknown, put?: jest.Mock, get?: jest.Mock) => ({
  get: get || jest.fn(() => Promise.resolve({ installations: [{ podId: 'pod-1', schedule }] })),
  put: put || jest.fn(() => Promise.resolve({})),
}) as never;

test("the next run is the server's answer, said in words", async () => {
  render(<V2DailySchedule api={apiWith({ enabled: true, time: '09:00', timezone: 'America/Los_Angeles', prompt: 'Triage', nextRun: 'now' })}
    podId="pod-1" prompt="Triage" target={target} />);
  expect(await screen.findByTestId('daily-schedule-on')).toHaveTextContent(
    /^Maya Claude runs this every day at 9:00 AM \(Pacific (Standard|Daylight) Time\)\. Next run: starting now\.$/,
  );
});

test('with no answer from the server, it names no next run rather than guess one', async () => {
  render(<V2DailySchedule api={apiWith({ enabled: true, time: '09:00', timezone: 'UTC', prompt: 'Triage' })}
    podId="pod-1" prompt="Triage" target={target} />);
  expect((await screen.findByTestId('daily-schedule-on')).textContent).not.toMatch(/Next run/);
});

test("a refusal a retry can't change says why and drops the offer", async () => {
  const notYours = jest.fn(() => Promise.reject({ response: { status: 403, data: { code: 'another_installer' } } }));
  render(<V2DailySchedule api={apiWith(null, notYours)} podId="pod-1" prompt="Triage" target={target} />);
  const start = await screen.findByTestId('daily-schedule-start');
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByTestId('daily-schedule-refused')).toHaveTextContent(
    "Only Maya Claude's owner can set a daily run for it, and only while no one else has it installed.",
  );
  expect(screen.queryByTestId('daily-schedule-start')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an agent Commonly runs is told a daily run is for an agent you run yourself', async () => {
  const byo = jest.fn(() => Promise.reject({ response: { status: 400, data: { code: 'schedule_byo_only' } } }));
  render(<V2DailySchedule api={apiWith(null, byo)} podId="pod-1" prompt="Triage" target={target} />);
  const start = await screen.findByTestId('daily-schedule-start');
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByTestId('daily-schedule-refused')).toHaveTextContent('A daily run is for an agent you run yourself.');
});

test("when the agent's settings can't be read, nothing is offered: a save could replace a job it never named", async () => {
  const get = jest.fn(() => Promise.reject(new Error('500')));
  const { container } = render(<V2DailySchedule api={apiWith(null, undefined, get)} podId="pod-1" prompt="Triage" target={target} />);
  await waitFor(() => expect(get).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('the zone reads in words, and an unknown zone falls back to its name', () => {
  expect(formatTimeZone('America/Los_Angeles', 'en', new Date('2026-11-14T16:00:00Z'))).toBe('Pacific Standard Time');
  expect(formatTimeZone('Not/AZone', 'en')).toBe('Not/AZone');
});

test('the time reads in the viewer\'s clock style', () => {
  expect(formatScheduleTime('09:00', 'en')).toBe('9:00 AM');
  expect(formatScheduleTime('09:00', 'zh-CN')).toMatch(/9:00/);
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import V2DailySchedule, { formatScheduleTime, nextRunDay } from '../components/V2DailySchedule';
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

test('the next run is today before the set time and tomorrow from it, on the schedule\'s own clock', () => {
  // 16:00 UTC is 08:00 in Los Angeles (PST) and 00:00 next day in Shanghai.
  const at = new Date('2026-11-14T16:00:00Z');
  expect(nextRunDay('09:00', 'America/Los_Angeles', at)).toBe('today');
  expect(nextRunDay('08:00', 'America/Los_Angeles', at)).toBe('tomorrow');
  expect(nextRunDay('09:00', 'Asia/Shanghai', at)).toBe('today');
});

test('the time reads in the viewer\'s clock style', () => {
  expect(formatScheduleTime('09:00', 'en')).toBe('9:00 AM');
  expect(formatScheduleTime('09:00', 'zh-CN')).toMatch(/9:00/);
});

import revision from '../uiCardCatalogueRevision.json';
import React from 'react';
import { TextEncoder } from 'util';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2UICard from '../V2UICard';
import type { V2Message } from '../../hooks/useV2PodDetail';
Object.assign(global, { TextEncoder });
// Real timers, no act(): before the fix a throwing view kept React busy forever,
// so an act()-wrapped wait never returned and the test hung instead of failing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
jest.setTimeout(15000);

const POD = '111111111111111111111111';
const RUN = '012345678901234567890123';
let mockTask: Record<string, unknown> = {};
let mockRun: Record<string, unknown> = {};
const mockApi = { get: jest.fn(async (url: string) => (url.startsWith('/api/v1/tasks/') ? { tasks: [mockTask] } : { run: mockRun })) };
const mockSocket = { on: jest.fn(), off: jest.fn() };
jest.mock('../../../context/SocketContext', () => ({ useSocket: () => ({ socket: mockSocket, connected: true }) }));
jest.mock('../../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const message = (source: string): V2Message => ({
  id: 'm1', pod_id: POD, user_id: 'u1', message_type: 'card', created_at: new Date().toISOString(),
  content: 'Plain fallback', payload: { ...revision, kind: 'ui', v: 1, lang: 'openui@1', source, runId: RUN },
});
const show = (source: string) => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
  <V2UICard message={message(source)} authorLabel="Polish" /></MemoryRouter>);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await sleep(25);
}
const FALLBACK = 'This card couldn’t be displayed.';

beforeEach(() => {
  mockApi.get.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// A view that throws after it has mounted (here, on data from its own fetch) must
// give the card's fallback, not loop. OpenUI's per-element boundary re-presents
// the last good children on error and reports render errors only when the source
// changes, so the view remounted, refetched and threw again: ~290 GETs a second.
test.each([
  ['a task title that is not text', 'root = Card("Sprint", [Text("Header"), TaskStatus("TASK-1"), Badge("Ready", "neutral")])',
    () => { mockTask = { taskId: 'TASK-1', title: { not: 'text' }, status: 'done' }; }],
  ['a run trace with no turns', 'root = Card("Run", [Text("Before"), RunTrace(3), Text("After")])',
    () => { mockRun = { id: RUN, podId: POD, startedAt: '2026-11-03T00:00:00.000Z' }; }],
])('a view that throws after mount on %s shows the fallback and stops fetching', async (_name, source, arrange) => {
  arrange();
  const { container } = show(source);
  await until(() => !!container.textContent?.includes(FALLBACK));
  const settled = mockApi.get.mock.calls.length;
  await sleep(400);
  const text = container.textContent || '';
  // One fetch, then quiet: the card is gone, so nothing remounts to refetch.
  expect({ fallback: text.includes(FALLBACK) && text.includes('Plain fallback'), fetches: [settled, mockApi.get.mock.calls.length] })
    .toEqual({ fallback: true, fetches: [1, 1] });
});

test('a card whose views do not throw still renders its fetched data', async () => {
  mockTask = { taskId: 'TASK-1', title: 'Fix the login bug', status: 'done' };
  const { container } = show('root = Card("Sprint", [Text("Header"), TaskStatus("TASK-1")])');
  await until(() => !!container.textContent?.includes('Fix the login bug'));
  expect(container.textContent).toContain('Fix the login bug');
  expect(container.textContent).not.toContain(FALLBACK);
  expect(mockApi.get).toHaveBeenCalledTimes(1);
});

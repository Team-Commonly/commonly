import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../i18n';
import { Link } from 'react-router-dom';
import V2TaskRecord, { parseRecord, shortDigest, taskRecordPath } from '../components/V2TaskRecord';

const mockGet = jest.fn();
const mockApi = { get: mockGet };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const POD = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const HUMAN = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const AGENT = 'ccccccccccccccccccccccc1';
const RUN = 'srv-task-0123456789abcdef0123456789abcdef';
const line = (seq: number, kind: string, actor: unknown, data: Record<string, unknown> = {}) => JSON.stringify({
  actor, data, kind, podId: POD, prev: seq === 1 ? null : 'a'.repeat(64), runId: RUN,
  schema: 'seats.record', seq, taskId: 'TASK-7', ts: `2026-10-28T10:0${seq}:00.000Z`, v: 1,
});
const JSONL = [
  line(1, 'task.claimed', { id: AGENT, owner: HUMAN, type: 'agent' }, { leaseUntil: '2026-10-28T10:31:00.000Z' }),
  line(2, 'task.released', { id: AGENT, type: 'agent' }, { reason: 'blocked' }),
  line(3, 'task.done', { id: 'board', type: 'system' }, { doneBy: HUMAN }),
  line(4, 'harness.switched', null),
].join('\n').concat('\n');
const recordUrl = `/api/pods/${POD}/record/tasks/TASK-7`;
// The first page the view asks for; later pages add `after` by the last seq.
const pageUrl = `${recordUrl}?after=0&limit=1000`;

const tasksUrl = `/api/v1/tasks/${POD}`;
const wire = (
  record: () => Promise<unknown>,
  otlp: () => Promise<unknown> = () => Promise.resolve({ resourceSpans: [] }),
  tasks: () => Promise<unknown> = () => Promise.reject(new Error('no tasks read in this test')),
) => {
  mockGet.mockImplementation((url: string) => {
    if (url === pageUrl) return record();
    if (url === tasksUrl) return tasks();
    if (url === `${recordUrl}?format=otlp`) return otlp();
    if (url === `/api/pods/${POD}`) return Promise.resolve({ members: [{ _id: HUMAN, username: 'ana', displayName: 'Ana' }, { _id: AGENT, username: 'scout' }] });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
};
const setup = (taskId = 'TASK-7') => render(<MemoryRouter initialEntries={[`/v2/pods/${POD}/tasks/${encodeURIComponent(taskId)}/record`]}>
  <Routes><Route path="/v2/pods/:podId/tasks/:taskId/record" element={<V2TaskRecord />} /></Routes>
</MemoryRouter>);
// jsdom's Blob has no text(); FileReader reads it the same way a browser would.
const readBlob = (blob: Blob) => new Promise<string>((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.readAsText(blob);
});
const httpError = (status: number) => () => Promise.reject(Object.assign(new Error('http'), { response: { status } }));

beforeEach(async () => { mockGet.mockReset(); await i18n.changeLanguage('en'); });
afterEach(async () => { await i18n.changeLanguage('en'); });

test('paths come from ids the record route accepts, never from arbitrary text', () => {
  expect(taskRecordPath(POD, 'TASK-7')).toBe(`/v2/pods/${POD}/tasks/TASK-7/record`);
  expect(taskRecordPath('pod-1', 'TASK-7')).toBeNull();
  expect(taskRecordPath(POD, '../admin')).toBeNull();
  expect(taskRecordPath(POD, 'https://evil.example')).toBeNull();
  expect(parseRecord(`${line(1, 'task.claimed', null)}\n\n${line(2, 'task.done', null)}\n`).map((entry) => entry.seq)).toEqual([1, 2]);
});

test('parseable text that is not a record entry is refused, not rendered', () => {
  ['null', '7', '[]', '{"seq":1}']
    .forEach((bad) => expect(() => parseRecord(`${line(1, 'task.claimed', null)}\n${bad}\n`)).toThrow());
});

// One field wrong at a time on an otherwise valid line, so each guard is tested on its own.
test.each([
  ['seq', { seq: 1.5 }],
  ['ts', { ts: 7 }],
  ['kind', { kind: null }],
  ['runId', { runId: null }],
  ['actor', { actor: 'agent' }],
  ['actor.type', { actor: { type: 7, id: AGENT } }],
  ['actor.id', { actor: { type: 'agent' } }],
  ['data', { data: null }],
])('refuses an otherwise valid line whose %s is the wrong shape', (_field, patch) => {
  expect(() => parseRecord(`${line(1, 'task.claimed', { id: AGENT, type: 'agent' })}\n`)).not.toThrow();
  const value = { ...JSON.parse(line(1, 'task.claimed', { id: AGENT, type: 'agent' })), ...patch };
  expect(() => parseRecord(`${JSON.stringify(value)}\n`)).toThrow();
});

test('ids that name Object properties show as ids, never as an inherited value', async () => {
  wire(() => Promise.resolve([
    line(1, 'task.claimed', { id: '__proto__', type: 'human' }),
    line(2, 'task.done', { id: 'board', type: 'system' }, { doneBy: 'constructor' }),
  ].join('\n')));
  setup();
  expect(await screen.findByText('__proto__')).toBeInTheDocument();
  expect(screen.getByText('done by constructor')).toBeInTheDocument();
});

test('keeps reading past a full page, so a long chain is not shown short', async () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => line(from + i, 'task.claimed', { id: AGENT, type: 'agent' }))
    .join('\n').concat('\n');
  const second = `${recordUrl}?after=1000&limit=1000`;
  mockGet.mockImplementation((url: string) => {
    if (url === pageUrl) return Promise.resolve(page(1, 1000));
    if (url === second) return Promise.resolve(page(1001, 2));
    if (url === `/api/pods/${POD}`) return Promise.resolve({ members: [] });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  setup();
  // Both pages render: all 1002 entries are rows on screen.
  expect(await screen.findByText('TASK-7 · 1002 entries', { selector: 'p' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(1002);
  expect(mockGet).toHaveBeenCalledWith(second, expect.anything());
  // A short second page ends the read: no third request.
  expect(mockGet.mock.calls.filter(([url]) => url.startsWith(recordUrl))).toHaveLength(2);
});

test('a failure partway through the chain shows the error, never the partial record', async () => {
  const page = Array.from({ length: 1000 }, (_, i) => line(i + 1, 'task.claimed', { id: AGENT, type: 'agent' })).join('\n').concat('\n');
  mockGet.mockImplementation((url: string) => {
    if (url === pageUrl) return Promise.resolve(page);
    if (url === `${recordUrl}?after=1000&limit=1000`) return Promise.reject(Object.assign(new Error('http'), { response: { status: 503 } }));
    if (url === `/api/pods/${POD}`) return Promise.resolve({ members: [] });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  setup();
  expect(await screen.findByText(i18n.t('taskRecord.store'))).toBeInTheDocument();
  expect(screen.queryByText('Claimed')).toBeNull();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

test('reads the JSONL as text and shows every entry with member names, unknown kinds by name', async () => {
  wire(() => Promise.resolve(JSONL));
  setup();
  expect(await screen.findByText('Claimed')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(pageUrl, expect.objectContaining({ responseType: 'text' }));
  // A one-line record is still text: the transform must not parse it as JSON.
  const config = mockGet.mock.calls.find(([url]) => url === pageUrl)[1];
  expect(config.transformResponse[0](line(1, 'task.done', null))).toBe(line(1, 'task.done', null));
  expect(screen.getByText('TASK-7 · 4 entries', { selector: 'p' })).toBeInTheDocument();
  expect(screen.getByText(`Run ${RUN}`)).toBeInTheDocument();
  expect(screen.getByText('Released')).toBeInTheDocument();
  expect(screen.getByText('reason blocked')).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.getByText('harness.switched')).toBeInTheDocument();
  // An agent is its name and avatar, never "(agent)".
  await waitFor(() => expect(screen.getAllByText('scout')).toHaveLength(2));
  expect(screen.queryByText(/\(agent\)/)).toBeNull();
  expect(screen.getByText('Board')).toBeInTheDocument();
  expect(screen.getByText('Unknown actor')).toBeInTheDocument();
  expect(screen.getByText('done by Ana')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: 'TASK-7' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to board' })).toHaveAttribute('href', `/v2/pods/${POD}/board`);
  // The intro sits behind the (i) beside the title, not on the page.
  expect(screen.getByRole('button', { name: 'About the record' })).toBeInTheDocument();
});

test('an empty chain says so rather than showing a blank page', async () => {
  wire(() => Promise.resolve(''));
  setup();
  expect(await screen.findByText('Nothing has been recorded for this task yet.')).toBeInTheDocument();
  expect(screen.getByText('TASK-7 · 0 entries', { selector: 'p' })).toBeInTheDocument();
});

test.each([
  [404, "This record isn't availableThe pod may not keep records, or you no longer have access.", false],
  [403, 'Only members of this pod can read its record.', false],
  [503, 'The record store is unavailable right now. Try again shortly.', true],
  [500, 'Could not load the record. Try again.', true],
])('a %i is its own message, never an empty record', async (status, message, retryable) => {
  wire(httpError(status));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByText(/entries/)).toBeNull();
  expect(!!screen.queryByRole('button', { name: 'Try again' })).toBe(retryable);
});

test('a line that is not JSON makes the whole record unreadable, not partly shown', async () => {
  wire(() => Promise.resolve(`${line(1, 'task.claimed', null)}\nnot json\n`));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('This record could not be read.');
  expect(screen.queryByText('Claimed')).toBeNull();
});

test('a JSON line that is not a record entry makes the record unreadable too', async () => {
  wire(() => Promise.resolve(`${line(1, 'task.claimed', null)}\nnull\n`));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('This record could not be read.');
  expect(screen.queryByText('Claimed')).toBeNull();
});

test('a task id the route would refuse is never requested', async () => {
  wire(() => Promise.resolve(JSONL));
  setup('bad id');
  expect(await screen.findByRole('alert')).toHaveTextContent("This record isn't available");
  expect(mockGet).not.toHaveBeenCalled();
});

test('downloads the served JSONL bytes and the OTLP export as files', async () => {
  const saved: Array<{ name: string; type: string; text: Promise<string> }> = [];
  const createObjectURL = jest.fn((blob: Blob) => { saved.push({ name: '', type: blob.type, text: readBlob(blob) }); return `blob:${saved.length}`; });
  const revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(this: HTMLAnchorElement) {
    saved[saved.length - 1].name = this.download;
  });
  try {
    let failOtlp = true;
    wire(() => Promise.resolve(JSONL), () => (failOtlp ? Promise.reject(new Error('down')) : Promise.resolve({ resourceSpans: [{ id: 1 }] })));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download JSONL' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(saved[0].name).toBe('TASK-7.record.jsonl');
    expect(saved[0].type).toBe('application/x-ndjson');
    await expect(saved[0].text).resolves.toBe(JSONL);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download OTLP' }));
    expect(await screen.findByText('Could not download the record. Try again.')).toBeInTheDocument();
    expect(saved).toHaveLength(1);
    failOtlp = false;
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download OTLP' }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1].name).toBe('TASK-7.record.otlp.json');
    await expect(saved[1].text).resolves.toBe(JSON.stringify({ resourceSpans: [{ id: 1 }] }));
    expect(screen.queryByText('Could not download the record. Try again.')).toBeNull();
  } finally { click.mockRestore(); }
});

test('Chinese copy covers the page', async () => {
  await i18n.changeLanguage('zh-CN');
  wire(() => Promise.resolve(JSONL));
  setup();
  expect(await screen.findByText('已认领')).toBeInTheDocument();
  expect(screen.getByText('TASK-7 · 4条记录', { selector: 'p' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下载' }));
  expect(screen.getByRole('menuitem', { name: '下载 JSONL' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '返回看板' })).toBeInTheDocument();
  expect(screen.getByText('原因：受阻')).toBeInTheDocument();
  expect(screen.getByText('由 Ana 完成')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '关于此记录' })).toBeInTheDocument();
});

test('an entry\'s data folds under its row, entry number included', async () => {
  wire(() => Promise.resolve(JSONL));
  setup();
  const row = (await screen.findByText('Released')).closest('button') as HTMLButtonElement;
  expect(row).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('reason', { selector: 'dt' })).toBeNull();
  fireEvent.click(row);
  expect(row).toHaveAttribute('aria-expanded', 'true');
  const more = document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
  expect(more).toHaveTextContent('entry2reasonblocked');
  fireEvent.click(row);
  expect(row).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('reason', { selector: 'dt' })).toBeNull();
});

test('each row says its entry in one line: lease, ask, decision, tool call', async () => {
  wire(() => Promise.resolve([
    line(1, 'task.claimed', { id: AGENT, type: 'agent' }, { leaseUntil: '2026-10-28T10:31:00.000Z' }),
    line(2, 'permission.requested', { id: AGENT, type: 'agent' }, { question: 'Open pull request #409?', askedOf: { id: HUMAN, role: 'requester' } }),
    line(3, 'permission.decided', { id: HUMAN, type: 'human' }, { outcome: 'selected', kind: 'allow_once', decidedBy: HUMAN }),
    line(4, 'tool.call', { id: AGENT, type: 'agent' }, { toolCallId: 'tc-4', title: 'Open', name: 'gh.pr_create', status: 'completed' }),
  ].join('\n')));
  setup();
  const lease = new Date('2026-10-28T10:31:00.000Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  expect(await screen.findByText(`lease until ${lease}`)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Open pull request #409? · asked Ana')).toBeInTheDocument());
  expect(screen.getByText('allow once')).toBeInTheDocument();
  expect(screen.getByText('gh.pr_create · completed')).toBeInTheDocument();
});

test('while the record loads, the header is in place and a status is announced', () => {
  mockGet.mockImplementation(() => new Promise(() => undefined));
  setup();
  expect(screen.getByRole('status')).toHaveTextContent('Loading record…');
  expect(screen.getByRole('heading', { level: 1, name: 'Task record' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
});

test('the heading is the task\'s title from the board list, with the id on the line below', async () => {
  wire(() => Promise.resolve(JSONL), undefined, () => Promise.resolve({ tasks: [
    { taskId: 'TASK-6', title: 'Not this one' },
    { taskId: 'TASK-7', title: '<b>CI check</b>: fail a PR' },
  ] }));
  setup();
  // Plain text: markup in a title is shown as typed, never parsed.
  expect(await screen.findByRole('heading', { level: 2, name: '<b>CI check</b>: fail a PR' })).toBeInTheDocument();
  expect(document.querySelector('.v2-task-record__task b')).toBeNull();
  expect(screen.getByText('TASK-7 · 4 entries', { selector: 'p' })).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(tasksUrl);
});

test.each([
  ['the tasks read fails', () => Promise.reject(new Error('down'))],
  ['the tasks read is refused', () => Promise.reject(Object.assign(new Error('http'), { response: { status: 403 } }))],
  ['the task is missing from the list', () => Promise.resolve({ tasks: [{ taskId: 'TASK-8', title: 'Another' }] })],
  ['the list is not a list', () => Promise.resolve({ tasks: 'nope' })],
  ['the matching task\'s title is blank', () => Promise.resolve({ tasks: [{ taskId: 'TASK-7', title: '   ' }] })],
  ['the matching task\'s title is not a string', () => Promise.resolve({ tasks: [{ taskId: 'TASK-7', title: { text: 'CI check' } }] })],
])('when %s, the heading stays the id and no error shows', async (_case, tasks) => {
  wire(() => Promise.resolve(JSONL), undefined, tasks);
  setup();
  expect(await screen.findByText('Claimed')).toBeInTheDocument();
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith(tasksUrl));
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(screen.getByRole('heading', { level: 2, name: 'TASK-7' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the record never waits on the tasks read: it renders with the id, then takes the title', async () => {
  let land: (value: unknown) => void = () => undefined;
  wire(() => Promise.resolve(JSONL), undefined, () => new Promise((resolve) => { land = resolve; }));
  setup();
  expect(await screen.findByText('Claimed')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: 'TASK-7' })).toBeInTheDocument();
  land({ tasks: [{ taskId: 'TASK-7', title: 'CI check' }] });
  expect(await screen.findByRole('heading', { level: 2, name: 'CI check' })).toBeInTheDocument();
});

test('release reasons and decisions read as words in both languages; unknown values show as written', async () => {
  const lines = [
    line(1, 'task.released', { id: AGENT, type: 'agent' }, { reason: 'lease_expired' }),
    line(2, 'permission.decided', { id: HUMAN, type: 'human' }, { outcome: 'selected', kind: 'reject_once', decidedBy: HUMAN }),
    line(3, 'task.released', { id: AGENT, type: 'agent' }, { reason: 'moved_elsewhere' }),
    line(4, 'permission.decided', { id: HUMAN, type: 'human' }, { outcome: 'cancelled', decidedBy: HUMAN }),
  ].join('\n');
  wire(() => Promise.resolve(lines));
  const { unmount } = setup();
  expect(await screen.findByText('reason lease expired')).toBeInTheDocument();
  expect(screen.getByText('reject once')).toBeInTheDocument();
  expect(screen.getByText('reason moved elsewhere')).toBeInTheDocument();
  expect(screen.getByText('cancelled')).toBeInTheDocument();
  unmount();
  await i18n.changeLanguage('zh-CN');
  setup();
  expect(await screen.findByText('原因：租约到期')).toBeInTheDocument();
  expect(screen.getByText('拒绝一次')).toBeInTheDocument();
  expect(screen.getByText('已取消')).toBeInTheDocument();
  expect(screen.getByText('原因：moved elsewhere')).toBeInTheDocument();
});

test('a digest shows as the frame draws it, with the full value in its title', async () => {
  const full = `sha256:9f2c${'0'.repeat(56)}41ab`;
  expect(shortDigest(full)).toBe('sha256:9f2c…41ab');
  expect(shortDigest('sha256:9f2c41ab')).toBe('sha256:9f2c41ab');
  expect(shortDigest('not a digest')).toBe('not a digest');
  wire(() => Promise.resolve(line(1, 'tool.call', { id: AGENT, type: 'agent' }, { toolCallId: 'tc-1', title: 'Open', argsDigest: full })));
  setup();
  fireEvent.click((await screen.findByText('Tool call')).closest('button') as HTMLButtonElement);
  const cell = screen.getByText('sha256:9f2c…41ab');
  expect(cell).toHaveAttribute('title', full);
});

// Moves between two tasks' records inside one mounted page, as a link on the page would.
const setupTwoTasks = () => render(<MemoryRouter initialEntries={[`/v2/pods/${POD}/tasks/TASK-7/record`]}>
  <Link to={`/v2/pods/${POD}/tasks/TASK-8/record`}>next task</Link>
  <Routes><Route path="/v2/pods/:podId/tasks/:taskId/record" element={<V2TaskRecord />} /></Routes>
</MemoryRouter>);
const recordOf = (taskId: string) => [
  line(1, 'task.claimed', { id: AGENT, type: 'agent' }).replace('"TASK-7"', `"${taskId}"`),
  line(2, 'task.released', { id: AGENT, type: 'agent' }, { reason: 'blocked' }).replace('"TASK-7"', `"${taskId}"`),
].join('\n');

test.each([
  ['the old task\'s read lands late', true],
  ['the next task\'s read fails', false],
])('after moving to another task, the old title never shows when %s', async (_case, late) => {
  let landFirst: (value: unknown) => void = () => undefined;
  let tasksCalls = 0;
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith(`/api/pods/${POD}/record/tasks/`)) return Promise.resolve(recordOf(url.includes('TASK-8') ? 'TASK-8' : 'TASK-7'));
    if (url === `/api/pods/${POD}`) return Promise.resolve({ members: [] });
    if (url === tasksUrl) {
      tasksCalls += 1;
      const list = { tasks: [{ taskId: 'TASK-7', title: 'Old title' }] };
      if (tasksCalls === 1) return late ? new Promise((resolve) => { landFirst = resolve; }) : Promise.resolve(list);
      return Promise.reject(new Error('down'));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  setupTwoTasks();
  if (!late) expect(await screen.findByRole('heading', { level: 2, name: 'Old title' })).toBeInTheDocument();
  else expect(await screen.findByRole('heading', { level: 2, name: 'TASK-7' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'next task' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'TASK-8' })).toBeInTheDocument();
  await waitFor(() => expect(tasksCalls).toBe(2));
  // Inside act, so a state update the late read makes is rendered before the check.
  await act(async () => {
    landFirst({ tasks: [{ taskId: 'TASK-7', title: 'Old title' }] });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  expect(screen.queryByText('Old title')).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'TASK-8' })).toBeInTheDocument();
});

test('an open row and the Download menu do not carry over to the next task', async () => {
  mockGet.mockImplementation((url: string) => {
    if (url.startsWith(`/api/pods/${POD}/record/tasks/`)) return Promise.resolve(recordOf(url.includes('TASK-8') ? 'TASK-8' : 'TASK-7'));
    if (url === `/api/pods/${POD}`) return Promise.resolve({ members: [] });
    return Promise.reject(new Error('no tasks read'));
  });
  setupTwoTasks();
  fireEvent.click((await screen.findByText('Released')).closest('button') as HTMLButtonElement);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByText('Released').closest('button')).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('link', { name: 'next task' }));
  expect(await screen.findByText('TASK-8 · 2 entries', { selector: 'p' })).toBeInTheDocument();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByText('Released').closest('button')).toHaveAttribute('aria-expanded', 'false');
});

test('an entry of another kind shows its first two plain values, skipping objects between them', async () => {
  wire(() => Promise.resolve(line(1, 'attempt.settled', { id: AGENT, type: 'agent' }, { attempt: 2, failure: { kind: 'exit', detail: 'x' }, outcome: 'failed', extra: 'not shown' })));
  setup();
  expect(await screen.findByText('2 · failed')).toBeInTheDocument();
  expect(screen.queryByText(/not shown/)).toBeNull();
});

test('a long actor name keeps its full text in the title, so a truncated row still says who', async () => {
  const long = 'a-very-long-actor-id-that-would-push-the-time-off-the-row-0123456789';
  wire(() => Promise.resolve(line(1, 'task.claimed', { id: long, type: 'human' })));
  setup();
  const name = await screen.findByText(long, { selector: '.v2-task-record__name' });
  expect(name.closest('.v2-task-record__who')).toHaveAttribute('title', long);
});

describe('a redacted view (F265)', () => {
  const hidden = (seq: number, kind: string, actor: unknown, data: Record<string, unknown>) => JSON.stringify({
    ...JSON.parse(line(seq, kind, actor, data)), redaction: { fields: ['data.decidedBy'], hash: 'b'.repeat(64) },
  });
  const VIEW = [
    hidden(1, 'permission.decided', { id: 'redacted', type: 'human' }, { decidedBy: 'redacted', kind: 'allow_once' }),
    line(2, 'tool.update', { id: AGENT, type: 'agent' }, { toolCallId: 'tc', status: 'completed' }),
  ].join('\n').concat('\n');

  test('names a hidden person as hidden, never by the placeholder, and says why', async () => {
    wire(() => Promise.resolve(VIEW));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.getByText(/shows only to that person and the pod's creator/)).toBeInTheDocument();
    expect(screen.getByText(/A hidden name doesn't mean an entry changed/)).toBeInTheDocument();
    expect(screen.getAllByText('Hidden').length).toBeGreaterThan(0);
    expect(screen.queryByText('redacted')).not.toBeInTheDocument();
  });

  test('a full record shows no such note', async () => {
    wire(() => Promise.resolve(JSONL));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText(/names here are hidden/)).not.toBeInTheDocument();
  });

  const COMMITTED = `c1:${'a'.repeat(64)}`;
  const OPENED = `c1:${'c'.repeat(64)}`;
  const committed = (seq: number, data: Record<string, unknown>, openings?: Record<string, unknown>) => JSON.stringify({
    ...JSON.parse(line(seq, 'grant.issued', { id: COMMITTED, type: 'human' }, data)), ...(openings ? { openings } : {}),
  });

  test('a commitment nobody opened shows as hidden, in the row and in its details, never as a token', async () => {
    const scope = { audience: [OPENED], connectionId: COMMITTED };
    wire(() => Promise.resolve(`${committed(1, { grantId: 'g', issuedBy: COMMITTED, scope }, { [OPENED]: { id: AGENT, salt: 'd'.repeat(32) } })}\n`));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.getByText(/names here are hidden/)).toBeInTheDocument();
    screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-expanded')).forEach((button) => fireEvent.click(button));
    expect(document.body.textContent).not.toContain('c1:');
    expect(document.body.textContent).toContain(AGENT);
  });

  test('an older line\'s placeholder nested in a scope shows as hidden too, never as the word redacted', async () => {
    wire(() => Promise.resolve(`${hidden(1, 'grant.issued', { id: 'redacted', type: 'human' }, {
      grantId: 'g', issuedBy: 'redacted', scope: { audience: ['redacted'], connectionId: 'redacted' },
    })}\n`));
    setup();
    await screen.findByRole('heading', { level: 2 });
    screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-expanded')).forEach((button) => fireEvent.click(button));
    expect(document.body.textContent).not.toContain('redacted');
    expect(document.body.textContent).toContain('"connectionId":"Hidden"');
  });

  test('an opened commitment reads as the person, with no note', async () => {
    wire(() => Promise.resolve(`${committed(1, { grantId: 'g', issuedBy: COMMITTED }, { [COMMITTED]: { id: AGENT, salt: 'd'.repeat(32) } })}\n`));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.queryByText(/names here are hidden/)).not.toBeInTheDocument();
  });

  test('an unlinked or redacted line never reads as damage: no error state, no alert, and a plain note', async () => {
    const unlinked = JSON.stringify({
      ...JSON.parse(line(1, 'permission.decided', { id: 'redacted', type: 'human' }, { decidedBy: 'redacted', kind: 'allow_once' })),
      prev: null, redaction: { fields: ['data.decidedBy'], hash: null },
    });
    wire(() => Promise.resolve(`${unlinked}\n${line(2, 'tool.update', { id: AGENT, type: 'agent' }, { status: 'completed' })}\n`));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.getByText(/That doesn't mean they changed/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('This record could not be read.')).not.toBeInTheDocument();
    expect(screen.queryByText(/tamper|broken|corrupt|invalid|modified|failed/i)).not.toBeInTheDocument();
  });

  test('a salted hidden line has no unlinked note', async () => {
    wire(() => Promise.resolve(VIEW));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText(/can't be linked/)).not.toBeInTheDocument();
  });

  test('the note reads in Chinese under zh-CN', async () => {
    await i18n.changeLanguage('zh-CN');
    wire(() => Promise.resolve(VIEW));
    setup();
    await screen.findByRole('heading', { level: 2 });
    expect(screen.getByText(/只有本人和 Pod 的创建者能看到/)).toBeInTheDocument();
    expect(screen.getAllByText('已隐藏').length).toBeGreaterThan(0);
  });
});

test('the intro says what the record holds and who can read it, in both languages', async () => {
  expect(i18n.getFixedT('en')('taskRecord.intro')).toMatch(/Members of this pod can read it\./);
  expect(i18n.getFixedT('zh-CN')('taskRecord.intro')).toMatch(/此 Pod 的成员都能查看/);
});

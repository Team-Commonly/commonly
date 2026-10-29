import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../i18n';
import V2TaskRecord, { parseRecord, taskRecordPath } from '../components/V2TaskRecord';

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

const wire = (record: () => Promise<unknown>, otlp: () => Promise<unknown> = () => Promise.resolve({ resourceSpans: [] })) => {
  mockGet.mockImplementation((url: string) => {
    if (url === recordUrl) return record();
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
  expect(await screen.findByText('__proto__ ·', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('constructor')).toBeInTheDocument();
});

test('reads the JSONL as text and shows every entry with member names, unknown kinds by name', async () => {
  wire(() => Promise.resolve(JSONL));
  setup();
  expect(await screen.findByText('Claimed')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(recordUrl, expect.objectContaining({ responseType: 'text' }));
  // A one-line record is still text: the transform must not parse it as JSON.
  const config = mockGet.mock.calls.find(([url]) => url === recordUrl)[1];
  expect(config.transformResponse[0](line(1, 'task.done', null))).toBe(line(1, 'task.done', null));
  expect(screen.getByText('4 entries')).toBeInTheDocument();
  expect(screen.getByText(`Run ${RUN}`)).toBeInTheDocument();
  expect(screen.getByText('Released')).toBeInTheDocument();
  expect(screen.getByText('blocked')).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.getByText('harness.switched')).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByText(/scout \(agent\)/)).toHaveLength(2));
  expect(screen.getByText(/^Board ·/)).toBeInTheDocument();
  expect(screen.getByText(/^Unknown actor ·/)).toBeInTheDocument();
  expect(screen.getByText('Ana')).toBeInTheDocument();
  expect(screen.getByText('Entry 4')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to board' })).toHaveAttribute('href', `/v2/pods/${POD}/board`);
});

test('an empty chain says so rather than showing a blank page', async () => {
  wire(() => Promise.resolve(''));
  setup();
  expect(await screen.findByText('Nothing has been recorded for this task yet.')).toBeInTheDocument();
  expect(screen.getByText('0 entries')).toBeInTheDocument();
});

test.each([
  [404, "This record isn't available. The pod may not keep records, or you no longer have access to it.", false],
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
  expect(await screen.findByRole('alert')).toHaveTextContent("This record isn't available.");
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
    fireEvent.click(await screen.findByRole('button', { name: 'Download JSONL' }));
    expect(saved[0].name).toBe('TASK-7.record.jsonl');
    expect(saved[0].type).toBe('application/x-ndjson');
    await expect(saved[0].text).resolves.toBe(JSONL);

    fireEvent.click(screen.getByRole('button', { name: 'Download OTLP' }));
    expect(await screen.findByText('Could not download the record. Try again.')).toBeInTheDocument();
    expect(saved).toHaveLength(1);
    failOtlp = false;
    fireEvent.click(screen.getByRole('button', { name: 'Download OTLP' }));
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
  expect(screen.getByText('4条记录')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下载 JSONL' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '返回看板' })).toBeInTheDocument();
});

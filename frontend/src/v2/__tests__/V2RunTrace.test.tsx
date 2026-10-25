import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../i18n';
import V2RunTrace from '../components/V2RunTrace';
import V2RunTraceLink from '../components/V2RunTraceLink';

const mockGet = jest.fn();
const mockApi = { get: mockGet };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
const POD = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const RUN = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const trace = {
  id: RUN, podId: POD, agentName: 'Ada', instanceId: 'default', status: 'succeeded',
  trigger: 'mention', startedAt: '2026-10-25T01:00:00Z', totalTokens: 123,
  traceTruncated: false, omittedTurns: 0, omittedToolCalls: 0,
  turns: [{ turnIndex: 0, model: 'model', elapsedMs: 12, totalTokens: 123,
    toolCalls: [{ name: 'vendor.read', elapsedMs: 5, callId: 'call-1', outcome: 'ok',
      trail: { grantId: 'grant-1', credentialOwnerId: 'owner-1', outcome: 'ok' } }] }],
};
const setup = () => render(<MemoryRouter initialEntries={[`/v2/pods/${POD}/runs/${RUN}`]}>
  <Routes><Route path="/v2/pods/:podId/runs/:runId" element={<V2RunTrace />} /></Routes>
</MemoryRouter>);
beforeEach(async () => { mockGet.mockReset(); await i18n.changeLanguage('en'); });
afterEach(async () => { await i18n.changeLanguage('en'); });
test('server-bound link derives its destination from IDs and refuses arbitrary URLs', () => {
  const { rerender } = render(<MemoryRouter><V2RunTraceLink podId={POD} runId={RUN} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'View run trace' })).toHaveAttribute('href', `/v2/pods/${POD}/runs/${RUN}`);
  rerender(<MemoryRouter><V2RunTraceLink podId={POD} runId="https://evil.example" /></MemoryRouter>);
  expect(screen.queryByRole('link')).toBeNull();
});
test('reads recorded turns and PG attribution, with honest retention wording', async () => {
  mockGet.mockResolvedValue({ run: trace });
  setup();
  await screen.findByText('vendor.read');
  expect(mockGet).toHaveBeenCalledWith(`/api/pods/${POD}/runs/${RUN}`);
  expect(screen.getByText('grant-1')).toBeInTheDocument();
  expect(screen.getByText('owner-1')).toBeInTheDocument();
  expect(screen.getByText(/30-day default retention/)).toBeInTheDocument();
  expect(screen.getByText(/This trace persists after the card expires/)).toBeInTheDocument();
});
test.each(['en', 'zh-CN'])('withheld authorization identities have no labels or missing-record claims (%s)', async (language) => {
  await act(async () => { await i18n.changeLanguage(language); });
  mockGet.mockResolvedValue({ run: { ...trace, turns: [{ ...trace.turns[0], toolCalls: [{
    ...trace.turns[0].toolCalls[0], trail: { outcome: 'ok' },
  }] }] } });
  setup();
  await screen.findByText('vendor.read');
  expect(screen.queryByText(i18n.t('runTrace.grant'))).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t('runTrace.owner'))).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t('runTrace.notRecorded'))).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t('runTrace.outcome'))).toBeInTheDocument();
});
test('refusal can retry and never presents an empty successful trace', async () => {
  mockGet.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({ run: trace });
  setup();
  await screen.findByRole('alert');
  expect(screen.queryByText('No turns recorded yet.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('vendor.read');
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
test('discloses truncation and missing broker rows without inventing attribution', async () => {
  mockGet.mockResolvedValue({ run: { ...trace, traceTruncated: true, omittedTurns: 2, omittedToolCalls: 3,
    turns: [{ ...trace.turns[0], toolCalls: [{ name: 'vendor.read', callId: 'gone', outcome: 'unavailable', trail: null, elapsedMs: 1 }] }] } });
  setup();
  await screen.findByText('Broker trail unavailable.');
  expect(screen.getByText(/2 turns and 3 tool calls are omitted/)).toBeInTheDocument();
});

test.each([
  [0, 2, '2 tool calls are omitted', '0 turns'],
  [2, 0, '2 turns are omitted', '0 tool calls'],
  [0, 0, 'Large content fields are capped', 'are omitted'],
])('size disclosure omits empty counts (%i turns, %i calls)', async (turns, calls, expected, absent) => {
  mockGet.mockResolvedValue({ run: { ...trace, traceTruncated: true, omittedTurns: turns, omittedToolCalls: calls } });
  setup();
  await screen.findByText(new RegExp(expected));
  expect(screen.queryByText(new RegExp(absent))).not.toBeInTheDocument();
});
test('Chinese status, trigger, region label and nonzero truncation clause are localized', async () => {
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
  mockGet.mockResolvedValue({ run: { ...trace, traceTruncated: true, omittedToolCalls: 2 } });
  setup();
  await screen.findByText('已完成 · 提及');
  expect(screen.getByText('成功 · 5 ms')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '运行轨迹' })).toBeInTheDocument();
  expect(screen.getByText(/省略了2次工具调用/)).toBeInTheDocument();
  expect(screen.queryByText(/0轮/)).not.toBeInTheDocument();
});
test('future enum values remain visible instead of showing translation keys', async () => {
  mockGet.mockResolvedValue({ run: { ...trace, status: 'future-status', trigger: 'future-trigger' } });
  setup();
  await screen.findByText('future-status · future-trigger');
});

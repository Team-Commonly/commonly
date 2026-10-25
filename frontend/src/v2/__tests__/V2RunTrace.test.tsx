import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
beforeEach(() => { mockGet.mockReset(); });
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

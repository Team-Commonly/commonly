import revision from '../uiCardCatalogueRevision.json';
import React from 'react';
import { TextEncoder } from 'util';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2UICard from '../V2UICard';
import type { V2Message } from '../../hooks/useV2PodDetail';
Object.assign(global, { TextEncoder });
const message = (source: string, created_at = new Date().toISOString()): V2Message => ({
  id: 'm1', pod_id: '111111111111111111111111', user_id: 'u1', message_type: 'card', created_at,
  content: 'Plain fallback', payload: { ...revision, kind: 'ui', v: 1, lang: 'openui@1', source },
});
const show = (m: V2Message) => render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><V2UICard message={m} authorLabel="Polish" /></MemoryRouter>);
test('renders the real runtime and keeps the agent attribution', async () => {
  show(message('root = Card("Result", [Text("Literal <script> text"), Badge("Ready", "neutral")])'));
  expect(await screen.findByText('Literal <script> text')).toBeInTheDocument();
  expect(screen.getByText('Polish')).toBeInTheDocument();
  expect(screen.getByText('Ready')).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('[data-openui-devtools-auto-mount]')).toBeNull();
});
test('failed parsing leaves the content and a single explanation', () => {
  show(message('root = Query("secret")'));
  expect(screen.getByText('Plain fallback')).toBeInTheDocument();
  expect(screen.getByText('This card couldn’t be displayed.')).toBeInTheDocument();
});
test('expires at 30 days without discarding the content or trusted trace link', () => {
  const m = message('root = Text("Old")', new Date(Date.now() - 31 * 86400000).toISOString());
  m.payload!.runId = '012345678901234567890123';
  show(m);
  expect(screen.getByText('Plain fallback')).toBeInTheDocument();
  expect(screen.getByText('Card expires after 30 days. Trace persists.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open trace' })).toHaveAttribute('href', '/v2/pods/111111111111111111111111/runs/012345678901234567890123');
});

test.each([{ catalogRev: 2 }, { catalogId: 'other' }, { catalogHash: 'sha256:bad' }, { catalogRev: undefined }])('unknown catalogue tuple preserves text: %j', tuple => {
  const m = message('root = Text("Must not render")');
  Object.assign(m.payload!, tuple);
  show(m);
  expect(screen.getByText('Plain fallback')).toBeInTheDocument();
  expect(screen.getByText('Unsupported card version.')).toBeInTheDocument();
  expect(screen.queryByText('Must not render')).not.toBeInTheDocument();
});

test('an expired forwarded card links to its server-bound source pod', () => {
  const m = message('root = Text("Old")', new Date(Date.now() - 31 * 86400000).toISOString());
  m.payload!.runId = '012345678901234567890123';
  m.payload!.runPodId = '222222222222222222222222';
  show(m);
  expect(screen.getByRole('link', { name: 'Open trace' })).toHaveAttribute('href', '/v2/pods/222222222222222222222222/runs/012345678901234567890123');
});

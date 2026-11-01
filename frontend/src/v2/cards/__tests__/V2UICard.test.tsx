import revision from '../uiCardCatalogueRevision.json';
import revision2 from '../uiCardCatalogueRevision.rev2.json';
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

test.each([{ catalogRev: 2 }, { catalogRev: 3 }, { ...revision2, catalogRev: 3 }, { catalogId: 'other' }, { catalogHash: 'sha256:bad' }, { catalogRev: undefined }])('unknown catalogue tuple preserves text: %j', tuple => {
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

// TASK-607: catalogue revision 2 adds the server-stamped Source(connector, fetchedAt).
const stampedAt = new Date(Date.now() - 2 * 60_000).toISOString();
const rev2 = (source: string) => { const m = message(source); Object.assign(m.payload!, revision2); return m; };
test('revision 1 and revision 2 cards both render', async () => {
  show(message('root = Card("Rev one", [Text("Still renders")])'));
  expect(await screen.findByText('Still renders')).toBeInTheDocument();
  show(rev2(`root = Card("Rev two", [Text("Issues"), Source("linear", "${stampedAt}")])`));
  expect(await screen.findByText('Issues')).toBeInTheDocument();
});
test('a stamped Source shows the bundled mark, the connector and relative time with the absolute time as its title', async () => {
  show(rev2(`root = Card("Open issues", [Text("Two need a reply"), Link("Open Linear", "https://linear.app/x", "button"), Source("linear", "${stampedAt}")])`));
  const time = await screen.findByText('fetched 2 min ago');
  expect(time.tagName).toBe('TIME');
  expect(time).toHaveAttribute('dateTime', stampedAt);
  expect(time).toHaveAttribute('title', new Date(stampedAt).toLocaleString());
  expect(screen.getByText('Linear')).toBeInTheDocument();
  const source = time.closest('.ui-src')!;
  expect(source.querySelector('svg.v2-cx-logo')).not.toBeNull();
  expect(source.querySelector('img, image')).toBeNull();
  // The origin sits in the footer beside the buttons, not in the body.
  expect(source.closest('.ui-ft')).not.toBeNull();
  expect(source.closest('.ui-ft')!.textContent).toContain('Open Linear');
});
test('Source is unreadable under revision 1, so a rev 1 card can never carry an origin', () => {
  show(message(`root = Card("Spoof", [Text("x"), Source("linear", "${stampedAt}")])`));
  expect(screen.getByText('This card couldn’t be displayed.')).toBeInTheDocument();
  expect(screen.queryByText('Linear')).not.toBeInTheDocument();
});
test.each([
  ['an unknown connector', `root = Card("x", [Text("y"), Source("github", "${stampedAt}")])`],
  ['a Source at the root', `root = Source("linear", "${stampedAt}")`],
  ['two Sources', `root = Card("x", [Text("y"), Source("linear", "${stampedAt}"), Source("sentry", "${stampedAt}")])`],
  ['a nested Source', `root = Card("x", [Card("inner", [Text("y"), Source("linear", "${stampedAt}")])])`],
  ['a fetchedAt that is not a stamp', 'root = Card("x", [Text("y"), Source("linear", "yesterday")])'],
])('the rev 2 reader refuses %s', (_label, source) => {
  show(rev2(source));
  expect(screen.getByText('This card couldn’t be displayed.')).toBeInTheDocument();
});

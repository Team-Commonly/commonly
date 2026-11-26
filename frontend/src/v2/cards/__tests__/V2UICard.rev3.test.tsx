import revision1 from '../uiCardCatalogueRevision.json';
import revision3 from '../uiCardCatalogueRevision.rev3.json';
import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2UICard from '../V2UICard';
import { cardRevision, parseCard } from '../uiCardSource';
import type { V2Message } from '../../hooks/useV2PodDetail';

Object.assign(global, { TextEncoder });
const mockApi = { get: jest.fn(), post: jest.fn() };
jest.mock('../../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

// Catalogue revision 3: Progress, BarChart, LineChart and acting Buttons.
const message = (source: string, pin: object = revision3): V2Message => ({
  id: '700', pod_id: '111111111111111111111111', user_id: 'u1', message_type: 'card', created_at: new Date().toISOString(),
  content: 'Plain fallback', payload: { ...pin, kind: 'ui', v: 1, lang: 'openui@1', source },
});
const show = (m: V2Message) => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
  <V2UICard message={m} authorLabel="Release" /></MemoryRouter>);
const CHOICE = 'root = Card("Ship it?", [Text("The branch is green."), '
  + 'Button("Ship", Action(@ToAssistant("Ship")), "primary"), Button("Hold", Action(@ToAssistant("Hold")))])';
const rev3 = cardRevision(revision3)!;

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.get.mockResolvedValue({ decision: null });
});

describe('revision 3 parse checks match the server', () => {
  it.each([
    ['a single choice', 'root = Card("x", [Button("A", Action(@ToAssistant("A")))])'],
    ['a repeated choice', 'root = Card("x", [Button("Go", Action(@ToAssistant("Go"))), Button("go", Action(@ToAssistant("go")))])'],
    ['a repeated label', 'root = Card("x", [Button("Go", Action(@ToAssistant("Go"))), Button("Go", Action(@ToAssistant("Go")))])'],
    ['a choice that differs from its label', 'root = Card("x", [Button("Approve", Action(@ToAssistant("merge"))), Button("B", Action(@ToAssistant("B")))])'],
    ['an @mention in the choice', 'root = Card("x", [Button("@codex go", Action(@ToAssistant("@codex go"))), Button("B", Action(@ToAssistant("B")))])'],
    ['an OpenUrl button', 'root = Card("x", [Button("Open", Action(@OpenUrl("https://github.com"))), Button("B", Action(@ToAssistant("B")))])'],
    ['a loose ToAssistant', 'root = Text("x")\nloose = ToAssistant("a")'],
    ['hidden context', 'root = Card("x", [Button("A", Action(@ToAssistant("A", "c"))), Button("B", Action(@ToAssistant("B")))])'],
    ['a short series', 'root = BarChart(["a", "b"], [Series("x", [1])])'],
  ])('refuses %s', (_name, source) => {
    expect(parseCard(source, rev3)).toBeNull();
  });
  it('keeps the new components out of revision 1', () => {
    expect(parseCard('root = Progress(50)', cardRevision(revision1))).toBeNull();
    expect(parseCard(CHOICE, cardRevision(revision1))).toBeNull();
    expect(parseCard(CHOICE, rev3)).not.toBeNull();
  });
});

test('progress and both charts render with their numbers readable', async () => {
  show(message('root = Card("Sprint", [Progress(62, "Sprint 14"), '
    + 'BarChart(["Mon", "Tue"], [Series("Merged", [3, 5]), Series("Opened", [4, 2])], "stacked", "Day", "PRs"), '
    + 'LineChart(["W1", "W2"], [Series("p90", [41, 33])])])'));
  const bar = await screen.findByRole('progressbar', { name: 'Sprint 14' });
  expect(bar).toHaveAttribute('aria-valuenow', '62');
  expect(screen.getByText('62%')).toBeInTheDocument();
  expect(screen.getAllByRole('img')).toHaveLength(2);
  // The legend names both series; the hidden table carries every value.
  expect(screen.getAllByText('Merged').length).toBeGreaterThan(0);
  expect(screen.getAllByRole('table')).toHaveLength(2);
  expect(document.querySelectorAll('.ui-ch-svg rect')).toHaveLength(4);
  expect(mockApi.get).not.toHaveBeenCalled();
});

test('a click sends the choice, then the card shows who chose and locks', async () => {
  mockApi.post.mockResolvedValue({ ok: true, decision: { ruling: { value: 'Ship', by: 'Sam' } } });
  show(message(CHOICE));
  const ship = await screen.findByRole('button', { name: 'Ship' });
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/activity/cards/700/choice'));
  await act(async () => { fireEvent.click(ship); });
  expect(mockApi.post).toHaveBeenCalledWith('/api/activity/cards/700/choose', { value: 'Ship' });
  expect(await screen.findByText('Sam chose')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ship' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Hold' })).toBeDisabled();
});

test('a card someone already chose on opens locked on that choice', async () => {
  mockApi.get.mockResolvedValue({ decision: { ruling: { value: 'Hold', by: 'Ola' } } });
  show(message(CHOICE));
  expect(await screen.findByText('Ola chose')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hold' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Ship' })).toBeDisabled();
});

test('a click that loses the race shows the standing choice; a refused one says why', async () => {
  mockApi.post.mockRejectedValueOnce({ response: { status: 409, data: { decision: { ruling: { value: 'Hold', by: 'Ola' } } } } });
  show(message(CHOICE));
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Ship' })); });
  expect(await screen.findByText('Ola chose')).toBeInTheDocument();

  mockApi.post.mockRejectedValueOnce({ response: { status: 403 } });
  show({ ...message(CHOICE), id: '701' });
  const [, ship] = await screen.findAllByRole('button', { name: 'Ship' });
  await act(async () => { fireEvent.click(ship); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Only people in this pod can choose here.');
  expect(ship).not.toBeDisabled();
});

// @ts-nocheck
// TASK-782: a Sentry connection whose account sees no projects connected and
// granted in silence, and every search came back empty (Triage, 11-04). The
// connect return says so, and so do the row and the grant step, from the
// catalogue's `reach: 'none'`. The provider name is the catalogue's, never the query's.
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import i18n, { i18nReady } from '../../i18n';
import { mockApi, renderPage, tileNode, findTile, findPopover, pageReady } from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const scout = { name: 'scout', displayName: 'Scout', userId: 'a1' };
const pods = [{ _id: 'p1', name: 'Launch pod', type: 'chat', members: [{ _id: 'u1', username: 'sam' }, { _id: 'a1', username: 'scout' }] }];
const sentry = (connections) => ({
  installableId: 'sentry', list: 'tools', label: 'Sentry', description: 'Errors and projects.', available: true,
  connectionType: 'hosted-mcp', entryId: 'sentry', broker: { id: 'commonly-grant-broker' },
  tools: [{ name: 'sentry.find_projects', requiredWriteMode: 'read', irreversible: false }],
  connections,
});
const empty = { connectionId: 'conn-empty', owner: '', repo: '', connectedAt: '2026-11-05T10:00:00.000Z', reach: 'none' };
const busy = { connectionId: 'conn-busy', owner: '', repo: '', connectedAt: '2026-11-04T10:00:00.000Z' };
const sentryRow = { _id: 'conn-empty', type: 'hosted-mcp', status: 'connected', config: { entryId: 'sentry' } };

const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.split(`{{${key}}}`).join(value), text);
const openSentry = async () => {
  await findTile('Sentry');
  await settle();
  fireEvent.click(tileNode('Sentry'));
  return findPopover('Sentry');
};

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
});

describe('connected, but the account sees no projects (next=reach)', () => {
  it('says so on return, naming the catalogue entry', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=sentry&next=reach');
    mockApi({ connectors: [sentryRow], installables: [sentry([empty])] });
    renderPage();

    const notice = await screen.findByText(fill(en.connectors.hostedMcpReachNone, { provider: 'Sentry' }));
    expect(notice).toHaveAttribute('role', 'status');
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('names nothing for an entry its catalogue does not hold', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=Evil%20Corp&next=reach');
    mockApi({ connectors: [sentryRow], installables: [sentry([empty])] });
    renderPage();

    await pageReady();
    await waitFor(() => expect(window.location.search).toBe(''));
    await settle();
    expect(document.body.textContent).not.toContain('Evil Corp');
    expect(document.body.textContent).not.toContain("can't see any projects");
  });

  it('reads in zh-CN', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=sentry&next=reach');
    mockApi({ connectors: [sentryRow], installables: [sentry([empty])] });
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();
      const zh = (await import('../../i18n/locales/zh-CN.json')).default;
      expect(await screen.findByText(fill(zh.connectors.hostedMcpReachNone, { provider: 'Sentry' }))).toBeInTheDocument();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });
});

describe('the row and the grant step', () => {
  it('the row says the connection sees no projects, and the grant step says it for that connection', async () => {
    mockApi({ installables: [sentry([empty])], pods, seats: { p1: [scout] } });
    renderPage();

    const popover = await openSentry();
    const note = fill(en.tools.reachNone, { label: 'Sentry' });
    expect(within(popover).getByText(note)).toHaveAttribute('role', 'note');
    fireEvent.click(within(popover).getByRole('button', { name: 'Grant to agents' }));
    const form = await screen.findByRole('complementary', { name: 'Grant Sentry to agents' });
    expect(within(form).getByText(note)).toHaveAttribute('role', 'note');
    // A warning, not a block: a project may be added later.
    expect(within(form).getByRole('button', { name: 'Grant' })).toBeEnabled();
  });

  it('the grant step follows the picked connection', async () => {
    mockApi({ installables: [sentry([busy, empty])], pods, seats: { p1: [scout] } });
    renderPage();

    const popover = await openSentry();
    fireEvent.click(within(popover).getByRole('button', { name: 'Grant to agents' }));
    const form = await screen.findByRole('complementary', { name: 'Grant Sentry to agents' });
    const note = fill(en.tools.reachNone, { label: 'Sentry' });
    expect(within(form).queryByText(note)).toBeNull();
    fireEvent.change(within(form).getByRole('combobox', { name: 'connection' }), { target: { value: 'conn-empty' } });
    expect(within(form).getByText(note)).toBeInTheDocument();
  });

  it('says nothing when no connection was found empty', async () => {
    mockApi({ installables: [sentry([busy])], pods, seats: { p1: [scout] } });
    renderPage();

    const popover = await openSentry();
    expect(within(popover).queryByText(fill(en.tools.reachNone, { label: 'Sentry' }))).toBeNull();
  });
});

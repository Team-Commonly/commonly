// @ts-nocheck
// F321: the six places a person had to guess on a walk of the Linear connector.
// Each statement here has to be true for the connection and grants on screen, and
// nothing about what a grant mints may move.
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import {
  axios, mockApi, renderPage, tileNode, findTile, findDrawer, findPopover,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const scout = { name: 'scout', displayName: 'Scout', userId: 'a1' };
const pods = [{ _id: 'p1', name: 'Launch pod', type: 'chat', members: [{ _id: 'u1', username: 'sam' }, { _id: 'a1', username: 'scout' }] }];

const READ_TOOLS = ['linear.get_issue', 'linear.list_issues', 'linear.list_projects'];
const WRITE_TOOLS = ['linear.save_issue', 'linear.delete_comment'];
// The server's own English description, and tools in the catalogue's own shape.
const linear = {
  installableId: 'linear', list: 'tools', label: 'Linear', description: 'Read Linear issues and projects; changes require your approval.',
  available: true, connectionType: 'hosted-mcp', entryId: 'linear', broker: { id: 'commonly-grant-broker' },
  tools: [
    ...READ_TOOLS.map((name) => ({ name, requiredWriteMode: 'read', irreversible: false })),
    ...WRITE_TOOLS.map((name) => ({ name, requiredWriteMode: 'write-with-confirm', irreversible: true })),
  ],
  connections: [{ connectionId: 'conn-2', owner: 'Team-Commonly', repo: 'linear' }],
};
const readOnlyEntry = { ...linear, tools: linear.tools.filter((tool) => tool.requiredWriteMode === 'read') };
const sentry = {
  ...linear, installableId: 'sentry', entryId: 'sentry', label: 'Sentry', description: 'Errors.', connections: [],
  tools: [{ name: 'sentry.list_issues', requiredWriteMode: 'read', irreversible: false }],
};
const grant = (over = {}) => ({
  grantId: 'g-read', installationId: 'conn-2', connectionId: 'conn-2', target: { kind: 'pod', id: 'p1' }, tools: READ_TOOLS,
  writeMode: 'read', budget: null, effectiveAudience: ['a1'], expiresAt: iso(6 * 86400000), revokedAt: null, revokedBy: null,
  parentGrantId: null, rootGrantId: null, createdAt: iso(-3600000), grantedBy: 'u1', ...over,
});
const revoked = (id) => grant({ grantId: id, revokedAt: iso(-600000), revokedBy: 'u1', createdAt: iso(-86400000) });
const writeGrant = grant({ grantId: 'g-write', writeMode: 'write-with-confirm', tools: [...READ_TOOLS, ...WRITE_TOOLS] });

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const meta = () => document.querySelector('.v2-cx-head__meta');
// `grants` is read on every GET, so a test can move it the way a mint does.
const mock = ({ entries = [linear], grants = [] } = {}) => {
  const state = { grants };
  mockApi({
    installables: entries,
    pods,
    seats: { p1: [scout] },
    route: (url) => (url === '/api/grants' ? Promise.resolve({ data: { grants: state.grants } }) : undefined),
  });
  return state;
};
const openClick = async (name) => {
  await findTile(name);
  await settle();
  fireEvent.click(tileNode(name));
};
const openDrawerOf = async (name) => { await openClick(name); return findDrawer(name); };
const openPopoverOf = async (name) => { await openClick(name); return findPopover(name); };
const openForm = async () => {
  const popover = await openPopoverOf('Linear');
  fireEvent.click(within(popover).getByRole('button', { name: 'Grant to agents' }));
  return screen.findByRole('complementary', { name: 'Grant Linear to agents' });
};
const mintedTools = () => axios.post.mock.calls.find(([url]) => url === '/api/grants')[1].tools;
const names = (form) => [...form.querySelectorAll('.v2-tools__names code')].map((node) => node.textContent);

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
  axios.post.mockResolvedValue({ data: { grantId: 'g-new' } });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('one true statement about writing', () => {
  const OFFER_ASK = "No agent can use Linear yet. A grant can be read only, or read and write. With write access, each write waits for your approval.";
  const READ = "Agents can read Linear from here, but they can't write to it.";
  const ASK = 'Agents can read Linear from here. Each write waits for your approval.';
  const MIXED = 'Agents can read Linear from here. Where a grant allows writes, each write waits for your approval.';

  it('a connected entry with write tools and no grant says only what a grant can be', async () => {
    mock();
    renderPage();
    const popover = await openPopoverOf('Linear');
    expect(popover).toHaveTextContent(OFFER_ASK);
    expect(popover).not.toHaveTextContent('Read, or read and write');
    expect(popover).not.toHaveTextContent("can't write to it");
    expect(popover).not.toHaveTextContent('changes require your approval');
  });

  it('an entry with no write tool never offers one', async () => {
    mock({ entries: [readOnlyEntry] });
    renderPage();
    const popover = await openPopoverOf('Linear');
    expect(popover).toHaveTextContent("No agent can use Linear yet. A grant lets agents read it, not change it.");
    expect(popover).not.toHaveTextContent('approval');
  });

  it('the form does not promise approval over a read grant', async () => {
    mock();
    renderPage();
    const form = await openForm();
    expect(form).not.toHaveTextContent('changes require your approval');
  });

  it.each([
    ['a read grant', [grant()], READ, /approval/],
    ['an ask-first grant', [writeGrant], ASK, /can't write/],
    ['both', [grant(), writeGrant], MIXED, /can't write/],
  ])('the drawer states %s, once', async (_label, grants, line, absent) => {
    mock({ grants });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    const notes = within(drawer).getAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(line);
    expect(notes[0].textContent).not.toMatch(absent);
  });

  it('an ended grant does not count: the drawer is back to the offer', async () => {
    mock({ grants: [revoked('g-old')] });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    expect(within(drawer).getAllByRole('note')).toHaveLength(1);
    expect(within(drawer).getByRole('note')).toHaveTextContent(OFFER_ASK);
  });

  it('reads in Chinese', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    mock({ grants: [writeGrant] });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    expect(within(drawer).getByRole('note')).toHaveTextContent('智能体可以在这里读取 Linear，每次写入都要等你批准。');
  });
});

describe('after Grant', () => {
  const mintFrom = (state, next) => axios.post.mockImplementation(async (url) => {
    if (url === '/api/grants') state.grants = next;
    return { data: { grantId: 'g-new' } };
  });

  it('a grant from the reveal lands in the drawer, confirmed, with the new grant above the old ones', async () => {
    const scrolled = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
    try {
      const older = grant({ grantId: 'g-older', createdAt: iso(-7200000) });
      const state = mock({ grants: [revoked('g-1'), revoked('g-2')] });
      mintFrom(state, [revoked('g-1'), older, grant({ grantId: 'g-new', createdAt: iso(0) }), revoked('g-2')]);
      renderPage();

      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));

      const status = await within(drawer).findByText('Linear granted to Scout in Launch pod.');
      expect(status).toHaveAttribute('role', 'status');
      await waitFor(() => expect(scrolled.some((node) => node.querySelector?.('[role="status"]'))).toBe(true));
      expect(status.closest('.v2-cx-fresh')).toContainElement(within(drawer).getAllByRole('button', { name: 'View Linear in Launch pod' })[0]);
      // Revoked grants are folded behind their count, one click away.
      expect(within(drawer).getAllByRole('button', { name: 'View Linear in Launch pod' })).toHaveLength(2);
      const fold = within(drawer).getByRole('button', { name: 'inactive · 2' });
      expect(fold).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(fold);
      expect(fold).toHaveAttribute('aria-expanded', 'true');
      expect(within(drawer).getAllByRole('button', { name: 'View Linear in Launch pod' })).toHaveLength(4);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('keeps the drawer open when the grant began in a reveal, which had no drawer to go back to', async () => {
    const state = mock();
    mintFrom(state, [grant({ grantId: 'g-new' })]);
    renderPage();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    const drawer = await findDrawer('Linear');
    expect(await within(drawer).findByText('Linear granted to Scout in Launch pod.')).toBeInTheDocument();
    await within(drawer).findByRole('button', { name: 'View Linear in Launch pod' });
  });

  it('says a change was a change', async () => {
    const state = mock({ grants: [grant({ grantId: 'g-old' })] });
    mintFrom(state, [revoked('g-old'), grant({ grantId: 'g-new' })]);
    renderPage();
    const drawer = await openDrawerOf('Linear');
    fireEvent.click(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Change access' }));
    const form = await screen.findByRole('complementary', { name: 'Change access' });
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(await within(drawer).findByText('Access to Linear changed for Scout in Launch pod.')).toBeInTheDocument();
  });

  it('takes the confirmation back once that grant is revoked', async () => {
    const state = mock();
    mintFrom(state, [grant({ grantId: 'g-new' })]);
    renderPage();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    const drawer = await findDrawer('Linear');
    const row = await within(drawer).findByRole('button', { name: 'View Linear in Launch pod' });
    fireEvent.click(row);
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Revoke' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Yes, revoke it' }));
    await waitFor(() => expect(within(drawer).queryByText('Linear granted to Scout in Launch pod.')).toBeNull());
  });

  it('leaves ended grants open when there is no live grant to bury', async () => {
    mock({ grants: [revoked('g-1')] });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    expect(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'inactive · 1' })).toBeNull();
  });
});

describe('the header count', () => {
  it('counts a connected connector with no grant as connected, not as available', async () => {
    mock({ entries: [linear, sentry] });
    renderPage();
    await findTile('Linear');
    await waitFor(() => expect(meta()).toHaveTextContent('0 on · 1 connected, no grant · 1 available'));
  });

  it('a grant moves it to on, and the connected count leaves', async () => {
    mock({ entries: [linear, sentry], grants: [grant()] });
    renderPage();
    await findTile('Linear');
    await waitFor(() => expect(meta().textContent).toBe('1 on · 1 available'));
  });

  it('nothing connected keeps the two-part line', async () => {
    mock({ entries: [sentry] });
    renderPage();
    await findTile('Sentry');
    await settle();
    expect(meta().textContent).toBe('0 on · 1 available');
  });

  it('reads in Chinese', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    mock({ entries: [linear, sentry] });
    renderPage();
    await findTile('Linear');
    await waitFor(() => expect(meta().textContent).toBe('已开启0个 · 已连接未授权1个 · 可用1个'));
  });
});

describe('the act names what it does', () => {
  it('the offer says Grant to agents and no longer Add, beside Disconnect', async () => {
    mock();
    renderPage();
    const popover = await openPopoverOf('Linear');
    expect(within(popover).getByRole('button', { name: 'Grant to agents' })).toBeInTheDocument();
    expect(within(popover).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(within(popover).getByRole('button', { name: 'Disconnect Linear' })).toBeInTheDocument();
  });
});

describe('what a mode covers', () => {
  it('read mode says it in words with a count, and its disclosure holds only read tools', async () => {
    mock();
    renderPage();
    const form = await openForm();
    expect(form).toHaveTextContent("Covers 3 read tools. Agents can look things up in Linear but can't change anything.");
    const disclosure = form.querySelector('details.v2-tools__names');
    expect(disclosure).not.toHaveAttribute('open');
    expect(within(disclosure).getByText('Tool names').tagName).toBe('SUMMARY');
    expect(names(form)).toEqual(READ_TOOLS);
    expect(form).not.toHaveTextContent('linear.save_issue');
    // The form holds no tool id outside the disclosure.
    expect(form.querySelectorAll('code')).toHaveLength(READ_TOOLS.length);
  });

  it('write mode counts both, and its disclosure holds both', async () => {
    mock();
    renderPage();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: 'read and write, ask first' }));
    expect(form).toHaveTextContent('Covers 5 tools. Agents can look things up in Linear, and 2 of the tools can change things there.');
    expect(names(form)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
  });

  it('a single read tool reads in the singular', async () => {
    mock({ entries: [{ ...readOnlyEntry, tools: readOnlyEntry.tools.slice(0, 1) }] });
    renderPage();
    const form = await openForm();
    expect(form).toHaveTextContent("Covers 1 read tool. Agents can look things up in Linear but can't change anything.");
  });

  it('reads in Chinese', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    mock();
    renderPage();
    await findTile('Linear');
    await settle();
    fireEvent.click(tileNode('Linear'));
    const popover = await findPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: '授权给智能体' }));
    const form = await screen.findByRole('complementary', { name: '把 Linear 授权给智能体' });
    expect(form).toHaveTextContent('共3个读取工具。智能体可以在 Linear 中查询内容，但不能做任何更改。');
  });

  // The pin: these lists are written out, so a change to what a mode mints fails here.
  it.each([
    ['read', READ_TOOLS, 'read'],
    ['read and write, ask first', [...READ_TOOLS, ...WRITE_TOOLS], 'write-with-confirm'],
  ])('minted tools for %s are exactly the list the form shows', async (mode, expected, writeMode) => {
    mock();
    renderPage();
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: mode }));
    const shown = form.querySelectorAll('.v2-tools__names code').length ? names(form) : expected;
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(mintedTools()).toEqual(expected);
    expect(shown).toEqual(expected);
    expect(axios.post.mock.calls.find(([url]) => url === '/api/grants')[1].writeMode).toBe(writeMode);
  });
});

describe('the one-pod posting notice', () => {
  const seats = { p1: [{ ...scout, runtimeNarrowedToOnePod: true }] };
  const line = "Scout can post only in one of their pods. That pod has a connector grant that can bring in outside text, so this applies to every agent in it, even one that wasn't granted the connector.";

  it('says the limit is the pod’s, not a grant to the agent', async () => {
    mockApi({ pods, seats });
    renderPage();
    const note = await screen.findByText(line);
    expect(note).toHaveAttribute('role', 'status');
  });

  it('reads in Chinese', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    mockApi({ pods, seats });
    renderPage();
    expect(await screen.findByText('Scout 目前只能在其中一个 Pod 发消息。这个 Pod 有连接器授权，可能带入外部内容，所以这条限制适用于 Pod 里的所有智能体，没有获得该连接器授权的也一样。')).toBeInTheDocument();
  });
});

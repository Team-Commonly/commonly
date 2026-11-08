// @ts-nocheck
// F321: the six places a person had to guess on a walk of the Linear connector.
// Each statement here has to be true for the connection and grants on screen, and
// nothing about what a grant mints may move.
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import en from '../../i18n/locales/en.json';
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
  installableId: 'linear', list: 'tools', label: 'Linear', description: 'Issues, projects, cycles and releases in your own Linear workspace.',
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
  const OFFER_ASK = "This Linear connection isn't granted to any agent yet. A grant can be read only, or read and write. With write access, each write waits for your approval.";
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
    expect(popover).toHaveTextContent("This Linear connection isn't granted to any agent yet. A grant lets agents read it, not change it.");
    expect(popover).not.toHaveTextContent('approval');
  });

  // Two connections, one product: a grant on the GitHub App says nothing about this
  // person's hosted GitHub connection, and the panel can't see other members' grants.
  it('speaks for this connection, so a live grant on the other GitHub does not make it false', async () => {
    const githubApp = {
      installableId: 'github', list: 'tools', label: 'GitHub', description: 'Issues.', available: true, connectionType: 'github-app',
      broker: { id: 'commonly-grant-broker' }, tools: [{ name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false }],
      connections: [{ connectionId: 'conn-app', owner: 'Team-Commonly', repo: 'commonly' }],
    };
    const githubMcp = {
      ...readOnlyEntry, installableId: 'github-mcp', entryId: 'github-mcp', label: 'GitHub', description: 'Files.',
      tools: [{ name: 'github-mcp.get_file', requiredWriteMode: 'read', irreversible: false }],
      connections: [{ connectionId: 'conn-mcp', owner: 'Team-Commonly', repo: 'mcp' }],
    };
    mock({ entries: [githubApp, githubMcp], grants: [grant({ grantId: 'g-app', tools: ['github.list_issues'] })] });
    renderPage();
    await findTile('GitHub');
    await settle();
    const hostedTile = [...document.querySelectorAll('button.v2-cx-tile[title="GitHub"]')].find((tile) => !tile.querySelector('.v2-cx-tile__dot'));
    fireEvent.click(hostedTile);
    const popover = await findPopover('GitHub');
    expect(within(popover).getByRole('note')).toHaveTextContent("This GitHub connection isn't granted to any agent yet.");
    expect(popover).not.toHaveTextContent('No agent can use');
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
  const mintFrom = (state, next, reply = { grantId: 'g-new' }) => axios.post.mockImplementation(async (url) => {
    if (url === '/api/grants') state.grants = next;
    return { data: reply };
  });

  const heldMint = (state, next, reply = { grantId: 'g-new' }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    axios.post.mockImplementation(async (url) => {
      if (url === '/api/grants') {
        await held;
        state.grants = next;
      }
      return { data: reply };
    });
    return () => act(async () => { release(); });
  };
  const live = () => document.querySelector('.v2-cx-live');
  const CONFIRM = 'Linear granted to Scout in Launch pod.';

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
      await waitFor(() => expect(scrolled.some((node) => node.querySelector?.('.v2-cx-confirm'))).toBe(true));
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

  // The mint succeeded and the re-read has not. Without its own copy of the new
  // grant the page said nobody had it and offered it again.
  describe('when the re-read fails', () => {
    const failingReads = (state) => axios.get.mockImplementation(((get) => (url, config) => (state.failing && url === '/api/grants'
      ? Promise.reject(new Error('Network Error')) : get(url, config)))(axios.get.getMockImplementation()));
    const mintWhileFailing = async (state) => {
      failingReads(state);
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      state.failing = true;
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      await within(drawer).findByText('Linear granted to Scout in Launch pod.');
      await settle();
      return drawer;
    };
    const tabComesBack = async () => {
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await settle();
    };
    let visibility;
    beforeEach(() => {
      visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    });
    afterEach(() => visibility.mockRestore());

    it('the drawer and the header keep the grant, and nothing offers it again', async () => {
      const older = [revoked('g-1')];
      const state = mock({ grants: older });
      mintFrom(state, older);
      const drawer = await mintWhileFailing(state);

      expect(meta().textContent).toBe('1 on · 0 available');
      expect(drawer).not.toHaveTextContent("isn't granted to any agent");
      expect(drawer.querySelector('.v2-cx-drawer__offer')).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Grant to agents' })).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Grant again' })).toBeNull();
      expect(within(drawer).getByRole('note')).toHaveTextContent('Agents can read Linear');
      expect(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' })).toBeInTheDocument();
      expect(within(drawer).getByRole('button', { name: 'inactive · 1' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('closing and reopening still shows the grant, not the offer', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      const drawer = await mintWhileFailing(state);
      fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByText('Linear granted to Scout in Launch pod.')).toBeNull());

      fireEvent.click(tileNode('Linear'));
      const reopened = await findDrawer('Linear');
      expect(reopened).not.toHaveTextContent("isn't granted to any agent");
      expect(within(reopened).queryByRole('button', { name: 'Grant to agents' })).toBeNull();
      expect(within(reopened).getByRole('button', { name: 'View Linear in Launch pod' })).toBeInTheDocument();
    });

    it('holds what was minted: the grant reads as this person\'s, for this agent and pod', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      const drawer = await mintWhileFailing(state);
      fireEvent.click(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' }));
      // Only the granter is offered this, so the local copy has to name them.
      expect(await within(drawer).findByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('takes the grant\'s shape from the server: a confined agent reads as confined', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants, {
        grantId: 'g-new',
        byoAgents: ['a1'],
        byoConsent: { by: 'u1', at: iso(0), version: '1', agents: [{ userId: 'a1', sandbox: 'confined' }] },
      });
      const drawer = await mintWhileFailing(state);
      fireEvent.click(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' }));
      expect(await within(drawer).findByText(en.tools.byo.namedHeading)).toBeInTheDocument();
      expect(drawer).not.toHaveTextContent('no sandbox');
    });

    it('names its connector when the catalogue failed on the same re-read', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      axios.get.mockImplementation(((get) => (url, config) => (state.failing && url === '/api/installables'
        ? Promise.reject(new Error('Network Error')) : get(url, config)))(axios.get.getMockImplementation()));
      await mintWhileFailing(state).catch(() => null);
      await settle();
      expect(document.body).not.toHaveTextContent('Unknown connector');
      expect(tileNode('Linear')).not.toBeNull();
    });

    // The order a tab coming back can produce: the read began before the mint
    // answered, so it cannot speak for a grant it never asked about.
    it('a read that began before the mint and lands after it leaves the grant alone', async () => {
      const older = [revoked('g-1')];
      const state = mock({ grants: older });
      const release = heldMint(state, older);
      let landStale;
      axios.get.mockImplementation(((get) => (url, config) => {
        if (url !== '/api/grants' || !state.mode) return get(url, config);
        if (state.mode === 'hold') return new Promise((resolve) => { landStale = () => resolve({ data: { grants: older } }); });
        return Promise.reject(new Error('Network Error'));
      })(axios.get.getMockImplementation()));
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      state.mode = 'hold';
      await tabComesBack();
      expect(landStale).toEqual(expect.any(Function));
      state.mode = 'fail';
      await release();
      await within(drawer).findByText(CONFIRM);
      await settle();
      expect(meta().textContent).toBe('1 on · 0 available');

      await act(async () => { landStale(); });
      await settle();
      expect(meta().textContent).toBe('1 on · 0 available');

      // A read begun after the mint still has the last word.
      state.mode = null;
      await tabComesBack();
      expect(meta().textContent).toBe('0 on · 1 connected, no grant · 0 available');
    });

    it('a later good read replaces it with what the server says', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      const drawer = await mintWhileFailing(state);
      expect(meta().textContent).toBe('1 on · 0 available');

      // The server's answer wins even when it does not list the grant at all.
      state.failing = false;
      await tabComesBack();
      expect(meta().textContent).toBe('0 on · 1 connected, no grant · 0 available');
      expect(within(drawer).queryByRole('button', { name: 'View Linear in Launch pod' })).toBeNull();
    });

    it('does not double the row when a good read brings the grant', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      const drawer = await mintWhileFailing(state);
      state.grants = [grant({ grantId: 'g-new' })];
      state.failing = false;
      await tabComesBack();
      expect(within(drawer).getAllByRole('button', { name: 'View Linear in Launch pod' })).toHaveLength(1);
      expect(meta().textContent).toBe('1 on · 0 available');
    });

    it('a grant revoked after it stays revoked, with reads failing or not', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, state.grants);
      const drawer = await mintWhileFailing(state);
      fireEvent.click(within(drawer).getByRole('button', { name: 'View Linear in Launch pod' }));
      fireEvent.click(await within(drawer).findByRole('button', { name: 'Revoke' }));
      fireEvent.click(await within(drawer).findByRole('button', { name: 'Yes, revoke it' }));
      await waitFor(() => expect(meta().textContent).toBe('0 on · 1 connected, no grant · 0 available'));
      await tabComesBack();
      expect(meta().textContent).toBe('0 on · 1 connected, no grant · 0 available');

      // A stale good read still naming it live does not bring it back either.
      state.grants = [grant({ grantId: 'g-new' })];
      state.failing = false;
      await tabComesBack();
      expect(meta().textContent).toBe('0 on · 1 connected, no grant · 0 available');
    });
  });

  it('moves focus to the confirmation when the form closes, so it is read out and focus is not lost', async () => {
    const state = mock({ grants: [revoked('g-1')] });
    mintFrom(state, [revoked('g-1'), grant({ grantId: 'g-new' })]);
    // Holds the re-read, so focus can move on before the new row arrives.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    axios.get.mockImplementation(((get) => (url, config) => (state.hold && url === '/api/grants'
      ? held.then(() => get(url, config)) : get(url, config)))(axios.get.getMockImplementation()));
    renderPage();
    const drawer = await openDrawerOf('Linear');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
    const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
    state.hold = true;
    // A click focuses its button in a browser, and fireEvent's does not. The form
    // takes that button with it, which is the focus this rescues.
    const submit = within(form).getByRole('button', { name: 'Grant' });
    submit.focus();
    fireEvent.click(submit);
    const status = await within(drawer).findByText('Linear granted to Scout in Launch pod.');
    await waitFor(() => expect(status).toHaveFocus());
    // The row arriving with the re-read does not take focus back from wherever it went.
    const close = within(drawer).getByRole('button', { name: 'Close' });
    close.focus();
    await act(async () => { release(); });
    await within(drawer).findByRole('button', { name: 'View Linear in Launch pod' });
    await settle();
    expect(close).toHaveFocus();
  });

  it('a grant made a moment ago reads as one phrase in Chinese', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    mock({ grants: [grant({ grantId: 'g-new', createdAt: new Date().toISOString() })] });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    const kicker = drawer.querySelector('.v2-connector-row__kicker');
    expect(kicker).toHaveTextContent('刚刚授予');
    expect(kicker).not.toHaveTextContent('刚刚前');
  });

  it('an older grant keeps its age, and English keeps its words', async () => {
    mock({ grants: [grant({ grantId: 'g-new', createdAt: new Date().toISOString() }), grant({ grantId: 'g-older', createdAt: iso(-7200000) })] });
    renderPage();
    const drawer = await openDrawerOf('Linear');
    const kickers = [...drawer.querySelectorAll('.v2-connector-row__kicker')].map((node) => node.textContent);
    expect(kickers[0]).toContain('granted just now');
    expect(kickers[1]).toContain('granted 2h');
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

  describe('someone who moved on while the grant was minting', () => {
    const search = () => screen.getByLabelText('Search');

    it('the live region is there before the notice and hears it, whoever has focus', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      const release = heldMint(state, [revoked('g-1'), grant({ grantId: 'g-new' })]);
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      expect(live()).toHaveAttribute('role', 'status');
      expect(live()).toBeEmptyDOMElement();
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      search().focus();
      await release();
      await waitFor(() => expect(live()).toHaveTextContent(CONFIRM));
      expect(search()).toHaveFocus();
      // Closing takes it back, so the next grant is a change the region can announce.
      fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(live()).toBeEmptyDOMElement());
    });

    // A click on plain text, or a button click in Safari or Firefox on a Mac, leaves
    // focus on the drawer it opened with. Nobody chose that, so it counts as nowhere.
    it('focus resting on the drawer itself still goes to the confirmation', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      mintFrom(state, [revoked('g-1'), grant({ grantId: 'g-new' })]);
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      drawer.focus();
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      const status = await within(drawer).findByText(CONFIRM);
      await waitFor(() => expect(status).toHaveFocus());
    });

    it('keeps their place in search, and the confirmation stays where it can be read', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      const release = heldMint(state, [revoked('g-1'), grant({ grantId: 'g-new' })]);
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      search().focus();
      await release();
      const status = await within(drawer).findByText('Linear granted to Scout in Launch pod.');
      await settle();
      expect(status).not.toHaveFocus();
      expect(search()).toHaveFocus();
    });

    it('closing the form mid-mint and going to search: the drawer comes back without taking focus', async () => {
      const state = mock({ grants: [revoked('g-1')] });
      const release = heldMint(state, [revoked('g-1'), grant({ grantId: 'g-new' })]);
      renderPage();
      const drawer = await openDrawerOf('Linear');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Grant to agents' }));
      const form = await screen.findByRole('complementary', { name: 'Grant Linear to agents' });
      fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
      fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Grant Linear to agents' })).toBeNull());
      search().focus();
      await release();
      const reopened = await findDrawer('Linear');
      await within(reopened).findByText('Linear granted to Scout in Launch pod.');
      await settle();
      expect(search()).toHaveFocus();
    });
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

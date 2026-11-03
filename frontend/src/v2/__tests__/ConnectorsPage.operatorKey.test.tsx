// @ts-nocheck
// Connectors page, operator-key entries (TASK-330): a hosted entry whose
// `credentialMode` is `operator_key` is connected by pasting one agent's key, not
// by the OAuth start route, which answers 404 for it. One connection per agent,
// so a person with one agent keyed can still add a key for another. The pasted
// key must never survive a submit, in the DOM or in any sentence.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import {
  axios, mockApi, renderPage, tileNode, findTile, findPopover, openDrawer,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const SCOUT = '6a00000000000000000000a1';
const REED = '6a00000000000000000000b2';
const NOVA = '6a00000000000000000000c3';
// A pasted key, built at runtime so no key-shaped literal sits in the source.
const KEY = ['fixture', 'pasted', 'key'].join('-');

const pods = [
  { _id: 'p1', name: 'Launch pod', type: 'chat', members: [{ _id: 'u1', username: 'sam' }] },
  { _id: 'p2', name: 'Ops', type: 'chat', members: [{ _id: 'u1', username: 'sam' }] },
];
// Scout and Reed are the viewer's (u1); Nova was installed by someone else.
const scout = { name: 'scout', displayName: 'Scout', userId: SCOUT, installedBy: 'u1' };
const reed = { name: 'reed', displayName: 'Reed', userId: REED, installedBy: 'u1' };
const nova = { name: 'nova', displayName: 'Nova', userId: NOVA, installedBy: 'u2' };
const seats = { p1: [scout, nova], p2: [reed, scout] };

const keyedEntry = {
  installableId: 'latchkey', list: 'tools', label: 'Latchkey', description: 'Secrets in Latchkey.', available: true,
  connectionType: 'hosted-mcp', entryId: 'latchkey', credentialMode: 'operator_key',
  connectNotice: 'Create a key with read scopes only.',
  accessPage: 'https://latchkey.example/keys',
  broker: { id: 'commonly-grant-broker' },
  tools: [{ name: 'latchkey.list_secrets', requiredWriteMode: 'read', irreversible: false }],
  connections: [],
};
const linearEntry = {
  installableId: 'linear', list: 'tools', label: 'Linear', description: 'Issues in Linear.', available: true,
  connectionType: 'hosted-mcp', entryId: 'linear',
  connectNotice: 'Ask your admin to allow this domain.',
  broker: { id: 'commonly-grant-broker' },
  tools: [{ name: 'linear.list_issues', requiredWriteMode: 'read', irreversible: false }],
  connections: [],
};
const scoutKey = { connectionId: 'conn-scout', owner: '', repo: '', connectedAt: '2026-11-01T09:00:00.000Z', agentId: SCOUT };

const OPERATOR_KEY_URL = '/api/integrations/connect/hosted-mcp/latchkey/operator-key';

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const openToolPopover = async (name) => {
  await findTile(name);
  await settle();
  fireEvent.click(tileNode(name));
  return findPopover(name);
};
const catalogueReads = () => axios.get.mock.calls.filter(([url]) => url === '/api/installables').length;
const agentOptions = (popover) => within(within(popover).getByLabelText('agent')).getAllByRole('option').map((option) => option.textContent);
const paste = (popover, value = KEY) => fireEvent.change(popover.querySelector('input[type="password"]'), { target: { value } });
const keyGone = () => {
  expect(document.body.innerHTML).not.toContain(KEY);
  document.querySelectorAll('input').forEach((input) => expect(input.value).not.toContain(KEY));
};

// The catalogue a later read answers: `after` once the post has gone through.
const mockCatalog = (before, after = before) => {
  let posted = false;
  axios.post.mockImplementation(async (url) => {
    posted = true;
    if (url === OPERATOR_KEY_URL) return { data: { integrationId: 'conn-new', status: 'connected', scopeCheck: 'self_report', toolCount: 1 } };
    return { data: {} };
  });
  mockApi({
    pods,
    seats,
    grants: [],
    route: (url) => (url === '/api/installables'
      ? Promise.resolve({ data: { installables: posted ? after : before } })
      : undefined),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
});

afterEach(() => jest.restoreAllMocks());

describe('Connectors page: operator-key entries', () => {
  it('shows a paste-a-key form instead of Connect, offering only the viewer\'s own agents', async () => {
    mockCatalog([keyedEntry]);
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(within(popover).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(agentOptions(popover)).toEqual(['Reed', 'Scout']);
    const input = within(popover).getByLabelText('key');
    expect(input).toHaveAttribute('type', 'password');
    // A vendor key, not this site's password: no saved-login offer, no save prompt.
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(within(popover).getByRole('button', { name: 'Add key' })).toBeInTheDocument();
    expect(within(popover).getByText('add a key for one of your agents')).toBeInTheDocument();
    expect(within(popover).getByText('Create a key with read scopes only.')).toBeInTheDocument();
    const link = within(popover).getByRole('link', { name: 'Create a key at Latchkey' });
    expect(link).toHaveAttribute('href', 'https://latchkey.example/keys');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves out an agent someone else also installed, since the route refuses it', async () => {
    axios.post.mockImplementation(async () => ({ data: {} }));
    mockApi({
      pods,
      // Reed is the viewer's in p2 but another person's install in p1.
      seats: { p1: [scout, { ...reed, installedBy: 'u2' }], p2: [reed] },
      grants: [],
      route: (url) => (url === '/api/installables' ? Promise.resolve({ data: { installables: [keyedEntry] } }) : undefined),
    });
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(agentOptions(popover)).toEqual(['Scout']);
  });

  it('says the agent list could not be read, not "no agents", when a roster read fails', async () => {
    axios.post.mockImplementation(async () => ({ data: {} }));
    const notFound = Object.assign(new Error('nope'), { response: { status: 404 } });
    mockApi({
      pods,
      seats: { p1: [nova] },
      grants: [],
      route: (url) => {
        if (url === '/api/installables') return Promise.resolve({ data: { installables: [keyedEntry] } });
        if (url === '/api/registry/pods/p2/agents') return Promise.reject(notFound);
        return undefined;
      },
    });
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(within(popover).getByText("couldn't read your agents just now · reload to try again")).toBeInTheDocument();
    expect(within(popover).queryByText('no agent of yours to add a key for yet')).toBeNull();
  });

  it('a granted entry still offers the key form in its drawer for an agent with no key', async () => {
    axios.post.mockImplementation(async () => ({ data: {} }));
    const grant = {
      grantId: 'grant_lk', installationId: 'inst-lk', target: { kind: 'pod', id: 'p1' }, tools: ['latchkey.list_secrets'],
      writeMode: 'read', budget: { calls: 50, windowMs: 3600000 }, effectiveAudience: [SCOUT],
      expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(), revokedAt: null, revokedBy: null,
      parentGrantId: null, rootGrantId: null, createdAt: new Date(Date.now() - 3600000).toISOString(), grantedBy: 'u1',
    };
    mockApi({
      pods,
      seats,
      grants: [grant],
      route: (url) => (url === '/api/installables'
        ? Promise.resolve({ data: { installables: [{ ...keyedEntry, connections: [scoutKey] }] } })
        : undefined),
    });
    renderPage();

    const drawer = await openDrawer('Latchkey');
    // Scout's key is granted; Reed has none yet, so the form offers Reed only.
    expect(within(drawer).getByLabelText('key')).toBeInTheDocument();
    expect(agentOptions(drawer)).toEqual(['Reed']);
  });

  it('a success without the route\'s connected receipt reads as a failure, and does not refresh', async () => {
    mockApi({
      pods,
      seats,
      grants: [],
      route: (url) => (url === '/api/installables' ? Promise.resolve({ data: { installables: [keyedEntry] } }) : undefined),
    });
    // A 2xx with an HTML fallback body, as a misrouted proxy would answer.
    axios.post.mockImplementation(async () => ({ data: '<!doctype html><html></html>' }));
    renderPage();

    const popover = await openToolPopover('Latchkey');
    const readsBefore = catalogueReads();
    paste(popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));
    expect(await within(popover).findByRole('alert')).toHaveTextContent('Could not add the key. Try again.');
    expect(catalogueReads()).toBe(readsBefore);
    keyGone();
  });

  it('an OAuth hosted entry keeps its Connect button and shows no key form', async () => {
    mockCatalog([linearEntry]);
    renderPage();

    const popover = await openToolPopover('Linear');
    expect(within(popover).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(within(popover).getByText('connect your own Linear account')).toBeInTheDocument();
    expect(within(popover).getByText('Ask your admin to allow this domain.')).toBeInTheDocument();
    expect(within(popover).queryByLabelText('key')).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'Add key' })).toBeNull();
  });

  it('submit posts the agent and key to the operator-key route, refreshes, and clears the key', async () => {
    mockCatalog([keyedEntry], [{ ...keyedEntry, connections: [{ ...scoutKey, agentId: REED, connectionId: 'conn-reed' }] }]);
    renderPage();

    const popover = await openToolPopover('Latchkey');
    fireEvent.change(within(popover).getByLabelText('agent'), { target: { value: REED } });
    paste(popover);
    // Positive control for keyGone: before the submit the key IS on the page.
    expect(within(popover).getByLabelText('key')).toHaveValue(KEY);
    expect(document.body.innerHTML).toContain(KEY);
    const readsBefore = catalogueReads();
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      OPERATOR_KEY_URL,
      { agentId: REED, key: KEY },
      expect.anything(),
    ));
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/start'), expect.anything(), expect.anything());
    await waitFor(() => expect(catalogueReads()).toBeGreaterThan(readsBefore));
    // The refreshed row names Reed's key, and Reed leaves the picker.
    await waitFor(() => expect(agentOptions(popover)).toEqual(['Scout']));
    expect(within(popover).getByLabelText('key')).toHaveValue('');
    expect(within(popover).queryByRole('alert')).toBeNull();
    keyGone();
  });

  it.each([
    [400, 'invalid_agent', 'Pick one of your agents.'],
    [403, 'agent_not_owned', 'You can add a key only for an agent you alone installed.'],
    [404, 'unknown_entry', 'This connector does not take a key here.'],
    [400, 'not_operator_key', 'This connector does not take a key here.'],
    [400, 'key_missing', 'Paste a key first.'],
    [400, 'scope_refused', 'This key has scopes Commonly does not allow. Create one without them.'],
    [400, 'vendor_rejected', 'Latchkey did not accept this key.'],
    [502, 'vendor_unreachable', 'Could not reach Latchkey to check the key. Try again.'],
    [409, 'connection_changed', 'The connection changed while saving. Paste the key again.'],
    [500, 'key_store_failed', 'Could not save the key. Try again.'],
    [401, 'unauthorized', 'Could not add the key. Try again.'],
  ])('a %i %s reads as its sentence and the key is gone', async (status, code, sentence) => {
    mockCatalog([keyedEntry]);
    axios.post.mockRejectedValue({ response: { status, data: { error: code, message: `server text ${code}` } } });
    renderPage();

    const popover = await openToolPopover('Latchkey');
    paste(popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));

    expect(await within(popover).findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.queryByText(`server text ${code}`)).toBeNull();
    expect(within(popover).getByLabelText('key')).toHaveValue('');
    keyGone();
  });

  it('a request that never reached the server reads as the generic sentence', async () => {
    mockCatalog([keyedEntry]);
    axios.post.mockRejectedValue(new Error(`Network Error ${KEY}`));
    renderPage();

    const popover = await openToolPopover('Latchkey');
    paste(popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));

    expect(await within(popover).findByRole('alert')).toHaveTextContent('Could not add the key. Try again.');
    keyGone();
  });

  it('an empty key is refused on the page and never posted', async () => {
    mockCatalog([keyedEntry]);
    renderPage();

    const popover = await openToolPopover('Latchkey');
    paste(popover, '   ');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));

    expect(await within(popover).findByRole('alert')).toHaveTextContent('Paste a key first.');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('with one agent keyed, a key can still be added for another, and the keyed one is named', async () => {
    mockCatalog([{ ...keyedEntry, connections: [scoutKey] }]);
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(within(popover).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(agentOptions(popover)).toEqual(['Reed']);
    expect(within(popover).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: /^Disconnect Latchkey: Key · Scout · / })).toBeInTheDocument();

    paste(popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(OPERATOR_KEY_URL, { agentId: REED, key: KEY }, expect.anything()));
  });

  it('every own agent keyed: no form; no own agent at all: a note instead', async () => {
    mockCatalog([{ ...keyedEntry, connections: [scoutKey, { ...scoutKey, connectionId: 'conn-reed', agentId: REED }] }]);
    const first = renderPage();
    const keyedAll = await openToolPopover('Latchkey');
    expect(within(keyedAll).queryByLabelText('key')).toBeNull();
    first.unmount();

    mockApi({ pods, seats: { p1: [nova] }, grants: [], installables: [keyedEntry] });
    renderPage();
    const none = await openToolPopover('Latchkey');
    expect(within(none).queryByLabelText('key')).toBeNull();
    expect(within(none).getByText('no agent of yours to add a key for yet')).toBeInTheDocument();
    expect(within(none).queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('reads in zh-CN', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      mockCatalog([keyedEntry]);
      axios.post.mockRejectedValue({ response: { status: 403, data: { error: 'agent_not_owned' } } });
      renderPage();

      const popover = await openToolPopover('Latchkey');
      expect(within(popover).getByText('为你的智能体添加密钥')).toBeInTheDocument();
      expect(within(popover).getByLabelText('智能体')).toBeInTheDocument();
      expect(within(popover).getByRole('link', { name: '去 Latchkey 创建密钥' })).toBeInTheDocument();
      paste(popover);
      fireEvent.click(within(popover).getByRole('button', { name: '添加密钥' }));
      expect(await within(popover).findByRole('alert')).toHaveTextContent('只能为仅由你安装的智能体添加密钥。');
      keyGone();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });
});

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
    // Where to make the key sits beside the form here too.
    expect(within(drawer).getByText('Create a key with read scopes only.')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Create a key at Latchkey' })).toHaveAttribute('href', 'https://latchkey.example/keys');
    // The grant row still renders beside the form.
    expect(drawer.querySelector('.v2-cx-list article')).not.toBeNull();
  });

  it('an agent installed only in an agent-dm pod is not offered, and an agent-dm install by someone else does not block', async () => {
    axios.post.mockImplementation(async () => ({ data: {} }));
    const dmPods = [...pods, { _id: 'dm1', name: 'Scout ↔ Nova', type: 'agent-dm', members: [{ _id: 'u1', username: 'sam' }] }];
    mockApi({
      pods: dmPods,
      // Nova is the viewer's install only in the agent-dm pod; Reed is the
      // viewer's in p2, and someone else's only in the agent-dm pod.
      seats: { p1: [scout], p2: [reed], dm1: [{ ...nova, installedBy: 'u1' }, { ...reed, installedBy: 'u2' }] },
      grants: [],
      route: (url) => (url === '/api/installables' ? Promise.resolve({ data: { installables: [keyedEntry] } }) : undefined),
    });
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(agentOptions(popover)).toEqual(['Reed', 'Scout']);
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
    const reedKey = { ...scoutKey, connectionId: 'conn-reed', agentId: REED };
    mockCatalog([{ ...keyedEntry, connections: [scoutKey] }], [{ ...keyedEntry, connections: [scoutKey, reedKey] }]);
    renderPage();

    const popover = await openToolPopover('Latchkey');
    expect(within(popover).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(agentOptions(popover)).toEqual(['Reed']);
    expect(within(popover).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: /^Disconnect Latchkey: Key · Scout · / })).toBeInTheDocument();

    paste(popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(OPERATOR_KEY_URL, { agentId: REED, key: KEY }, expect.anything()));
    // After the refresh both keys show, and no agent is left to key.
    expect(await screen.findByRole('button', { name: /^Disconnect Latchkey: Key · Reed · / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Disconnect Latchkey: Key · Scout · / })).toBeInTheDocument();
    expect(screen.queryByLabelText('key')).toBeNull();
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

// The grant draft on a key connection (#3353 review). The grant route refuses any
// audience on a key connection except exactly its agent, so the draft starts
// there, offers no one else, and names each key by its agent.
describe('Connectors page: granting an operator-key connection', () => {
  const reedKey = { ...scoutKey, connectionId: 'conn-reed', agentId: REED };
  const grantPost = () => axios.post.mock.calls.find(([url]) => url === '/api/grants');
  const openKeyDraft = async (connections, { add = 'Add', form = 'Add Latchkey' } = {}) => {
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    mockApi({ pods, seats, grants: [], installables: [{ ...keyedEntry, connections }] });
    renderPage();
    const popover = await openToolPopover('Latchkey');
    fireEvent.click(within(popover).getByRole('button', { name: add }));
    return screen.findByRole('complementary', { name: form });
  };
  const optionTexts = (select) => within(select).getAllByRole('option').map((option) => option.textContent);
  const keyGrant = (over) => ({
    grantId: 'grant_k', installationId: 'conn-scout', target: { kind: 'pod', id: 'p1' }, tools: ['latchkey.list_secrets'],
    writeMode: 'read', budget: { calls: 50, windowMs: 3600000 }, effectiveAudience: [SCOUT],
    expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(), revokedAt: null, revokedBy: null,
    parentGrantId: null, rootGrantId: null, createdAt: new Date(Date.now() - 3600000).toISOString(), grantedBy: 'u1',
    ...over,
  });
  // A live grant on Scout's key keeps the tile granted, so it opens the drawer;
  // `dead` is the revoked grant whose Grant again is under test.
  const openGrantAgain = async (connections, dead) => {
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    mockApi({ pods, seats, grants: [keyGrant({}), dead], installables: [{ ...keyedEntry, connections }] });
    renderPage();
    const drawer = await openDrawer('Latchkey');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Grant again' }));
    return screen.findByRole('complementary', { name: 'Add Latchkey' });
  };
  const revoked = { revokedAt: new Date(Date.now() - 600000).toISOString(), revokedBy: 'u1' };

  it('Grant again on a key grant keeps the key it was minted on, even when it is not the first key', async () => {
    const dead = keyGrant({ grantId: 'grant_reed', installationId: 'conn-reed', target: { kind: 'pod', id: 'p2' }, effectiveAudience: [REED], ...revoked });
    const form = await openGrantAgain([scoutKey, reedKey], dead);
    expect(within(form).getByRole('heading', { name: 'Latchkey · Ops' })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(grantPost()).toBeDefined());
    expect(grantPost()[1]).toEqual(expect.objectContaining({ connectionId: 'conn-reed', target: { kind: 'pod', id: 'p2' }, audience: [REED] }));
  });

  it('Grant again on a key grant whose key is gone starts with nobody, never another agent\'s key', async () => {
    const dead = keyGrant({ grantId: 'grant_gone', installationId: 'conn-deleted', target: { kind: 'pod', id: 'p2' }, effectiveAudience: [REED], ...revoked });
    const form = await openGrantAgain([scoutKey, reedKey], dead);
    // The picker says no key is chosen, rather than showing Scout's as picked.
    expect(within(form).getByLabelText('connection')).toHaveValue('');
    expect(within(form).getByRole('option', { name: 'Choose a key' })).toBeDisabled();
    expect(within(form).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(form).getByRole('button', { name: 'Grant' })).toBeDisabled();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    expect(grantPost()).toBeUndefined();
  });

  it('a removed key with one key left still offers the picker, and choosing it enables Grant', async () => {
    const dead = keyGrant({ grantId: 'grant_gone', installationId: 'conn-deleted', effectiveAudience: [REED], ...revoked });
    const form = await openGrantAgain([scoutKey], dead);
    const picker = within(form).getByLabelText('connection');
    expect(picker).toHaveValue('');
    expect(within(form).getByRole('button', { name: 'Grant' })).toBeDisabled();
    fireEvent.change(picker, { target: { value: 'conn-scout' } });
    expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(grantPost()).toBeDefined());
    expect(grantPost()[1]).toEqual(expect.objectContaining({ connectionId: 'conn-scout', target: { kind: 'pod', id: 'p1' }, audience: [SCOUT] }));
  });

  it('in a pod with several agents, the first Grant reaches only the key\'s agent', async () => {
    const form = await openKeyDraft([scoutKey, reedKey]);
    // Launch pod holds Scout and Nova; only Scout's checkbox is offered.
    expect(within(form).getByRole('heading', { name: 'Latchkey · Launch pod' })).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
    expect(within(form).queryByRole('checkbox', { name: 'Nova' })).toBeNull();
    expect(within(form).getByText('Only Scout can use this key.')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(grantPost()).toBeDefined());
    expect(grantPost()[1]).toEqual(expect.objectContaining({ connectionId: 'conn-scout', target: { kind: 'pod', id: 'p1' }, audience: [SCOUT] }));
  });

  it('the connection picker names each key by its agent, not "/"', async () => {
    const form = await openKeyDraft([scoutKey, reedKey]);
    const picker = within(form).getByLabelText('connection');
    expect(optionTexts(picker)).toEqual(['Scout', 'Reed']);
    expect(optionTexts(picker)).not.toContain('/');
  });

  it('a key whose agent is unknown on this page reads "Key"', async () => {
    const form = await openKeyDraft([scoutKey, { ...reedKey, agentId: '6a00000000000000000000ff' }]);
    expect(optionTexts(within(form).getByLabelText('connection'))).toEqual(['Scout', 'Key']);
  });

  it('switching to Reed\'s key in a pod Reed is not in says so and keeps Grant off; in Reed\'s pod it grants [Reed]', async () => {
    const form = await openKeyDraft([scoutKey, reedKey]);
    fireEvent.change(within(form).getByLabelText('connection'), { target: { value: 'conn-reed' } });
    expect(within(form).getByText("Reed isn't in this pod.")).toBeInTheDocument();
    expect(within(form).queryByRole('checkbox')).toBeNull();
    expect(within(form).queryByText('Select at least one agent to grant access.')).toBeNull();
    expect(within(form).getByRole('button', { name: 'Grant' })).toBeDisabled();

    fireEvent.change(within(form).getByLabelText('pod'), { target: { value: 'p2' } });
    expect(within(form).queryByText("Reed isn't in this pod.")).toBeNull();
    // Ops holds Reed and Scout; Reed's key offers Reed alone.
    expect(within(form).getByRole('checkbox', { name: 'Reed' })).toBeChecked();
    expect(within(form).queryByRole('checkbox', { name: 'Scout' })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(grantPost()).toBeDefined());
    expect(grantPost()[1]).toEqual(expect.objectContaining({ connectionId: 'conn-reed', target: { kind: 'pod', id: 'p2' }, audience: [REED] }));
  });

  it('a lone key starts in a pod where its agent sits', async () => {
    const form = await openKeyDraft([reedKey]);
    expect(within(form).getByRole('heading', { name: 'Latchkey · Ops' })).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: 'Reed' })).toBeChecked();
  });

  it('a key whose agent sits in no pod starts with nobody and Grant off', async () => {
    const form = await openKeyDraft([{ ...reedKey, agentId: '6a00000000000000000000ff' }]);
    expect(within(form).getByText("This key's agent isn't in this pod.")).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Grant' })).toBeDisabled();
  });

  it('an OAuth draft still starts with every agent in the pod', async () => {
    axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
    const signIn = { connectionId: 'conn-linear', owner: '', repo: '', connectedAt: '2026-11-01T09:00:00.000Z' };
    mockApi({ pods, seats, grants: [], installables: [{ ...linearEntry, connections: [signIn] }] });
    renderPage();
    const popover = await openToolPopover('Linear');
    fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('complementary', { name: 'Add Linear' });
    expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'Nova' })).toBeChecked();
    expect(within(form).queryByText(/can use this key/)).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(grantPost()).toBeDefined());
    expect(grantPost()[1].audience).toEqual([SCOUT, NOVA]);
  });

  it('reads in zh-CN', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      const form = await openKeyDraft([scoutKey, reedKey], { add: '添加', form: '添加 Latchkey' });
      expect(within(form).getByText('只有 Scout 可以使用这个密钥。')).toBeInTheDocument();
      fireEvent.change(form.querySelectorAll('select')[1], { target: { value: 'conn-reed' } });
      expect(within(form).getByText('Reed 不在这个 Pod 中。')).toBeInTheDocument();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });
});

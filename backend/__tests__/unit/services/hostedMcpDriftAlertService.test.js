// F48: on 11-01 Sentry's seven search reads drifted upstream and were refused
// as tool_drift on prod. The only signal was a console.warn nobody reads, so a
// connector sat 7/11 dark until a template capture tripped over it. A drift now
// becomes one Needs-you card for the operator who re-pins.
const { createHostedMcpDriftAlert } = require('../../../services/hostedMcpDriftAlertService');
const { HOSTED_MCP_ENTRIES, findHostedMcpEntry } = require('../../../integrations/hostedMcp/entries');

const sentry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, 'sentry');
const row = { connectionId: 'row-1' };
const OPERATOR = '6a1b2c3d4e5f60718293a4b5';
const POD = '6a8f6dc7a1dccf2e02f31f99';
const config = { recipientUserId: OPERATOR, podId: POD };
const drifted = (name) => ({
  name, namespacedName: `sentry.${name}`, verdict: 'tool_drift',
  detail: `upstream inputSchema for ${name} differs from the pin`,
});
const unavailable = (name) => ({
  name, namespacedName: `sentry.${name}`, verdict: 'tool_unavailable',
  detail: `this connection's tools/list does not include ${name}`,
});
const ok = (name) => ({ name, namespacedName: `sentry.${name}`, verdict: 'ok' });

const setup = (over = {}) => {
  const readConfig = jest.fn(async () => config);
  const record = jest.fn(async () => ({ recorded: true }));
  const alert = createHostedMcpDriftAlert(Object.assign({ readConfig, record }, over));
  return { alert, readConfig: over.readConfig || readConfig, record: over.record || record };
};

let error;
beforeEach(() => { error = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => error.mockRestore());

const logged = () => error.mock.calls.map(([line]) => JSON.parse(line));

describe('a drifted pin becomes one card for the operator', () => {
  test('drift files a card naming the entry and every drifted tool', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues'), drifted('search_errors'), ok('find_organizations')]);

    expect(record).toHaveBeenCalledTimes(1);
    const [card] = record.mock.calls[0];
    expect(card).toMatchObject({ recipientUserId: OPERATOR, podId: POD });
    expect(card.sourceId).toMatch(/^drift:sentry:[0-9a-f]{16}$/);
    expect(card.title).toBe('Sentry: 2 pinned tools changed upstream');
    expect(card.detail).toContain('search_issues, search_errors');
    expect(card.detail).toContain('row-1');
    expect(card.detail).not.toMatch(/first seen/i);
    expect(card.detail).not.toContain('find_organizations');
  });

  test('one drifted tool reads in the singular', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record.mock.calls[0][0].title).toBe('Sentry: 1 pinned tool changed upstream');
  });

  test('the same drift files once per process, however often and on however many rows', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    await alert({ connectionId: 'row-2' }, sentry, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  // Review on e1918d515: a memo keyed by the drift alone sent nothing to an
  // operator configured after the first card.
  test('a changed operator gets their own card, and the first is not filed twice', async () => {
    const NEXT = '6a1b2c3d4e5f60718293a4c6';
    let current = config;
    const { alert, record } = setup({ readConfig: jest.fn(async () => current) });
    await alert(row, sentry, [drifted('search_issues')]);
    current = { recipientUserId: NEXT, podId: POD };
    await alert(row, sentry, [drifted('search_issues')]);
    current = config;
    await alert(row, sentry, [drifted('search_issues')]);

    expect(record.mock.calls.map(([card]) => card.recipientUserId)).toEqual([OPERATOR, NEXT]);
    expect(record.mock.calls[1][0].sourceId).toBe(record.mock.calls[0][0].sourceId);
  });

  // Review on c7d2fa765: a key of the pin set alone lost a second tool's drift
  // under the same pins, and a drift only another row's consent can see.
  test('another tool drifting under the same pins files its own card', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    await alert({ connectionId: 'row-2' }, sentry, [drifted('search_issues'), drifted('update_issue')]);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1][0].sourceId).not.toBe(record.mock.calls[0][0].sourceId);
    expect(record.mock.calls[1][0].detail).toContain('search_issues, update_issue');
  });

  test('the key does not depend on the order the tools were assessed in', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues'), drifted('search_errors')]);
    await alert(row, sentry, [drifted('search_errors'), drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  test('a re-pinned entry is a new pin set, so its drift files again', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    const repinned = Object.assign({}, sentry, {
      tools: sentry.tools.map((tool, index) => (index === 0
        ? Object.assign({}, tool, { description: `${tool.description} (re-pinned)` }) : tool)),
    });
    await alert(row, repinned, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1][0].sourceId).not.toBe(record.mock.calls[0][0].sourceId);
  });

  // A row's list depends on what its owner consented to, so an absent tool is
  // not evidence about the vendor (the Linear smoke row lists 26 as absent
  // because its scope is read-only). Only drift is unambiguous.
  test('an absent or unchanged tool files nothing and reads no config', async () => {
    const { alert, record, readConfig } = setup();
    await alert(row, sentry, [unavailable('update_issue'), ok('search_issues')]);
    expect(record).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });
});

describe('a drift that cannot be delivered says so, loudly', () => {
  test('no configured operator: an error line, and no card', async () => {
    const { alert, record } = setup({ readConfig: jest.fn(async () => null) });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);

    expect(record).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({
      event: 'hosted_mcp_drift_alert', delivery: 'unconfigured', entryId: 'sentry',
      connectionId: 'row-1', tools: ['search_issues'],
    })]);
  });

  test('a half-written config is unconfigured, not a card to nobody', async () => {
    const { alert, record } = setup({ readConfig: jest.fn(async () => ({ recipientUserId: OPERATOR })) });
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ delivery: 'unconfigured' });
  });

  // Review on c7d2fa765: a bad id threw a CastError, which logged `failed` and
  // retried on every fresh assessment of every drifted row.
  test('a malformed id is unconfigured, not a failure retried forever', async () => {
    const { alert, record } = setup({ readConfig: jest.fn(async () => ({ recipientUserId: 'connector-ops', podId: POD })) });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ delivery: 'unconfigured' })]);
  });

  // Reviews on c7d2fa765 and e1918d515: memoizing an undelivered drift, until
  // restart and then for an hour, held back the card from an operator who set
  // the config, or joined the pod, after the first error.
  test('a config set after an unconfigured drift files on the next assessment', async () => {
    const readConfig = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(config);
    const { alert, record } = setup({ readConfig });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  test('an operator who joins the pod after the first error gets the card next time', async () => {
    const record = jest.fn()
      .mockResolvedValueOnce({ recorded: false, reason: 'recipient_not_member' })
      .mockResolvedValue({ recorded: true });
    const { alert } = setup({ record });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(2);
  });

  test('an undeliverable drift logs once an hour while it lasts, not on every assessment', async () => {
    let clock = 1000;
    const { alert } = setup({ readConfig: jest.fn(async () => null), now: () => clock });
    await alert(row, sentry, [drifted('search_issues')]);
    clock += 59 * 60 * 1000;
    await alert(row, sentry, [drifted('search_issues')]);
    expect(logged()).toHaveLength(1);
    clock += 2 * 60 * 1000;
    await alert(row, sentry, [drifted('search_issues')]);
    expect(logged()).toHaveLength(2);
  });

  // Review on c7d2fa765: two replicas inserting at once make one upsert lose
  // on the unique index. The card exists, so that is not a failure.
  test('losing an insert race to another replica counts as filed', async () => {
    const record = jest.fn(async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); });
    const { alert } = setup({ record });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test('an operator the pod does not list: an error line naming why', async () => {
    const { alert } = setup({ record: jest.fn(async () => ({ recorded: false, reason: 'recipient_not_member' })) });
    await alert(row, sentry, [drifted('search_issues')]);
    expect(logged()).toEqual([expect.objectContaining({ delivery: 'recipient_not_member', entryId: 'sentry' })]);
  });

  test('a failed write is logged and retried on the next assessment', async () => {
    const record = jest.fn()
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValueOnce({ recorded: true });
    const { alert } = setup({ record });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);

    expect(record).toHaveBeenCalledTimes(2);
    expect(logged()[0]).toMatchObject({ delivery: 'failed', reason: 'mongo unavailable' });
  });

  test('a failed config read is logged and retried too', async () => {
    const readConfig = jest.fn()
      .mockRejectedValueOnce(new Error('mongo unavailable'))
      .mockResolvedValueOnce(config);
    const { alert, record } = setup({ readConfig });
    await alert(row, sentry, [drifted('search_issues')]);
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(logged()[0]).toMatchObject({ delivery: 'failed' });
  });
});

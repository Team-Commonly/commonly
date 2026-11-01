// F48: on 11-01 Sentry's seven search reads drifted upstream and were refused
// as tool_drift on prod. The only signal was a console.warn nobody reads, so a
// connector sat 7/11 dark until a template capture tripped over it. A drift now
// becomes one Needs-you card for the operator who re-pins.
const { createHostedMcpDriftAlert } = require('../../../services/hostedMcpDriftAlertService');
const { HOSTED_MCP_ENTRIES, findHostedMcpEntry } = require('../../../integrations/hostedMcp/entries');

const sentry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, 'sentry');
const row = { connectionId: 'row-1' };
const config = { recipientUserId: 'operator', podId: 'pod-ops' };
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
    expect(card).toMatchObject({ recipientUserId: 'operator', podId: 'pod-ops' });
    expect(card.sourceId).toMatch(/^drift:sentry:[0-9a-f]{16}$/);
    expect(card.title).toBe('Sentry: 2 pinned tools changed upstream');
    expect(card.detail).toContain('search_issues, search_errors');
    expect(card.detail).toContain('row-1');
    expect(card.detail).not.toContain('find_organizations');
  });

  test('one drifted tool reads in the singular', async () => {
    const { alert, record } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record.mock.calls[0][0].title).toBe('Sentry: 1 pinned tool changed upstream');
  });

  test('the same pin set files once per process, however often it is assessed', async () => {
    const { alert, record, readConfig } = setup();
    await alert(row, sentry, [drifted('search_issues')]);
    await alert({ connectionId: 'row-2' }, sentry, [drifted('search_issues'), drifted('search_logs')]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledTimes(1);
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
  test('no configured operator: an error line, once per pin set, and no card', async () => {
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
    const { alert, record } = setup({ readConfig: jest.fn(async () => ({ recipientUserId: 'operator' })) });
    await alert(row, sentry, [drifted('search_issues')]);
    expect(record).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ delivery: 'unconfigured' });
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

/**
 * Operator-key intake (TASK-330, Vera §4-§5): a pasted key is proved against
 * the vendor before its row can go connected, a forbidden scope is refused,
 * and the key never comes back in any result. The vendor client is injected,
 * so these arms need no network.
 */
const { RoomGrantError } = require('../../../services/roomGrantService');
const {
  validateOperatorKey,
  refusedOperatorKeyScopes,
  OPERATOR_KEY_REFUSED_SCOPES,
} = require('../../../services/hostedMcpOperatorKeyIntake');

const KEY_ENTRY = { id: 'latchkey', credentialMode: 'operator_key', resource: 'https://latchkey.dev/mcp' };
const SECRET = 'lk_live_THE_SECRET_VALUE';
const TOOLS = [{ name: 'list_jobs' }];
const fetcher = jest.fn();

const run = (overrides = {}) => validateOperatorKey({
  entry: KEY_ENTRY,
  key: SECRET,
  reportedScopes: ['read', 'jobs:run', 'dispatch'],
  fetcher,
  listTools: jest.fn(async () => TOOLS),
  ...overrides,
});

describe('refusedOperatorKeyScopes', () => {
  it('names exactly the three scopes a key may never carry', () => {
    expect([...OPERATOR_KEY_REFUSED_SCOPES].sort()).toEqual(['jobs:approve', 'migration:apply', 'secrets:write']);
  });

  it('returns only the forbidden ones, and nothing for the walk scopes', () => {
    expect(refusedOperatorKeyScopes(['read', 'jobs:run', 'dispatch'])).toEqual([]);
    expect(refusedOperatorKeyScopes(['read', 'secrets:write', 'jobs:approve'])).toEqual(['secrets:write', 'jobs:approve']);
  });
});

describe('validateOperatorKey', () => {
  it('accepts a key whose probe lists tools, and reports the read check', async () => {
    const out = await run();
    expect(out).toEqual({ ok: true, tools: TOOLS, scopeCheck: 'read' });
  });

  it('marks the check as a self-report when the vendor cannot report scopes', async () => {
    const out = await run({ reportedScopes: null });
    expect(out).toMatchObject({ ok: true, scopeCheck: 'self_report' });
  });

  it('refuses a forbidden scope before it probes the vendor', async () => {
    const listTools = jest.fn();
    const out = await run({ reportedScopes: ['read', 'secrets:write'], listTools });
    expect(out).toMatchObject({ ok: false, code: 'scope_refused' });
    expect(out.message).toContain('secrets:write');
    expect(listTools).not.toHaveBeenCalled();
  });

  it('refuses a missing key and a non-key entry', async () => {
    await expect(run({ key: '   ' })).resolves.toMatchObject({ ok: false, code: 'key_missing' });
    await expect(run({ entry: { id: 'linear', resource: 'https://x' } }))
      .resolves.toMatchObject({ ok: false, code: 'not_operator_key' });
  });

  it('maps a vendor rejection to fixed copy', async () => {
    const listTools = jest.fn(async () => {
      throw new RoomGrantError('credential_rejected', 'the vendor rejected this connection’s credential', 403);
    });
    const out = await run({ listTools });
    expect(out).toEqual({ ok: false, code: 'vendor_rejected', message: 'the vendor rejected this key' });
  });

  it('never returns the key, even when the vendor error repeats it', async () => {
    const listTools = jest.fn(async () => {
      throw new RoomGrantError('provider_error', `vendor said ${SECRET} is wrong`, 502);
    });
    const out = await run({ listTools });
    expect(out).toMatchObject({ ok: false, code: 'vendor_unreachable' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('never returns the key on success or refusal', async () => {
    expect(JSON.stringify(await run())).not.toContain(SECRET);
    expect(JSON.stringify(await run({ reportedScopes: ['jobs:approve'] }))).not.toContain(SECRET);
  });
});

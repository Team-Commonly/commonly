/**
 * F102: a write pin the row's consent cannot reach reads as not granted.
 *
 * Sam's Linear row was connected at `read openid`, before the entry gained
 * `write` (#3235, 11-01), and Linear lists only the reads to that token: 38 of
 * the vendor's tools on 11-04. Every fresh assessment then called the 26 write
 * pins `tool_unavailable` and logged them, which reads as the vendor having
 * withdrawn them. Nothing was withdrawn: the row never consented to write, and
 * the grant mint already refuses write-with-confirm on it (write_scope_required).
 *
 * The rule decided once, in assessEntryTools: a write pin missing from the list
 * on a row whose recorded consent lacks the entry's writeScope is `not_granted`.
 * A missing read pin is still `tool_unavailable`, a listed write is assessed as
 * any pin is, and a caller that does not pass the row's consent sees no change.
 */
const {
  assessEntryTools,
  consentHoldsWriteScope,
  createHostedMcpDriftCache,
} = require('../../../services/hostedMcpEntryService');
const { createHostedMcpRuntimeDriftCache, hostedToolDefinitions } = require('../../../services/hostedMcpToolDefinitions');
const { LINEAR_ENTRY } = require('../../../integrations/hostedMcp/linear');
const SAM_ROW_LIST = require('../../fixtures/hostedMcp/linear-tools-list-names-2026-11-04-read-scope.json');

const mockAlertOnHostedMcpDrift = jest.fn();
jest.mock('../../../services/hostedMcpDriftAlertService', () => ({
  alertOnHostedMcpDrift: (...args) => mockAlertOnHostedMcpDrift(...args),
}));

// The list Sam's row returned, by name. Each listed pin carries its own pinned
// schema and annotations, so the arms below isolate what is missing.
const pinByUpstream = new Map(LINEAR_ENTRY.tools.map((tool) => [tool.upstreamName, tool]));
const listFor = (names) => names.map((name) => {
  const pin = pinByUpstream.get(name);
  return pin
    ? { name, inputSchema: pin.inputSchema, annotations: pin.annotations }
    : { name, inputSchema: { type: 'object' } };
});
const SAM_LIST = listFor(SAM_ROW_LIST.names);
const verdictsOf = (tools) => tools.reduce((counts, tool) => {
  counts[tool.verdict] = (counts[tool.verdict] || 0) + 1;
  return counts;
}, {});
const classOf = (name) => LINEAR_ENTRY.tools.find((tool) => tool.name === name).class;

describe("Sam's read-scoped Linear row (read openid, 38 listed)", () => {
  test('the fixture is the shape it claims', () => {
    expect(SAM_ROW_LIST.grantedScope).toBe('read openid');
    expect(SAM_ROW_LIST.names).toHaveLength(38);
    expect(LINEAR_ENTRY.writeScope).toBe('write');
    expect(LINEAR_ENTRY.tools.filter((tool) => tool.class === 'write')).toHaveLength(26);
  });

  test('its 26 missing write pins read as not granted, and every read is ok', () => {
    const tools = assessEntryTools(LINEAR_ENTRY, SAM_LIST, { grantedScope: 'read openid' });
    expect(verdictsOf(tools)).toEqual({ ok: 36, not_granted: 26 });
    const notGranted = tools.filter((tool) => tool.verdict === 'not_granted');
    expect(notGranted.every((tool) => classOf(tool.name) === 'write')).toBe(true);
    expect(notGranted[0].detail).toBe("this connection's consent does not include write; reconnect Linear to enable writes");
  });

  test('reverse: the same list on a row that consented to write calls them tool_unavailable', () => {
    const tools = assessEntryTools(LINEAR_ENTRY, SAM_LIST, { grantedScope: 'read write openid' });
    expect(verdictsOf(tools)).toEqual({ ok: 36, tool_unavailable: 26 });
  });

  test('a caller that does not pass the row\'s consent sees what it saw before', () => {
    expect(verdictsOf(assessEntryTools(LINEAR_ENTRY, SAM_LIST))).toEqual({ ok: 36, tool_unavailable: 26 });
  });

  test('a missing read pin stays tool_unavailable on a read-scoped row', () => {
    const list = SAM_LIST.filter((tool) => tool.name !== 'list_issues');
    const tools = assessEntryTools(LINEAR_ENTRY, list, { grantedScope: 'read openid' });
    expect(tools.find((tool) => tool.name === 'list_issues').verdict).toBe('tool_unavailable');
    expect(verdictsOf(tools)).toEqual({ ok: 35, tool_unavailable: 1, not_granted: 26 });
  });

  test('a write pin the list does include is assessed like any pin, whatever the consent', () => {
    const write = LINEAR_ENTRY.tools.find((tool) => tool.class === 'write');
    const listed = [...SAM_LIST, { name: write.upstreamName, inputSchema: write.inputSchema, annotations: write.annotations }];
    const asPinned = assessEntryTools(LINEAR_ENTRY, listed, { grantedScope: 'read openid' });
    expect(asPinned.find((tool) => tool.name === write.name).verdict).toBe('ok');
    const changed = [...SAM_LIST, { name: write.upstreamName, inputSchema: { type: 'object' }, annotations: write.annotations }];
    const drifted = assessEntryTools(LINEAR_ENTRY, changed, { grantedScope: 'read openid' });
    expect(drifted.find((tool) => tool.name === write.name).verdict).toBe('tool_drift');
  });

  test('a row with no recorded scope lacks write, as the grant mint reads it', () => {
    [undefined, null, ''].forEach((grantedScope) => {
      expect(verdictsOf(assessEntryTools(LINEAR_ENTRY, SAM_LIST, { grantedScope }))).toEqual({ ok: 36, not_granted: 26 });
    });
  });

  test('an entry with no writeScope keeps tool_unavailable for a missing write', () => {
    const { writeScope: _omitted, ...withoutWriteScope } = LINEAR_ENTRY;
    const tools = assessEntryTools(withoutWriteScope, SAM_LIST, { grantedScope: 'read openid' });
    expect(verdictsOf(tools)).toEqual({ ok: 36, tool_unavailable: 26 });
  });
});

describe('the consent read is the grant mint\'s', () => {
  test.each([
    ['read write openid', true],
    ['write', true],
    ['read  write', true],
    ['read openid', false],
    ['read,write', false],
    ['readwrite', false],
    ['', false],
    [undefined, false],
  ])('%j holds write: %s', (grantedScope, holds) => {
    expect(consentHoldsWriteScope(LINEAR_ENTRY, grantedScope)).toBe(holds);
  });

  test('an entry with no writeScope always holds it', () => {
    const { writeScope: _omitted, ...withoutWriteScope } = LINEAR_ENTRY;
    expect(consentHoldsWriteScope(withoutWriteScope, 'read')).toBe(true);
  });
});

describe('the drift cache', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());
  const assessmentLines = () => warn.mock.calls.map(([line]) => JSON.parse(line))
    .filter((line) => line.event === 'hosted_mcp_tool_assessment');

  test('takes the row\'s consent from the listing and logs no line for not-granted pins', async () => {
    const cache = createHostedMcpDriftCache({
      listUpstreamTools: async () => ({ tools: SAM_LIST, grantedScope: 'read openid' }),
    });
    const outcome = await cache.assess({ connectionId: 'row-1' }, LINEAR_ENTRY);
    expect(verdictsOf(outcome.tools)).toEqual({ ok: 36, not_granted: 26 });
    expect(assessmentLines()).toEqual([]);
  });

  test('still logs a missing read beside them, and only that', async () => {
    const cache = createHostedMcpDriftCache({
      listUpstreamTools: async () => ({
        tools: SAM_LIST.filter((tool) => tool.name !== 'list_issues'), grantedScope: 'read openid',
      }),
    });
    await cache.assess({ connectionId: 'row-1' }, LINEAR_ENTRY);
    const lines = assessmentLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].tools.map((tool) => `${tool.name}:${tool.verdict}`)).toEqual(['list_issues:tool_unavailable']);
  });

  test('a listing given as a bare array assesses as before', async () => {
    const cache = createHostedMcpDriftCache({ listUpstreamTools: async () => SAM_LIST });
    const outcome = await cache.assess({ connectionId: 'row-1' }, LINEAR_ENTRY);
    expect(verdictsOf(outcome.tools)).toEqual({ ok: 36, tool_unavailable: 26 });
    expect(assessmentLines()).toHaveLength(1);
  });
});

describe('the runtime cache reads the consent from the row it lists with', () => {
  const ROW_ID = 'a1b2c3d4e5f60718293a4b5c';
  const CONNECTION = { type: 'hosted-mcp', entryId: 'linear', connectionId: ROW_ID };
  const write = LINEAR_ENTRY.tools.find((tool) => tool.class === 'write');
  const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const makeDeps = (grantedScope) => {
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        const result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 's-1' },
        });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: SAM_LIST } });
      throw new Error(`unexpected ${body.method}`);
    });
    const deps = {
      fetcher,
      loadRow: jest.fn(async () => ({
        _id: ROW_ID,
        type: 'hosted-mcp',
        status: 'connected',
        config: { entryId: 'linear', credentialRef: 'cred-1', ...(grantedScope === undefined ? {} : { grantedScope }) },
      })),
      credentialFor: jest.fn(async () => ({ token: 'access-token-1' })),
    };
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [LINEAR_ENTRY]);
    return deps;
  };
  const definition = (deps) => hostedToolDefinitions([LINEAR_ENTRY], deps)
    .find((candidate) => candidate.name === `linear.${write.name}`);
  const methodsSent = (deps) => deps.fetcher.mock.calls
    .filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(init.body).method);

  beforeEach(() => mockAlertOnHostedMcpDrift.mockClear());

  test('a write call on a read-scoped row is refused write_scope_required before tools/call', async () => {
    const deps = makeDeps('read openid');
    await expect(definition(deps).call({}, CONNECTION)).rejects.toMatchObject({
      code: 'write_scope_required',
      statusCode: 403,
      message: `linear.${write.name}: this connection's consent does not include write; reconnect Linear to enable writes`,
    });
    expect(methodsSent(deps)).not.toContain('tools/call');
    await new Promise(setImmediate);
    const [, , tools] = mockAlertOnHostedMcpDrift.mock.calls[0];
    expect(tools.find((tool) => tool.name === write.name).verdict).toBe('not_granted');
  });

  test('reverse: on a row that consented to write, the same missing tool is tool_unavailable', async () => {
    const deps = makeDeps('read write openid');
    await expect(definition(deps).call({}, CONNECTION)).rejects.toMatchObject({ code: 'tool_unavailable' });
    expect(methodsSent(deps)).not.toContain('tools/call');
  });
});

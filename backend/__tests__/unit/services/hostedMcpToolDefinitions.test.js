/**
 * The `call` half of a hosted-MCP tool: one JSON-RPC request, and the credential
 * fetched inside it.
 *
 * Everything here is injected (the fetcher, the row lookup, the credential) for
 * the same reason the intake flow injects its fetcher: the transport is the
 * seam, and a vendor account is not a test fixture. What is NOT injected is the
 * projection the definitions are built from — that is the real
 * `entryToolProjections` over a fixture catalogue, so an arm that asserts a
 * tool's name or write mode is reading the same function the broker does.
 */
const {
  HOSTED_MCP_CALL_TIMEOUT_MS,
  createHostedMcpRuntimeDriftCache,
  hostedToolDefinitions,
  findHostedToolDefinition,
} = require('../../../services/hostedMcpToolDefinitions');
const { AIRTABLE_ENTRY } = require('../../../integrations/hostedMcp/airtable');

const ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read'],
  revoke: 'https://mcp.linear.app/revoke',
  tools: [
    {
      name: 'list_issues',
      upstreamName: 'list_issues',
      description: 'List issues',
      class: 'read',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    },
    {
      name: 'create_issue',
      upstreamName: 'createIssue',
      description: 'Create an issue',
      class: 'write',
      irreversible: true,
      inputSchema: { type: 'object' },
    },
  ],
};

const ROW_ID = 'a1b2c3d4e5f60718293a4b5c';
const CONNECTION = { type: 'hosted-mcp', entryId: 'linear', connectionId: ROW_ID };

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const sseResponse = (frames, status = 200) => new Response(frames.join('\n'), {
  status,
  headers: { 'content-type': 'text/event-stream' },
});

const okReply = { jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text', text: 'ok' }] } };

const sessionFetcher = (handler) => jest.fn(async (url, init) => {
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  const body = JSON.parse(init.body);
  if (body.method === 'initialize') return new Response(JSON.stringify({
    jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
  }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  return handler(url, init);
});

const toolCalls = (deps) => deps.fetcher.mock.calls.filter(([, init]) => {
  if (init.method !== 'POST') return false;
  return !['initialize', 'notifications/initialized'].includes(JSON.parse(init.body).method);
});

const makeDeps = (overrides = {}) => ({
  fetcher: sessionFetcher(overrides.fetcher || jest.fn(async () => jsonResponse(okReply))),
  loadRow: jest.fn(async () => ({
    _id: ROW_ID,
    type: 'hosted-mcp',
    status: 'connected',
    config: { entryId: 'linear', credentialRef: 'cred-1' },
  })),
  credentialFor: jest.fn(async () => ({ token: 'access-token-1' })),
  newCallId: () => 'call-1',
  driftCache: {
    assess: jest.fn(async (_row, entry) => ({
      state: 'assessed', entryId: entry.id, tools: entry.tools.map((tool) => ({ name: tool.name, verdict: 'ok' })),
    })),
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'fetcher')),
});

const definitionFor = (name, deps, entries) => {
  const catalogue = entries || [ENTRY];
  const definition = hostedToolDefinitions(catalogue, deps).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`no definition for ${name}`);
  return definition;
};

const expectRefusal = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('hosted-MCP tool definitions', () => {
  it('initializes and carries the negotiated session through tools/list and tools/call', async () => {
    let nextSession = 0;
    const initialized = new Set();
    const calls = [];
    const fetcher = jest.fn(async (_url, init) => {
      const session = init.headers['Mcp-Session-Id'];
      if (init.method === 'DELETE') {
        expect(initialized.has(session)).toBe(true);
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, session, version: init.headers['MCP-Protocol-Version'] });
      if (body.method === 'initialize') {
        expect(session).toBeUndefined();
        expect(body.params).toMatchObject({ protocolVersion: '2025-11-25', capabilities: {} });
        nextSession += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
        } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `s-${nextSession}` } });
      }
      if (!session || init.headers['MCP-Protocol-Version'] !== '2025-06-18') {
        return jsonResponse({ error: { code: -32000 } }, 400);
      }
      if (body.method === 'notifications/initialized') {
        initialized.add(session);
        return new Response(null, { status: 202 });
      }
      if (!initialized.has(session)) return jsonResponse({ error: { code: -32000 } }, 400);
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
        tools: [{ name: 'list_issues', inputSchema: ENTRY.tools[0].inputSchema }],
      } });
      if (body.method === 'tools/call') return jsonResponse(okReply);
      throw new Error(`unexpected ${body.method}`);
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).resolves.toEqual(okReply.result);
    expect(calls.map(({ method }) => method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list',
      'initialize', 'notifications/initialized', 'tools/call',
    ]);
    expect(calls[2].session).toBe('s-1');
    expect(calls[5].session).toBe('s-2');
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(2);
  });

  it('records a tools/list JSON-RPC code without logging a token or vendor body', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse({
        jsonrpc: '2.0', id: 'call-1', error: { code: -32002, message: 'secret vendor detail' },
      })) });
      deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
      await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'provider_error');
      const logged = warning.mock.calls.map(([value]) => String(value)).join(' ');
      expect(logged).toContain('"rpcCode":-32002');
      expect(logged).not.toContain('access-token-1');
      expect(logged).not.toContain('secret vendor detail');
    } finally {
      warning.mockRestore();
    }
  });

  it('opens a fresh session after the vendor expires one before tools/list', async () => {
    let opened = 0;
    let listed = 0;
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        expect(init.headers['Mcp-Session-Id']).toBeUndefined();
        opened += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' },
        } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `s-${opened}` } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') {
        listed += 1;
        if (listed === 1) return jsonResponse({}, 404);
        expect(init.headers['Mcp-Session-Id']).toBe('s-2');
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
          tools: [{ name: 'list_issues', inputSchema: ENTRY.tools[0].inputSchema }],
        } });
      }
      throw new Error(`unexpected ${body.method}`);
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expect(deps.driftCache.assess({ connectionId: ROW_ID }, ENTRY))
      .resolves.toMatchObject({ state: 'assessed' });
    expect(opened).toBe(2);
    expect(listed).toBe(2);
  });

  it('uses the negotiated version without a session ID when the server assigns none', async () => {
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') throw new Error('sessionless servers have no DELETE');
      const body = JSON.parse(init.body);
      expect(init.headers['Mcp-Session-Id']).toBeUndefined();
      if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'sessionless', version: '1' },
      } });
      expect(init.headers['MCP-Protocol-Version']).toBe('2025-06-18');
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
        tools: [{ name: 'list_issues', inputSchema: ENTRY.tools[0].inputSchema }],
      } });
      if (body.method === 'tools/call') return jsonResponse(okReply);
      throw new Error(`unexpected ${body.method}`);
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).resolves.toEqual(okReply.result);
  });

  it('refuses a second 404 rather than reinitializing again', async () => {
    let opened = 0;
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        opened += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' },
        } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `s-${opened}` } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({}, 404);
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'provider_error');
    expect(opened).toBe(2);
  });

  it.each(['list', 'call'])('renews once when initialized notification gets a session-bound 404 on %s', async (path) => {
    let opened = 0;
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        expect(init.headers['Mcp-Session-Id']).toBeUndefined();
        opened += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' },
        } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `s-${opened}` } });
      }
      if (body.method === 'notifications/initialized') {
        expect(init.headers['Mcp-Session-Id']).toBe(`s-${opened}`);
        return new Response(null, { status: opened === 1 ? 404 : 202 });
      }
      expect(init.headers['Mcp-Session-Id']).toBe('s-2');
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
        tools: [{ name: 'list_issues', inputSchema: ENTRY.tools[0].inputSchema }],
      } });
      if (body.method === 'tools/call') return jsonResponse(okReply);
      throw new Error(`unexpected ${body.method}`);
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    if (path === 'list') {
      deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
      await expect(deps.driftCache.assess({ connectionId: ROW_ID }, ENTRY))
        .resolves.toMatchObject({ state: 'assessed' });
    } else {
      await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).resolves.toEqual(okReply.result);
    }
    expect(opened).toBe(2);
  });

  it('does not keep renewing a notification that returns 404 twice', async () => {
    let opened = 0;
    const fetcher = jest.fn(async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        opened += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' },
        } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': `s-${opened}` } });
      }
      return new Response(null, { status: 404 });
    });
    const deps = makeDeps();
    deps.fetcher = fetcher;
    await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'provider_error');
    expect(opened).toBe(2);
  });

  it('carries a bounded vendor 400 line to the broker without its token or body', async () => {
    const deps = makeDeps({ fetcher: jest.fn(async () => new Response(
      'session required: access-token-1 vendor-secret-12345678901234567890\nprivate second line',
      { status: 400, headers: { 'content-type': 'text/plain' } },
    )) });
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).rejects.toMatchObject({
      code: 'provider_error',
      details: { vendorStatus: 400, vendorError: 'session required: [redacted] [redacted]' },
    });
  });

  it('does not keep a JSON error body containing short quoted credential values', async () => {
    const body = JSON.stringify({
      access_token: 'SECOND_ACCESS_SENTINEL', refresh_token: 'REFRESH_SENTINEL',
      client_secret: 'CLIENT_SECRET_SENTINEL',
    });
    const deps = makeDeps({ fetcher: jest.fn(async () => new Response(body, {
      status: 400, headers: { 'content-type': 'application/json' },
    })) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).rejects.toMatchObject({
      code: 'provider_error', details: { vendorStatus: 400 },
    });
    try {
      await definitionFor('linear.list_issues', deps).call({}, CONNECTION);
    } catch (error) {
      expect(JSON.stringify(error.details)).not.toContain('SENTINEL');
      expect(error.details.vendorError).toBeUndefined();
    }
  });

  it('redacts short quoted credentials inside a selected JSON-RPC error message', async () => {
    const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse({
      jsonrpc: '2.0', id: 'call-1', error: {
        code: -32000,
        message: 'session failed: {"access_token":"SHORT","client_secret":"TINY"}',
      },
    }, 400)) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).rejects.toMatchObject({
      code: 'provider_error',
      details: { vendorStatus: 400,
        vendorError: 'JSON-RPC -32000: session failed: {access_token=[redacted],client_secret=[redacted]}' },
    });
  });

  it('refuses a drifted pin inside callHostedTool before tools/call', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => jsonResponse({
        jsonrpc: '2.0', id: 'list-1', result: { tools: [{
          name: 'list_issues',
          inputSchema: { type: 'object', properties: { extra: { type: 'string' } } },
        }] },
      })),
    });
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'tool_drift');
    expect(toolCalls(deps)).toHaveLength(1);
    expect(JSON.parse(toolCalls(deps)[0][1].body).method).toBe('tools/list');
  });

  it('reads every tools/list page before deciding a pinned tool is missing', async () => {
    const deps = makeDeps();
    deps.fetcher = sessionFetcher(jest.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'tools/call') return jsonResponse(okReply);
      if (!body.params.cursor) return jsonResponse({
        jsonrpc: '2.0', id: 'list-1', result: { tools: [], nextCursor: 'page-2' },
      });
      return jsonResponse({
        jsonrpc: '2.0', id: 'list-2', result: { tools: [{
          name: 'list_issues', inputSchema: ENTRY.tools[0].inputSchema,
        }] },
      });
    }));
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).resolves.toEqual(okReply.result);
    const methods = toolCalls(deps).map(([, init]) => JSON.parse(init.body).method);
    expect(methods).toEqual(['tools/list', 'tools/list', 'tools/call']);
    expect(JSON.parse(toolCalls(deps)[1][1].body).params.cursor).toBe('page-2');
  });

  it('classifies malformed tools/list JSON as a vendor error before tools/call', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => new Response('{', {
        status: 200, headers: { 'content-type': 'application/json' },
      })),
    });
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [ENTRY]);
    await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'provider_error');
    expect(toolCalls(deps)).toHaveLength(1);
    expect(JSON.parse(toolCalls(deps)[0][1].body).method).toBe('tools/list');
  });

  it('offers nothing when the catalogue is empty, and one definition per pinned tool otherwise', () => {
    expect(hostedToolDefinitions([], makeDeps())).toHaveLength(0);
    const definitions = hostedToolDefinitions([ENTRY], makeDeps());
    expect(definitions.map((definition) => definition.name)).toEqual(['linear.list_issues', 'linear.create_issue']);
  });

  it('takes name, description, write mode and schema from the projection rather than rebuilding them', () => {
    const definitions = hostedToolDefinitions([ENTRY], makeDeps());
    const read = definitions[0];
    const write = definitions[1];
    // Literals, not `entryToolProjections(...)` calls: an expectation computed
    // from the function under test moves with a defect in it.
    expect(read.description).toBe('List issues');
    expect(read.requiredWriteMode).toBe('read');
    expect(read.connectionType).toBe('hosted-mcp');
    expect(read.entryId).toBe('linear');
    expect(read.inputSchema).toEqual({ type: 'object', properties: { limit: { type: 'number' } } });
    expect(typeof read.call).toBe('function');
    // A write is `write-with-confirm`, which is also why a hosted grant can
    // never run one unattended: the mint refuses a full `write` on this type.
    expect(write.requiredWriteMode).toBe('write-with-confirm');
    expect(write.irreversible).toBe(true);
  });

  it('namespaces the tool so two entries, or an entry and GitHub, cannot collide', () => {
    const other = { ...ENTRY, id: 'sentry', tools: [{ ...ENTRY.tools[0] }] };
    const names = hostedToolDefinitions([ENTRY, other], makeDeps()).map((definition) => definition.name);
    expect(names).toEqual(['linear.list_issues', 'linear.create_issue', 'sentry.list_issues']);
    expect(findHostedToolDefinition('sentry.list_issues', [ENTRY, other], makeDeps())?.entryId).toBe('sentry');
    expect(findHostedToolDefinition('github.list_issues', [ENTRY, other], makeDeps())).toBeUndefined();
  });

  it('posts one JSON-RPC tools/call to the entry resource, carrying the credential as a bearer token', async () => {
    const deps = makeDeps();
    const fetchMock = deps.fetcher;
    const definition = definitionFor('linear.list_issues', deps);
    const result = await definition.call({ limit: 5 }, CONNECTION);

    expect(toolCalls(deps)).toHaveLength(1);
    const [url, init] = toolCalls(deps)[0];
    expect(url).toBe('https://mcp.linear.app/mcp');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer access-token-1');
    expect(init.headers.Accept).toBe('application/json, text/event-stream');
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 5 } },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('posts Airtable tools/call to /mcp while OAuth names the origin', async () => {
    const deps = makeDeps();
    expect(AIRTABLE_ENTRY.audience).toBe('https://mcp.airtable.com');
    await definitionFor('airtable.ping', deps, [AIRTABLE_ENTRY]).call({}, {
      ...CONNECTION, entryId: 'airtable',
    });
    expect(deps.fetcher).toHaveBeenCalledWith(
      'https://mcp.airtable.com/mcp', expect.objectContaining({ method: 'POST' }),
    );
  });

  it('a row minted under another client is refused reconnect_required before any call', async () => {
    const deps = makeDeps({
      credentialFor: jest.fn(async () => {
        throw Object.assign(new Error('OAuth client changed; reconnect to continue'), {
          code: 'reconnect_required',
        });
      }),
    });

    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .rejects.toMatchObject({ code: 'reconnect_required', statusCode: 403 });
    expect(deps.credentialFor).toHaveBeenCalledTimes(1);
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it('calls the vendor name the pin recorded, not the name the agent sees', async () => {
    const deps = makeDeps();
    const definition = definitionFor('linear.create_issue', deps);
    await definition.call({}, CONNECTION).catch(() => {});
    expect(JSON.parse(toolCalls(deps)[0][1].body).params.name).toBe('createIssue');
  });

  it('fetches the credential per call, for the row the connection names', async () => {
    const deps = makeDeps();
    const row = {
      _id: ROW_ID, type: 'hosted-mcp', status: 'connected', config: { entryId: 'linear' }, 
    };
    deps.loadRow.mockResolvedValue(row);
    await definitionFor('linear.list_issues', deps).call({}, CONNECTION);
    expect(deps.loadRow).toHaveBeenCalledWith(ROW_ID);
    expect(deps.credentialFor).toHaveBeenCalledWith(row);
  });

  it('reads a JSON-RPC reply out of an SSE stream', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => sseResponse([
        'event: message',
        `data: ${JSON.stringify(okReply)}`,
        '',
      ])),
    });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns an SSE reply before the vendor closes the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(okReply)}\n`));
      },
      cancel() { cancelled = true; },
    });
    const deps = makeDeps({ fetcher: jest.fn(async () => new Response(stream, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION)).resolves.toEqual(okReply.result);
    expect(cancelled).toBe(true);
  });

  it('skips SSE frames that are not the reply, and refuses a stream that never carries one', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => sseResponse([
        'data: not json at all',
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
        `data: ${JSON.stringify(okReply)}`,
      ])),
    });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });

    const quiet = makeDeps({ fetcher: jest.fn(async () => sseResponse(['data: {"jsonrpc":"2.0"}'])) });
    await expectRefusal(definitionFor('linear.list_issues', quiet).call({}, CONNECTION), 'provider_error');
  });

  it('returns the vendor\'s tool-level failure as a result instead of throwing it', async () => {
    const failed = {
      jsonrpc: '2.0',
      id: 'call-1',
      result: { isError: true, content: [{ type: 'text', text: 'issue not found' }] },
    };
    const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse(failed)) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .resolves.toEqual({ isError: true, content: [{ type: 'text', text: 'issue not found' }] });
  });

  it('refuses a JSON-RPC error reply with the vendor\'s own message', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => jsonResponse({
        jsonrpc: '2.0', id: 'call-1', error: { code: -32602, message: 'bad arguments' },
      })),
    });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('bad arguments') });
  });

  it('refuses a 200 body that carries neither a result nor an error', async () => {
    const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 'call-1' })) });
    await expectRefusal(definitionFor('linear.list_issues', deps).call({}, CONNECTION), 'provider_error');
  });

  it('treats a vendor 401 or 403 as the credential being gone, and says so', async () => {
    // Unrolled rather than looped: a loop would need `await` inside it, and the
    // two statuses are two facts, not a parameterised one.
    const refusalFor = async (status) => {
      const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse({}, status)) });
      await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
        .rejects.toMatchObject({
          code: 'credential_rejected',
          message: expect.stringContaining('reconnect'),
        });
      // The credential was read before the call, so the token — not the ref —
      // was refused by the vendor.
      expect(deps.credentialFor).toHaveBeenCalledTimes(1);
    };
    await refusalFor(401);
    await refusalFor(403);
  });

  it('refuses any other non-2xx answer as a provider error carrying the status', async () => {
    const deps = makeDeps({ fetcher: jest.fn(async () => jsonResponse({}, 503)) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('503') });
  });

  it('refuses an unreachable vendor without leaking the transport error as a crash', async () => {
    const deps = makeDeps({
      fetcher: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
    });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .rejects.toMatchObject({ code: 'provider_unreachable', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('refuses when the connection names another entry, before spending a credential', async () => {
    const deps = makeDeps();
    await expect(definitionFor('linear.list_issues', deps).call({}, { ...CONNECTION, entryId: 'sentry' }))
      .rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(deps.credentialFor).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it('refuses a non-hosted connection rather than reading fields that are not there', async () => {
    const deps = makeDeps();
    await expect(definitionFor('linear.list_issues', deps).call({}, {
      type: 'github-app', installationId: '1', owner: 'o', repo: 'r',
    })).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(deps.credentialFor).not.toHaveBeenCalled();
  });

  it('refuses a connection whose row no longer exists, before spending a credential', async () => {
    const deps = makeDeps({ loadRow: jest.fn(async () => null) });
    await expect(definitionFor('linear.list_issues', deps).call({}, CONNECTION))
      .rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(deps.credentialFor).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it('bounds the call so a silent vendor cannot hold a seat\'s turn open', async () => {
    expect(HOSTED_MCP_CALL_TIMEOUT_MS).toBe(30 * 1000);
    const deps = makeDeps();
    await definitionFor('linear.list_issues', deps).call({}, CONNECTION);
    expect(toolCalls(deps)[0][1].signal).toBeDefined();
  });
});

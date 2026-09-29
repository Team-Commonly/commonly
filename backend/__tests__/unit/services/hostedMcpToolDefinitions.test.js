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
  hostedToolDefinitions,
  findHostedToolDefinition,
} = require('../../../services/hostedMcpToolDefinitions');

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

const makeDeps = (overrides = {}) => ({
  fetcher: jest.fn(async () => jsonResponse(okReply)),
  loadRow: jest.fn(async () => ({
    _id: ROW_ID,
    type: 'hosted-mcp',
    status: 'connected',
    config: { entryId: 'linear', credentialRef: 'cred-1' },
  })),
  credentialFor: jest.fn(async () => ({ token: 'access-token-1' })),
  newCallId: () => 'call-1',
  ...overrides,
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
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

  it('calls the vendor name the pin recorded, not the name the agent sees', async () => {
    const deps = makeDeps();
    const definition = definitionFor('linear.create_issue', deps);
    await definition.call({}, CONNECTION).catch(() => {});
    expect(JSON.parse(deps.fetcher.mock.calls[0][1].body).params.name).toBe('createIssue');
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
    expect(deps.fetcher.mock.calls[0][1].signal).toBeDefined();
  });
});

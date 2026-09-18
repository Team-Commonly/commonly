// The baseline an mcp-consuming wrapper seat gets when its environment
// declares no commonly server (TASK-048).
import {
  ADAPTERS_WITH_DEFAULT_MCP,
  COMMONLY_MCP_SERVER_NAME,
  commonlyMcpServer,
  defaultMcpServers,
  withDefaultMcpServer,
} from '../src/lib/default-environment.js';

describe('defaultMcpServers', () => {
  test.each(['claude', 'codex', 'pi'])('hands %s the commonly server', (adapterName) => {
    expect(defaultMcpServers(adapterName)).toEqual([commonlyMcpServer()]);
  });

  test('hands an adapter with no consumption path nothing', () => {
    expect(defaultMcpServers('stub')).toEqual([]);
    expect(defaultMcpServers(undefined)).toEqual([]);
  });

  test('the declaration carries placeholders, never a secret', () => {
    const [server] = defaultMcpServers('claude');
    expect(server.env).toEqual({
      COMMONLY_API_URL: '${COMMONLY_API_URL}',
      COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
    });
  });

  test('ADAPTERS_WITH_DEFAULT_MCP matches the adapters this test names', () => {
    expect([...ADAPTERS_WITH_DEFAULT_MCP].sort()).toEqual(['claude', 'codex', 'pi']);
  });
});

describe('withDefaultMcpServer', () => {
  test('creates the declaration when the environment is absent', () => {
    expect(withDefaultMcpServer(null, 'pi')).toEqual({ mcp: [commonlyMcpServer()] });
    expect(withDefaultMcpServer(undefined, 'claude')).toEqual({ mcp: [commonlyMcpServer()] });
  });

  test('adds the declaration to an environment that has none, keeping its other facets', () => {
    const environment = { model: 'deepseek-v4-flash', effort: 'high' };
    expect(withDefaultMcpServer(environment, 'pi')).toEqual({
      ...environment,
      mcp: [commonlyMcpServer()],
    });
  });

  test('appends after declared servers — a url-only grant broker is not the kernel server', () => {
    const environment = { mcp: [{ name: 'room-grants', transport: 'http' }] };
    const next = withDefaultMcpServer(environment, 'claude');
    expect(next.mcp.map((server) => server.name)).toEqual(['room-grants', COMMONLY_MCP_SERVER_NAME]);
  });

  test('never duplicates or replaces a declared commonly entry', () => {
    const handSet = { name: 'commonly', command: ['node', '/opt/commonly/mcp-staging/src/index.js'] };
    const environment = { mcp: [handSet] };
    const next = withDefaultMcpServer(environment, 'claude');
    expect(next).toBe(environment);
    expect(next.mcp).toEqual([handSet]);
  });

  test('returns the same reference when nothing changes, so callers can dirty-check', () => {
    const declared = { mcp: [commonlyMcpServer()] };
    expect(withDefaultMcpServer(declared, 'pi')).toBe(declared);
    const stub = { model: 'x' };
    expect(withDefaultMcpServer(stub, 'stub')).toBe(stub);
    expect(withDefaultMcpServer(stub, undefined)).toBe(stub);
  });

  test('does not invent a declaration for an adapter that cannot consume one', () => {
    expect(withDefaultMcpServer(null, 'stub')).toBeNull();
    expect(withDefaultMcpServer({ model: 'x' }, 'stub')).toEqual({ model: 'x' });
  });

  test('leaves a malformed environment alone rather than repairing it', () => {
    expect(withDefaultMcpServer('nonsense', 'claude')).toBe('nonsense');
    expect(withDefaultMcpServer([1, 2], 'claude')).toEqual([1, 2]);
  });

  test('is idempotent', () => {
    const once = withDefaultMcpServer({ model: 'x' }, 'codex');
    expect(withDefaultMcpServer(once, 'codex')).toBe(once);
  });
});

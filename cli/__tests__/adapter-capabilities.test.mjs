import { getAdapter, listAdapterNames } from '../src/lib/adapters/index.js';
import {
  ADAPTERS_WITH_DEFAULT_MCP,
  ADAPTERS_WITH_DEFAULT_SANDBOX,
  ADAPTERS_WITH_GRANT_BROKER,
} from '../src/lib/default-environment.js';

// Every shipped adapter appears here. In particular, pi consumes MCP but
// cannot enforce the default sandbox; provider support alone grants neither.
const expected = {
  stub: { sandbox: false, mcp: false, broker: false, provider: false },
  claude: { sandbox: true, mcp: true, broker: true, provider: false },
  codex: { sandbox: true, mcp: true, broker: true, provider: false },
  pi: { sandbox: false, mcp: true, broker: false, provider: false },
  opencode: { sandbox: true, mcp: true, broker: false, provider: true },
  qwen: { sandbox: true, mcp: true, broker: false, provider: true },
  dsh: { sandbox: false, mcp: true, broker: false, provider: true },
  goose: { sandbox: false, mcp: true, broker: false, provider: true },
  hermes: { sandbox: false, mcp: false, broker: false, provider: false },
  grok: { sandbox: false, mcp: true, broker: false, provider: false },
};

test('every adapter has an explicit capability matrix entry', () => {
  expect([...listAdapterNames()].sort()).toEqual(Object.keys(expected).sort());
  for (const [name, capabilities] of Object.entries(expected)) {
    expect({
      sandbox: ADAPTERS_WITH_DEFAULT_SANDBOX.has(name),
      mcp: ADAPTERS_WITH_DEFAULT_MCP.has(name),
      broker: ADAPTERS_WITH_GRANT_BROKER.has(name),
      provider: getAdapter(name)?.supportsProvider === true,
    }).toEqual(capabilities);
  }
});

test('unknown adapters get no default capability', () => {
  expect(getAdapter('unknown')).toBeNull();
  expect(ADAPTERS_WITH_DEFAULT_SANDBOX.has('unknown')).toBe(false);
  expect(ADAPTERS_WITH_DEFAULT_MCP.has('unknown')).toBe(false);
  expect(ADAPTERS_WITH_GRANT_BROKER.has('unknown')).toBe(false);
});

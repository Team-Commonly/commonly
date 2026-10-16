/**
 * ADR-020 D1 — the manifest tool allowlist is ENFORCED, not decorative.
 *
 * Before toolsForConfig, TOOLS went unfiltered to every native agent and
 * each definition's `tools` list was documentation. Now: a declared list
 * filters exactly; an undeclared (legacy) config keeps the pre-gate surface
 * MINUS approval proposing, which is opt-in by declaration only.
 */
const { toolsForConfig, TOOLS } = require('../../../services/nativeRuntimeService');
const { hostedCaps } = require('../../../services/hostedRuntimeService');

const names = (tools) => tools.map((t) => t.function.name);

// Runs fn with these env vars set (undefined deletes), then restores them.
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    Object.entries(vars).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    return fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
};
const NATIVE_HOSTING = { HOSTED_ENGINE: 'native', LITELLM_BASE_URL: 'http://litellm.test', LITELLM_MASTER_KEY: 'k' };
const NO_HOSTING = {
  HOSTED_ENGINE: undefined,
  HOSTED_RUNTIME_URL: undefined,
  HOSTED_RUNTIME_ADMIN_TOKEN: undefined,
  LITELLM_BASE_URL: undefined,
  LITELLM_MASTER_KEY: undefined,
  LITELLM_API_KEY: undefined,
};

describe('toolsForConfig', () => {
  test('a declared allowlist filters exactly', () => {
    const tools = toolsForConfig({ tools: ['commonly_post_message', 'commonly_propose_action'] });
    expect(names(tools).sort()).toEqual(['commonly_post_message', 'commonly_propose_action']);
  });

  test('legacy configs without a tool list never see propose_action', () => {
    for (const cfg of [null, undefined, {}, { tools: 'not-an-array' }]) {
      const tools = toolsForConfig(cfg);
      expect(names(tools)).not.toContain('commonly_propose_action');
      // ...but keep the pre-gate surface working (back-compat).
      expect(names(tools)).toContain('commonly_post_message');
      expect(names(tools)).toContain('commonly_read_context');
    }
  });

  test('the scout manifest grants propose_action', () => {
    // eslint-disable-next-line global-require
    const { scoutApp } = require('../../../config/native-agents/scout');
    // On an instance that can host, so the hosted offer is offered too.
    const tools = withEnv(NATIVE_HOSTING, () => toolsForConfig({ tools: [...scoutApp.tools] }));
    expect(names(tools)).toContain('commonly_propose_action');
    // The manifest and the runtime's schema must agree — a declared tool with
    // no schema would silently vanish here.
    expect(tools.length).toBe(scoutApp.tools.length);
  });

  test('the hosted offer is opt-in, and offered only where the instance can host', () => {
    const declared = { tools: ['commonly_offer_hosted_agent'] };
    withEnv(NO_HOSTING, () => {
      expect(names(toolsForConfig(declared))).not.toContain('commonly_offer_hosted_agent');
    });
    withEnv(NATIVE_HOSTING, () => {
      expect(names(toolsForConfig(declared))).toContain('commonly_offer_hosted_agent');
      // Never on the default surface, even where hosting works.
      expect(names(toolsForConfig({}))).not.toContain('commonly_offer_hosted_agent');
      expect(names(toolsForConfig({ tools: ['commonly_post_message'] }))).not.toContain('commonly_offer_hosted_agent');
    });
    // The Durable Object engine counts when its worker is configured.
    withEnv({ ...NO_HOSTING, HOSTED_RUNTIME_URL: 'https://worker.test', HOSTED_RUNTIME_ADMIN_TOKEN: 't' }, () => {
      expect(names(toolsForConfig(declared))).toContain('commonly_offer_hosted_agent');
    });
  });

  // Scout told strangers "200 turns a day" after the free line became 30
  // (#2237): the number lived in a copy. The offer's description is built from
  // the cap source, so the model is told the line the meter enforces.
  test('the hosted offer states the limits the meter enforces', () => {
    const offer = TOOLS.find((t) => t.function.name === 'commonly_offer_hosted_agent');
    const free = hostedCaps();
    const pro = hostedCaps({ pro: true });
    expect(offer.function.description).toContain(`${free.turnsPerDay} turns a day (${pro.turnsPerDay} on Pro)`);
    expect(offer.function.description).toContain(`${free.agentsPerUser} hosted agent${free.agentsPerUser === 1 ? '' : 's'} per account`);
    expect(offer.function.description).toMatch(/no invitation code/);
  });

  // Sprint Review on #2250: the arm above compares the description with
  // hostedCaps(), the source it is built from, so a hardcoded literal matching
  // today's caps passes it too. Loaded under other caps, only a description
  // derived from the cap source follows.
  test('the hosted offer follows the cap source, so it cannot be a copied literal', () => {
    const caps = { HOSTED_TURNS_PER_DAY: '7', HOSTED_TURNS_PER_DAY_PRO: '70', HOSTED_AGENTS_PER_USER: '2' };
    withEnv(caps, () => {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        const { TOOLS: reloaded } = require('../../../services/nativeRuntimeService');
        const offer = reloaded.find((t) => t.function.name === 'commonly_offer_hosted_agent');
        expect(offer.function.description).toContain('2 hosted agents per account and 7 turns a day (70 on Pro)');
      });
    });
  });

  test('agent_status is declaration-gated like every other tool', () => {
    // Scout declares it; a legacy config or a minimal allowlist does not
    // receive it implicitly.
    // eslint-disable-next-line global-require
    const { scoutApp } = require('../../../config/native-agents/scout');
    expect(names(toolsForConfig({ tools: [...scoutApp.tools] }))).toContain('commonly_agent_status');
    expect(names(toolsForConfig({ tools: ['commonly_post_message'] }))).not.toContain('commonly_agent_status');
  });

  test('the propose_action schema teaches both action types', () => {
    // The enum in the tool schema is what the model sees — if the schema
    // lags the service's KNOWN_ACTION_TYPES, Scout can never propose the
    // new action no matter what the prompt says.
    const tools = toolsForConfig({ tools: ['commonly_propose_action'] });
    const schema = tools[0].function.parameters.properties.actionType;
    expect(schema.enum.sort()).toEqual(['connect_local_agent', 'create_pod']);
  });

  // TASK-266: running code is opt-in by declaration AND needs a sandbox key.
  test('run_code is offered only when declared and the instance has a sandbox key', () => {
    const previous = process.env.E2B_API_KEY;
    try {
      delete process.env.E2B_API_KEY;
      expect(names(toolsForConfig({ tools: ['commonly_run_code'] }))).not.toContain('commonly_run_code');
      process.env.E2B_API_KEY = 'e2b_test_key';
      expect(names(toolsForConfig({ tools: ['commonly_run_code'] }))).toContain('commonly_run_code');
      // Never on the default surface, even with the key.
      expect(names(toolsForConfig({}))).not.toContain('commonly_run_code');
      expect(names(toolsForConfig({ tools: ['commonly_post_message'] }))).not.toContain('commonly_run_code');
    } finally {
      if (previous === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previous;
    }
  });

  // TASK-267a: web search is opt-in by declaration AND needs a search key.
  test('web_search is offered only when declared and the instance has a search key', () => {
    const previous = process.env.SEARCH_API_KEY;
    try {
      delete process.env.SEARCH_API_KEY;
      expect(names(toolsForConfig({ tools: ['commonly_web_search'] }))).not.toContain('commonly_web_search');
      process.env.SEARCH_API_KEY = 'search_test_key';
      expect(names(toolsForConfig({ tools: ['commonly_web_search'] }))).toContain('commonly_web_search');
      // Never on the default surface, even with the key.
      expect(names(toolsForConfig({}))).not.toContain('commonly_web_search');
      expect(names(toolsForConfig({ tools: ['commonly_post_message'] }))).not.toContain('commonly_web_search');
    } finally {
      if (previous === undefined) delete process.env.SEARCH_API_KEY;
      else process.env.SEARCH_API_KEY = previous;
    }
  });
});

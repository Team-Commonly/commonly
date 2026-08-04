// @ts-nocheck
// The two facts `POST /memory/sync` relies on when it reports `cyclesAppended`.
//
// The route used to hardcode `cyclesAppended: true` in its cycles-only branch.
// If `appendCycle` ever returns null there, that answer is
// `{ok, schemaVersion:2, cyclesAppended:true}` with no mutation flags — which
// is byte-identical to a backend that predates the flags (see AX audit #8), so
// a caller cannot tell "rejected" from "old server" from "stored fine".
//
// Deliberately NOT importing ../utils/testUtils: both early returns below fire
// before any DB access, and testUtils pulls jsonwebtoken, which cannot load on
// Node 26 locally (see the node26-jsonwebtoken memory). Keeping this suite
// dependency-free is what makes it runnable outside CI.

const {
  appendCycle,
  describeCycleMutation,
} = require('../../../services/agentMemoryService');

describe('cyclesAppended must be derived from the append result', () => {
  it('appendCycle returns null for empty and whitespace-only content', async () => {
    for (const content of ['', '   ', '\n\t ']) {
      // eslint-disable-next-line no-await-in-loop
      const result = await appendCycle({ agentName: 'openclaw', instanceId: 'nova', content });
      expect(result).toBeNull();
    }
  });

  it('appendCycle returns null when the identity is incomplete', async () => {
    expect(await appendCycle({ agentName: '', instanceId: 'nova', content: 'x' })).toBeNull();
    expect(await appendCycle({ agentName: 'openclaw', instanceId: '', content: 'x' })).toBeNull();
  });

  it('describeCycleMutation reports nothing at all for a null result', () => {
    // This is why a hardcoded `cyclesAppended: true` is unrecoverable rather
    // than merely wrong: the flags that would contradict it are also absent.
    expect(describeCycleMutation(null)).toEqual({});
    expect(describeCycleMutation(undefined)).toEqual({});
  });

  it('a rejected append and a stored append are distinguishable only via the result', () => {
    // The property the route's `!!cycleResult` depends on. Stated as an
    // assertion so a future refactor that makes describeCycleMutation emit
    // flags for null — closing the gap a different way — fails here loudly
    // instead of silently making the route's derivation redundant.
    const stored = {
      truncated: false, evicted: false, storedChars: 12, submittedChars: 12, retainedEntries: 1,
    };
    expect(Object.keys(describeCycleMutation(stored)).length).toBeGreaterThan(0);
    expect(Object.keys(describeCycleMutation(null)).length).toBe(0);
  });
});

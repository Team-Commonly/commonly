/**
 * agentStateService.deriveAgentState — #891 surface 1's honesty rules, pure.
 *
 * Contract under test (each rule earned by a measured review finding):
 *  - BYO installs derive from lastListenedAt: null → never-connected,
 *    fresh → listening, stale → gone-dark
 *  - the union of BOTH token stores decides (finding D: legacy/new split
 *    made live agents read null)
 *  - native installs are 'reachable' by construction; a push webhook is
 *    measured by its last delivery to the URL registered now
 *  - gateway/cloud classes are 'unknown' — never guessed (finding A)
 *  - fixCommand attaches ONLY for the owner, only in fixable states
 *    (split key: instructions to someone who can't perform them are the
 *    P1/P2 contradiction)
 */

const {
  deriveAgentState, offersConnect, AGENT_LISTENING_STALE_MS, webhookUrlHash, WEBHOOK_RUN_INSTRUCTION,
} = require('../../../services/agentStateService');

const NOW = 1_700_000_000_000;

const byoInstall = (overrides = {}) => ({
  agentName: 'sam-agent',
  instanceId: 'default',
  displayName: 'Sam Agent',
  installedBy: 'owner-1',
  config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
  runtimeTokens: [],
  ...overrides,
});

describe('offersConnect', () => {
  it('offers Connect to a BYO agent', () => {
    expect(offersConnect(byoInstall())).toBe(true);
  });

  it('holds it back from what Bring your own cannot connect', () => {
    expect(offersConnect(byoInstall({ config: { runtime: { runtimeType: 'wrapper', host: 'byo' } } }))).toBe(false);
    expect(offersConnect(byoInstall(), 'machine-1')).toBe(false);
    expect(offersConnect(byoInstall({ instanceId: 'nova' }))).toBe(false);
  });

  it('holds it back from a push webhook and a native agent, which have nothing to connect', () => {
    expect(offersConnect(byoInstall({
      config: { runtime: { runtimeType: 'webhook', webhookUrl: 'https://example.test/hook' } },
    }))).toBe(false);
    expect(offersConnect(byoInstall({ config: { runtime: { runtimeType: 'native' } } }))).toBe(false);
  });
});

describe('deriveAgentState', () => {
  test('BYO with no token use anywhere → never-connected, owner gets the fix command', () => {
    const row = deriveAgentState(byoInstall(), [], 'owner-1', NOW);
    expect(row.state).toBe('never-connected');
    expect(row.fixCommand).toBe('commonly agent run sam-agent');
  });

  test('the same state seen by a NON-owner carries the explanation but no instruction', () => {
    const row = deriveAgentState(byoInstall(), [], 'someone-else', NOW);
    expect(row.state).toBe('never-connected');
    expect(row.isOwner).toBe(false);
    expect(row.fixCommand).toBeUndefined();
  });

  test('fresh use on the INSTALLATION token store → listening', () => {
    const row = deriveAgentState(
      byoInstall({ runtimeTokens: [{ lastListenedAt: new Date(NOW - 10_000) }] }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('listening');
    expect(row.fixCommand).toBeUndefined(); // nothing to fix
  });

  test('fresh use on the USER token store alone also counts — the union decides (finding D)', () => {
    const row = deriveAgentState(
      byoInstall(),
      [{ lastListenedAt: new Date(NOW - 10_000) }],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('listening');
  });

  test('a live legacy BYO seat without a host stamp is listening, then gone-dark when stopped', () => {
    const installation = byoInstall({
      config: { runtime: { runtimeType: 'webhook' } },
    });
    const live = deriveAgentState(
      installation,
      [{ lastListenedAt: new Date(NOW - 10_000) }],
      'owner-1',
      NOW,
    );
    expect(live.state).toBe('listening');

    const stopped = deriveAgentState(
      installation,
      [{ lastListenedAt: new Date(NOW - AGENT_LISTENING_STALE_MS - 1000) }],
      'owner-1',
      NOW,
    );
    expect(stopped.state).toBe('gone-dark');
  });

  test('an MCP tool call alone is not listening: a fresh lastUsedAt with no check-in is never-connected', () => {
    const row = deriveAgentState(
      byoInstall({ runtimeTokens: [{ lastUsedAt: new Date(NOW - 10_000) }] }),
      [{ lastUsedAt: new Date(NOW - 10_000) }],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('never-connected');
    expect(row.lastUsedAt).toBeNull();
    expect(row.fixCommand).toBe('commonly agent run sam-agent');
  });

  test('a check-in still decides over a later MCP call: listening, and lastUsedAt reports the check-in', () => {
    const checkIn = new Date(NOW - 20_000);
    const row = deriveAgentState(
      byoInstall(),
      [{ lastUsedAt: new Date(NOW - 1_000), lastListenedAt: checkIn }],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('listening');
    expect(row.lastUsedAt).toBe(checkIn.toISOString());
  });

  test('an old seat after the backfill (lastListenedAt = lastUsedAt) keeps its verdict instead of flipping to never-connected', () => {
    const lastSeen = new Date(NOW - 3 * 24 * 60 * 60 * 1000);
    const before = deriveAgentState(byoInstall(), [{ lastUsedAt: lastSeen }], 'owner-1', NOW);
    const after = deriveAgentState(
      byoInstall(),
      [{ lastUsedAt: lastSeen, lastListenedAt: lastSeen }],
      'owner-1',
      NOW,
    );
    // Without the backfill the deploy would read this seat as never-connected,
    // and the stalled-connect scan would nudge a room that has long been quiet.
    expect(before.state).toBe('never-connected');
    expect(after.state).toBe('gone-dark');
  });

  test('stale use → gone-dark, and the owner gets the wake command', () => {
    const row = deriveAgentState(
      byoInstall({ runtimeTokens: [{ lastListenedAt: new Date(NOW - AGENT_LISTENING_STALE_MS - 1000) }] }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('gone-dark');
    expect(row.fixCommand).toBe('commonly agent run sam-agent');
  });

  test('native runtime is reachable by construction — no dot, no lastUsedAt reading', () => {
    const row = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'native' } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('reachable');
    expect(row.lastUsedAt).toBeNull();
  });

  test('a provisioned hosted install on the native engine is reachable; a stopped one is not', () => {
    const live = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date(NOW) } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(live.state).toBe('reachable');
    const stopped = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: null } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(stopped.state).not.toBe('reachable');
  });

  // Walk 4 (2026-10-16): the shell hides Scout's "Run an agent here" start
  // once the viewer holds a hosted agent, so the row says which agents are hosted.
  test('marks a hosted install as hosted, and no other runtime class', () => {
    const hosted = deriveAgentState({
      agentName: 'lee-agent', instanceId: 'default', installedBy: 'u1',
      config: { runtime: { runtimeType: 'hosted' } },
    }, [], 'u1', NOW);
    expect(hosted).toMatchObject({ hosted: true, isOwner: true });
    const others = [{ runtimeType: 'native' }, { runtimeType: 'webhook', host: 'byo' }, { runtimeType: 'moltbot' }, {}];
    for (const runtime of others) {
      expect(deriveAgentState({ agentName: 'x', config: { runtime } }, [], 'u1', NOW).hosted).toBe(false);
    }
  });

  describe('a push webhook is measured by its last delivery, never assumed reachable', () => {
    const URL = 'https://x.example/cap';
    const pushInstall = (webhookDelivery) => byoInstall({
      config: { runtime: { runtimeType: 'webhook', host: 'byo', webhookUrl: URL } },
      ...(webhookDelivery === undefined ? {} : { webhookDelivery }),
    });
    const at = (msAgo) => new Date(NOW - msAgo);

    test('nothing sent to it yet reads unknown, not reachable, whatever its tokens say', () => {
      const row = deriveAgentState(pushInstall(), [{ lastListenedAt: at(1_000) }], 'owner-1', NOW);
      expect(row.state).toBe('unknown');
      expect(row.lastUsedAt).toBeNull();
      expect(row.deliveryError).toBeUndefined();
      expect(row.fixCommand).toBeUndefined();
    });

    test('an endpoint that answered the last delivery is reachable, as of that answer', () => {
      const row = deriveAgentState(pushInstall({
        urlHash: webhookUrlHash(URL), lastAttemptAt: at(60_000), lastOkAt: at(60_000),
      }), [], 'owner-1', NOW);
      expect(row.state).toBe('reachable');
      expect(row.lastUsedAt).toBe(at(60_000).toISOString());
      expect(row.deliveryError).toBeUndefined();
    });

    test('a failure after the last answer is gone-dark, with what failed and when', () => {
      const install = pushInstall({
        urlHash: webhookUrlHash(URL),
        lastAttemptAt: at(30_000),
        lastOkAt: at(3_600_000),
        lastFailedAt: at(30_000),
        lastFailure: 'http',
        lastFailureStatus: 502,
      });
      const owner = deriveAgentState(install, [], 'owner-1', NOW);
      expect(owner.state).toBe('gone-dark');
      expect(owner.lastUsedAt).toBe(at(3_600_000).toISOString());
      expect(owner.deliveryError).toEqual({ at: at(30_000).toISOString(), kind: 'http', status: 502 });
      expect(owner.fixCommand).toBe(WEBHOOK_RUN_INSTRUCTION);
      // The explanation goes to every viewer; the instruction only to the owner.
      const viewer = deriveAgentState(install, [], 'someone-else', NOW);
      expect(viewer.deliveryError).toEqual(owner.deliveryError);
      expect(viewer.fixCommand).toBeUndefined();
    });

    test('a failure on a URL that never answered is gone-dark with no last answer', () => {
      const row = deriveAgentState(pushInstall({
        urlHash: webhookUrlHash(URL), lastAttemptAt: at(5_000), lastFailedAt: at(5_000), lastFailure: 'timeout',
      }), [], 'owner-1', NOW);
      expect(row.state).toBe('gone-dark');
      expect(row.lastUsedAt).toBeNull();
      expect(row.deliveryError).toEqual({ at: at(5_000).toISOString(), kind: 'timeout' });
    });

    test('an answer after a failure clears it', () => {
      const row = deriveAgentState(pushInstall({
        urlHash: webhookUrlHash(URL), lastOkAt: at(1_000), lastFailedAt: at(9_000), lastFailure: 'network',
      }), [], 'owner-1', NOW);
      expect(row.state).toBe('reachable');
      expect(row.deliveryError).toBeUndefined();
    });

    test('an outcome recorded for another URL says nothing about this one', () => {
      const row = deriveAgentState(pushInstall({
        urlHash: webhookUrlHash('https://old.example/hook'), lastFailedAt: at(1_000), lastFailure: 'http', lastFailureStatus: 500,
      }), [], 'owner-1', NOW);
      expect(row.state).toBe('unknown');
      expect(row.deliveryError).toBeUndefined();
    });

    test('a status rides only on an HTTP failure, and an unknown kind reads as a network failure', () => {
      const row = deriveAgentState(pushInstall({
        urlHash: webhookUrlHash(URL), lastFailedAt: at(1_000), lastFailure: 'bogus', lastFailureStatus: 500,
      }), [], 'owner-1', NOW);
      expect(row.deliveryError).toEqual({ at: at(1_000).toISOString(), kind: 'network' });
    });
  });

  test('gateway/cloud classes are unknown — never guessed from a shared boot timestamp (finding A)', () => {
    const row = deriveAgentState(
      byoInstall({
        config: { runtime: { runtimeType: 'moltbot', host: 'cloud' } },
        runtimeTokens: [{ lastListenedAt: new Date(NOW - 5_000) }], // fresh, and still not trusted
      }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('unknown');
    expect(row.fixCommand).toBeUndefined();
  });

  test('an explicit non-BYO host is not reclassified from token use', () => {
    const row = deriveAgentState(
      byoInstall({
        config: { runtime: { runtimeType: 'webhook', host: 'cloud' } },
        runtimeTokens: [{ lastListenedAt: new Date(NOW - 5_000) }],
      }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('unknown');
  });

  test('legacy local-cli installs count as BYO', () => {
    const row = deriveAgentState(
      byoInstall({ config: { runtime: { runtimeType: 'local-cli' } } }),
      [],
      'owner-1',
      NOW,
    );
    expect(row.state).toBe('never-connected');
  });
});

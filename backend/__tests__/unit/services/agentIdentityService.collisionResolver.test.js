// Tests for the inline displayName collision resolver in
// getOrCreateAgentUser. This is the sticky-dedup path (counterpart to the
// one-shot offline dedup script scripts/dedupe-agent-display-names.ts) —
// every fresh install / reprovision now disambiguates inline, so a future
// reprovision-all run cannot reintroduce a "Pixel" / "Pixel" collision.
//
// We exercise the resolver via getOrCreateAgentUser (the public entry
// point) because the helper is module-internal; this also doubles as a
// regression test for the entire write path.

jest.mock('../../../models/Pod', () => ({}));

// Mongo User mock — minimal save() + find() shape sufficient for the
// three branches in getOrCreateAgentUser. Each test seeds state into
// `mockPeers` (other bot Users with potential displayName collisions) and
// `mockExisting` (the user the caller is trying to get-or-create).
//
// All mutable state is prefixed with `mock` so the jest.mock() factory can
// reference it — Jest's hoisting-safety allow-list only permits names
// starting with `mock`.
let mockPeers = [];
let mockExisting = null;
const mockSaved = [];

jest.mock('../../../models/User', () => {
  function User(doc) {
    Object.assign(this, doc);
  }
  User.prototype.save = async function save() {
    mockSaved.push(JSON.parse(JSON.stringify(this)));
    return this;
  };
  // `apiToken` is select:false on the schema, so production code loads the
  // agent user with `.select('+apiToken')`. The mock therefore has to be a
  // thenable query builder, not a bare promise.
  const findOneResult = (query) => {
    if (mockExisting && query.username === mockExisting.username) {
      const doc = JSON.parse(JSON.stringify(mockExisting));
      doc.save = async function save() {
        mockSaved.push(JSON.parse(JSON.stringify(this)));
        return this;
      };
      return doc;
    }
    return null;
  };
  User.findOne = jest.fn((query) => {
    const promise = Promise.resolve(findOneResult(query));
    promise.select = () => promise;
    promise.lean = () => promise;
    return promise;
  });
  User.find = (query) => ({
    select: () => ({
      lean: async () => {
        const dn = query['botMetadata.displayName'];
        return mockPeers
          .filter((p) => p.botMetadata?.displayName === dn)
          .filter((p) => {
            if (!query._id || !query._id.$ne) return true;
            return String(p._id) !== String(query._id.$ne);
          });
      },
    }),
  });
  return User;
});

const { default: AgentIdentityService } = require('../../../services/agentIdentityService');

const reset = () => {
  mockPeers = [];
  mockExisting = null;
  mockSaved.length = 0;
};

describe('inline displayName collision resolver (sticky dedup)', () => {
  beforeEach(reset);

  test('a hire that carries a description stores it; one that does not gets no line, never "<name> agent" (#1649)', async () => {
    await AgentIdentityService.getOrCreateAgentUser('scout-1', {
      instanceId: 'scout', displayName: 'Scout', description: 'Your first teammate. Answers how things work here.',
    });
    expect(mockSaved[0].botMetadata.description).toBe('Your first teammate. Answers how things work here.');
    reset();
    await AgentIdentityService.getOrCreateAgentUser('scout-2', { instanceId: 'scout', displayName: 'Scout' });
    expect(mockSaved[0].botMetadata.description).toBe('');
    expect(mockSaved[0].botMetadata.description).not.toMatch(/ agent$/);
  });

  test('the upgrade branch (existing non-bot user) and the repair branch (bot user with stale meta) store no placeholder either (#1649)', async () => {
    // Fixture updated for TASK-133 (a), disclosed: the upgrade branch now requires
    // the row to carry an agent marker, so this legacy row carries the derived
    // agent address an install writes. Without it the row is a PERSON's account and
    // is refused by name — see the two tests below.
    mockExisting = {
      _id: 'legacy-agent-id',
      username: 'scout-3-scout',
      email: 'scout-3-scout@agents.commonly.local',
      isBot: false,
    };
    await AgentIdentityService.getOrCreateAgentUser('scout-3', { instanceId: 'scout', displayName: 'Scout' });
    expect(mockSaved[0].botMetadata.description).toBe('');
    reset();
    mockExisting = { _id: 'bot-id', username: 'scout-4-scout', isBot: true, botMetadata: { agentName: 'scout-4', instanceId: 'scout', displayName: 'Scout' } };
    await AgentIdentityService.getOrCreateAgentUser('scout-4', { instanceId: 'scout', displayName: 'Scout' });
    expect(mockSaved[0].botMetadata.description).toBe('');
    expect(mockSaved[0].botMetadata.description).not.toMatch(/ agent$/);
  });

  test('still adopts a row written before isBot existed, on any of the three agent markers (TASK-133 a)', async () => {
    mockExisting = {
      _id: 'legacy-email-id',
      username: 'scout-5-scout',
      email: 'scout-5-scout@agents.commonly.local',
      isBot: false,
    };
    const byEmail = await AgentIdentityService.getOrCreateAgentUser('scout-5', { instanceId: 'scout', displayName: 'Scout' });
    expect(byEmail.isBot).toBe(true);
    expect(mockSaved[0].isBot).toBe(true);

    // botType, written by an install that predates the derived address
    reset();
    mockExisting = {
      _id: 'legacy-bottype-id',
      username: 'scout-6-scout',
      email: 'old-address@example.com',
      isBot: false,
      botType: 'agent',
    };
    const byBotType = await AgentIdentityService.getOrCreateAgentUser('scout-6', { instanceId: 'scout', displayName: 'Scout' });
    expect(byBotType.isBot).toBe(true);

    // botMetadata, written by an install
    reset();
    mockExisting = {
      _id: 'legacy-botmeta-id',
      username: 'scout-7-scout',
      isBot: false,
      botMetadata: { agentName: 'scout-7', instanceId: 'scout', displayName: 'Scout' },
    };
    const byBotMetadata = await AgentIdentityService.getOrCreateAgentUser('scout-7', { instanceId: 'scout', displayName: 'Scout' });
    expect(byBotMetadata.isBot).toBe(true);
  });

  // The arms are judged on a REAL User document, not an object literal: the
  // container `botMetadata` is materialised on every row by its sub-path
  // defaults, so `Boolean(botMetadata)` reads true for a person and the refusal
  // never fires in production (vera 73985). A nested-path guard witnessed only
  // against literals misses exactly that, so this test builds the document the
  // service actually holds.
  test('on a hydrated User document, a person row is not agent-owned and is refused (TASK-133 a)', async () => {
    const RealUser = jest.requireActual('../../../models/User');
    const person = new RealUser({ username: 'scout-9-scout', email: 'person@example.com', isBot: false });

    // The container is always present; the leaf this writer sets is not.
    expect(person.botMetadata).toBeTruthy();
    expect(person.botMetadata.agentName).toBeUndefined();
    expect(
      AgentIdentityService.isAgentOwnedRow(person, 'scout-9-scout@agents.commonly.local'),
    ).toBe(false);

    // A legacy agent row written by this service carries the leaf, so it is
    // still adopted.
    const legacy = new RealUser({
      username: 'scout-5-scout',
      email: 'scout-5-scout@agents.commonly.local',
      isBot: false,
      botMetadata: { agentName: 'scout-5' },
    });
    expect(
      AgentIdentityService.isAgentOwnedRow(legacy, 'scout-5-scout@agents.commonly.local'),
    ).toBe(true);

    // And the refusal itself runs on that document shape: the mock's findOne
    // copy keeps the materialised container and no leaf, which is what a real
    // person row looks like to this branch.
    mockExisting = person;
    await expect(
      AgentIdentityService.getOrCreateAgentUser('scout-9', { instanceId: 'scout', displayName: 'Scout' }),
    ).rejects.toThrow(/refusing to adopt the existing non-agent account/);
    expect(mockSaved).toHaveLength(0);
  });

  test('refuses to adopt an account no agent install wrote, instead of converting a person into a bot (TASK-133 a)', async () => {
    mockExisting = {
      _id: 'person-id',
      username: 'scout-9-scout',
      email: 'person@example.com',
      isBot: false,
    };

    await expect(
      AgentIdentityService.getOrCreateAgentUser('scout-9', { instanceId: 'scout', displayName: 'Scout' }),
    ).rejects.toThrow(/refusing to adopt the existing non-agent account/);

    // Typed, and it names what it refused, so a caller can report the collision
    // instead of guessing why a send or an install failed.
    const err = await AgentIdentityService.getOrCreateAgentUser('scout-9', { instanceId: 'scout', displayName: 'Scout' })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AgentIdentityService.AgentUsernameConflictError);
    expect(err.code).toBe('agent_username_conflict');
    expect(err.username).toBe('scout-9-scout');
    expect(err.existingUserId).toBe('person-id');

    // The refusal writes nothing: no upgrade, so the person's account keeps its
    // row and stays able to log in. (The mock hands back a copy, so `mockSaved`
    // is the instrument that would show a conversion, not the fixture itself.)
    expect(mockSaved).toHaveLength(0);
    expect(mockExisting.isBot).toBe(false);
  });

  test('new install with no peers — bare displayName is kept', async () => {
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'pixel',
      displayName: 'Pixel',
    });
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].botMetadata.displayName).toBe('Pixel');
  });

  test('new identity seeds a normalized package avatar', async () => {
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'aria',
      displayName: 'Aria',
      profilePicture: 'https://api-dev.commonly.me/api/uploads/aria.png',
    });

    expect(mockSaved[0].profilePicture).toBe('/api/uploads/aria.png');
  });

  test('reinstall does not overwrite an existing customized identity avatar', async () => {
    mockExisting = {
      _id: 'aria-id',
      username: 'openclaw-aria',
      profilePicture: '/api/uploads/customized.png',
      isBot: true,
      botMetadata: {
        agentName: 'openclaw',
        instanceId: 'aria',
        displayName: 'Aria',
        runtime: 'moltbot',
      },
    };

    const user = await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'aria',
      profilePicture: '/api/uploads/package-seed.png',
    });

    expect(user.profilePicture).toBe('/api/uploads/customized.png');
    expect(mockSaved).toHaveLength(0);
  });

  test('a sibling pod label cannot overwrite the portable agent identity', async () => {
    // One principal can be installed in several pods. The displayName passed
    // by CAP is the target installation's label, not permission to rename the
    // shared User row. This is the cross-pod regression that previously made
    // historical bylines oscillate between the two rooms.
    mockExisting = {
      _id: 'strategist-id',
      username: 'cl-strategist-strategist-fable',
      isBot: true,
      botMetadata: {
        agentName: 'cl-strategist',
        instanceId: 'strategist-fable',
        displayName: 'Strategist (Fable)',
        runtime: 'codex',
      },
    };

    const user = await AgentIdentityService.getOrCreateAgentUser('cl-strategist', {
      instanceId: 'strategist-fable',
      // This is the label from the sibling pod's AgentInstallation.
      displayName: 'Strategist (Claude)',
    });

    expect(user.botMetadata.displayName).toBe('Strategist (Fable)');
    expect(mockSaved).toHaveLength(0);
  });

  test('a same-pod installation rename cannot silently rename the principal', async () => {
    // The config route owns the pod-scoped AgentInstallation/AgentProfile
    // rename. A later post from that same pod must not turn it into a global
    // identity rename as a side effect.
    mockExisting = {
      _id: 'strategist-id',
      username: 'cl-strategist-strategist-fable',
      isBot: true,
      botMetadata: {
        agentName: 'cl-strategist',
        instanceId: 'strategist-fable',
        displayName: 'Strategist (Claude)',
        runtime: 'codex',
      },
    };

    const user = await AgentIdentityService.getOrCreateAgentUser('cl-strategist', {
      instanceId: 'strategist-fable',
      // The installation/profile was renamed inside this pod.
      displayName: 'Strategy reviewer',
    });

    expect(user.botMetadata.displayName).toBe('Strategist (Claude)');
    expect(mockSaved).toHaveLength(0);
  });

  test('new install collides with an existing canonical — gets suffix', async () => {
    // openclaw-pixel already has displayName="Pixel" with instanceId "pixel" (shorter)
    mockPeers = [
      {
        _id: 'canonical-id',
        botMetadata: { displayName: 'Pixel', instanceId: 'pixel' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'pixel-demo',
      displayName: 'Pixel',
    });
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].botMetadata.displayName).toBe('Pixel (Pixel-Demo)');
  });

  test('opaque per-user token colliding with a canonical peer keeps the bare name', async () => {
    // Every user's Guide is displayName "Guide" by design. Suffixing the
    // collision puts the opaque token in every chat byline of every user
    // except the first ("Guide (U0da521ab41)", observed live 2026-08-13).
    // Opaque tokens are machine identity — same convention as the #930
    // mention-handle rule — so the resolver must skip them entirely.
    mockPeers = [
      {
        _id: 'first-users-guide',
        botMetadata: { displayName: 'Guide', instanceId: 'u11aa22bb33' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('guide', {
      instanceId: 'u0da521ab41',
      displayName: 'Guide',
    });
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].botMetadata.displayName).toBe('Guide');
  });

  test('legacy long-form opaque token also keeps the bare name', async () => {
    mockPeers = [
      {
        _id: 'first-users-guide',
        botMetadata: { displayName: 'Guide', instanceId: 'u11aa22bb33' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('guide', {
      instanceId: 'u6a7d154b0ec237d4b15dd28b',
      displayName: 'Guide',
    });
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].botMetadata.displayName).toBe('Guide');
  });

  test('new install IS canonical (shorter instanceId than existing peer) — keeps bare name', async () => {
    // pixel-stub-x already has displayName="Pixel" with longer instanceId
    mockPeers = [
      {
        _id: 'longer-instance',
        botMetadata: { displayName: 'Pixel', instanceId: 'pixel-stub-x' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'pixel',
      displayName: 'Pixel',
    });
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].botMetadata.displayName).toBe('Pixel');
  });

  test('refresh (reprovision) on existing collision-suffixed name does NOT double-suffix', async () => {
    mockExisting = {
      _id: 'reprovision-id',
      username: 'openclaw-pixel-demo',
      isBot: true,
      botMetadata: {
        agentName: 'openclaw',
        instanceId: 'pixel-demo',
        displayName: 'Pixel (Pixel-Demo)',
      },
    };
    // Preset still passes the bare "Pixel"
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'pixel-demo',
      displayName: 'Pixel',
      runtimeId: 'runtime-force-update',
    });
    // The refresh branch should detect peer collision and re-apply suffix.
    // The non-canonical pre-write check sees the existing reprovision-id
    // self-excluded, but there are still no OTHER peers in this test, so
    // the bare "Pixel" passes through. This is fine: in production the
    // canonical openclaw-pixel exists as a peer and the suffix is re-applied.
    expect(mockSaved.length).toBe(1);
  });

  test('already-disambiguated name passes through unchanged', async () => {
    mockPeers = [
      {
        _id: 'canonical-id',
        botMetadata: { displayName: 'Pixel', instanceId: 'pixel' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('openclaw', {
      instanceId: 'pixel-demo',
      displayName: 'Pixel (Pixel-Demo)',
    });
    expect(mockSaved[0].botMetadata.displayName).toBe('Pixel (Pixel-Demo)');
  });

  test('humanizes multi-segment instanceId — underscore / dash boundaries capitalized', async () => {
    mockPeers = [
      {
        _id: 'canonical-id',
        botMetadata: { displayName: 'Cody', instanceId: 'cody' },
      },
    ];
    await AgentIdentityService.getOrCreateAgentUser('codex', {
      instanceId: 'cody-bot',
      displayName: 'Cody',
    });
    expect(mockSaved[0].botMetadata.displayName).toBe('Cody (Cody-Bot)');
  });
});

// @ts-nocheck

// TASK-163. The bot password minted by `getOrCreateAgentUser` used to be
// `agent-password-${Date.now()}` — a millisecond timestamp, against an identity
// whose existence is public (`botMetadata` and the username are both readable).
//
// Two witness shapes were proposed for this row and neither can fail, so neither
// is here. "Two bots minted in the same millisecond store different hashes" is
// already true of the old code: `models/User.ts` hashes with
// `bcrypt.hash(password, 10)` and bcrypt salts per call. "The minted value is not
// a function of Date.now()" is unobservable after the pre-save hook, because the
// plaintext is gone by the time anything can read the row.
//
// So the arms below observe the two places where the property is actually
// visible: the stored hash, via the attack an attacker would run, and the
// plaintext at the moment it is handed to the hash function.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../../../models/User');
const { default: AgentIdentityService } = require('../../../services/agentIdentityService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

// A fixed instant, so the withheld guess is one string rather than a race.
const FIXED_MS = 1758931200000; // 2026-09-27T00:00:00Z

const mint = (instanceId) => AgentIdentityService.getOrCreateAgentUser('openclaw', { instanceId });

describe('bot password is minted with entropy, not from the clock (TASK-163)', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the creation-time guess does not authenticate the minted seat', async () => {
    // The attack the row is about, run end to end: whoever knows when the seat
    // was created reconstructs the old plaintext and presents it. Reddens the
    // moment the mint goes back to a timestamp.
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_MS);

    await mint('clocked');
    const stored = await User.findOne({ username: 'openclaw-clocked' }).select('+password');

    // Control: a bcrypt hash is on the row, so the `false` below is the mint's
    // property and not an empty password field passing a comparison it never made.
    expect(stored.password).toMatch(/^\$2[aby]\$/);
    await expect(stored.comparePassword(`agent-password-${FIXED_MS}`)).resolves.toBe(false);
  });

  test('the plaintext handed to the hash is random hex, not a low-entropy template', async () => {
    // Blind to `Date.now()` on purpose: this arm carries the entropy half, so a
    // future edit that swaps one guessable template for another is still caught.
    const hashSpy = jest.spyOn(bcrypt, 'hash');

    await mint('entropy');

    // Control first: if the spy cannot see the call, fail loudly here rather
    // than pass vacuously on an empty call list.
    expect(hashSpy).toHaveBeenCalled();
    const [plaintext] = hashSpy.mock.calls[0];
    expect(plaintext).not.toMatch(/^agent-password-\d+$/);
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
  });

  test('two seats minted in the same millisecond do not share a plaintext', async () => {
    // The row's original first arm, repaired: the observation moved from the
    // stored hash (where the salt hides the collision) to the plaintext.
    const hashSpy = jest.spyOn(bcrypt, 'hash');
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_MS);

    await mint('twin-a');
    await mint('twin-b');

    const plaintexts = hashSpy.mock.calls.map(([plaintext]) => plaintext);
    expect(plaintexts).toHaveLength(2);
    expect(new Set(plaintexts).size).toBe(2);
  });
});

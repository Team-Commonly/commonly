/**
 * The install intro must not promise a listener that does not exist.
 *
 * Posted server-side at seat creation, the old copy always said "Mention me
 * with @handle when you need me" — for a BYO seat, before any wrapper process
 * exists. Production message history shows exactly what that costs:
 *
 *   m0re        2026-08-04  "@m0re-agent 1"                        → silence
 *   l3r0ys4n3   2026-08-07  "Hi" (right after the intro)           → silence
 *   user-8863   2026-08-09  asked 3× whether the connection worked → silence
 *   ngoc-tran   2026-08-10  "@ngoc-tran-agent what modal you use"  → silence
 *
 * None of the four returned. The promise is made in the AGENT'S OWN VOICE,
 * which is why it matters more than the connect page's honesty copy (#887).
 *
 * F651 (prod, 11-26): the fix for that used to post the opposite sentence in
 * the same voice, "As I post this, nothing is running me yet" plus a start
 * command, at the top of every new pod. A seat nothing runs now gets no intro
 * at all; the installer's own surfaces carry the command.
 */

const { composeInstallIntro, installIntroPlan } = require('../../../routes/registry/helpers');

const base = {
  displayName: 'Ngoc Tran Agent',
  handle: 'ngoc-tran-agent',
};

describe('install intro — the promise matches reality', () => {
  test('a seat with nothing running it posts no intro, rather than one saying so', () => {
    // Certain (never ran) and inferred (gone quiet) alike: nothing in the
    // agent's voice about its own state, and no command for the whole room.
    ['never-connected', 'gone-dark'].forEach((state) => {
      expect(composeInstallIntro({ ...base, state })).toBeNull();
      expect(composeInstallIntro({ ...base, state, blurb: 'I review pull requests.' })).toBeNull();
      expect(installIntroPlan({ state })).toBe('none');
    });
  });

  test('an identity declared with no listener gets no command to start one', () => {
    // A stable declaration, true whenever it is read, so it still posts.
    ['never-connected', 'gone-dark', 'unknown'].forEach((state) => {
      const intro = composeInstallIntro({ ...base, state, listens: false });
      expect(intro).toMatch(/run no listener, so mentioning me won't wake me/);
      expect(intro).not.toMatch(/commonly agent run/);
      expect(intro).not.toMatch(/Mention me with @ngoc-tran-agent when you need me/);
      expect(intro).not.toMatch(/nothing is running me/);
      expect(installIntroPlan({ state, listens: false })).toBe('no-listener');
    });
  });

  test('a measured check-in outweighs a declaration of no listener', () => {
    ['listening', 'reachable'].forEach((state) => {
      const intro = composeInstallIntro({ ...base, state, listens: false });
      expect(intro).toMatch(/Mention me with @ngoc-tran-agent when you need me/);
      expect(installIntroPlan({ state, listens: false })).toBe('invite');
    });
  });

  test('a live seat still invites the mention — the fix must not lie the other way', () => {
    // A running agent installed into a NEW pod is genuinely reachable, which
    // is why the caller derives state instead of assuming a fresh seat is dead.
    const intro = composeInstallIntro({ ...base, state: 'listening' });

    expect(intro).toMatch(/Mention me with @ngoc-tran-agent when you need me/);
    expect(intro).not.toMatch(/won't reach anyone/);
    expect(intro).not.toMatch(/agent run/);
    // Asserts no state, so it carries no "as I post this" caveat to age.
    expect(intro).not.toMatch(/never updates/);
    expect(intro).not.toMatch(/As I post this/);
  });

  test('an unknown state keeps the invitation — we only warn about what we can show', () => {
    // Gateway/cloud classes derive to 'unknown', and so does a derivation
    // failure. Wrongly telling a live agent's room that nothing listens is the
    // opposite lie, so silence about liveness is the correct default.
    const intro = composeInstallIntro({ ...base, state: 'unknown' });

    expect(intro).toMatch(/Mention me with @ngoc-tran-agent when you need me/);
    expect(intro).not.toMatch(/agent run/);
    expect(installIntroPlan({ state: 'unknown' })).toBe('invite');
  });

  test('the handle, not the agent name, is what gets mentioned', () => {
    // A BYO user is told their agent is named "sam-agent" while the mention
    // handle is the instanceId (GH smoke finding 2026-07-05).
    const live = composeInstallIntro({ ...base, handle: 'scout', state: 'listening' });

    expect(live).toMatch(/@scout/);
  });

  test('a meaningful blurb survives', () => {
    const intro = composeInstallIntro({ ...base, blurb: 'I review pull requests.', state: 'listening' });

    expect(intro).toMatch(/I review pull requests\./);
  });

  test('a blurb that just repeats the name is dropped, not echoed', () => {
    // Older CLI versions seeded description from displayName, producing
    // "Hi all — I'm bot. bot Ping me ...".
    const intro = composeInstallIntro({
      ...base, displayName: 'bot', blurb: 'BOT', state: 'listening',
    });

    expect(intro).toMatch(/just joined the pod/);
    expect(intro).not.toMatch(/bot\. BOT/i);
  });

  test('a placeholder description is not read as a claim', () => {
    // The self-serve path writes "A connected agent." on an agent that may
    // never have connected.
    const intro = composeInstallIntro({
      ...base, blurb: 'A connected agent.', state: 'unknown',
    });

    expect(intro).not.toMatch(/connected agent/i);
    expect(intro).toMatch(/just joined the pod/);
  });
});

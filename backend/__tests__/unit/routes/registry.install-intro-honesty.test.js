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
 * which is why it matters more than the connect page's honesty copy (#887) —
 * that fix never touched this sentence.
 */

const { composeInstallIntro } = require('../../../routes/registry/helpers');

const base = {
  displayName: 'Ngoc Tran Agent',
  handle: 'ngoc-tran-agent',
  fixCommand: 'commonly agent run ngoc-tran-agent',
};

describe('install intro — the promise matches reality', () => {
  test('a seat with nothing running it does NOT invite a mention', () => {
    const intro = composeInstallIntro({ ...base, listening: false });

    // The exact sentence the four casualties acted on must be absent.
    expect(intro).not.toMatch(/Mention me with @ngoc-tran-agent when you need me/);
    // It must say plainly that a mention goes nowhere...
    expect(intro).toMatch(/won't reach anyone/);
    // ...and hand over the one command that fixes it.
    expect(intro).toMatch(/commonly agent run ngoc-tran-agent/);
  });

  test('a live seat still invites the mention — the fix must not lie the other way', () => {
    // A running agent installed into a NEW pod is genuinely reachable. Telling
    // that room "nothing is running me" would be the opposite defect, which is
    // why the caller derives state instead of assuming a fresh seat is dead.
    const intro = composeInstallIntro({ ...base, listening: true });

    expect(intro).toMatch(/Mention me with @ngoc-tran-agent when you need me/);
    expect(intro).not.toMatch(/won't reach anyone/);
    expect(intro).not.toMatch(/commonly agent run/);
  });

  test('the handle, not the agent name, is what gets mentioned', () => {
    // A BYO user is told their agent is named "sam-agent" while the mention
    // handle is the instanceId (GH smoke finding 2026-07-05). Both branches
    // must use the handle.
    const live = composeInstallIntro({ ...base, handle: 'scout', listening: true });
    const dead = composeInstallIntro({ ...base, handle: 'scout', listening: false });

    expect(live).toMatch(/@scout/);
    expect(dead).toMatch(/@scout/);
  });

  test('a meaningful blurb survives in both branches', () => {
    const opts = { ...base, blurb: 'I review pull requests.' };

    expect(composeInstallIntro({ ...opts, listening: true })).toMatch(/I review pull requests\./);
    expect(composeInstallIntro({ ...opts, listening: false })).toMatch(/I review pull requests\./);
  });

  test('a blurb that just repeats the name is dropped, not echoed', () => {
    // Older CLI versions seeded description from displayName, producing
    // "Hi all — I'm bot. bot Ping me ...".
    const intro = composeInstallIntro({
      ...base, displayName: 'bot', blurb: 'BOT', listening: true,
    });

    expect(intro).toMatch(/just joined the pod/);
    expect(intro).not.toMatch(/bot\. BOT/i);
  });

  test('the dead-seat copy never blames the reader', () => {
    // Whoever reads this in a shared pod usually cannot run the command. The
    // instruction names the installer rather than commanding the room — the
    // same split agentStateService makes between state and fixCommand.
    const intro = composeInstallIntro({ ...base, listening: false });

    expect(intro).toMatch(/Whoever installed me/);
  });
});

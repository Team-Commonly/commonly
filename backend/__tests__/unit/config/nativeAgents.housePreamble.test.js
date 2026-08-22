/**
 * ADR-022 D3 — one company voice, composed into every manifest.
 *
 * The point of the extraction is that a tone fix propagates to the whole
 * cast. These pin the composition so a future manifest can't quietly fork
 * the voice again, and so the preamble can't get double-appended.
 */
const { HOUSE_PREAMBLE, composePrompt } = require('../../../config/native-agents/housePreamble');
const { FIRST_PARTY_APPS } = require('../../../config/native-agents/apps');
const { scoutApp } = require('../../../config/native-agents/scout');
const { recorderApp } = require('../../../config/native-agents/recorder');

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

describe('house-style preamble', () => {
  test('persona-plan manifests carry the preamble exactly once', () => {
    // Scout and Recorder are the composed cast today. The legacy trio
    // (welcomer/clerk/summarizer) is retiring under the plan, not migrating.
    for (const app of [scoutApp, recorderApp]) {
      expect(countOccurrences(app.systemPrompt, HOUSE_PREAMBLE)).toBe(1);
    }
  });

  test('role prompt leads; the shared voice follows', () => {
    // Who you are outranks how the house talks — the model weights the
    // opening, so identity must come first.
    for (const app of [scoutApp, recorderApp]) {
      expect(app.systemPrompt.indexOf(HOUSE_PREAMBLE)).toBeGreaterThan(100);
      expect(app.systemPrompt.startsWith('You are ')).toBe(true);
    }
  });

  test('composePrompt appends role hard rules after the shared block', () => {
    const composed = composePrompt('You are X.', 'Never do Y.');
    expect(composed.indexOf('You are X.')).toBe(0);
    expect(composed.indexOf(HOUSE_PREAMBLE)).toBeGreaterThan(0);
    expect(composed.indexOf('Never do Y.')).toBeGreaterThan(composed.indexOf(HOUSE_PREAMBLE));
  });

  test('recorder ships mention-only with no board tools — D3 identity as mechanism', () => {
    // Wake policy and tool list ARE the persona. A residency claim needs a
    // wake that verifiably fires; mention is the only one Recorder has.
    expect(recorderApp.triggers).toEqual(['mention']);
    expect(recorderApp.tools).not.toContain('commonly_create_task');
    expect(recorderApp.tools).not.toContain('commonly_propose_action');
    expect(recorderApp.wakeOnMessage).toBeUndefined();
  });

  test('planner has no manifest until the board-wake gate splits from wake-on-message', () => {
    // taskEventService.notifyPodAgents filters board wakes on
    // wakeOnMessageEnabled — shipping Planner today would wake it on every
    // chat line in a shared pod (D6 violation) or never (no residency).
    expect(FIRST_PARTY_APPS.some((a) => a.agentName === 'planner')).toBe(false);
  });
});

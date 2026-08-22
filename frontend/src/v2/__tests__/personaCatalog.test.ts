import { PERSONA_CARDS } from '../agents/personaCatalogData';

/**
 * The card discipline is ux-lead's checklist and fable-lead's two rulings
 * (Sharpen, 2026-08-21) as CI assertions — so a future card edit cannot
 * quietly drop the parts that make a card trustworthy.
 */
describe('persona catalog discipline', () => {
  test('every card carries the full evidence shape', () => {
    for (const card of PERSONA_CARDS) {
      // First-person one-liner, first-thing, a real two-turn sample, the
      // ALWAYS-rendered limits line, and the how-I-work disclosure.
      expect(card.oneLiner.length).toBeGreaterThan(20);
      expect(card.firstThing.length).toBeGreaterThan(10);
      expect(card.sample.ask.length).toBeGreaterThan(5);
      expect(card.sample.reply.length).toBeGreaterThan(5);
      expect(card.limits.length).toBeGreaterThan(10);
      expect(card.howIWork.length).toBeGreaterThan(20);
      expect(card.skills.length).toBeGreaterThan(0);
      expect(card.tiers.length).toBeGreaterThan(0);
    }
  });

  test('ruling 1: Code Reviewer is the only one-tier local persona', () => {
    const oneTierLocal = PERSONA_CARDS.filter(
      (c) => c.tiers.length === 1 && c.tiers[0] === 'local',
    );
    expect(oneTierLocal.map((c) => c.key)).toEqual(['code-reviewer']);
  });

  test('ruling 2: Host ships no earlier than its placement trigger', () => {
    // Host is admitted to the ROSTER but banned from the grid until Phase 2
    // builds the trigger it rides. Its presence here would be a card live
    // before its producer fires — the exact thing the roster's rule bans.
    expect(PERSONA_CARDS.some((c) => c.key === 'host')).toBe(false);
  });

  test("fable's veto as a test: no card's wake basis mentions pod.join", () => {
    for (const card of PERSONA_CARDS) {
      expect(card.howIWork).not.toMatch(/pod\.join/i);
    }
  });

  test('no runtime vocabulary on cards, except ruling 1 handles local', () => {
    // Card-facing copy never says moltbot/gateway/runtime/native/openclaw.
    const banned = /moltbot|gateway|openclaw|runtime|native engine|litellm/i;
    for (const card of PERSONA_CARDS) {
      for (const text of [card.oneLiner, card.firstThing, card.limits, card.howIWork, ...card.skills]) {
        expect(text).not.toMatch(banned);
      }
    }
  });
});

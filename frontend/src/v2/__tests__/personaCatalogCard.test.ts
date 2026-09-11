// #1649 — every persona carries the sentence its seat will show on Your Team, in the brief
// the fleet's twelve seats follow (#1636): one sentence, under 100 characters, no quotes,
// ends with a period. The card renders this line or nothing; never a fallback string.
import { PERSONA_CARDS } from '../agents/personaCatalogData';

describe('persona card sentences', () => {
  test('every persona has a card sentence in the brief', () => {
    expect(PERSONA_CARDS.length).toBeGreaterThan(0);
    for (const persona of PERSONA_CARDS) {
      expect(persona.card).toBeTruthy();
      expect(persona.card.length).toBeLessThan(100);
      expect(persona.card.trim().endsWith('.')).toBe(true);
      expect(persona.card).not.toMatch(/[“”"]/);
      expect(persona.card).not.toMatch(/ agent$/);
    }
  });
});

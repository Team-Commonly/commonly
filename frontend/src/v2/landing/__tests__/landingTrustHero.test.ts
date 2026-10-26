// TASK-571. The Trust-led hero (GTM §6 B) is built behind TRUST_LED_HERO, and
// every line carries a walk marker in the handoff note: a line may ship only
// after its walk has passed on prod. These guards keep the copy at the ceiling
// the walks allow and keep the flag off until they do.
import fs from 'fs';
import path from 'path';

const LANDING_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'i18n', 'locales', 'en.json'), 'utf8'));
const trustHero = en.landing.trustHero as Record<string, string>;

describe('Trust-led hero copy (TASK-571)', () => {
  test('the hero stays on the current copy until the T4 and Codex walks are on record', () => {
    expect(LANDING_SOURCE).toMatch(/const TRUST_LED_HERO = false;/);
  });

  test('the headline, subhead and proof line are the revised GTM wording', () => {
    expect(trustHero.headline).toBe('Every agent gets the access you grant, scoped to its pod.');
    expect(trustHero.subhead).toBe(
      'Bring your Claude Code or Codex into one pod with your team, and see what each one claimed and finished.',
    );
    expect(trustHero.proof).toBe('Each connector call through a grant is recorded.');
  });

  test('no claim the walks have not earned: no "only", "needs", "tried", "any agent" or "zero trust"', () => {
    Object.values(trustHero).forEach((line) => {
      expect(line).not.toMatch(/\b(only|needs|tried|zero trust)\b/i);
      expect(line).not.toMatch(/any agent/i);
    });
  });

  test('OpenCode is left out until it is walked', () => {
    Object.values(trustHero).forEach((line) => {
      expect(line).not.toMatch(/opencode/i);
    });
  });
});

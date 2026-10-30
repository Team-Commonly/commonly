// TASK-550: Scout's welcome body is stored once, at signup, in the language
// the person signed up in. The English starts stay as they are, because Scout
// matches on those labels.
const {
  SCOUT_WELCOME,
  SCOUT_STARTS,
  normalizeScoutLocale,
  scoutWelcomeFor,
} = require('../../../config/native-agents/scout');

describe('Scout welcome locale', () => {
  it('keeps the English welcome unchanged', () => {
    expect(scoutWelcomeFor('en')).toBe('What would you like to do first?');
    expect(SCOUT_WELCOME).toBe('What would you like to do first?');
  });

  it('returns a zh-CN welcome with no English in it', () => {
    const zh = scoutWelcomeFor('zh-CN');
    expect(zh).not.toBe(SCOUT_WELCOME);
    expect(zh).not.toMatch(/[A-Za-z]{2,}/);
  });

  it('falls back to English for anything that is not zh-CN', () => {
    expect(normalizeScoutLocale(undefined)).toBe('en');
    expect(normalizeScoutLocale('fr')).toBe('en');
    expect(normalizeScoutLocale('zh')).toBe('en');
    expect(scoutWelcomeFor('fr')).toBe(SCOUT_WELCOME);
  });

  it('keeps the start labels in English, since Scout reads them', () => {
    expect(SCOUT_STARTS.map((s) => s.label)).toEqual([
      'Connect an agent I already use',
      'Start a pod for a project',
    ]);
  });
});

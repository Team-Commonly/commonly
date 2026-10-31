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
    expect(scoutWelcomeFor('en')).toBe("I'm Scout, your first agent here. Pick one below, or just tell me what you're working on.");
    expect(SCOUT_WELCOME).toBe("I'm Scout, your first agent here. Pick one below, or just tell me what you're working on.");
  });

  it('returns a zh-CN welcome whose only English is Scout\'s name', () => {
    const zh = scoutWelcomeFor('zh-CN');
    expect(zh).not.toBe(SCOUT_WELCOME);
    expect(zh.replace(/Scout/g, '')).not.toMatch(/[A-Za-z]{2,}/);
  });

  // TASK-644, ruled by UX Lead: the line says who Scout is and that typing
  // works, and never calls the buttons "starts" (an internal name).
  it('says who Scout is and that the person can just type, in both languages', () => {
    expect(scoutWelcomeFor('zh-CN')).toBe('我是 Scout，你在这里的第一个智能体。选下面一项开始，或者直接告诉我你在做什么。');
    expect(SCOUT_WELCOME).not.toMatch(/\bstarts?\b/i);
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

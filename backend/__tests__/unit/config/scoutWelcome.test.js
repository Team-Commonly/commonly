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
      'Show me what you can do',
      'Connect an agent I already use',
      'Start a pod for a project',
    ]);
  });

  // Staging walk 2026-11-02: a start that asks for nothing leads the sent
  // starts, and Scout's prompt says how to answer it.
  it('leads the sent starts with the one that asks nothing, and tells Scout how to answer it', () => {
    expect(SCOUT_STARTS[0]).toEqual({ id: 'ask-scout', label: 'Show me what you can do' });
    // eslint-disable-next-line global-require
    const { scoutApp } = require('../../../config/native-agents/scout');
    expect(scoutApp.systemPrompt).toContain('For "Show me what you can do", answer in two or three short sentences');
    expect(scoutApp.systemPrompt).toContain('For "Connect an agent I already use", find out which tool they run');
    expect(scoutApp.systemPrompt).toContain('For "Start a pod for a project", if they have not named a project, do not ask what it is');
  });

  // Growth, 2026-11-06: 8 people clicked a start and 5 of those chats ended with
  // Scout waiting on them. Three never answered "What's the project?".
  describe('the start-pod first move', () => {
    // eslint-disable-next-line global-require
    const { scoutApp, SCOUT_FIRST_TASK, SCOUT_AGENT_OFFER } = require('../../../config/native-agents/scout');
    const prompt = scoutApp.systemPrompt;

    it('puts one task on the board instead of asking', () => {
      expect(SCOUT_FIRST_TASK).toBe('Read your repo and say what to do first');
      expect(prompt).toContain(`Call commonly_create_task once with the title "${SCOUT_FIRST_TASK}"`);
      expect(prompt).not.toContain('ask what the project is if');
      expect(scoutApp.tools).toContain('commonly_create_task');
    });

    it('offers their own agent, then the pod, in one fixed line', () => {
      expect(SCOUT_AGENT_OFFER).toBe("I can't open repos, but your agent can: connect Claude Code or Codex, or tell me the project and I'll set up its pod.");
      expect(prompt).toContain(`"${SCOUT_AGENT_OFFER}"`);
    });

    it('fits the reply budget with the task clause in front', () => {
      expect(`I put "${SCOUT_FIRST_TASK}" on your board. ${SCOUT_AGENT_OFFER}`.length).toBeLessThanOrEqual(200);
    });

    it('still proposes the pod once a project is named, and keeps its locale rule', () => {
      expect(prompt).toContain('Once they name a project, propose create_pod with a short name for it');
      expect(prompt).toContain('Set create_pod params.locale to the person\'s language');
    });

    it('claims the task only when the tool said so', () => {
      expect(prompt).toContain('Say the task is on their board only if commonly_create_task returned ok');
      const hardRules = prompt.slice(prompt.lastIndexOf('ROLE-SPECIFIC HARD RULES:'));
      expect(hardRules).toContain('Never say a task is on the board unless commonly_create_task returned ok');
    });

    it('does not add the task twice', () => {
      expect(prompt).toContain('If your earlier messages show that task is already on the board, skip the call');
    });

    it('makes the same offer at any "I can\'t" moment, with Run it here as the fallback', () => {
      expect(prompt).toContain('Any time you have to say you can\'t do something their own agent could');
      expect(prompt).toContain('"Run it here" is the fallback, not the first offer');
      expect(prompt).toContain('never offer it as the way to read one');
    });
  });
});

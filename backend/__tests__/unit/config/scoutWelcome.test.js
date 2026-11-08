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
    const { scoutApp, SCOUT_OFFER_COPY } = require('../../../config/native-agents/scout');
    const prompt = scoutApp.systemPrompt;
    const { en } = SCOUT_OFFER_COPY;

    it('hands the move to the tool instead of asking', () => {
      expect(en.firstTask).toBe('Read your repo and say what to do first');
      expect(prompt).toContain('Call commonly_offer_own_agent with addFirstTask true');
      expect(prompt).not.toContain('ask what the project is if');
      expect(scoutApp.tools).toContain('commonly_offer_own_agent');
    });

    it('lists Connect, then Run it here with its limit, then the pod', () => {
      Object.values(SCOUT_OFFER_COPY).forEach((copy) => {
        expect(copy.withHosted).toContain('Claude Code');
        expect(copy.withHosted.indexOf('Codex')).toBeLessThan(copy.withHosted.search(/run one here|在这里运行/));
        expect(copy.withHosted.search(/run one here|在这里运行/)).toBeLessThan(copy.withHosted.search(/tell me the project|告诉我是什么项目/));
        expect(copy.withoutHosted).not.toMatch(/run one here|在这里运行/);
      });
      expect(en.withHosted).toContain("which can't reach your computer or clone a repo");
    });

    // Over the 200-character budget by the caveat, which the budget exempts.
    it('stays close to the reply budget with the task clause in front', () => {
      expect(`${en.taskOnBoard(en.firstTask)} ${en.withHosted}`.length).toBeLessThanOrEqual(250);
    });

    it('still proposes the pod once a project is named, and keeps its locale rule', () => {
      expect(prompt).toContain('Once they name a project, propose create_pod with a short name for it');
      expect(prompt).toContain('Set create_pod params.locale to the person\'s language');
    });

    it('makes the same offer at any "I can\'t" moment, with Run it here after Connect', () => {
      expect(prompt).toContain('Any time you have to say you can\'t do something their own agent could');
      expect(prompt).toContain('"Run it here" comes right after Connect in that reply, never first');
      expect(prompt).toContain('never offer it as the way to work on their code');
      expect(prompt).toContain('Skip this offer when they already told you which tool they run');
    });

    it('keeps the no-false-claim rule last', () => {
      const hardRules = prompt.slice(prompt.lastIndexOf('ROLE-SPECIFIC HARD RULES:'));
      expect(hardRules).toContain('Never say a task is on the board unless a tool told you it is');
    });
  });
});

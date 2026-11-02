/**
 * Scout's first replies stay short (F60, staging walk 2026-11-02).
 *
 * Asked what it could do, Scout named five things in one sentence, and the reply
 * folded behind "Show more" on a phone. The prompt told it to answer the literal
 * question, and the literal answer to "what can you do?" is the whole catalogue.
 * Measured offline on the same model before this rule (9 first posts, 3 samples
 * each): median 265 characters, 6 of 27 replies past the desktop fold, 19 of 27
 * past it at phone width. With it: 181, 0 of 27, 4 of 27.
 */
const { scoutApp } = require('../../../config/native-agents/scout');

describe('Scout reply length', () => {
  const prompt = scoutApp.systemPrompt;

  it('budgets every reply and names the case that ran long', () => {
    expect(prompt).toContain('two or three short sentences, about 200 characters');
    expect(prompt).toContain('Never volunteer a list of what you or Commonly can do');
    expect(prompt).toContain('name the one thing most useful to them now');
  });

  it('exempts what the person asked for and every caveat the rules require', () => {
    expect(prompt).toContain('a caveat these rules tell you to state, may run longer');
    expect(prompt).toContain('Asked which tools, models or paths work, name them');
  });

  it('repeats the budget in the hard rules, the last thing the model reads, with its exemption', () => {
    const hardRules = prompt.slice(prompt.lastIndexOf('ROLE-SPECIFIC HARD RULES:'));
    expect(hardRules).toContain('A first impression is also short');
    expect(hardRules).toContain('unless a command or a caveat these rules require needs more');
    expect(hardRules).toContain('never a tour of what you can do');
  });
});

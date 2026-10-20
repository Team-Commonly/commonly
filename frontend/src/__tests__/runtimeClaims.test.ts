// @ts-nocheck
// Which tools can join a pod is a public claim, so the copy may name only what
// was walked. Earned 2026-10-19: the landing said "Chat with your Claude Code,
// Cursor, Codex" and "any runtime", and the in-app hints said Cursor "joins this
// pod". A non-admin walk that night put the Bring your own page's exact Cursor
// config (~/.cursor/mcp.json) in front of @commonlyai/mcp 0.3.13: it read the
// pod and posted, as the agent the page issued, and an @mention to that agent
// was queued and never answered, because no MCP tool reads the event queue. So
// Cursor uses the pod through MCP; it does not join it, and nobody chats with
// it. The agents that join and answer are Claude Code and Codex (plus OpenCode
// from the CLI guide), and hosted agents.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const en = JSON.parse(read('frontend/src/i18n/locales/en.json'));
const zh = JSON.parse(read('frontend/src/i18n/locales/zh-CN.json'));
const at = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// Sentences that say an agent joins a pod, or that you chat with it.
const JOIN_KEYS = [
  'firstRun.lede',
  'inviteModal.agentHint',
  'landing.hero.ariaLabel',
  'landing.features.byo.points.runtimes',
  'yourTeam.empty.text',
];

describe('runtime claims match the 2026-10-19 walks', () => {
  test.each([['en', en], ['zh-CN', zh]])('%s: the join and chat sentences name Claude Code and Codex, never Cursor', (_, locale) => {
    JOIN_KEYS.forEach((key) => {
      const text = at(locale, key);
      expect(typeof text).toBe('string');
      expect(text).toContain('Claude Code');
      expect(text).not.toMatch(/Cursor/);
    });
  });

  test.each([['en', en], ['zh-CN', zh]])('%s: the hero rotator does not offer Cursor', (_, locale) => {
    const terms = at(locale, 'landing.hero.terms');
    expect(Object.keys(terms)).not.toContain('cursor');
    expect(Object.values(terms)).not.toContain('Cursor');
  });

  test('the Cursor config is labelled as using the pod through MCP', () => {
    expect(at(en, 'agentByo.snippets.cursor')).toMatch(/^Use the pod from Cursor via MCP/);
    expect(at(zh, 'agentByo.snippets.cursor')).toMatch(/^通过 MCP 在 Cursor 中使用这个 Pod/);
  });

  test('no public copy promises any runtime', () => {
    const anyRuntime = /\b(any|every) (agent )?runtime\b/i;
    expect(read('frontend/src/i18n/locales/en.json')).not.toMatch(anyRuntime);
    expect(read('README.md')).not.toMatch(anyRuntime);
    expect(read('docs-site/introduction.mdx')).not.toMatch(anyRuntime);
    expect(read('frontend/src/i18n/locales/zh-CN.json')).not.toMatch(/(任意|任何|所有)运行时/);
  });

  // The guides keep "every runtime" where it is advice ("do not assume every
  // runtime supports…"), so they are held to the specific claims they made.
  test('the SEO guides neither recommend MCP as the way to join nor offer OpenClaw to commonly.me', () => {
    const guides = read('frontend/src/content/guides.json');
    expect(guides).not.toMatch(/MCP is the recommended path|recommended path for attaching/i);
    expect(guides).not.toMatch(/OpenClaw is (one|a) supported runtime/i);
    expect(guides).not.toMatch(/Cursor, OpenClaw|Codex, OpenClaw/);
  });
});
